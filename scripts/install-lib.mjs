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
import { loadAuth } from "../src/server/auth.mjs";

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
 *   buiHome      — where the code is unpacked (MANTA_HOME || ~/manta)
 *   authDir      — ~/.manta (never inside buiHome)
 *   authFile     — ~/.manta/auth.json (idempotency probe target)
 *   tarballUrl   — explicit MANTA_TARBALL_URL, else null (overrides manifest fetch)
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
// Relay-handshake poller (BET-151 / BET-155)
// ---------------------------------------------------------------------------
//
// Poll the box-server's loopback-only GET /relay/status until the in-process
// relay agent reports `connected: true` (the dial-out to relay.mantaui.com
// succeeded and the WS handshake completed). The shape mirrors `waitForHealth`
// — same injectable fetchFn/sleep, same `{ ok, attempts, ... }` return — so
// install.sh can use one mental model for both waits.
//
// Unlike `waitForHealth` (which dies the install on failure), this one MUST
// NOT fail the install: a relay outage or a network hiccup on the VPS still
// leaves the box working locally. install.sh treats `ok=false` or
// `connected=false` as a `warn` (with the journalctl hint), not a `die`.
//
// `healthUrlBase` is the server's loopback base WITHOUT any path
// (e.g. `http://127.0.0.1:8787`). The endpoint `/relay/status` is appended
// here so the install script doesn't have to know the route — same shape as
// MANTA_HEALTH_URL minus the path component.
//
// Return shape:
//   { ok: true,  enabled, connected, attempts, status }   — got a 2xx
//   { ok: false, enabled: null, connected: false, attempts, error } — gave up
export async function waitForRelay(
  healthUrlBase,
  {
    maxAttempts = 30,
    intervalMs = 1000,
    fetchFn = globalThis.fetch,
    sleep = defaultSleep,
  } = {},
) {
  if (typeof healthUrlBase !== "string" || healthUrlBase === "") {
    throw new Error("waitForRelay: healthUrlBase required");
  }
  if (typeof fetchFn !== "function") {
    throw new Error("waitForRelay: no fetch available (pass fetchFn)");
  }
  const base = stripTrailingSlash(healthUrlBase);
  const url = `${base}/relay/status`;

  let lastError = null;
  // Track the last settled state across attempts so the final return carries
  // the most recent truthful answer even if we exit via the maxAttempts cap
  // (e.g. the server is up but the agent is mid-handshake and never finishes).
  let lastEnabled = null;
  let lastConnected = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchFn(url);
      if (res && typeof res.status === "number") {
        // 2xx = server is up AND answered the relay status route. The body
        // tells us whether the agent is enabled and (if so) whether it's
        // connected. Tolerate a missing/non-JSON body — we already know the
        // server is alive, which is all this loop needs to settle.
        let body = {};
        try {
          body = await res.json();
        } catch {
          /* non-JSON body; treat as no info beyond the status code */
        }
        if (res.status >= 200 && res.status < 300) {
          const enabled = body.enabled === true;
          const connected = body.connected === true;
          lastEnabled = enabled;
          lastConnected = connected;
          // Short-circuit ONLY when the answer is final. Two terminal states:
          //   connected=true  → the handshake succeeded, install.sh can ok()
          //   enabled=false   → config opted out, no point polling further
          // Anything else means "the agent is enabled but hasn't connected
          // yet" — keep polling until the handshake resolves or we exhaust.
          if (connected || !enabled) {
            return {
              ok: true,
              enabled,
              connected,
              attempts: attempt,
              status: res.status,
            };
          }
        } else {
          // 403 from /relay/status means the install ran from somewhere that
          // isn't loopback (rare — would only happen via a port-forward mistake).
          // We treat any non-2xx as "not yet" and retry, same as waitForHealth.
          lastError = new Error(`server returned HTTP ${res.status}`);
        }
      } else {
        lastError = new Error("fetch returned no status");
      }
    } catch (e) {
      lastError = e;
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  // Out of attempts. We MAY have a known state from a recent 2xx (the server
  // answered but the handshake never landed) — return that, with ok=true so
  // install.sh doesn't treat a server-up-but-handshake-degraded case as a
  // server-down failure. ok=false is reserved for "we never reached the
  // server at all" (everything below the loop was ECONNREFUSED).
  if (lastEnabled !== null) {
    return {
      ok: true,
      enabled: lastEnabled,
      connected: lastConnected === true,
      attempts: maxAttempts,
    };
  }
  return {
    ok: false,
    enabled: null,
    connected: false,
    attempts: maxAttempts,
    error: `relay did not connect at ${url} after ${maxAttempts} attempts: ${
      lastError?.message ?? lastError ?? "unknown"
    }`,
  };
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
 */
export function formatPairingOutput({ pairing_code, box_id, expiresAt, serverUrl } = {}) {
  if (!/^[0-9]{6}$/.test(String(pairing_code ?? ""))) {
    throw new Error("formatPairingOutput: pairing_code must be 6 digits");
  }
  const lines = [];
  lines.push("");
  lines.push("  ✓ manta server is running.");
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
  lines.push("  → Enter the pairing code in the Manta desktop app to connect.");
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
    MANTA_HOME: cfg.buiHome,
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
  process.stderr.write(
    `install-lib: unknown command ${JSON.stringify(cmd)}\n` +
      "  usage: node install-lib.mjs <print-config|check-identity|merge-opencode-config|render-systemd-unit> [--version X]\n",
  );
  return 2;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version") {
      out.version = args[++i];
    } else if (args[i] === "--template") {
      out.template = args[++i];
    } else if (args[i] === "--placeholder") {
      // --placeholder KEY=VAL  (value may itself contain `=`; split on FIRST)
      const kv = args[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq === -1) {
        process.stderr.write(`install-lib: --placeholder expects KEY=VAL (got ${JSON.stringify(kv)})\n`);
        process.exit(2);
      }
      out[kv.slice(0, eq)] = kv.slice(eq + 1);
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
