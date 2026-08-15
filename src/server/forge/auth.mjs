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

import { randomBytes } from "node:crypto";
import { runLoginShell } from "../launchers.mjs";
import { resolveSecret, loadSecrets, setSecret } from "../secrets.mjs";
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// How long a cached resolution is trusted before the CLI/secret is re-read.
const TTL_MS = 60_000;

// The CLI legs, per host. GitHub: `gh auth token` through a login shell.
// GitLab: glab persists its token in a config file (`~/.config/glab-cli/`).
const GITHUB_CLI_HOST = "github.com";
const GITLAB_CLI_HOST = "gitlab.com";

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

// Derive the env/secret key NAMESPACE for an arbitrary host. A self-hosted
// host isn't in the fixed maps, so it gets a deterministic, host-derived name:
// `git.example.com` → env `MANTA_GIT_EXAMPLE_COM_TOKEN`, secrets `[GIT_EXAMPLE_COM_TOKEN, forge.git.example.com.token]`.
function hostKey(host) {
  return String(host).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function envToken(host, env) {
  const key = ENV_BY_HOST[host] ?? (host ? `MANTA_${hostKey(host)}_TOKEN` : null);
  if (!key) return null;
  const v = env?.[key];
  return typeof v === "string" && v ? v : null;
}

function storedTokenKeys(host) {
  if (STORED_KEYS_BY_HOST[host]) return STORED_KEYS_BY_HOST[host];
  if (!host) return null;
  const k = hostKey(host);
  return [`${k}_TOKEN`, `forge.${host}.token`];
}

async function cliToken(host, shell) {
  if (host !== GITHUB_CLI_HOST) return null;
  try {
    const { stdout } = await shell("gh auth token");
    const token = (stdout ?? "").trim();
    return token ? token : null;
  } catch {
    // `gh auth token` exits non-zero when not authenticated (or gh is missing).
    return null;
  }
}

// glab (GitLab's CLI) has no `glab auth token` command; its credential lives in
// a config file. Locate + parse the token for `host` without a YAML dependency:
// find the `hosts:` block, then the entry whose host line equals `host`, then
// the `token:` line indented under it. Tokens are read-only on the box — the
// LADDER guard in resolveToken never lets one cross RPC. Injectable `readFile`
// + `home` for tests.
export async function gitlabCliToken(
  host,
  { readFile = fsReadFile, home = homedir() } = {},
) {
  if (host !== GITLAB_CLI_HOST) return null;
  const paths = [
    join(home, ".config", "glab-cli", "config.yml"),
    join(home, ".config", "glab-cli", "config.yaml"),
  ];
  let text = "";
  for (const p of paths) {
    try {
      text = await readFile(p, "utf-8");
      break;
    } catch {
      /* try the next candidate */
    }
  }
  return parseGlabToken(text, host);
}

// Extract the token for `host` from raw glab config text. Pure + tested.
export function parseGlabToken(text, host) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  const hostsIdx = lines.findIndex((l) => /^\s*hosts\s*:\s*$/.test(l));
  if (hostsIdx === -1) return null;
  let inHostEntry = false;
  let entryIndent = null;
  for (let i = hostsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (inHostEntry && indent <= entryIndent) {
      // left the host entry (a sibling key outside `hosts:` or a new host)
      inHostEntry = false;
    }
    if (!inHostEntry) {
      const hostMatch = /^(\s*)(\S+)\s*:\s*$/.exec(line);
      if (hostMatch && hostMatch[2] === host) {
        inHostEntry = true;
        entryIndent = hostMatch[1].length;
        continue;
      }
      if (/^\s*\S+\s*:/.test(line) && /^\s*hosts\b/.test(line) === false) {
        // an unrelated top-level key — nothing more inside hosts
      }
      continue;
    }
    const tokenMatch = /^(\s*)token\s*:\s*["']?([^\s"']+)["']?\s*$/.exec(line);
    if (tokenMatch && tokenMatch[1].length > entryIndent) {
      return tokenMatch[2];
    }
  }
  return null;
}

function storedToken(host, loadSecretsFn) {
  const keys = storedTokenKeys(host);
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
  { shell = runLoginShell, loadSecretsFn = loadSecrets, env = process.env, now = Date.now, readFile, home } = {},
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

  const cli =
    host === GITHUB_CLI_HOST
      ? await cliToken(host, shell)
      : await gitlabCliToken(host, { readFile, home });
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
 * Rotate a GitLab OAuth token pair, persisting the NEW pair BEFORE the old is
 * used again.
 *
 * The trap this exists for (BET-799 §Auth): GitLab rotates the refresh token on
 * EVERY use, invalidating both old tokens. If a crash happens mid-refresh with
 * the old pair already discarded, the rotation is unrecoverable. So the order is
 * fixed and caller-enforced: `persistPair(newPair)` runs and settles BEFORE the
 * caller makes any further authenticated request with the new access token.
 *
 * `refresh` is injected (network), `persistPair` is injectable (atomic secrets
 * write). Returns the new pair on success; a failed persist propagates so the
 * caller aborts rather than continue on a half-written pair.
 *
 * @param {() => Promise<{ access_token: string, refresh_token: string }>} refresh
 * @param {(pair: { access_token: string, refresh_token: string }) => Promise<void>} persistPair
 * @returns {Promise<{ access_token: string, refresh_token: string }>}
 */
export async function rotateOauthPair(refresh, persistPair) {
  const next = await refresh();
  await persistPair(next);
  return next;
}

/**
 * Drop the cached resolution for a host so the next resolveToken re-reads the
 * CLI/secret — use after the user rotates a token or connects a fresh gh auth.
 * @param {string} host
 */
export function invalidateToken(host) {
  CACHE.delete(host);
}

// ===========================================================================
// §7.4 case C — the device grant (BET-796): step 3 of the ladder, INTERACTIVE
// ===========================================================================
//
// resolveToken above is the passive ladder (env → CLI → stored secret). A
// freshly provisioned box has none of those, so the UI runs an explicit device
// flow (the "Connect GitHub" screen): POST /login/device/code, the user signs
// in on github.com/login/device and enters the user_code, and we poll
// /login/oauth/access_token until it yields a token. That token is stored in
// the existing secrets vault under `GITHUB_TOKEN` (shared scope) — the same key
// resolveToken's step 2 already checks — so every subsequent boot picks it up
// with no re-auth. No new credential store, no GitHub App, no client secret:
// the device grant authenticates with only a PUBLIC client_id.
//
// Spec rules, all mandatory:
//   1. `device_code` is an internal identifier and NEVER crosses RPC or reaches
//      the renderer — only `user_code`, the verification URI and poll metadata
//      are returned. The server keeps the device_code box-side, keyed by an
//      opaque grant id.
//   2. `user_code` is NOT baked into the verification URL (no query string) —
//      that would lengthen what the user types and remove our ability to
//      highlight a typo.
//   3. `slow_down` trusts GitHub's authoritative `interval` when present and
//      falls back to +5s (GitHub's own directive); `authorization_pending`
//      keeps polling; `expired_token` is a typed ExpiredCodeError ([E2]).
//   4. normalizeUserCode strips dashes/whitespace and uppercases before any
//      comparison, so `wdjb-mjht ` matches `WDJBMJHT`.
//   5. The code is copied to the clipboard automatically (the renderer does
//      this on receipt) so the user pastes rather than retypes on a phone.

// The public OAuth client_id for the device grant. The device flow needs NO
// secret — a client_id is public; the mechanics below are client-id-agnostic
// and fully injectable. This is the real Manta product id (BET-849) — verified
// accepted by `github.com/login/device/code` — so the flow runs for real users.
export const DEVICE_CLIENT_ID = "Ov23liJP5kpodIqrcc3F";

// A placeholder id has NEVER been registered with GitHub, so a start against it
// would categorically dead-end at /login/device/code. The flow is GUARDED: a
// placeholder (or empty) id raises DeviceFlowNotConfiguredError before any
// GitHub call, which forgeDeviceStart surfaces to the renderer as a clear
// "GitHub sign-in isn't configured on this box yet" state — a real user is
// never sent down a screen that cannot succeed.
export const DEVICE_CLIENT_ID_PLACEHOLDER = "Iv1.0000000000000000";

/**
 * Raised when the device grant is attempted with a not-yet-configured
 * `client_id`. Distinct from a network/HTTP failure so the caller can surface a
 * configuration state rather than a retryable error ([E2] is an *expired code*,
 * not a *not configured* box).
 */
export class DeviceFlowNotConfiguredError extends Error {
  constructor() {
    super("The GitHub device flow is not configured on this box yet.");
    this.name = "DeviceFlowNotConfiguredError";
  }
}

// GitHub's own device-code TTL (15 min) — the existing provider poll caps at 5
// min, but the device grant is GitHub's clock, not opencode's.
const DEVICE_TTL_MS = 15 * 60_000;

// grantId -> { deviceCode, expiresAt, intervalSec }
const ACTIVE_GRANTS = new Map();

function genGrantId() {
  return randomBytes(8).toString("hex");
}

/**
 * Normalise a user code for comparison: strip all separators/whitespace and
 * uppercase, so `wdjb-mjht ` → `WDJBMJHT`. The GitHub device code is case- and
 * dash-insensitive; comparing raw input would wrongly reject valid pastes.
 * @param {string} code
 * @returns {string}
 */
export function normalizeUserCode(code) {
  return String(code ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Typed signal for `expired_token` (spec rule 3) → the [E2] screen.
 */
export class ExpiredCodeError extends Error {
  constructor() {
    super("The sign-in code expired before it was entered.");
    this.name = "ExpiredCodeError";
  }
}

async function defaultStoreToken(token) {
  return setSecret({ key: "GITHUB_TOKEN", value: token, scope: "shared" });
}

/**
 * Start a GitHub device grant. Returns a RENDERER-SAFE shape — `device_code`
 * is intentionally absent (rule 1); the server keeps it box-side under the
 * returned `grantId` so the renderer can never leak it.
 *
 * @param {{ clientId?: string, fetch?: typeof fetch, now?: () => number, storeToken?: (token: string) => Promise<{ ok: boolean, error?: string }> }} [opts]
 * @returns {Promise<{ grantId: string, userCode: string, verificationUri: string, expiresIn: number, pollInterval: number }>}
 */
export async function startDeviceGrant({
  clientId = DEVICE_CLIENT_ID,
  fetch: fetchFn = globalThis.fetch,
  now = Date.now,
} = {}) {
  // Guard: a placeholder/unset public id would dead-end at GitHub — fail fast
  // with a typed "not configured" signal, never hit the network.
  if (!clientId || clientId === DEVICE_CLIENT_ID_PLACEHOLDER) {
    throw new DeviceFlowNotConfiguredError();
  }
  const res = await fetchFn("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
  });
  if (!res.ok) {
    throw new Error(`couldn't start the GitHub device grant (${res.status})`);
  }
  const raw = await res.json();
  if (!raw.device_code || !raw.user_code) {
    throw new Error("unexpected device-code response from GitHub");
  }
  const grantId = genGrantId();
  const intervalSec = Math.max(Number(raw.interval) || 5, 5);
  ACTIVE_GRANTS.set(grantId, {
    deviceCode: raw.device_code,
    expiresAt: now() + DEVICE_TTL_MS,
    intervalSec,
  });
  return {
    grantId,
    userCode: raw.user_code,
    verificationUri: raw.verification_uri,
    expiresIn: Number(raw.expires_in) || 900,
    pollInterval: intervalSec,
  };
}

/**
 * Cancel an in-flight device grant (the [S5] Cancel button). Safe to call for
 * an unknown/already-finished grant — no-op. Returns void.
 * @param {string} grantId
 */
export function cancelDeviceGrant(grantId) {
  ACTIVE_GRANTS.delete(grantId);
}

/**
 * Poll an in-flight device grant for its token. On success the token is stored
 * in the secrets vault under `GITHUB_TOKEN` (shared scope) via storeToken and
 * the ladder's resolution cache is invalidated so the stored secret is picked
 * up next boot. `authorization_pending` returns `{ status: "pending" }`;
 * `slow_down` trusts GitHub's authoritative `interval` (falling back to +5s
 * when it's absent/invalid); `expired_token` throws ExpiredCodeError ([E2]).
 *
 * @param {string} grantId
 * @param {{ clientId?: string, fetch?: typeof fetch, now?: () => number, storeToken?: (token: string) => Promise<{ ok: boolean, error?: string }> }} [opts]
 * @returns {Promise<{ status: "pending" | "done", pollInterval?: number }>}
 */
export async function pollDeviceGrant(
  grantId,
  { clientId = DEVICE_CLIENT_ID, fetch: fetchFn = globalThis.fetch, now = Date.now, storeToken = defaultStoreToken } = {},
) {
  const grant = ACTIVE_GRANTS.get(grantId);
  if (!grant) {
    throw new Error("unknown device grant");
  }
  if (now() >= grant.expiresAt) {
    ACTIVE_GRANTS.delete(grantId);
    throw new ExpiredCodeError();
  }
  const res = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: grant.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  let raw;
  try {
    raw = await res.json();
  } catch {
    throw new Error("unexpected access-token response from GitHub");
  }
  if (raw.error === "authorization_pending") return { status: "pending", pollInterval: grant.intervalSec };
  if (raw.error === "slow_down") {
    const next = Number(raw.interval);
    grant.intervalSec = Number.isFinite(next) && next > 0 ? next : grant.intervalSec + 5;
    return { status: "pending", pollInterval: grant.intervalSec };
  }
  if (raw.error === "expired_token") {
    ACTIVE_GRANTS.delete(grantId);
    throw new ExpiredCodeError();
  }
  if (!raw.access_token) {
    throw new Error(raw.error_description || "device sign-in failed");
  }
  const stored = await storeToken(raw.access_token);
  if (!stored.ok) throw new Error(stored.error || "couldn't store the token");
  ACTIVE_GRANTS.delete(grantId);
  invalidateToken(GITHUB_CLI_HOST);
  return { status: "done" };
}
