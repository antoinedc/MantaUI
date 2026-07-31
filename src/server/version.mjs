// GET /api/version — manta-server's package.json version, read once at startup.
//
// Pure helpers (no IO at import time) so the route, the RPC handler, and the
// tests can all consume the same source of truth without duplicating logic.
// The renderer never reads the package.json itself — it goes through the
// `server:version` RPC channel (rpc.mjs), which returns the same value the
// REST route would. The REST surface exists for curl / integration tests +
// non-renderer clients; same string either way.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Returned when package.json is unreadable / malformed / missing the `version`
// field. Lets the server boot in broken packaging scenarios (a tarball that
// dropped json, an fs permission glitch) without 500-ing on a metadata route
// that's purely informational — the renderer display falls back to "?" via
// the catch in MobileSettings.
export const FALLBACK_VERSION = "0.0.0";

// The oldest desktop/mobile client version the current server RPC contract
// still supports. Surfaces in `/api/version` + the `server:version` RPC
// channel so the renderer's version-skew guard (BET-225 stage 3) can reject
// stale builds with a non-dismissible banner BEFORE they touch incompatible
// routes. Bumped manually when a breaking RPC change ships — kept as a
// constant here (vs. reading from the manifest) so the response is
// deterministic and never depends on a flaky network fetch.
export const MIN_CLIENT = "0.0.0";

/**
 * Read the `version` field from `<repoRoot>/package.json`.
 *
 * `fs` is injectable so the test can pass a stub (no real fs IO during the
 * test, per BET-180's spec). Production passes `{ readFile }` from
 * `node:fs/promises`. On any failure path — ENOENT, JSON parse, missing
 * field, wrong type — returns FALLBACK_VERSION rather than throwing, so
 * the boot sequence is never blocked on a metadata read.
 */
export async function readServerVersion(repoRoot, fs = { readFile }) {
  try {
    const raw = await fs.readFile(join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" && pkg.version
      ? pkg.version
      : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * Read the running opencode CLI's version via `opencode --version`.
 *
 * opencode's HTTP API has no version endpoint (probed: `/api/health` returns
 * only `{healthy:true}`, `/version`/`/api/version`/`/api/config`/`/api/info`
 * all return the SPA HTML fallback), so a shell-out is the only viable
 * source. Runs synchronously ONCE at server startup (never per-request) and
 * is cached in `OPENCODE_VERSION` by src/server/index.mjs, mirroring the
 * `readServerVersion` startup-read pattern.
 *
 * `exec` is injectable so the test can pass a stub (no real subprocess
 * during the test, same resilience-injection contract as `readServerVersion`
 * takes for `fs`). Production passes the real `execFileSync` from
 * `node:child_process`. `opencode --version` prints a single line like
 * `1.18.10`; we take the last whitespace-separated token so a future
 * `opencode version 1.18.10`-style prefix won't silently break parsing.
 * On any failure path — ENOENT (opencode not installed), non-zero exit,
 * empty stdout — returns FALLBACK_VERSION rather than throwing, so the boot
 * sequence is never blocked on a metadata read.
 */
export function readOpencodeVersion(exec = execFileSync) {
  try {
    const stdout = exec("opencode", ["--version"], { encoding: "utf8" });
    const trimmed = String(stdout).trim();
    if (!trimmed) return FALLBACK_VERSION;
    const tokens = trimmed.split(/\s+/);
    const v = tokens[tokens.length - 1];
    return v || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

/**
 * Write the /api/version JSON response. Pure: takes `res` (anything with
 * writeHead + end) and `deps` ({ version, opencodeVersion? }) and emits the
 * response body. No IO. Tests pass a recorder `res` and assert on the
 * captured calls.
 *
 * Includes `minClient` (the constant from `MIN_CLIENT`) so the
 * version-skew guard consumer (renderer stage 3) can check the client is
 * still supported in a single round-trip — no separate endpoint needed.
 *
 * Includes `opencodeVersion` (BET-428) so Settings → About can render the
 * box's opencode CLI version alongside the desktop + server versions in the
 * same `getServerVersion` round-trip — no new IPC channel. Defaults to
 * FALLBACK_VERSION when omitted so the existing `{ version }`-only callers
 * (and the BET-180 test) keep working; production always passes the cached
 * startup value.
 */
export function writeVersionResponse(res, { version, opencodeVersion = FALLBACK_VERSION }) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      version,
      minClient: MIN_CLIENT,
      opencodeVersion,
    }),
  );
}
