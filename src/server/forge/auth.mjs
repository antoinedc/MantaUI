// auth.mjs — box-side forge-credential resolution: the §3.3 ladder (BET-788).
//
// Priority for a resolved token:
//   1. The forge CLI's own token — `gh auth token` for github.com, run through
//      a login shell. gh lives under ~/.local/bin or a Homebrew prefix that a
//      bare execFile PATH cannot see, so this reuses runLoginShell
//      (src/server/launchers.mjs) — the same helper the repo probe's
//      detectForgeCli() uses. This is the default and covers the overwhelmingly
//      common case of a box that is already a dev machine.
//   2. A stored secret — GITHUB_TOKEN in the box secrets vault
//      (~/.manta-secrets, 0600), read via resolveSecret. Reading the value
//      in-process is fine: the secrets-store invariant is that a value never
//      enters an AGENT's transcript, not that it never enters the server's
//      memory.
//
// A resolved token is cached in memory for a short TTL (so a poll loop doesn't
// re-spawn `gh auth token` every couple of seconds) and invalidateToken()
// lets a rotated token be picked up without a restart.
//
// HARD RULES (issue §1 + Do-NOT): never log the token, never return it over
// RPC (forge:status only ever surfaces `login`, computed elsewhere), never
// write it to disk. The only thing a caller outside this module may do with a
// resolved token is pass it to the fetch layer.

import { runLoginShell } from "../launchers.mjs";
import { resolveSecret, loadSecrets } from "../secrets.mjs";

// How long a cached resolution is trusted before the CLI/secret is re-read.
const TTL_MS = 60_000;

// The CLI leg only exists for github.com (`gh auth token`). GitLab has its own
// CLI but it arrives with the GitLab adapter; this issue is the GitHub read
// path.
const CLI_HOST = "github.com";

// Secrets-vault key per host for the stored leg. GITHUB_TOKEN is the issue's
// canonical key for GitHub.
const STORED_KEY_BY_HOST = Object.freeze({
  "github.com": "GITHUB_TOKEN",
});

// host -> { at, found, token?, source? }
const CACHE = new Map();

async function cliToken(host, shell) {
  if (host !== CLI_HOST) return null;
  try {
    const { stdout } = await shell("gh auth token");
    const token = (stdout ?? "").trim();
    return token ? token : null;
  } catch {
    // `gh auth token` exits non-zero when not authenticated (or gh is missing).
    return null;
  }
}

function storedToken(host, loadSecretsFn) {
  const key = STORED_KEY_BY_HOST[host];
  if (!key) return null;
  try {
    const entry = resolveSecret(loadSecretsFn(), key, null, null);
    return typeof entry?.value === "string" && entry.value ? entry.value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the box-side token for a forge host per §3.3's ladder, or null when
 * neither leg yields one (callers surface "not connected").
 *
 * Priority: CLI (`gh auth token`) wins over the stored secret. A resolved
 * value is cached for TTL_MS; a miss is cached briefly too so a not-connected
 * box doesn't re-spawn the CLI on every poll. Pass `now` to control the clock
 * in tests; `invalidateToken` clears a host's entry for the rotation case.
 *
 * @param {string} host
 * @param {{ shell?: (cmd: string) => Promise<{stdout: string}>, loadSecretsFn?: () => unknown, now?: () => number }} [opts]
 * @returns {Promise<{ token: string, source: "cli" | "stored" } | null>}
 */
export async function resolveToken(
  host,
  { shell = runLoginShell, loadSecretsFn = loadSecrets, now = Date.now } = {},
) {
  if (typeof host !== "string" || !host) return null;

  const hit = CACHE.get(host);
  if (hit && now() - hit.at < TTL_MS) {
    return hit.found ? { token: hit.token, source: hit.source } : null;
  }

  const cli = await cliToken(host, shell);
  if (cli) {
    CACHE.set(host, { at: now(), found: true, token: cli, source: "cli" });
    return { token: cli, source: "cli" };
  }

  const stored = storedToken(host, loadSecretsFn);
  if (stored) {
    CACHE.set(host, { at: now(), found: true, token: stored, source: "stored" });
    return { token: stored, source: "stored" };
  }

  CACHE.set(host, { at: now(), found: false });
  return null;
}

/**
 * Drop the cached resolution for a host so the next resolveToken re-reads the
 * CLI/secret — use after the user rotates a token or connects a fresh gh auth.
 * @param {string} host
 */
export function invalidateToken(host) {
  CACHE.delete(host);
}
