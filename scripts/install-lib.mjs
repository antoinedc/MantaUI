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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { STATE_DIRNAME } from "../src/shared/paths.mjs";
import { loadAuth } from "../src/server/auth.mjs";

// `qrcode-terminal` is CommonJS; we keep this module ESM. The local
// `createRequire` shim is sync (no top-level await) and resolves the lib
// lazily — only when `defaultQrRender` actually paints a QR (which is never
// in the cold-install path that uses only the text-only formatPairingOutput
// callers below).
const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants (single source of truth, shared with the shell via `--print-config`)
// ---------------------------------------------------------------------------

// Loopback health/pairing target. The server binds 127.0.0.1:8787 under the
// systemd unit we install; the installer + `manta pair` only ever talk to it over
// loopback (minting a pairing code is loopback-gated — see auth.mjs).
export const DEFAULT_PORT = 8787;
export const HEALTH_PATH = "/auth/status";

// Default release host. The repo is private; CI publishes a versioned tarball
// + a manifest file the installer downloads (no git clone on the VPS).
// `MANTA_TARBALL_URL` overrides the whole flow (skips manifest fetch + sha256)
// for local testing.
export const DEFAULT_RELEASE_HOST = "https://mantaui.com";

// Where the box lives once installed. `~/.manta/` (auth.json + config.json)
// is deliberately OUTSIDE this dir so an upgrade that replaces MANTA_HOME never
// touches box identity. `MANTA_HOME` overrides the code location only.
export const DEFAULT_HOME_DIRNAME = "manta";

// Download links printed in the pairing block. IOS_APP_URL is a placeholder
// until the App Store listing is live — update it there, nowhere else.
export const DESKTOP_DMG_URL = "https://mantaui.com/downloads/Manta-latest.dmg";
export const IOS_APP_URL = "https://mantaui.com";

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
 *   mantaHome      — where the code is unpacked (MANTA_HOME || ~/manta)
 *   authDir      — ~/.manta (never inside mantaHome)
 *   authFile     — ~/.manta/auth.json (idempotency probe target)
 *   tarballUrl   — explicit MANTA_TARBALL_URL, else null (overrides manifest fetch)
 *   releaseHost  — MANTA_RELEASE_HOST || DEFAULT_RELEASE_HOST
 *   port         — MANTA_MOBILE_PORT || DEFAULT_PORT
 *   healthUrl    — http://127.0.0.1:<port>/auth/status
 */
export function resolveConfig({ env = process.env, home = homedir() } = {}) {
  const mantaHome = envVal(env, "MANTA_HOME") ?? join(home, DEFAULT_HOME_DIRNAME);
  const authDir = join(home, AUTH_DIRNAME);
  const authFile = join(authDir, AUTH_FILENAME);
  const tarballUrl = envVal(env, "MANTA_TARBALL_URL") ?? null;
  const releaseHost = stripTrailingSlash(
    envVal(env, "MANTA_RELEASE_HOST") ?? DEFAULT_RELEASE_HOST,
  );
  const port = parsePort(envVal(env, "MANTA_MOBILE_PORT")) ?? DEFAULT_PORT;
  return {
    mantaHome,
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
 * (removed: resolveTarballUrl + isValidVersion — install.sh now derives the
 * URL from the manifest, not from version. The `tarball-url` CLI subcommand
 * was the only other caller; it's gone too.)
 */

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
 * which is all we need before running `manta pair`; /auth/status is gated so it
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
    acceptAnyStatus = true,
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
        if (acceptAnyStatus) {
          return { ok: true, attempts: attempt, status: res.status };
        }
        if (res.status >= 200 && res.status < 400) {
          return { ok: true, attempts: attempt, status: res.status };
        }
        lastError = new Error(`non-2xx status ${res.status}`);
      } else {
        lastError = new Error("fetch returned no status");
      }
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
// opencode.jsonc merge — pure, used by install.sh step C (BET-153)
// ---------------------------------------------------------------------------
//
// opencode.jsonc allows `//` line comments and trailing commas (JSONC). The
// plugin we seed lives in the top-level `plugin: string[]`. We MERGE — never
// clobber — so any other config the user has set (theme, model, mcp, …) is
// preserved across re-installs.
//
// Behavior:
//   * Strip `//` line comments (respecting strings — "//" inside a quoted
//     value must survive).
//   * JSON.parse the remainder. On parse failure → caller backs the file up
//     to `.pre-manta` and starts from `{}` (matches the documented
//     skills.urls merge pattern in src/server/local.mjs).
//   * Append `opencode-claude-auth@latest` to the `plugin` array IF not
//     already present (any version — re-installs are no-ops).
//   * Serialize with 2-space indent + trailing newline.
//
// Pure: no fs/network/sleep. Returns { text, corrupt }. `corrupt` is true
// only when the input text was non-empty but unparseable; an empty input
// is treated as `{}` (first install) and is not "corrupt".

// Strip `//` line comments without eating `//` inside strings. Pure, single-
// pass; matches the behavior of providers.mjs's stripLineComments (same rule,
// kept independent so the install lib has zero dependency on the server
// modules — install.sh runs even before the tarball is unpacked).
export function stripJsoncLineComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = true;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    out += c;
  }
  return out;
}

// Plugin we seed into every opencode.jsonc. The `@latest` is the official
// installer's version tag — we use the official opencode plugin registry
// (no version pinning in v1; the install is the source of truth for what
// version is "current").
export const OPENCODE_CLAUDE_AUTH_PLUGIN = "opencode-claude-auth@latest";

/**
 * Merge `opencode-claude-auth@latest` into the top-level `plugin` array of an
 * existing opencode.jsonc. Pure: receives raw text, returns raw text.
 *
 * @param {string} existingText  Raw file contents (possibly empty, possibly
 *                               containing JSONC `//` comments).
 * @returns {{ text: string, corrupt: boolean, plugin: string[] }}
 *   - text    — the new file contents (always well-formed JSON, 2-space
 *               indent, trailing newline). The caller writes this to disk.
 *   - corrupt — true iff the input was non-empty AND failed to parse.
 *               Caller decides whether to back the original up to
 *               `.pre-manta` before overwriting. An empty input is treated
 *               as `{}` and is NOT corrupt (first install).
 *   - plugin  — the post-merge plugin array (handy for tests + the summary
 *               log in install.sh).
 */
export function mergeOpencodeConfig(existingText) {
  const raw = typeof existingText === "string" ? existingText : "";
  const stripped = stripJsoncLineComments(raw).trim();
  let cfg = {};
  let corrupt = false;
  if (stripped.length > 0) {
    try {
      cfg = JSON.parse(stripped);
      if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
        cfg = {};
        corrupt = true;
      }
    } catch {
      cfg = {};
      corrupt = true;
    }
  }
  // Deep-merge ONLY the `plugin` key. Every other key is spread through
  // untouched (theme, model, mcp, provider, …).
  const plugins = Array.isArray(cfg.plugin) ? cfg.plugin.filter((p) => typeof p === "string") : [];
  if (!plugins.includes(OPENCODE_CLAUDE_AUTH_PLUGIN)) {
    plugins.push(OPENCODE_CLAUDE_AUTH_PLUGIN);
  }
  const next = { ...cfg, plugin: plugins };
  const text = JSON.stringify(next, null, 2) + "\n";
  return { text, corrupt, plugin: plugins };
}

// ---------------------------------------------------------------------------
// Gateway-auth merge — pure, used by install.sh's gateway-registration step
// (BET-205 WP5). The gateway returns { gateway_token, gateway_host } (first
// registration) or just { gateway_host } (subsequent registration when the
// IP refreshed). We MERGE both into the existing ~/.manta/auth.json —
// preserving box_id, box_token, created_at — so auth.mjs's loadAuth()
// still validates the file shape, and so the gateway identity is
// atomic with the box identity (one file, one 0600 permission).
//
// Behavior (mirrors mergeOpencodeConfig's safety contract):
//   * missing/empty text → seeds {gateway_token, gateway_host} alongside a
//     freshly-created box. In practice the server's ensureAuth() runs first
//     (the install waits for health after enabling the server unit), so
//     this branch is the fresh-install safety net.
//   * valid JSON object → MERGES in gateway_token + gateway_host (preserving
//     box_id/box_token/created_at/any other keys), pretty-prints.
//   * unparseable text or non-object JSON → { ok:false, error }, NO text.
//     Same policy as mergeRelayDisabled: never silently overwrite a file
//     we couldn't parse. The CLI subcommand that calls this returns the
//     error so install.sh can warn + skip (we never block the install on
//     a corrupt auth.json — that's the server's problem to surface).
//
// Returns { ok: true, text, changed } | { ok: false, error }.
//   changed=true iff any of gateway_token / gateway_host actually differed
//   from what's already on disk (so a re-registration with the same values
//   is byte-identical → no needless atomic write).
export function mergeGatewayAuth(
  existingText,
  { gateway_token = null, gateway_host = null } = {},
) {
  const hasToken = typeof gateway_token === "string";
  const hasHost = typeof gateway_host === "string";
  if (!hasToken && !hasHost) {
    // Caller provided neither — refuse the write so we don't waste an
    // atomic temp-rename round-trip on a no-op. (The CLI handler also
    // short-circuits, but defending in the pure function means the
    // `mergeGatewayAuth` invariant is testable on its own.)
    return {
      ok: false,
      error: "mergeGatewayAuth: at least one of gateway_token / gateway_host must be a non-empty string",
    };
  }
  const raw = typeof existingText === "string" ? existingText : "";
  const trimmed = raw.trim();
  let cfg;
  if (trimmed.length === 0) {
    // Fresh box with no auth.json yet — seed with ONLY the gateway fields.
    // The server's ensureAuth() will fill box_id/box_token/created_at on
    // its first health check; we don't try to guess those here.
    cfg = {};
  } else {
    try {
      cfg = JSON.parse(trimmed);
    } catch (e) {
      return { ok: false, error: `auth.json is not valid JSON: ${e?.message ?? e}` };
    }
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
      return { ok: false, error: "auth.json must be a JSON object (got non-object root)" };
    }
  }
  let changed = false;
  const next = { ...cfg };
  if (typeof gateway_token === "string" && next.gateway_token !== gateway_token) {
    next.gateway_token = gateway_token;
    changed = true;
  }
  if (typeof gateway_host === "string" && next.gateway_host !== gateway_host) {
    next.gateway_host = gateway_host;
    changed = true;
  }
  return { ok: true, text: JSON.stringify(next, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// DNS-resolution poller — pure, used by install.sh after gateway registration
// (BET-205 WP5). Once the box has registered with the gateway, OVH needs a
// few seconds to publish the new A record (<box_id>.boxes.mantaui.com). We
// poll until the box's hostname resolves to its own public IP, or give up
// after `maxAttempts` × `intervalMs`.
//
// The default `lookup` uses node:dns so we don't depend on `dig` being
// installed on the VPS (some minimal images skip it). The function is fully
// injectable — tests pass a fake lookupFn to exercise the
// "resolves immediately" and "never resolves" cases without real DNS.
//
// @param {string} hostname       e.g. "0123...cdef.boxes.mantaui.com"
// @param {string} expectedIp     the box's public IP (no CIDR, no port)
// @returns { ok: true, attempts, address } on success
//        | { ok: false, attempts, error }   on give-up
export async function waitForDns(
  hostname,
  expectedIp,
  {
    maxAttempts = 30,
    intervalMs = 10_000,
    lookup = defaultLookup,
    sleep = defaultSleep,
  } = {},
) {
  if (typeof hostname !== "string" || hostname === "") {
    throw new Error("waitForDns: hostname required");
  }
  if (typeof expectedIp !== "string" || expectedIp === "") {
    throw new Error("waitForDns: expectedIp required");
  }
  if (typeof lookup !== "function") {
    throw new Error("waitForDns: lookup must be a function");
  }
  let lastError = null;
  let lastResolved = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const addresses = await lookup(hostname);
      // node:dns.lookup returns either a string (single) or an array of
      // strings; normalize so callers can pass either.
      const list = Array.isArray(addresses) ? addresses : [addresses];
      lastResolved = list;
      if (list.includes(expectedIp)) {
        return { ok: true, attempts: attempt, address: expectedIp };
      }
      lastError = new Error(
        `resolved to ${list.join(", ")} (expected ${expectedIp})`,
      );
    } catch (e) {
      lastError = e;
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  const detail =
    lastError?.message ?? (lastResolved ? `resolved to ${lastResolved.join(", ")}` : "no answer");
  return {
    ok: false,
    attempts: maxAttempts,
    error: `${hostname} did not resolve to ${expectedIp} after ${maxAttempts} attempts (${Math.round((maxAttempts * intervalMs) / 1000)}s): ${detail}`,
  };
}

async function defaultLookup(hostname) {
  const dns = await import("node:dns/promises");
  return dns.lookup(hostname, { all: true, family: 4 }).then((records) =>
    records.map((r) => r.address),
  );
}

// ---------------------------------------------------------------------------
// Caddy vhost renderer — pure, used by install.sh after DNS resolves
// (BET-205 WP5). Two output shapes:
//
//   * "snippet" — the Caddyfile fragment to write to /etc/caddy/Caddyfile.d/
//     (Debian/Ubuntu's official caddy apt repo ships /etc/caddy/Caddyfile
//     which `import /etc/caddy/Caddyfile.d/*.caddy` — see #snippet-mode).
//
//   * "inline"  — the full vhost block to append to a Caddyfile when the
//     distro Caddy has no conf.d (e.g. custom installs). Wrapped in a
//     `# >>> manta >>>` / `# <<< manta <<<` marker pair so re-runs can find
//     and replace the block atomically.
//
// Idempotency: both shapes serialize the box_id + port verbatim; a re-run
// with the same inputs produces byte-identical output (the install.sh
// overwrite pattern + marker detection rely on this).
export function renderCaddyVhost(
  boxId,
  port,
  { mode = "snippet" } = {},
) {
  if (typeof boxId !== "string" || !/^[0-9a-f]{32}$/.test(boxId)) {
    throw new Error("renderCaddyVhost: boxId must be 32 lowercase hex");
  }
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error("renderCaddyVhost: port must be a valid TCP port (1-65535)");
  }
  if (mode !== "snippet" && mode !== "inline") {
    throw new Error(`renderCaddyVhost: mode must be "snippet" or "inline" (got ${JSON.stringify(mode)})`);
  }
  if (mode === "snippet") {
    return [
      `${boxId}.boxes.mantaui.com {`,
      `    reverse_proxy 127.0.0.1:${n}`,
      `}`,
      ``,
    ].join("\n");
  }
  // inline mode — same body, bracketed by markers so a re-run can find + replace
  // the block atomically instead of appending duplicate vhosts.
  return [
    `# >>> manta >>>`,
    `${boxId}.boxes.mantaui.com {`,
    `    reverse_proxy 127.0.0.1:${n}`,
    `}`,
    `# <<< manta <<<`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /etc/os-release parser + Debian/Ubuntu classifier — pure, used by
// install.sh's privileged-section gate (BET-205 reviewer guidance §4).
//
// /etc/os-release is a shell-source-style file (KEY="VALUE" or KEY=VALUE
// lines, optionally quoted). We extract just the two fields install.sh
// needs: `ID` (the canonical distro id, e.g. "ubuntu" / "debian") and
// `ID_LIKE` (a space-separated list of "this distro is derived from X"
// hints — Debian derivatives like Linux Mint or Raspbian put `debian`
// here). Everything else is ignored.
//
// Why not just `source /etc/os-release` in bash? The parser is small,
// pure, and unit-testable in isolation; install.sh stays a thin
// orchestrator that just consumes the result.
//
// Path injectable for tests; default `/etc/os-release` matches the
// systemd convention. Returns `null` if the file is missing or
// unparseable (caller decides what to do — install.sh warns + skips
// the privileged section).
export function readOsReleaseIds({ path = "/etc/os-release" } = {}) {
  let content;
  try {
    if (!existsSync(path)) return null;
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  // Match `ID=VALUE` or `ID="VALUE"` (same for ID_LIKE). os-release
  // values never contain newlines; quotes are allowed around any value.
  const result = { id: null, idLike: null };
  for (const line of content.split("\n")) {
    const m = line.match(/^(ID|ID_LIKE)=("?)([^"\n]+)\2$/);
    if (!m) continue;
    if (m[1] === "ID") result.id = m[3];
    else result.idLike = m[3]; // space-separated when quoted
  }
  if (result.id === null && result.idLike === null) return null;
  return result;
}

/**
 * Is this /etc/os-release info a Debian/Ubuntu-family distro? The
 * privileged Caddy + gateway + DNS section of install.sh is v1-
 * scoped to Debian/Ubuntu because the apt-repo install path is the
 * only one we test against. On other distros we bail with a clear
 * message + bring-your-own-proxy hint instead of half-installing.
 *
 * Truth table:
 *   info?.id  in {debian, ubuntu} → true
 *   info?.idLike contains "debian" → true (catches Linux Mint, Raspbian, etc.)
 *   otherwise → false (incl. null / non-object / empty)
 *
 * Return shape: { debianLike: boolean, id: string|null, idLike: string|null }
 * — the booleans + raw ids so install.sh can log "detected: <id>"
 * alongside "supported: debian/ubuntu" without re-parsing.
 */
export function classifyDistro(info) {
  const id = info?.id ?? null;
  const idLike = info?.idLike ?? null;
  let debianLike = false;
  if (id === "debian" || id === "ubuntu") debianLike = true;
  else if (typeof idLike === "string" && /\bdebian\b/.test(idLike)) debianLike = true;
  return { debianLike, id, idLike };
}

// ---------------------------------------------------------------------------
// Systemd unit placeholder substitution — pure, used by install.sh steps E
// and the existing manta-server step (BET-153).
// ---------------------------------------------------------------------------
//
// Mirrors what `sed -e 's|@@K@@|V|g' …` does in the shell, but as a pure
// function so the substitution is unit-testable (the "no @@ left after sed"
// hygiene check) and install.sh stays a thin orchestrator.
//
// `placeholders` is a plain { KEY: value } map. Each @@KEY@@ in `template`
// is replaced verbatim — values are NOT shell-quoted, because systemd unit
// files don't need quoting and a value with a `|` would otherwise confuse
// sed. Callers must keep values simple (paths + ports — no special chars).
export function renderSystemdUnit(template, placeholders) {
  if (typeof template !== "string") {
    throw new Error("renderSystemdUnit: template must be a string");
  }
  if (!placeholders || typeof placeholders !== "object") {
    throw new Error("renderSystemdUnit: placeholders object required");
  }
  let out = template;
  for (const [key, value] of Object.entries(placeholders)) {
    const token = `@@${key}@@`;
    // String.replaceAll keeps the semantics obvious; for-loop above ensures
    // we visit every key. Guard against values containing the token (would
    // re-substitute on the next iteration).
    const v = String(value);
    if (v.includes(token)) {
      throw new Error(`renderSystemdUnit: placeholder value for ${key} contains the token ${token}`);
    }
    out = out.split(token).join(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Box-identity loader (BET-151 / BET-155)
// ---------------------------------------------------------------------------
//
// Thin re-export of `loadAuth` from src/server/auth.mjs so install.sh can print
// the box_id alongside the pairing code without re-parsing JSON in bash. The
// server (src/server/auth.mjs) is the single source of truth for identity
// shape and validation; install.sh never writes here and never invents its
// own token reader.
//
// Returns `{ box_id, box_token, created_at }` on success, or `null` if the
// file is missing/corrupt (the box will mint a fresh identity on first
// start, so an absent auth.json at install time is not an error — install.sh
// falls back to "the server will mint an identity on first start").
export const readBoxIdentity = loadAuth;

// ---------------------------------------------------------------------------
// Pairing-output formatter
// ---------------------------------------------------------------------------

/**
 * Format the human-facing pairing block printed at the end of install (and by
 * `manta pair`). Given the server's { pairing_code, box_id, expiresAt } response,
 * produce a stable, greppable multi-line string.
 *
 * `serverUrl` is the address the DESKTOP should point at (the box's public
 * ingress the user set up — tailscale/reverse-proxy/cloudflared). We can't know
 * it, so it's passed in (or omitted, in which case we print a hint line).
 *
 * The output is the single connect block both install.sh and `manta pair`
 * print — install.sh captures it once and emits it LAST so the user sees it
 * at rest; `manta pair` prints the same block on every re-mint (intentional:
 * it always surfaces the download links + the iOS hint).
 *
 * The 6-digit code validation throw, the injected `qrRender` (with its
 * try/catch degradation), and the per-row QR indenting loop are all kept
 * intact — only the assembled line list changes.
 *
 * BET-177 §2.4: the pair link `manta://pair?box=<id>&code=<code>` is
 * always included in the output (when a box_id + a valid 6-digit code are
 * present) as BOTH a copy-paste line AND a terminal-rendered QR. The QR is
 * for the user who wants to scan with the iOS Camera instead of pasting the
 * link. The link string is the canonical box-form produced by
 * `buildPairLink` (local helper) — single source of truth, consumed
 * exclusively by this function now (install.sh's heredoc duplicate was
 * retired in BET-241).
 *
 * The QR generator is injected (`qrRender`) so tests can capture the output
 * without pulling in `qrcode-terminal` at module-load. The default
 * implementation lazy-imports `qrcode-terminal` (zero transitive deps), so
 * the QR is only required when the output actually needs to render one
 * (saves the cold-install path from a needless dep).
 */
export function formatPairingOutput(
  { pairing_code, box_id, expiresAt, serverUrl } = {},
  { qrRender = defaultQrRender } = {},
) {
  if (!/^[0-9]{6}$/.test(String(pairing_code ?? ""))) {
    throw new Error("formatPairingOutput: pairing_code must be 6 digits");
  }
  const lines = [];
  if (box_id) {
    // Branch A — full gateway install (box_id + valid 6-digit code).
    lines.push("");
    lines.push("  ✓ Manta server is running — connect your devices:");
    lines.push("");
    lines.push("  1. Get the desktop app (macOS, Apple silicon)");
    lines.push(`       ${DESKTOP_DMG_URL}`);
    lines.push("");
    lines.push("  2. Pair it — click this link, or paste it into the app's Connect screen");
    const pairLink = buildPairLink(box_id, pairing_code);
    lines.push(`       Pair page:     ${buildPairPageUrl(box_id, pairing_code)}`);
    lines.push(`       ${pairLink}`);
    lines.push("");
    lines.push("  3. iPhone (optional) — scan the QR below with your camera");
    lines.push(`       App download: ${IOS_APP_URL}  (App Store link coming soon)`);
    lines.push("");
    let qr;
    try {
      qr = qrRender(pairLink);
    } catch {
      // qrcode-terminal missing / broken (e.g. a dev's stripped node_modules) —
      // degrade to text-only rather than crash the install. The QR is a
      // nice-to-have, the text link is the source of truth.
      qr = null;
    }
    if (qr) {
      // Indent every QR row to match the surrounding two-space indent. The QR
      // itself is rendered with no leading indent; we wrap each line
      // individually so terminal width differences don't break alignment.
      for (const row of String(qr).split("\n")) lines.push("  " + row);
      lines.push("");
    }
    lines.push(`  Pairing code:  ${pairing_code}`);
    lines.push(`  Box ID:        ${box_id}`);
    if (serverUrl) {
      lines.push(`  Server URL:    ${serverUrl}`);
    }
    if (expiresAt != null) {
      lines.push(`  Expires:       ${formatExpiry(expiresAt)}`);
    }
    lines.push("                 (one-time — mint a fresh one any time with `manta pair`)");
  } else {
    // Branch B — degraded / no-gateway install (no box_id). Pair-link + QR
    // can't be rendered (there's no box half of the link), so we surface the
    // code + the ingress hint + a tail-line that names the desktop app URL
    // the user is meant to type the code into.
    lines.push("");
    lines.push("  ✓ Manta server is running.");
    lines.push("");
    lines.push(`  Pairing code:  ${pairing_code}`);
    if (expiresAt != null) {
      lines.push(`  Expires:       ${formatExpiry(expiresAt)}`);
    }
    lines.push("");
    if (serverUrl) {
      lines.push(`  Server URL:    ${serverUrl}`);
      lines.push("");
    } else {
      lines.push("  Expose this box to your phone/desktop (pick one):");
      lines.push("    • Tailscale / VPN  → use the box's tailnet address");
      lines.push("    • Reverse proxy    → point it at 127.0.0.1:8787");
      lines.push("");
    }
    lines.push("  → Enter the pairing code in the Manta desktop app to connect.");
    lines.push(`     Desktop app: ${DESKTOP_DMG_URL}`);
  }
  return lines.join("\n");
}

/**
 * Build the canonical box-form pair link. Mirrors the renderer-side
 * `buildPairPayload` (src/renderer/mobile/pairPayload.ts) but lives here as
 * a tiny local helper because install-lib.mjs is plain Node — importing the
 * TS helper would cross a transpile boundary for a one-liner. The shape
 * MUST round-trip through `parsePairPayload` to a non-null payload, so the
 * install heredoc + the desktop QR panel + the mobile deep-link handler all
 * agree on the same wire string. The test in scripts/install.test.mjs
 * round-trips this against the renderer's `parsePairPayload` via subprocess
 * to enforce the contract.
 *
 * Cross-reference: keep in sync with src/renderer/mobile/pairPayload.ts
 * `buildPairPayload` (box-form branch). If the canonical shape changes,
 * BOTH helpers must change in lockstep — the test catches drift.
 */
export function buildPairLink(boxId, code) {
  if (typeof boxId !== "string" || !/^[0-9a-f]{32}$/.test(boxId)) {
    throw new Error("buildPairLink: boxId must be a 32-hex token");
  }
  if (!/^[0-9]{6}$/.test(String(code ?? ""))) {
    throw new Error("buildPairLink: code must be 6 digits");
  }
  return `manta://pair?box=${encodeURIComponent(boxId)}&code=${code}`;
}

/**
 * Pair-page URL — the ONE link a fresh install reports. Fragment carries the
 * code so it never reaches server logs; the page derives the box id from its
 * own hostname. Shares buildPairLink's validation rules.
 */
export function buildPairPageUrl(boxId, code) {
  if (!/^[0-9a-f]{32}$/.test(boxId ?? "")) {
    throw new Error("buildPairPageUrl: boxId must be a 32-hex token");
  }
  if (!/^[0-9]{6}$/.test(code ?? "")) {
    throw new Error("buildPairPageUrl: code must be 6 digits");
  }
  return `https://${boxId}.boxes.mantaui.com/pair#code=${code}`;
}

// Lazy-default QR renderer: requires `qrcode-terminal` at call time, not at
// module-load. The install path only pays the cost when an output actually
// needs a QR. Pure defaultRender returns the QR string the terminal prints
// (with newlines); the wrapping loop in formatPairingOutput handles indent.
function defaultQrRender(text) {
  // qrcode-terminal's `generate(text, options, callback)` is sync internally;
  // we capture the rendered QR via the callback. `small:true` matches the
  // install's terminal width (40 cols → fits between the existing 2-space
  // indent and a normal terminal line length).
  const mod = _require("qrcode-terminal");
  let captured = "";
  mod.generate(text, { small: true }, (qr) => {
    captured = qr;
  });
  return captured;
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
// which sets MANTA_HOME / MANTA_AUTH_FILE / MANTA_PORT / MANTA_HEALTH_URL in
// the shell, and:
//   node scripts/install-lib.mjs check-identity
// which prints "preserve" or "fresh" (exit 0) so the shell knows whether to
// keep ~/.manta untouched.

// Emit KEY=VALUE lines the shell can `eval`. Values are single-quoted so paths
// with spaces survive; embedded single quotes are escaped the POSIX way.
//
// Note: MANTA_TARBALL_URL is NOT emitted here. install.sh reads the manifest
// itself to resolve the tarball, so this script no longer needs to be told
// the URL by the shell. The `tarballUrl` field on `cfg` is preserved so
// existing resolveConfig tests that probe MANTA_TARBALL_URL still pass.
export function renderShellConfig(cfg, { version } = {}) {
  const kv = {
    MANTA_HOME: cfg.mantaHome,
    MANTA_AUTH_DIR: cfg.authDir,
    MANTA_AUTH_FILE: cfg.authFile,
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
  if (cmd === "merge-opencode-config") {
    // Read raw text from stdin, write the merged text to stdout, and the
    // `corrupt` flag to stderr (so install.sh can branch on it for the
    // `.pre-manta` backup). Pure: no fs writes here.
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf-8");
    const { text, corrupt } = mergeOpencodeConfig(raw);
    if (corrupt) process.stderr.write("corrupt=1\n");
    process.stdout.write(text);
    return 0;
  }
  if (cmd === "render-systemd-unit") {
    // node install-lib.mjs render-systemd-unit --template <path> --placeholder K=V [--placeholder K=V ...]
    // Replaces @@K@@ in the template file with V (verbatim, no quoting).
    // Writes the rendered text to stdout. install.sh uses this to substitute
    // the opencode-serve unit's @@OPENCODE_BIN@@ placeholder (sed was an
    // option but a lib function is unit-testable + lib-quoteable).
    const tplPath = flags.template;
    if (!tplPath) {
      process.stderr.write("render-systemd-unit: --template <path> required\n");
      return 2;
    }
    const { readFileSync } = await import("node:fs");
    const tpl = readFileSync(tplPath, "utf-8");
    // Strip the --template flag + value out of `flags` and treat everything
    // else as a placeholder; values can contain `=` so split on the FIRST `=`.
    const placeholders = {};
    for (const [k, v] of Object.entries(flags)) {
      if (k === "template" || k === "version") continue;
      placeholders[k] = v;
    }
    process.stdout.write(renderSystemdUnit(tpl, placeholders));
    return 0;
  }
  if (cmd === "merge-gateway") {
    // node install-lib.mjs merge-gateway --file <path>
    // Reads {gateway_token, gateway_host} from stdin (JSON object), merges
    // them into the existing auth.json (preserving box_id/box_token), and
    // writes the result atomically (write <path>.tmp then rename).
    //   exit 0  → merged successfully; may be byte-identical (changed=false)
    //            or rewritten (changed=true). install.sh can grep stderr
    //            for `changed=0` vs `changed=1` if it needs to log diffs.
    //   exit 1  → merge refused (auth.json was unparseable). install.sh
    //            warns + skips; the server's gatewayRegister.mjs will
    //            re-persist the values on its next boot.
    const filePath = flags.file;
    if (!filePath) {
      process.stderr.write("merge-gateway: --file <path> required\n");
      return 2;
    }
    const stdinChunks = [];
    for await (const c of process.stdin) stdinChunks.push(c);
    let payload = {};
    const raw = Buffer.concat(stdinChunks).toString("utf-8").trim();
    if (raw.length > 0) {
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`merge-gateway: stdin is not valid JSON: ${e?.message ?? e}\n`);
        return 1;
      }
    }
    const { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    let existing = "";
    if (existsSync(filePath)) {
      try {
        existing = readFileSync(filePath, "utf-8");
      } catch (e) {
        process.stderr.write(`merge-gateway: read failed: ${e?.message ?? e}\n`);
        return 1;
      }
    }
    const res = mergeGatewayAuth(existing, {
      gateway_token: typeof payload?.gateway_token === "string" ? payload.gateway_token : null,
      gateway_host: typeof payload?.gateway_host === "string" ? payload.gateway_host : null,
    });
    if (!res.ok) {
      process.stderr.write(`merge-gateway: ${res.error}\n`);
      return 1;
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(`${filePath}.tmp`, res.text);
      renameSync(`${filePath}.tmp`, filePath);
    } catch (e) {
      process.stderr.write(`merge-gateway: write failed: ${e?.message ?? e}\n`);
      return 1;
    }
    process.stderr.write(`changed=${res.changed ? "1" : "0"}\n`);
    return 0;
  }
  if (cmd === "wait-for-dns") {
    // node install-lib.mjs wait-for-dns --hostname <host> --expected-ip <ip>
    //                            [--max-attempts N] [--interval-ms MS]
    // Polls node:dns.lookup(hostname, {family:4}) until it returns expectedIp
    // or `maxAttempts` × `intervalMs` elapses. Idempotent for tests via
    // injected lookup; the CLI uses the real node:dns.
    const hostname = flags.hostname;
    const expectedIp = flags["expected-ip"];
    if (!hostname) {
      process.stderr.write("wait-for-dns: --hostname <host> required\n");
      return 2;
    }
    if (!expectedIp) {
      process.stderr.write("wait-for-dns: --expected-ip <ip> required\n");
      return 2;
    }
    const maxAttempts = flags["max-attempts"] ? Number(flags["max-attempts"]) : 30;
    const intervalMs = flags["interval-ms"] ? Number(flags["interval-ms"]) : 10_000;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      process.stderr.write("wait-for-dns: --max-attempts must be a positive integer\n");
      return 2;
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 0) {
      process.stderr.write("wait-for-dns: --interval-ms must be a non-negative integer\n");
      return 2;
    }
    const r = await waitForDns(hostname, expectedIp, { maxAttempts, intervalMs });
    if (!r.ok) {
      process.stderr.write(`wait-for-dns: ${r.error}\n`);
      return 1;
    }
    process.stderr.write(`resolved after ${r.attempts} attempt(s) (${r.address})\n`);
    return 0;
  }
  if (cmd === "render-caddy-vhost") {
    // node install-lib.mjs render-caddy-vhost --box-id <32hex> --port <N>
    //                                [--mode snippet|inline]
    // Writes the Caddyfile fragment to stdout. install.sh tees it into
    // /etc/caddy/Caddyfile.d/manta.caddy (or appends to the Caddyfile in
    // inline mode — bracketed by # >>> manta >>> / # <<< manta <<< markers
    // so a re-run finds and replaces the block).
    const boxId = flags["box-id"];
    const port = flags.port ? Number(flags.port) : undefined;
    const mode = flags.mode ?? "snippet";
    if (!boxId) {
      process.stderr.write("render-caddy-vhost: --box-id <32hex> required\n");
      return 2;
    }
    if (!port) {
      process.stderr.write("render-caddy-vhost: --port <N> required\n");
      return 2;
    }
    try {
      process.stdout.write(renderCaddyVhost(boxId, port, { mode }));
    } catch (e) {
      process.stderr.write(`render-caddy-vhost: ${e?.message ?? e}\n`);
      return 1;
    }
    return 0;
  }
  if (cmd === "detect-distro") {
    // node install-lib.mjs detect-distro [--os-release <path>]
    // Parses /etc/os-release and emits a one-line JSON status object
    // install.sh can `eval` or json-parse. The status object:
    //   { debianLike: boolean, id: string|null, idLike: string|null,
    //     supported: boolean, reason: string }
    // install.sh gates the privileged Caddy section on
    // `supported === true`; the `reason` string is logged for the
    // operator when it's false (distro not supported + bring-your-
    // own-proxy hint).
    const path = flags["os-release"] ?? "/etc/os-release";
    const info = readOsReleaseIds({ path });
    const cls = classifyDistro(info);
    const status = {
      debianLike: cls.debianLike,
      id: cls.id,
      idLike: cls.idLike,
      supported: cls.debianLike,
      reason: cls.debianLike
        ? "supported Debian/Ubuntu family"
        : cls.id
          ? `distro "${cls.id}" is not in the v1 supported list (debian, ubuntu, or ID_LIKE=debian)`
          : "could not parse /etc/os-release (missing or unparseable)",
    };
    process.stdout.write(JSON.stringify(status) + "\n");
    return 0;
  }
  process.stderr.write(
    `install-lib: unknown command ${JSON.stringify(cmd)}\n` +
      "  usage: node install-lib.mjs <print-config|check-identity|merge-opencode-config|merge-gateway|wait-for-dns|render-caddy-vhost|detect-distro|render-systemd-unit> [--version X] [--file P] [--template P] [--hostname H] [--expected-ip IP] [--max-attempts N] [--interval-ms MS] [--box-id ID] [--port N] [--mode M] [--os-release PATH] [--placeholder K=V]\n",
  );
  return 2;
}

function parseFlags(args) {
  const out = {};
  // Each recognized flag is a string-to-value pair: the key is the flag
  // name (without the leading `--`), the value type is one of "string"
  // (next arg becomes the value) or "boolean" (presence = true).
  // Unknown flags are silently ignored — the per-command handler decides
  // whether to die (most do, with a clear "required" message).
  const STRING_FLAGS = new Set([
    "version",
    "template",
    "file",
    "hostname",
    "expected-ip",
    "max-attempts",
    "interval-ms",
    "box-id",
    "port",
    "mode",
    "os-release",
  ]);
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (typeof tok !== "string" || !tok.startsWith("--")) continue;
    const key = tok.slice(2);
    if (STRING_FLAGS.has(key)) {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        process.stderr.write(`install-lib: --${key} requires a value\n`);
        process.exit(2);
      }
      out[key] = val;
      i += 1;
      continue;
    }
    if (key === "placeholder") {
      // --placeholder KEY=VAL  (value may itself contain `=`; split on FIRST)
      const kv = args[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq === -1) {
        process.stderr.write(`install-lib: --placeholder expects KEY=VAL (got ${JSON.stringify(kv)})\n`);
        process.exit(2);
      }
      out[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    // Unknown flag — silently skip so a future flag addition doesn't
    // break older callers; the per-command handler is the strict gate.
  }
  return out;
}

// Run the CLI only when invoked as `node install-lib.mjs …`, not on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cliMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
