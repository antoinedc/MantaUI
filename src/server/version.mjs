// GET /api/version — bui-server's package.json version, read once at startup.
//
// Pure helpers (no IO at import time) so the route, the RPC handler, and the
// tests can all consume the same source of truth without duplicating logic.
// The renderer never reads the package.json itself — it goes through the
// `server:version` RPC channel (rpc.mjs), which returns the same value the
// REST route would. The REST surface exists for curl / integration tests +
// non-renderer clients; same string either way.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Returned when package.json is unreadable / malformed / missing the `version`
// field. Lets the server boot in broken packaging scenarios (a tarball that
// dropped json, an fs permission glitch) without 500-ing on a metadata route
// that's purely informational — the renderer display falls back to "?" via
// the catch in MobileSettings.
export const FALLBACK_VERSION = "0.0.0";

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
 * Write the /api/version JSON response. Pure: takes `res` (anything with
 * writeHead + end) and `deps` ({ version }) and emits the response body.
 * No IO. Tests pass a recorder `res` and assert on the captured calls.
 */
export function writeVersionResponse(res, { version }) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ version }));
}
