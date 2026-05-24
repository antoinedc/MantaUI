// Setup wizard logic for the Settings "Test connection" + "Bootstrap remote"
// buttons. Pure parsing helpers are exported for unit testing; the SSH-driven
// `probe()` and `bootstrap()` orchestrators live alongside the runner.

import type { AppConfig, ProbeCheck, ProbeResult, BootstrapResult } from "../shared/types.js";
import { runSshOnce } from "./pty.js";

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
 *   anthropicAuth       — checks ~/.claude/.credentials.json exists AND is
 *                         non-empty. Doesn't validate contents (that would
 *                         require running opencode).
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
if [ -s "$CRED" ]; then
  echo "anthropicAuth=ok|credentials present"
else
  echo "anthropicAuth=fail|Run 'opencode auth login anthropic' on the remote to sign in to Claude."
fi
`;

/**
 * Bootstrap script: install opencode if missing and write a minimal
 * opencode.jsonc that loads the opencode-claude-auth plugin. Idempotent —
 * each step checks before acting and reports a clear ok/skip/fail line.
 *
 * The output is a sequence of human-readable lines (one per step). The
 * caller splits on newlines for the wizard's log pane. Distinct from the
 * probe format because this is a transcript, not a structured result.
 *
 * Does NOT run \`opencode auth login\` — that opens a browser/device-code
 * flow that must be driven interactively in a shell. The wizard surfaces
 * the next step as a copy-pasteable command instead.
 */
export const BOOTSTRAP_SCRIPT = `
log() { printf '%s\\n' "$1"; }

# 1. Install opencode if missing
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

# 2. Ensure opencode.jsonc has the claude-auth plugin
CFG="$HOME/.config/opencode/opencode.jsonc"
mkdir -p "$(dirname "$CFG")"
if [ -f "$CFG" ] && grep -q 'opencode-claude-auth' "$CFG"; then
  log "✓ opencode.jsonc already configured for Claude auth — skipping"
else
  # If a config exists but lacks the plugin, back it up before overwriting.
  if [ -f "$CFG" ]; then
    cp -a "$CFG" "$CFG.pre-bui"
    log "→ Existing opencode.jsonc backed up to $CFG.pre-bui"
  fi
  cat > "$CFG" <<'BUI_OC_JSONC'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-claude-auth@latest"]
}
BUI_OC_JSONC
  log "✓ Wrote $CFG with opencode-claude-auth plugin"
fi

# 3. Surface auth state + next step (don't run login — needs browser)
if [ -s "$HOME/.claude/.credentials.json" ]; then
  log "✓ Anthropic credentials present at ~/.claude/.credentials.json"
else
  log "→ Next: log in to Anthropic by running this on the remote:"
  log "    opencode auth login anthropic"
fi

log "Bootstrap complete."
`;

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

export async function bootstrap(config: AppConfig): Promise<BootstrapResult> {
  if (!config.host) {
    return {
      ok: false,
      log: ["✗ No host configured. Set the remote host in Settings first."],
    };
  }
  try {
    const { stdout, stderr } = await runSshOnce(config, BOOTSTRAP_SCRIPT);
    const lines = stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (stderr.trim()) lines.push(`(stderr) ${stderr.trim()}`);
    const ok = !lines.some((l) => l.startsWith("✗"));
    return { ok, log: lines };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, log: [`✗ Bootstrap failed: ${msg}`] };
  }
}
