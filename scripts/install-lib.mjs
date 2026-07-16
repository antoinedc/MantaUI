// install-lib.mjs — pure, testable helpers for the VPS self-install flow.
//
// The bash entrypoint (scripts/install.sh) and the pairing CLI
// (scripts/manta-pair.mjs) both stay THIN: all the logic that is worth testing —
// resolving the tarball URL / install home, waiting for the server health
// endpoint, formatting the pairing block, and deciding whether an existing box
// identity must be preserved — lives here as small pure functions with injected
// I/O (fetch, clock, sleep, env). No side effects at import time.
//
// Design rules:
//   * The script NEVER generates box_id/box_token — src/server/auth.mjs owns
//     identity (ensureAuth). This module only DETECTS an existing auth.json so
//     a re-run preserves it (idempotency), it never writes one.
//   * Overrides come from the environment: MANTA_TARBALL_URL and MANTA_HOME.
//     Defaults are applied when unset/empty.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_DIRNAME } from "../src/shared/paths.mjs";

// ---------------------------------------------------------------------------
// Constants (single source of truth, shared with the shell via `--print-config`)
// ---------------------------------------------------------------------------

// Loopback health/pairing target. The server binds 127.0.0.1:8787 under the
// systemd unit we install; the installer + `bui pair` only ever talk to it over
// loopback (minting a pairing code is loopback-gated — see auth.mjs).
export const DEFAULT_PORT = 8787;
export const HEALTH_PATH = "/auth/status";

// Default release host. The repo is private; CI publishes a versioned tarball
// the installer downloads (no git clone on the VPS). `MANTA_TARBALL_URL` overrides
// the whole URL for local testing; otherwise we build it from host + version.
export const DEFAULT_RELEASE_HOST = "https://bui.useronda.com";

// Where the box lives once installed. `~/.manta/` (auth.json + config.json)
// is deliberately OUTSIDE this dir so an upgrade that replaces MANTA_HOME never
// touches box identity. `MANTA_HOME` overrides the code location only.
export const DEFAULT_HOME_DIRNAME = "bui";

// Persisted box identity — the file ensureAuth() writes on first server run.
// Its presence is the idempotency signal: "identity already exists, preserve it."
export const AUTH_DIRNAME = STATE_DIRNAME;
export const AUTH_FILENAME = "auth.json";

// ---------------------------------------------------------------------------
// Config resolution (arg/env parsing)
// ---------------------------------------------------------------------------

// Read a var from an env-like object, treating "" the same as unset so an
// exported-but-empty override falls back to the default (a common shell
// footgun: `MANTA_HOME= curl ... | bash`).
function envVal(env, key) {
  const v = env?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Resolve the effective install config from the environment.
 * Injectable `home` for tests (defaults to os.homedir()).
 *
 * Returns:
 *   buiHome      — where the code is unpacked (MANTA_HOME || ~/bui)
 *   authDir      — ~/.manta (never inside buiHome)
 *   authFile     — ~/.manta/auth.json (idempotency probe target)
 *   tarballUrl   — explicit MANTA_TARBALL_URL, else null (resolved per-version)
 *   releaseHost  — MANTA_RELEASE_HOST || DEFAULT_RELEASE_HOST
 *   port         — MANTA_MOBILE_PORT || DEFAULT_PORT
 *   healthUrl    — http://127.0.0.1:<port>/auth/status
 */
export function resolveConfig({ env = process.env, home = homedir() } = {}) {
  const buiHome = envVal(env, "MANTA_HOME") ?? join(home, DEFAULT_HOME_DIRNAME);
  const authDir = join(home, AUTH_DIRNAME);
  const authFile = join(authDir, AUTH_FILENAME);
  const tarballUrl = envVal(env, "MANTA_TARBALL_URL") ?? null;
  const releaseHost = stripTrailingSlash(
    envVal(env, "MANTA_RELEASE_HOST") ?? DEFAULT_RELEASE_HOST,
  );
  const port = parsePort(envVal(env, "MANTA_MOBILE_PORT")) ?? DEFAULT_PORT;
  return {
    buiHome,
    authDir,
    authFile,
    tarballUrl,
    releaseHost,
    port,
    healthUrl: `http://127.0.0.1:${port}${HEALTH_PATH}`,
  };
}

function stripTrailingSlash(s) {
  return typeof s === "string" ? s.replace(/\/+$/, "") : s;
}

// Accept only a valid TCP port (1-65535); anything else → undefined (fall back).
export function parsePort(value) {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Resolve the tarball download URL.
 *   - If MANTA_TARBALL_URL is set (via resolveConfig → cfg.tarballUrl), use it
 *     verbatim. This is the local-test / mirror override.
 *   - Otherwise build `<releaseHost>/releases/bui-<version>.tar.gz`.
 *
 * `version` must be a plain semver-ish string (no slashes / traversal); we
 * validate it so a bogus package.json version can't smuggle a path.
 */
export function resolveTarballUrl({ tarballUrl, releaseHost, version } = {}) {
  if (typeof tarballUrl === "string" && tarballUrl !== "") return tarballUrl;
  if (!isValidVersion(version)) {
    throw new Error(
      `resolveTarballUrl: invalid version ${JSON.stringify(version)} (expected e.g. "0.0.1")`,
    );
  }
  const host = stripTrailingSlash(releaseHost || DEFAULT_RELEASE_HOST);
  return `${host}/releases/bui-${version}.tar.gz`;
}

// A release version is digits/letters/dots/hyphens only — enough for semver +
// prerelease tags (1.2.3, 1.2.3-rc.1) but no `/` or `..` path escapes.
export function isValidVersion(version) {
  return typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version);
}

// ---------------------------------------------------------------------------
// Idempotency: detect an existing box identity so a re-run preserves it.
// ---------------------------------------------------------------------------

/**
 * Given the resolved config, decide whether the box already has an identity.
 * Injectable `exists` (defaults to fs.existsSync) for tests.
 *
 * Returns { preserveIdentity, authFile, reason }:
 *   preserveIdentity=true  → auth.json present; the server must NOT regenerate
 *                            it and the installer must not delete ~/.manta.
 *   preserveIdentity=false → fresh box; first server start mints identity.
 *
 * This function NEVER writes anything — it only reports. The single source of
 * truth for identity is ensureAuth() in src/server/auth.mjs.
 */
export function checkIdentity(cfg, { exists = existsSync } = {}) {
  const authFile = cfg?.authFile;
  if (typeof authFile !== "string" || authFile === "") {
    throw new Error("checkIdentity: cfg.authFile required");
  }
  const present = exists(authFile);
  return {
    preserveIdentity: present,
    authFile,
    reason: present
      ? "existing box identity found — preserving it (server owns identity, never regenerated)"
      : "no existing identity — the server will mint one on first start",
  };
}

// ---------------------------------------------------------------------------
// Health-wait poller
// ---------------------------------------------------------------------------

/**
 * Poll `url` until it returns any HTTP response (server is up), or give up.
 *
 * A *connection refused* (fetch throws) means the server hasn't bound yet →
 * retry. ANY HTTP status (200, 401, 403, ...) means the process is listening,
 * which is all we need before running `bui pair`; /auth/status is gated so it
 * legitimately answers 401 without a token, and that still proves liveness.
 *
 * Deterministic + testable: inject `fetchFn`, `sleep`, and `now`. No real
 * timers when those are provided.
 *
 * @returns { ok:true, attempts } on success, or { ok:false, attempts, error }
 *          after `maxAttempts` exhausted.
 */
export async function waitForHealth(
  url,
  {
    maxAttempts = 60,
    intervalMs = 1000,
    fetchFn = globalThis.fetch,
    sleep = defaultSleep,
  } = {},
) {
  if (typeof url !== "string" || url === "") {
    throw new Error("waitForHealth: url required");
  }
  if (typeof fetchFn !== "function") {
    throw new Error("waitForHealth: no fetch available (pass fetchFn)");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchFn(url);
      // Any HTTP answer means the socket is bound and serving.
      if (res && typeof res.status === "number") {
        return { ok: true, attempts: attempt, status: res.status };
      }
      lastError = new Error("fetch returned no status");
    } catch (e) {
      lastError = e;
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  return {
    ok: false,
    attempts: maxAttempts,
    error: `server did not become healthy at ${url} after ${maxAttempts} attempts: ${
      lastError?.message ?? lastError ?? "unknown"
    }`,
  };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Pairing-output formatter
// ---------------------------------------------------------------------------

/**
 * Format the human-facing pairing block printed at the end of install (and by
 * `bui pair`). Given the server's { pairing_code, box_id, expiresAt } response,
 * produce a stable, greppable multi-line string.
 *
 * `serverUrl` is the address the DESKTOP should point at (the box's public
 * ingress the user set up — tailscale/reverse-proxy/cloudflared). We can't know
 * it, so it's passed in (or omitted, in which case we print a hint line).
 */
export function formatPairingOutput({ pairing_code, box_id, expiresAt, serverUrl } = {}) {
  if (!/^[0-9]{6}$/.test(String(pairing_code ?? ""))) {
    throw new Error("formatPairingOutput: pairing_code must be 6 digits");
  }
  const lines = [];
  lines.push("");
  lines.push("  ✓ bui server is running.");
  lines.push("");
  lines.push(`  Pairing code:  ${pairing_code}`);
  if (expiresAt != null) {
    lines.push(`  Expires:       ${formatExpiry(expiresAt)}`);
  }
  if (box_id) {
    lines.push(`  Box ID:        ${box_id}`);
  }
  lines.push("");
  if (serverUrl) {
    lines.push(`  Server URL:    ${serverUrl}`);
    lines.push("");
  } else {
    lines.push("  Expose this box to your phone/desktop (pick one):");
    lines.push("    • Tailscale / VPN  → use the box's tailnet address");
    lines.push("    • Reverse proxy    → point it at 127.0.0.1:8787");
    lines.push("    • cloudflared      → see docs (the operated relay replaces this later)");
    lines.push("");
  }
  lines.push("  → Enter the pairing code in the bui desktop app to connect.");
  lines.push("");
  return lines.join("\n");
}

// Render an expiry as an ISO-ish local timestamp. Accepts an epoch-ms number
// (what auth.mjs returns) or an ISO string; falls back to the raw value.
export function formatExpiry(expiresAt) {
  let ms = null;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    ms = expiresAt;
  } else if (typeof expiresAt === "string" && expiresAt !== "") {
    const parsed = Date.parse(expiresAt);
    if (!Number.isNaN(parsed)) ms = parsed;
    else return expiresAt;
  }
  if (ms == null) return String(expiresAt ?? "");
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(expiresAt);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// ---------------------------------------------------------------------------
// Shell bridge — keeps install.sh thin by resolving config here.
// ---------------------------------------------------------------------------
//
// install.sh calls:
//   eval "$(node scripts/install-lib.mjs print-config --version <v>)"
// which sets MANTA_HOME / MANTA_AUTH_FILE / MANTA_TARBALL_URL / MANTA_PORT in the shell,
// and:
//   node scripts/install-lib.mjs check-identity
// which prints "preserve" or "fresh" (exit 0) so the shell knows whether to
// keep ~/.manta untouched.

// Emit KEY=VALUE lines the shell can `eval`. Values are single-quoted so paths
// with spaces survive; embedded single quotes are escaped the POSIX way.
export function renderShellConfig(cfg, { version } = {}) {
  const tarball = resolveTarballUrl({
    tarballUrl: cfg.tarballUrl,
    releaseHost: cfg.releaseHost,
    version,
  });
  const kv = {
    MANTA_HOME: cfg.buiHome,
    MANTA_AUTH_DIR: cfg.authDir,
    MANTA_AUTH_FILE: cfg.authFile,
    MANTA_TARBALL_URL: tarball,
    MANTA_PORT: String(cfg.port),
    MANTA_HEALTH_URL: cfg.healthUrl,
  };
  return Object.entries(kv)
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`)
    .join("\n");
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// CLI entrypoint — only runs when executed directly, never on import.
async function cliMain(argv) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  if (cmd === "print-config") {
    const cfg = resolveConfig();
    process.stdout.write(renderShellConfig(cfg, { version: flags.version }) + "\n");
    return 0;
  }
  if (cmd === "check-identity") {
    const cfg = resolveConfig();
    const { preserveIdentity, reason } = checkIdentity(cfg);
    process.stdout.write((preserveIdentity ? "preserve" : "fresh") + "\n");
    process.stderr.write(reason + "\n");
    return 0;
  }
  if (cmd === "tarball-url") {
    const cfg = resolveConfig();
    process.stdout.write(
      resolveTarballUrl({
        tarballUrl: cfg.tarballUrl,
        releaseHost: cfg.releaseHost,
        version: flags.version,
      }) + "\n",
    );
    return 0;
  }
  process.stderr.write(
    `install-lib: unknown command ${JSON.stringify(cmd)}\n` +
      "  usage: node install-lib.mjs <print-config|check-identity|tarball-url> [--version X]\n",
  );
  return 2;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version") {
      out.version = args[++i];
    }
  }
  return out;
}

// Run the CLI only when invoked as `node install-lib.mjs …`, not on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cliMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
