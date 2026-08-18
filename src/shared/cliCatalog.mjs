// cliCatalog.mjs — THE single source of truth for which AI CLIs exist on a
// box, how to find out their version, and what command upgrades them.
//
// Both consumers — the box server (src/server/cliUpdates.mjs, this epic) and
// `scripts/self-update.sh` (stage 2) — read THIS table and nothing else. Do
// not duplicate any of it anywhere.
//
// Security note on the upgrade commands: the two `["sh","-c", …]` pipelines
// are CONSTANTS from this table. They are verified against each vendor's
// current docs and are NEVER built from any input. `resolveUpgradeCommand`
// may return an entry's `upgrade` verbatim, but nothing ever interpolates
// into these pipelines.
//
// The ONLY place install-method branching lives is `resolveUpgradeCommand`
// below — every other module reads this file's data and this function's
// verdict.

export const CLI_CATALOG = [
  {
    id: "opencode",
    label: "opencode",
    bin: "opencode",
    latest: { kind: "github", repo: "anomalyco/opencode" },
    npmPackage: null,
    upgrade: ["opencode", "upgrade"],
    manualUrl: "https://opencode.ai/docs",
    disruption: "ends-turns",
  },

  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    latest: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
    npmPackage: "@anthropic-ai/claude-code",
    upgrade: ["claude", "update"],
    manualUrl: "https://docs.claude.com/en/docs/claude-code/setup",
    disruption: "none",
  },

  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    latest: { kind: "npm", pkg: "@openai/codex" },
    npmPackage: "@openai/codex",
    upgrade: ["sh", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    manualUrl: "https://developers.openai.com/codex",
    disruption: "none",
  },

  {
    id: "kimi",
    label: "Kimi Code",
    bin: "kimi",
    latest: { kind: "npm", pkg: "@moonshot-ai/kimi-code" },
    npmPackage: "@moonshot-ai/kimi-code",
    upgrade: ["sh", "-c", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],
    manualUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    disruption: "none",
  },
];

// Homebrew-managed install prefixes. Re-running a vendor installer over a
// brew-managed binary installs a shadowing second copy — the upgrade must
// refuse rather than do that.
const HOMEBREW_PREFIXES = ["/opt/homebrew/", "/usr/local/Cellar/", "/home/linuxbrew/"];

function isInside(base, p) {
  if (typeof base !== "string" || base === "" || typeof p !== "string") return false;
  if (p === base) return true;
  return p.startsWith(base.endsWith("/") ? base : base + "/");
}

/** Is `p` inside any known Homebrew install prefix? */
function isHomebrewManaged(p) {
  if (typeof p !== "string") return false;
  return HOMEBREW_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Which command upgrades this CLI, given where its binary actually is.
 *
 * Returns null = "we cannot upgrade this safely" → the UI shows a manual link.
 *
 * Precedence, in this exact order — four branches, no more:
 *   1. npm-managed (resolvedPath inside npmGlobalRoot, entry exposes an npm
 *      package) → `npm install -g <pkg>@latest`. npm root WINS over the
 *      vendor installer because the vendor installer would shadow npm's copy.
 *   2. Homebrew-managed → null. Vendor installer over a brew-managed binary
 *      creates a shadowing second copy.
 *   3. entry.upgrade → returned verbatim.
 *   4. → null.
 *
 * @param {{ npmPackage: string|null, upgrade?: string[] }} entry
 * @param {string} [resolvedPath] absolute path the binary resolved to
 * @param {string} [npmGlobalRoot] `npm root -g` output, when known
 * @returns {string[]|null}
 */
export function resolveUpgradeCommand(entry, resolvedPath, npmGlobalRoot) {
  if (!entry || typeof resolvedPath !== "string") return null;

  if (
    typeof npmGlobalRoot === "string" &&
    npmGlobalRoot !== "" &&
    entry.npmPackage &&
    isInside(npmGlobalRoot, resolvedPath)
  ) {
    return ["npm", "install", "-g", `${entry.npmPackage}@latest`];
  }

  if (isHomebrewManaged(resolvedPath)) return null;

  if (Array.isArray(entry.upgrade) && entry.upgrade.length > 0) return entry.upgrade;

  return null;
}
