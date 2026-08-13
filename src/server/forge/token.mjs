// src/server/forge/token.mjs — box-side forge credential resolution (BET-797).
//
// Registration (`forge_rules_save`) POSTs to `POST /repos/{o}/{r}/hooks` and so
// needs a GitHub API token ON the box. That token must never reach the Electron
// renderer or the iOS app — all forge access is box-side, per the hard
// constraint in the issue. So this resolver reads ONLY box-side sources:
//
//   1. An env var (`MANTA_GITHUB_TOKEN` / `MANTA_GITLAB_TOKEN`) — the dev/test
//      override and a legitimate self-host affordance.
//   2. A forge token stored in the box secrets vault (~/.manta-secrets, 0600)
//      as a SHARED secret keyed per host (`github.token` / `gitlab.token`).
//      The AI can write this via the same secrets tool / Settings card that
//      holds other box credentials, and the server reads its OWN store
//      internally for this trusted box-side operation.
//
// The device-flow + gh-CLI-token legs of design §3.3's login ladder arrive
// with the GitHub adapter (BET-810); this file makes registration reachable
// today with an env or stored token, which unblocks criterion #1 (a real
// GitHub webhook delivered + logged).
//
// Pure of network. I/O (the secrets store) is injectable so unit tests never
// touch the real ~/.manta-secrets.

import { loadSecrets, resolveSecret } from "../secrets.mjs";

// Env var name per known forge host.
const ENV_BY_HOST = Object.freeze({
  "github.com": "MANTA_GITHUB_TOKEN",
  "gitlab.com": "MANTA_GITLAB_TOKEN",
});

// Secrets-vault key per host (shared scope).
const SECRET_KEY_BY_HOST = Object.freeze({
  "github.com": "github.token",
  "gitlab.com": "gitlab.token",
});

/**
 * Resolve the box-side forge API token for a host, or null when none is
 * configured. Order: per-host env var, then the shared secrets vault. A host
 * outside {github.com, gitlab.com} has no known source → null (self-hosted
 * host mapping arrives with the adapter).
 *
 * @param {string} host
 * @param {{env?: NodeJS.ProcessEnv, loadSecretsFn?: (path?: string) => ReturnType<typeof loadSecrets>}} [opts]
 * @returns {string|null}
 */
export function resolveForgeToken(host, { env = process.env, loadSecretsFn = loadSecrets } = {}) {
  if (typeof host !== "string" || !host) return null;

  const envKey = ENV_BY_HOST[host];
  if (envKey) {
    const v = env[envKey];
    if (typeof v === "string" && v) return v;
  }

  const secretKey = SECRET_KEY_BY_HOST[host];
  if (!secretKey) return null;
  try {
    const entry = resolveSecret(loadSecretsFn(), secretKey, null, null);
    return typeof entry?.value === "string" && entry.value ? entry.value : null;
  } catch {
    return null;
  }
}
