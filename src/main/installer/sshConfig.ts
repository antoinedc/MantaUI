// sshConfig.ts — parse an OpenSSH client config into a list of host aliases.
//
// WHY A PARSER (and not the user's literal SSH config as-is): the desktop reads
// ~/.ssh/config to offer a box picker — the user picks an alias from a list
// instead of typing an IP. We DO NOT derive connection settings from the parse
// (hostname, user, port, identity file, jump hosts all change per-Install and
// per-Include — re-deriving by hand is a guaranteed drift trap). The chosen
// alias is later passed to `ssh -G <alias>` (runner.ts sshResolvedFromSshG),
// which IS the single source of truth for the effective connection settings —
// OpenSSH itself resolves Includes, Match blocks, defaults, and jump-host chains.
//
// What this parser therefore MUST do:
//   - list every top-level `Host <alias>` (and the per-line patterns on the
//     same directive), with `Host *` excluded (the default block is never a
//     user-meaningful pickable box)
//   - tolerate comments (`#` and `//` are not legal in ssh_config but appear
//     in real configs; we ignore them defensively), blank lines, and inline
//     comments (`foo bar # trailing comment`)
//   - tolerate quoted values (Host "my box" is legal and the quotes are NOT
//     part of the alias)
//   - tolerate `=`-prefixed directives (ssh allows `Host = foo` because of
//     its "options may be passed as -o" history) and strip the leading `=`
//   - tolerate case-insensitive `host` directive (ssh_config is case-
//     insensitive — we accept `Host`, `HOST`, `hOsT` …)
//
// What this parser MUST NOT do:
//   - error on `Include` directives (we ignore Include entirely — `ssh -G`
//     resolves them; we just don't list the included aliases)
//   - error on `Match` blocks (a Match host can re-define the alias set
//     conditionally; we don't try to model it, same reason: `ssh -G` knows)
//   - validate the user's config — if it's broken, `ssh -G` will fail later
//     and the user sees the same error they would see in Terminal
//
// Pure: no fs, no spawn, no side effects. The file is read by the caller and
// passed as `text`. Tested in sshConfig.test.ts.

export type SshHostEntry = {
  /** First alias on the `Host` directive (canonical pickable name). */
  alias: string;
  /** Every pattern on the same directive (alias is always included). */
  patterns: string[];
};

/** Strip trailing whitespace + a single `# …` comment, respecting quotes. */
function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inSingle && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Tokenize `rest` (the args after a `Host` directive) into a list of
 * whitespace-separated words, respecting double-quoted strings so
 * `Host "my box" "another"` tokenises into ["my box", "another"] and NOT
 * into ["\"my", "box\"", "\"another\"]. Single quotes are not legal in
 * ssh_config values; we only handle double quotes.
 */
function tokenizeHostArgs(rest: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inStr = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "\\" && i + 1 < rest.length) {
      buf += c + rest[i + 1];
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr && /\s/.test(c)) {
      if (buf !== "") {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    buf += c;
  }
  if (buf !== "") tokens.push(buf);
  return tokens;
}

/**
 * Parse ssh_config text into the ordered list of host aliases. Order matches
 * the file's top-down appearance so the picker's UI matches what the user
 * sees when they open the file. `Host *` is silently skipped — the default
 * block is never a user-meaningful pickable box.
 *
 * Returns an empty array on an empty / whitespace-only / no-Hosts file —
 * callers turn that into "no candidates" UI rather than an error.
 */
export function parseSshConfig(text: string): SshHostEntry[] {
  if (typeof text !== "string") return [];
  const out: SshHostEntry[] = [];
  let current: string[] | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    const noComment = stripInlineComment(rawLine).trim();
    if (noComment === "") continue;
    // `Host = foo` (with the leading `=`) is legal in ssh_config because of
    // its -o-flag history. Strip the `=` so the directive parses cleanly.
    const normalized = noComment.startsWith("=") ? noComment.slice(1).trim() : noComment;
    // Split off the first whitespace-separated token; the rest are args.
    const sp = normalized.indexOf(" ");
    let directive: string;
    let rest: string;
    if (sp === -1) {
      directive = normalized;
      rest = "";
    } else {
      directive = normalized.slice(0, sp);
      rest = normalized.slice(sp + 1).trim();
    }
    // ssh_config also allows `Host = foo` (the `=` sits between the
    // directive and the first arg, NOT before the directive). Strip a
    // leading `=` from `rest` so `Host = dev` parses identically to
    // `Host =dev` and `Host=dev`.
    if (rest.startsWith("=")) rest = rest.slice(1).trim();
    // ssh_config is case-insensitive for directives.
    if (directive.toLowerCase() === "host") {
      if (current !== null) {
        out.push({ alias: current[0], patterns: current });
      }
      const patterns = tokenizeHostArgs(rest);
      // `Host *` is the default block — never a pickable box.
      const pickable = patterns.filter((p) => p !== "*");
      current = pickable.length > 0 ? pickable : null;
    } else {
      // Property line inside a `Host` block — ignored. `ssh -G` resolves the
      // effective settings; we only enumerate the alias names.
    }
  }
  if (current !== null) {
    out.push({ alias: current[0], patterns: current });
  }
  return out;
}
