// Hand-written type declarations for versionCompare.mjs. Implementation is plain
// JS so both the renderer tsconfig and the server-side .mjs import it natively
// (Node ESM resolves the .mjs directly, no declaration lookup needed). Keep in
// sync with src/shared/versionCompare.mjs.

/**
 * Compare two dotted version strings numerically. Returns -1 if a < b, 1 if
 * a > b, 0 if equal. Treats missing/malformed input as "0.0.0".
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1;

/**
 * True when `latest` is strictly newer than `current` — i.e. an update is
 * available for the running client.
 */
export function isUpdateAvailable(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean;

/**
 * True when `clientVersion` is strictly older than `minClient` — the
 * server-side version-skew guard rejects stale clients before they touch
 * incompatible routes.
 */
export function isClientTooOld(
  clientVersion: string | null | undefined,
  minClient: string | null | undefined,
): boolean;
