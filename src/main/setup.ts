// Pure helpers for parsing probe output and merging opencode.jsonc.
// The SSH-driven probe/bootstrap runners were removed in BET-103 (HTTP-mode
// onboarding replaces the wizard). These helpers are still used by the server
// path and kept for unit testing.

import type { ProbeCheck, ProbeResult } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/**
 * Parse the probe shell script's stdout. The remote script prints one line
 * per check in `KEY=value` form, where value is "ok|<detail>" or "fail|
 * <detail>". Unknown keys are ignored. Missing keys produce a "fail|not
 * reported" check so we never silently drop a prerequisite.
 *
 * Format chosen so the script is robust to interleaving (`set -e` would
 * abort halfway through; we want every check to run independently).
 */
export function parseProbeOutput(stdout: string): ProbeResult {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const byKey = new Map<string, { ok: boolean; detail: string }>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1);
    const bar = rest.indexOf("|");
    if (bar < 0) continue;
    const status = rest.slice(0, bar);
    const detail = rest.slice(bar + 1);
    if (status !== "ok" && status !== "fail") continue;
    byKey.set(key, { ok: status === "ok", detail });
  }
  const order: ProbeCheck["name"][] = [
    "ssh",
    "tmux",
    "opencode",
    "opencodeAuthPlugin",
    "anthropicAuth",
  ];
  const checks: ProbeCheck[] = order.map((name) => {
    const r = byKey.get(name);
    return r ? { name, ok: r.ok, detail: r.detail } : { name, ok: false, detail: "not reported" };
  });
  return { checks, allOk: checks.every((c) => c.ok) };
}

// ---------------------------------------------------------------------------
// JSONC merge — pure (tested)
// ---------------------------------------------------------------------------

// The plugin we write into a fresh opencode.jsonc. We use a fork of the
// upstream `opencode-claude-auth` plugin that fixes a long-lived-process
// recovery bug: in upstream, a single failed OAuth refresh clears the
// in-memory accountCacheMap, after which every subsequent request throws
// "credentials unavailable" until opencode-serve is restarted, even though
// ~/.claude/.credentials.json on disk is healthy. Our fork (1.5.4-bui.1)
// retries via refreshAccountsList() once before throwing, which restores
// file-sourced accounts and lets the existing refresh path succeed.
//
// Source: https://github.com/antoinedc/opencode-claude-auth (fork of
// griffinmartin/opencode-claude-auth). Published as opencode-claude-auth-bui
// on npm. The bare-name MATCH list below makes the probe and the merge
// accept either the fork OR the upstream package as "auth already wired,"
// so existing users with the upstream plugin pinned don't get a duplicate
// entry appended on re-bootstrap.
const CLAUDE_AUTH_PLUGIN = "opencode-claude-auth-bui@1.5.4-bui.1";
const CLAUDE_AUTH_PLUGIN_BARE = "opencode-claude-auth-bui";
const CLAUDE_AUTH_PLUGIN_ACCEPTED_BARES: readonly string[] = [
  CLAUDE_AUTH_PLUGIN_BARE,
  "opencode-claude-auth",
];

/**
 * Strip single-line `//` JSONC comments while respecting string literals.
 *
 * The naive global regex used elsewhere in this codebase (matching slash-
 * slash through end-of-line) is BROKEN for any config containing a URL:
 * it strips everything after the slash-slash inside `"https://..."`,
 * turning `{"$schema":"https://opencode.ai/config.json", ...}` into
 * `{"$schema":"https:` which fails to parse and silently triggers the
 * "unparseable → replace with minimal config" branch — clobbering user
 * keys exactly like the bug this whole refactor was meant to fix.
 *
 * Pass through the input character-by-character, tracking string state
 * (with `\` escape support) and only treating slash-slash outside a
 * string as a line-comment start. Block comments are NOT handled — the
 * merge target (opencode.jsonc) does not use them in the wild; adding
 * support would require multi-line state.
 */
export function stripLineComments(jsonc: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < jsonc.length) {
    const c = jsonc[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < jsonc.length) {
        // Copy the escape sequence verbatim so `\"` doesn't close the string.
        out += jsonc[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = true;
      i += 1;
      continue;
    }
    if (c === "/" && jsonc[i + 1] === "/") {
      // Skip to end of line; preserve the newline so line numbers stay
      // sensible if a parser ever surfaces position info to the user.
      const nl = jsonc.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Return a string version of `value` if it's a string; otherwise null.
 * Used to defensively unpack untrusted JSON values.
 */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export type MergeResult = {
  /** The merged JSON content, ready to write back. */
  content: string;
  /** Whether any actual change was made (false → safe no-op write). */
  changed: boolean;
  /** One-line human-readable description for the bootstrap log. */
  detail: string;
};

/**
 * Merge the opencode-claude-auth plugin into an existing opencode.jsonc.
 *
 * Rules:
 *  - If existing is empty / unparseable: return a minimal config with
 *    just `$schema` + `plugin: [auth]`. `changed=true`. The caller
 *    decides whether to back up the unparseable original first.
 *  - If existing parses but has no `plugin` array, or it's not an array:
 *    add `plugin: [auth]` preserving all other keys. `changed=true`.
 *  - If existing has a `plugin` array WITHOUT the auth plugin: append
 *    the auth plugin to the end. `changed=true`.
 *  - If existing has a `plugin` array WITH any string entry whose bare
 *    package name matches `opencode-claude-auth` (with or without the
 *    `@version` suffix): no change. `changed=false`. We respect the
 *    user's pinned version if they have one.
 *
 * Output is pretty-printed JSON (2-space). JSONC comments in the input
 * are NOT preserved (the strip is lossy). Acceptable for the bootstrap
 * use case — users editing opencode.jsonc by hand and adding comments
 * are doing so against a config the bootstrap mostly leaves alone (it
 * only touches `plugin`).
 */
export function mergeOpencodeJsonc(existing: string): MergeResult {
  const trimmed = existing.trim();
  if (!trimmed) {
    return {
      content: JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [CLAUDE_AUTH_PLUGIN],
        },
        null,
        2,
      ),
      changed: true,
      detail: "Wrote new opencode.jsonc with opencode-claude-auth plugin",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripLineComments(trimmed)) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
  } catch {
    // Unparseable — return a minimal config and let the runner back up
    // the original. Don't try to "fix" arbitrary corrupted JSONC.
    return {
      content: JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [CLAUDE_AUTH_PLUGIN],
        },
        null,
        2,
      ),
      changed: true,
      detail:
        "Existing opencode.jsonc was unparseable — replaced with a minimal config (original backed up to .pre-bui)",
    };
  }

  const rawPlugin = parsed.plugin;
  const pluginArray = Array.isArray(rawPlugin) ? rawPlugin : null;

  // Check if the auth plugin is already present in any form (pinned or
  // unpinned). `pkg@version` and bare `pkg` both count. Either the fork
  // (opencode-claude-auth-bui) or the upstream (opencode-claude-auth) name
  // is accepted — re-bootstrapping a remote that already runs upstream must
  // NOT append a duplicate fork entry; the user's choice is respected.
  const alreadyPresent =
    pluginArray !== null &&
    pluginArray.some((entry) => {
      const s = asString(entry);
      if (!s) return false;
      const bareName = s.split("@")[0];
      return CLAUDE_AUTH_PLUGIN_ACCEPTED_BARES.includes(bareName);
    });

  if (alreadyPresent) {
    return {
      content: JSON.stringify(parsed, null, 2),
      changed: false,
      detail: "opencode.jsonc already configured for Claude auth — no change",
    };
  }

  // Append (or create) the plugin array.
  const nextPlugin = pluginArray !== null
    ? [...pluginArray, CLAUDE_AUTH_PLUGIN]
    : [CLAUDE_AUTH_PLUGIN];

  const merged = { ...parsed, plugin: nextPlugin };
  return {
    content: JSON.stringify(merged, null, 2),
    changed: true,
    detail: "Merged opencode-claude-auth into existing opencode.jsonc",
  };
}


