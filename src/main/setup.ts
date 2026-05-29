// Setup wizard logic for the Settings "Test connection" + "Bootstrap remote"
// buttons. Pure parsing helpers are exported for unit testing; the SSH-driven
// `probe()` and `bootstrap()` orchestrators live alongside the runner.

import type { AppConfig, ProbeCheck, ProbeResult, BootstrapResult } from "../shared/types.js";
import { runSshOnce } from "./pty.js";
import { buildRemoteConfigWriteCmd } from "./remoteConfigWrite.js";

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

/**
 * Remote probe script. One shell program, no `set -e`, every check is
 * independent. Output is the KEY=ok|detail / KEY=fail|detail format
 * parsed by parseProbeOutput.
 *
 *   ssh                 — reaching this point means ssh is fine; reported
 *                         "ok" unconditionally so the renderer can always
 *                         render the first row.
 *   tmux                — `tmux -V` exit status + version line.
 *   opencode            — looks for `opencode` in PATH OR ~/.opencode/bin
 *                         (the installer's default). Reports version.
 *   opencodeAuthPlugin  — checks ~/.config/opencode/opencode.jsonc lists
 *                         `opencode-claude-auth` in the `plugin` array.
 *   anthropicAuth       — parses ~/.claude/.credentials.json (without running
 *                         opencode) and reports token health, not mere
 *                         presence: valid / expired-but-refreshable (ok) vs
 *                         expired-dead / malformed / unverifiable (fail).
 */
export const PROBE_SCRIPT = `
echo "ssh=ok|connected"

if v=$(tmux -V 2>/dev/null); then
  echo "tmux=ok|$v"
else
  echo "tmux=fail|tmux not found. Install with your package manager (apt, brew, dnf, ...)."
fi

OC=""
if command -v opencode >/dev/null 2>&1; then
  OC=$(command -v opencode)
elif [ -x "$HOME/.opencode/bin/opencode" ]; then
  OC="$HOME/.opencode/bin/opencode"
fi
if [ -n "$OC" ]; then
  ocv=$("$OC" --version 2>/dev/null | head -n1)
  echo "opencode=ok|$OC ($ocv)"
else
  echo "opencode=fail|opencode not installed. Click 'Bootstrap remote' to install."
fi

CFG="$HOME/.config/opencode/opencode.jsonc"
if [ -f "$CFG" ] && grep -q 'opencode-claude-auth' "$CFG"; then
  echo "opencodeAuthPlugin=ok|configured"
else
  echo "opencodeAuthPlugin=fail|opencode-claude-auth plugin not in $CFG. Bootstrap will add it."
fi

CRED="$HOME/.claude/.credentials.json"
if [ ! -s "$CRED" ]; then
  echo "anthropicAuth=fail|Not signed in. Run 'opencode auth login anthropic' on the remote to sign in to Claude."
else
  # File present — but "present" is not "usable". The access token is short-
  # lived (observed ~8h on the claude.ai OAuth tier); what keeps the box self-
  # sufficient is a VALID REFRESH TOKEN. The opencode-claude-auth plugin uses it
  # to mint a new access token and writes it back to this file in place — this
  # was verified directly: with the file's expiresAt forced into the past and
  # the refresh token retained, a single opencode call refreshed the token on
  # disk with no CLI or external timer involved. So the verdicts are:
  #   valid                 -> ok
  #   expired + refresh tok  -> ok (plugin self-heals on next request)
  #   expired, no refresh    -> fail (needs interactive re-auth)
  #   malformed / no token   -> fail
  #
  # NOTE on the "expired + refresh token" = ok heuristic: we report ok on the
  # PRESENCE of a refresh token, not proof it still works server-side. A revoked
  # or rotated-away refresh token reads ok here and only fails on the first real
  # request. We accept that — confirming it would mean spending the (single-use!)
  # refresh token, which would burn it for the plugin. Presence is the safe,
  # non-destructive signal.
  #
  # Parsing uses python3 if present, else node (bundled with opencode). If the
  # interpreter is missing OR exits unexpectedly, we report fail|unverified —
  # NOT ok. A probe whose job is to detect broken auth must never answer "ok"
  # when it could not actually validate; false confidence is worse than none.
  CHECK='
import json,sys,time
try:
    d=json.load(open(sys.argv[1]))["claudeAiOauth"]
except Exception:
    print("fail|Credentials file is malformed. Re-run: opencode auth login anthropic"); sys.exit()
acc=d.get("accessToken"); rt=d.get("refreshToken"); exp=d.get("expiresAt") or 0
now=int(time.time()*1000)
if not acc:
    print("fail|No access token. Re-run: opencode auth login anthropic")
elif exp>now:
    print("ok|valid (%dm left)"%int((exp-now)/60000))
elif rt:
    print("ok|access token expired; auto-refreshes via refresh token")
else:
    print("fail|Token expired and no refresh token. Re-run: opencode auth login anthropic")
'
  # Fallback verdict when we cannot run a validating interpreter. Deliberately
  # fail, not ok — see NOTE above.
  UNVERIFIED="fail|Credentials file present but could not be validated (no python3/node on remote). Verify auth manually."
  if command -v python3 >/dev/null 2>&1; then
    echo "anthropicAuth=$(python3 -c "$CHECK" "$CRED" 2>/dev/null || echo "$UNVERIFIED")"
  elif command -v node >/dev/null 2>&1; then
    # Mirror the python logic exactly: a valid-JSON file MISSING the
    # claudeAiOauth block must route to "malformed", same as python's KeyError.
    # JSON.parse(...).claudeAiOauth yields undefined (no throw), so we throw
    # explicitly inside the try; otherwise a later field access would throw
    # OUTSIDE the try, exit non-zero, and the OR-fallback would mask it.
    echo "anthropicAuth=$(node -e '
      const fs=require("fs");let d;
      try{
        d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).claudeAiOauth;
        if(!d) throw new Error("no claudeAiOauth block");
      }catch(e){console.log("fail|Credentials file is malformed. Re-run: opencode auth login anthropic");process.exit(0);}
      const now=Date.now(),exp=d.expiresAt||0;
      if(!d.accessToken)console.log("fail|No access token. Re-run: opencode auth login anthropic");
      else if(exp>now)console.log("ok|valid ("+Math.round((exp-now)/60000)+"m left)");
      else if(d.refreshToken)console.log("ok|access token expired; auto-refreshes via refresh token");
      else console.log("fail|Token expired and no refresh token. Re-run: opencode auth login anthropic");
    ' "$CRED" 2>/dev/null || echo "$UNVERIFIED")"
  else
    echo "anthropicAuth=$UNVERIFIED"
  fi
fi
`;

/**
 * Install-only bootstrap script: ensures the opencode binary exists.
 *
 * The opencode.jsonc edit is deliberately NOT in here — it's done in
 * Node via mergeOpencodeJsonc() so we can read the existing file and
 * deep-merge instead of clobbering hand-tuned user config (other
 * plugins, MCP servers, custom keymaps, etc.). The previous shell-only
 * version of this script overwrote the whole file with a 3-line
 * minimal config; recovery required restoring from .pre-bui.
 *
 * Does NOT run \`opencode auth login\` — that opens a browser/device-
 * code flow that must be driven interactively in a shell.
 */
export const INSTALL_SCRIPT = `
log() { printf '%s\\n' "$1"; }

if command -v opencode >/dev/null 2>&1 || [ -x "$HOME/.opencode/bin/opencode" ]; then
  log "✓ opencode already installed — skipping installer"
else
  log "→ Installing opencode (curl | bash)..."
  if curl -fsSL https://opencode.ai/install | bash >/tmp/bui-opencode-install.log 2>&1; then
    log "✓ opencode installed"
  else
    log "✗ opencode installer failed. Last lines:"
    tail -n 5 /tmp/bui-opencode-install.log | sed 's/^/  /'
    exit 1
  fi
fi
`;

/**
 * Auth-state probe used as the third bootstrap step. Surfaces the
 * next-step login command when credentials are missing. Separate from
 * the structured probe() above because this is a one-line transcript
 * line for the bootstrap log, not a status check.
 */
export const AUTH_HINT_SCRIPT = `
if [ -s "$HOME/.claude/.credentials.json" ]; then
  printf '%s\\n' "✓ Anthropic credentials present at ~/.claude/.credentials.json"
else
  printf '%s\\n' "→ Next: log in to Anthropic by running this on the remote:"
  printf '%s\\n' "    opencode auth login anthropic"
fi
`;

// ---------------------------------------------------------------------------
// JSONC merge — pure (tested)
// ---------------------------------------------------------------------------

const CLAUDE_AUTH_PLUGIN = "opencode-claude-auth@latest";
const CLAUDE_AUTH_PLUGIN_BARE = "opencode-claude-auth";

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
  // unpinned). `pkg@version` and bare `pkg` both count.
  const alreadyPresent =
    pluginArray !== null &&
    pluginArray.some((entry) => {
      const s = asString(entry);
      if (!s) return false;
      const bareName = s.split("@")[0];
      return bareName === CLAUDE_AUTH_PLUGIN_BARE;
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

// ---------------------------------------------------------------------------
// Runners (thin SSH glue, not unit tested)
// ---------------------------------------------------------------------------

export async function probe(config: AppConfig): Promise<ProbeResult> {
  if (!config.host) {
    return {
      checks: [
        { name: "ssh", ok: false, detail: "No host configured." },
        { name: "tmux", ok: false, detail: "not reported" },
        { name: "opencode", ok: false, detail: "not reported" },
        { name: "opencodeAuthPlugin", ok: false, detail: "not reported" },
        { name: "anthropicAuth", ok: false, detail: "not reported" },
      ],
      allOk: false,
    };
  }
  try {
    const { stdout } = await runSshOnce(config, PROBE_SCRIPT);
    return parseProbeOutput(stdout);
  } catch (e) {
    // SSH itself failed — every other check is moot.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      checks: [
        { name: "ssh", ok: false, detail: msg },
        { name: "tmux", ok: false, detail: "not reported (ssh failed)" },
        { name: "opencode", ok: false, detail: "not reported (ssh failed)" },
        { name: "opencodeAuthPlugin", ok: false, detail: "not reported (ssh failed)" },
        { name: "anthropicAuth", ok: false, detail: "not reported (ssh failed)" },
      ],
      allOk: false,
    };
  }
}

// Bootstrap stages can each be slow: the opencode installer pipes a curl
// payload through bash and may pull >50MB of binaries; SSH itself can wedge
// on a flaky link. Cap each stage at 2 minutes so the UI button can't
// spin forever (no in-app cancel today). The user can always retry.
const BOOTSTRAP_STAGE_TIMEOUT_MS = 120_000;

/**
 * Race an SSH command against a timeout. On timeout, returns a synthetic
 * error rather than leaving the ssh process leaking — `runSshOnce` doesn't
 * expose a kill handle, but `ssh -o ServerAliveInterval` + ControlPersist
 * mean a wedged session usually self-recovers within ~5 min anyway.
 */
async function runSshWithTimeout(
  config: AppConfig,
  cmd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `SSH command timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          `The remote may be unreachable or the installer stalled.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([runSshOnce(config, cmd), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function bootstrap(config: AppConfig): Promise<BootstrapResult> {
  if (!config.host) {
    return {
      ok: false,
      log: ["✗ No host configured. Set the remote host in Settings first."],
    };
  }

  const log: string[] = [];

  // -- Stage 1: install opencode binary (shell-driven) --
  try {
    const { stdout, stderr } = await runSshWithTimeout(
      config,
      INSTALL_SCRIPT,
      BOOTSTRAP_STAGE_TIMEOUT_MS,
    );
    for (const line of stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean)) {
      log.push(line);
    }
    if (stderr.trim()) {
      log.push(`(install stderr) ${stderr.trim()}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`✗ opencode install failed: ${msg}`);
    return { ok: false, log };
  }

  // -- Stage 2: deep-merge opencode.jsonc (Node-driven, non-destructive) --
  try {
    const cfgPath = "~/.config/opencode/opencode.jsonc";
    const { stdout: existing } = await runSshWithTimeout(
      config,
      `cat ${cfgPath} 2>/dev/null || true`,
      30_000,
    );
    const result = mergeOpencodeJsonc(existing);
    if (!result.changed) {
      log.push(`✓ ${result.detail}`);
    } else {
      // Back up only if there was non-empty existing content. mergeOpencodeJsonc
      // already decided whether to fully replace (unparseable) or merge — we
      // preserve the original either way so the user can recover.
      if (existing.trim()) {
        await runSshWithTimeout(
          config,
          `cp -a ${cfgPath} ${cfgPath}.pre-bui 2>/dev/null || true`,
          30_000,
        );
        log.push(`→ Existing opencode.jsonc backed up to ${cfgPath}.pre-bui`);
      }
      await runSshWithTimeout(
        config,
        buildRemoteConfigWriteCmd(result.content, cfgPath),
        30_000,
      );
      log.push(`✓ ${result.detail}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`✗ opencode.jsonc merge failed: ${msg}`);
    return { ok: false, log };
  }

  // -- Stage 3: surface Anthropic auth state + next step --
  try {
    const { stdout } = await runSshWithTimeout(
      config,
      AUTH_HINT_SCRIPT,
      30_000,
    );
    for (const line of stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean)) {
      log.push(line);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.push(`(auth check failed: ${msg})`);
    // Non-fatal — bootstrap still considered ok if install + merge succeeded.
  }

  log.push("Bootstrap complete.");

  // ok if no stage emitted a ✗ line. Note: bare stderr lines (e.g. "(install
  // stderr) …") are intentionally NOT counted as failures — most install
  // tools print progress and warnings to stderr without failing. A real
  // install failure surfaces as a thrown error caught above (which DOES
  // prepend ✗) because the script `exit 1`s.
  const ok = !log.some((l) => l.startsWith("✗"));
  return { ok, log };
}
