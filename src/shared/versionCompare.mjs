// versionCompare.mjs — pure semver-lite compare used by the update system.
//
// Three exports, all pure + framework-free so both src/server/*.mjs and the
// renderer can import the same source of truth (BET-225 stage 1 — stage 2
// wires the helper into src/server/serverUpdate.mjs + src/server/version.mjs
// `minClient`, stage 3 wires the banner/RPC/UI):
//
//   compareVersions(a, b)       → -1 | 0 | 1
//   isUpdateAvailable(current, latest)
//                              → true when latest > current
//   isClientTooOld(client, min)
//                              → true when client < min
//
// Semantics — deliberately narrow so the helper never disagrees with itself:
//
//   * Numeric-dotted compare: split on ".", parseInt each segment, compare
//     numerically. Multi-digit segments compare correctly (1.10.0 > 1.9.0,
//     which a string compare would mishandle).
//   * Strip a leading `-suffix` pre-release tag and ignore it: "1.2.3-beta"
//     compares equal to "1.2.3". The server only ships stable releases, so
//     pre-release ranking (1.0.0-alpha < 1.0.0) is intentionally NOT
//     implemented — it'd be untested dead code.
//   * Treat missing/malformed input as "0.0.0": null, undefined, "", "abc",
//     "1.x.3" — anything where a segment isn't all-digits. This is a
//     first-line guard against the manifest poller tripping over a typo'd
//     server.json or a client's empty version string during onboarding.
//   * Always operate on a 3-tuple: fewer segments are zero-padded
//     ("1.2" → 1.2.0), more are truncated ("1.2.3.4" → 1.2.3). Keeps the
//     comparison uniform — anything outside 3 segments is invalid semver.
//
// Pure → unit-tested in src/shared/versionCompare.test.ts.

const ZERO = [0, 0, 0];

/**
 * Parse a dotted version string into a 3-tuple of integers. Returns [0,0,0]
 * for null/undefined/empty/non-numeric input.
 */
function parseVersion(v) {
  if (v == null) return [...ZERO];
  const s = String(v).trim();
  if (s === "") return [...ZERO];
  // Pre-release tag: everything after the first '-' is metadata, ignored.
  const stable = s.split("-")[0];
  const segments = stable.split(".");
  const nums = [];
  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) return [...ZERO];
    nums.push(parseInt(seg, 10));
  }
  // Normalize to exactly 3 segments — pad with zeros, truncate extras.
  while (nums.length < 3) nums.push(0);
  return nums.slice(0, 3);
}

/**
 * Compare two version strings numerically. Returns -1 if a < b, 1 if a > b,
 * 0 if equal. Treats missing/malformed input as "0.0.0".
 */
export function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] < B[i]) return -1;
    if (A[i] > B[i]) return 1;
  }
  return 0;
}

/**
 * True when `latest` is strictly newer than `current` (i.e. a server-side
 * update is available for the running client). Missing/malformed inputs
 * collapse to "0.0.0", so a fresh install (empty current) sees any non-zero
 * latest as an update.
 */
export function isUpdateAvailable(current, latest) {
  return compareVersions(current, latest) < 0;
}

/**
 * True when `clientVersion` is strictly older than `minClient` — the server
 * uses this to gate endpoints with a "client too old" response so the
 * version-skew guard (BET-225 stage 2) can reject stale desktop/mobile
 * builds before they touch incompatible routes.
 */
export function isClientTooOld(clientVersion, minClient) {
  return compareVersions(clientVersion, minClient) < 0;
}
