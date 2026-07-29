// Hand-written type declarations for compatibility.mjs. Implementation is plain
// JS so both the renderer tsconfig and the server-side .mjs import it natively
// (Node ESM resolves the .mjs directly, no declaration lookup needed). Keep in
// sync with src/shared/compatibility.mjs.

/**
 * The default compatibility matrix. A frozen object so accidental mutation
 * in one caller can't drift the renderer's view of the matrix out from
 * under the server's. `supportedMajor` is the wire-contract major version
 * the current desktop build understands; a box on a different major is
 * incompatible (different RPC contract).
 */
export const DEFAULT_COMPATIBILITY_MATRIX: {
  readonly supportedMajor: number;
};

/**
 * The four variants `isCompatible` returns.
 *
 *   "match"        → same supported major, box is at-or-ahead of desktop.
 *   "behind"       → same supported major, box is older than desktop.
 *                    Renderer fires the box's existing self-update.
 *   "incompatible" → desktop or box is on a different major than
 *                    `matrix.supportedMajor`. The user must upgrade one
 *                    half manually; "click to upgrade" can't bridge a
 *                    wire-contract change.
 *   "unknown"      → missing / malformed input. Renderer never shows the
 *                    upgrade card mid-bootstrap.
 */
export type CompatibilityVariant =
  | "match"
  | "behind"
  | "incompatible"
  | "unknown";

export const COMPATIBILITY_VARIANTS: readonly CompatibilityVariant[];

/**
 * Parse the major-version segment of a dotted version string. Missing /
 * malformed input → 0. Pre-release tags are stripped. Mirrors
 * `versionCompare`'s "anything bad is 0.0.0" policy.
 */
export function majorOf(v: string | null | undefined): number;

/**
 * Decide whether the box / desktop pair is at a supported combination.
 *
 * Accepts `undefined` / `null` / a partial object so a mid-bootstrap
 * renderer can call it with whatever it has so far without TypeScript
 * complaining. The runtime always returns `"unknown"` for missing /
 * malformed input — never a destructive default.
 *
 * @param input.desktopVersion - the running desktop's own version
 *   (renderer reads from `getClientVersion()`).
 * @param input.boxVersion - the box's reported version (renderer reads
 *   from `getServerVersion().version`).
 * @param input.matrix - optional override; defaults to
 *   `DEFAULT_COMPATIBILITY_MATRIX`. Tests pass a custom matrix to pin the
 *   boundary; production callers use the default.
 */
export function isCompatible(
  input:
    | {
        desktopVersion: string | null | undefined;
        boxVersion: string | null | undefined;
        matrix?: { readonly supportedMajor: number };
      }
    | undefined
    | null,
): CompatibilityVariant;
