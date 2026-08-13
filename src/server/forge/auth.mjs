// auth.mjs — box-side forge-credential resolution: the §3.3 ladder (BET-788).
//
// Priority for a resolved token:
//   1. A per-host env var (`MANTA_GITHUB_TOKEN` / `MANTA_GITLAB_TOKEN`) — the
//      dev/test override and a legitimate self-host affordance. Highest
//      because an explicit operator override must win over ambient state.
//   2. The forge CLI's own token — `gh auth token` for github.com, run through
//      a login shell. gh lives under ~/.local/bin or a Homebrew prefix that a
//      bare execFile PATH cannot see, so this reuses runLoginShell
//      (src/server/launchers.mjs) — the same helper the repo probe's
//      detectForgeCli() uses. This is the default and covers the overwhelmingly
//      common case of a box that is already a dev machine.
//   3. A stored secret in the box secrets vault (~/.manta-secrets, 0600), read
//      via resolveSecret. Both the BET-788 canonical key (`GITHUB_TOKEN` /
//      `GITLAB_TOKEN`) and the BET-797 legacy key (`github.token` /
//      `gitlab.token`) are accepted so a secret stored through either
//      documentation path resolves. Reading the value in-process is fine: the
//      secrets-store invariant is that a value never enters an AGENT's
//      transcript, not that it never enters the server's memory.
//
// This is the ONE forge token resolver on the box. The rules
// (forge_rules_save in forgeRules.mjs) and the adapter (forge/index.mjs)
// both resolve through it, so a gh-authenticated or secret-stored box
// registers webhooks and reads the forge with the same credential.
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
// CLI but it arrives with the GitLab adapter.
const CLI_HOST = "github.com";

// Per-host env var override (priority 1).
const ENV_BY_HOST = Object.freeze({
  "github.com": "MANTA_GITHUB_TOKEN",
  "gitlab.com": "MANTA_GITLAB_TOKEN",
});

// Secrets-vault keys per host, checked in order. The first is the BET-788
// canonical key; the second is the BET-797 legacy key still documented in
// docs/forge-rules-authoring.md and accepted so an existing secret keeps
// working.
const STORED_KEYS_BY_HOST = Object.freeze({
  "github.com": ["GITHUB_TOKEN", "github.token"],
  "gitlab.com": ["GITLAB_TOKEN", "gitlab.token"],
});

// host -> { at, found, token?, source? }
const CACHE = new Map();

function envToken(host, env) {
  const key = ENV_BY_HOST[host];
  if (!key) return null;
  const v = env?.[key];
  return typeof v === "string" && v ? v : null;
}

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
  const keys = STORED_KEYS_BY_HOST[host];
  if (!keys || keys.length === 0) return null;
  try {
    const secrets = loadSecretsFn();
    for (const key of keys) {
      const entry = resolveSecret(secrets, key, null, null);
      if (typeof entry?.value === "string" && entry.value) return entry.value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the box-side token for a forge host per §3.3's ladder, or null when
 * no leg yields one (callers surface "not connected").
 *
 * Priority: env var → CLI (`gh auth token`) → stored secret. A resolved value
 * is cached for TTL_MS; a miss is cached briefly too so a not-connected box
 * doesn't re-spawn the CLI on every poll. Pass `now` / `env` / `shell` /
 * `loadSecretsFn` to control the clock and I/O in tests;
 * `invalidateToken` clears a host's entry for the rotation case.
 *
 * @param {string} host
 * @param {{ shell?: (cmd: string) => Promise<{stdout: string}>, loadSecretsFn?: () => unknown, env?: NodeJS.ProcessEnv, now?: () => number }} [opts]
 * @returns {Promise<{ token: string, source: "env" | "cli" | "stored" } | null>}
 */
export async function resolveToken(
  host,
  { shell = runLoginShell, loadSecretsFn = loadSecrets, env = process.env, now = Date.now } = {},
) {
  if (typeof host !== "string" || !host) return null;

  const hit = CACHE.get(host);
  if (hit && now() - hit.at < TTL_MS) {
    return hit.found ? { token: hit.token, source: hit.source } : null;
  }

  const envTok = envToken(host, env);
  if (envTok) {
    CACHE.set(host, { at: now(), found: true, token: envTok, source: "env" });
    return { token: envTok, source: "env" };
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
