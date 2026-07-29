// compatibility.mjs — pure desktop/box version matrix check (BET-357 §3).
//
// The renderer pairs with one box. The desktop and the box ship separately and
// will drift — the desktop reads its own version from package.json (`app.
// getVersion()` on Electron, `__APP_VERSION__` baked into the mobile bundle),
// the box reports its version via the existing `GET /api/version` route (same
// value the `server:version` RPC channel returns). This helper decides which
// of three states that pair is in:
//
//   "match"        → proceed. Same major, box is at-or-ahead of desktop.
//   "behind"       → box is older than the desktop within the same major.
//                    Trigger the box's self-update path.
//   "incompatible" → different major. A wire-contract change has shipped on
//                    one side; the user needs to act, but "click here to
//                    upgrade" can't paper over a breaking RPC change.
//   "unknown"      → either input is missing or unparseable. Mid-bootstrap,
//                    transient failure, or a corrupted package.json. Never
//                    used to drive a destructive action — both renderer and
//                    server treat "unknown" as "show nothing".
//
// Pure: framework-free so it can be consumed by the renderer (via
// chatUtils' re-export) AND the server-side guards. Tested in
// src/shared/compatibility.test.ts.
//
// The matrix is intentionally minimal — a single "supported major version".
// A desktop running the supported major talks to a box running the same
// major regardless of minor/patch skew; a box on any other major is
// rejected. Bumping the constant is a deliberate act ("the RPC contract
// changed; you cannot mix the two halves across this boundary").
//
// Pre-release tags: `versionCompare` strips them, so "1.2.3-beta" compares
// equal to "1.2.3". A desktop with a pre-release tag on the supported major
// is "match" against a stable box on the same minor, and "behind" against a
// box on the next minor. That's the deliberate behaviour; we don't try to
// distinguish "1.2.3-beta" from "1.2.3" for compatibility purposes.

import { compareVersions } from "./versionCompare.mjs";

/**
 * The default compatibility matrix.
 *
 * `supportedMajor` is the wire-contract major version the current desktop
 * build understands. A box whose parsed major differs from this number is
 * incompatible (different RPC contract — the user must upgrade one half to
 * the supported major). A box on the supported major is either "match"
 * (at-or-ahead of the desktop) or "behind" (older patch/minor than the
 * desktop).
 *
 * Frozen so accidental mutation can't drift the renderer's view of the
 * matrix out from under the server's.
 */
export const DEFAULT_COMPATIBILITY_MATRIX = Object.freeze({
  supportedMajor: 0,
});

/**
 * The four variants `isCompatible` can return.
 *
 * - `"match"`: same supported major; box is at-or-ahead of desktop. Proceed.
 * - `"behind"`: same supported major; box is older than desktop. Offer to
 *    upgrade the box (renderer fires the existing `server:update-apply`
 *    RPC, which runs `scripts/self-update.sh` on the box).
 * - `"incompatible"`: either desktop or box is on a major that differs from
 *    `matrix.supportedMajor`. The user must upgrade one half — there's no
 *    in-app action that bridges a major-version wire change.
 * - `"unknown"`: missing or malformed input. Renderer never flashes an
 *    upgrade card mid-bootstrap; the helper returns this so the caller can
 *    default to "show nothing".
 */
export const COMPATIBILITY_VARIANTS = Object.freeze([
  "match",
  "behind",
  "incompatible",
  "unknown",
]);

/**
 * Parse the major-version segment of a dotted version string. Missing /
 * malformed segments are treated as 0 — mirrors `versionCompare`'s
 * "anything bad is 0.0.0" policy so the matrix check doesn't special-case
 * garbage input. Pre-release tags are stripped before parsing (same policy
 * as `compareVersions`).
 *
 * Exported so callers building custom matrices / matrix-aware UI (e.g. a
 * "Supported versions: 0.x.y" tooltip) can derive the same number the
 * helper sees, without re-implementing the parser.
 *
 * @param {string | null | undefined} v
 * @returns {number}
 */
export function majorOf(v) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s === "") return 0;
  const stable = s.split("-")[0];
  const head = stable.split(".")[0] ?? "";
  if (!/^\d+$/.test(head)) return 0;
  return parseInt(head, 10);
}

/**
 * Decide whether the box / desktop pair is at a supported combination.
 *
 * @param {object} input
 * @param {string | null | undefined} input.desktopVersion - the running
 *   desktop's own version (renderer reads it from `getClientVersion()`; the
 *   server can read it from a desktop-supplied header or from its own copy
 *   of the package.json).
 * @param {string | null | undefined} input.boxVersion - the box's reported
 *   version (renderer reads it from `getServerVersion().version`; server
 *   reads its own package.json).
 * @param {object} [input.matrix] - the compatibility matrix. Defaults to
 *   `DEFAULT_COMPATIBILITY_MATRIX`. Pass a custom matrix only for tests;
 *   production callers should rely on the default so desktop + server stay
 *   in sync.
 * @returns {"match" | "behind" | "incompatible" | "unknown"}
 */
export function isCompatible(input) {
  if (!input || typeof input !== "object") return "unknown";
  const desktopVersion = input.desktopVersion;
  const boxVersion = input.boxVersion;
  const matrix = input.matrix ?? DEFAULT_COMPATIBILITY_MATRIX;

  // Missing input → unknown. Never drive a UI decision on garbage.
  if (
    typeof desktopVersion !== "string" ||
    desktopVersion === "" ||
    typeof boxVersion !== "string" ||
    boxVersion === ""
  ) {
    return "unknown";
  }
  const supportedMajor = matrix?.supportedMajor;
  if (typeof supportedMajor !== "number" || !Number.isFinite(supportedMajor)) {
    return "unknown";
  }

  const desktopMajor = majorOf(desktopVersion);
  const boxMajor = majorOf(boxVersion);

  // Either half on a different major than the matrix declares → wire
  // contract mismatch. This is the only variant where "click to upgrade"
  // cannot paper over the gap; the renderer shows the supported-versions
  // message instead of the actionable card.
  if (desktopMajor !== supportedMajor || boxMajor !== supportedMajor) {
    return "incompatible";
  }

  // Same supported major. Compare full versions: box < desktop means the
  // box needs to upgrade. box == desktop or box > desktop means match —
  // the box can be ahead of the desktop within the same major and still
  // serve it (the desktop uses a forward-compatible subset of the RPC).
  const cmp = compareVersions(boxVersion, desktopVersion);
  if (cmp < 0) return "behind";
  return "match";
}
