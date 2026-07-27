// updateError.mjs — classify electron-updater failures so the desktop can tell
// the user when auto-update is BROKEN, without nagging about transient blips.
//
// WHY THIS EXISTS
// ---------------
// `src/main/autoUpdate.ts` used to swallow every updater error into a
// `console.warn`. That is fine for a network hiccup and catastrophic for an
// integrity failure: when the published update feed's sha512 doesn't match the
// published binary, electron-updater downloads the update, rejects it, and
// gives up — forever, on every launch, in total silence. The app just never
// updates and never says why.
//
// That is not hypothetical. Desktop 0.0.13 and 0.0.14 both shipped with a feed
// whose checksum described the pre-notarization DMG (the staple step rewrites
// the file after the feed is written), so no installed copy could take an
// update. It went unnoticed across two releases precisely because the failure
// was invisible — a deep-link fix was reported as "never shipped" when in fact
// it had shipped and could not be delivered.
//
// So: integrity/permission-class failures are SURFACED (they need a human —
// re-download the app, or fix the release), transient ones stay quiet.

/**
 * Failure classes we distinguish.
 *
 * - "integrity"  — an update exists but cannot be verified/installed. The user
 *                  will NEVER get it without intervention. Surface it.
 * - "permission" — the updater can't write/replace the app bundle (read-only
 *                  volume, quarantined app, missing privileges). Also terminal.
 * - "transient"  — offline, DNS, timeout, 5xx. Resolves itself. Stay quiet.
 *
 * @typedef {"integrity" | "permission" | "transient"} UpdateErrorKind
 */

const INTEGRITY_PATTERNS = [
  /sha512/i,
  /checksum/i,
  /integrity/i,
  /signature/i,
  /code signature/i,
  /not signed/i,
];

const PERMISSION_PATTERNS = [/eacces/i, /eperm/i, /permission denied/i, /read-?only/i];

/**
 * Classify an electron-updater error message.
 *
 * Defaults to "transient" for anything unrecognized — a false quiet is much
 * cheaper than a banner the user can't act on, and genuinely broken updates
 * reliably say "sha512"/"checksum"/"signature".
 *
 * @param {string | null | undefined} message
 * @returns {UpdateErrorKind}
 */
export function classifyUpdateError(message) {
  const m = typeof message === "string" ? message : "";
  if (m === "") return "transient";
  if (INTEGRITY_PATTERNS.some((re) => re.test(m))) return "integrity";
  if (PERMISSION_PATTERNS.some((re) => re.test(m))) return "permission";
  return "transient";
}

/**
 * Should this failure be shown to the user at all?
 * @param {string | null | undefined} message
 * @returns {boolean}
 */
export function shouldSurfaceUpdateError(message) {
  return classifyUpdateError(message) !== "transient";
}

/**
 * User-facing copy for a surfaced failure. Deliberately says what to DO —
 * a banner that only says "update error" is barely better than the silence
 * it replaces.
 *
 * @param {string | null | undefined} message
 * @returns {string}
 */
export function describeUpdateError(message) {
  switch (classifyUpdateError(message)) {
    case "integrity":
      return "An update was downloaded but failed its integrity check, so it wasn't installed. Download the latest version manually.";
    case "permission":
      return "An update is ready but couldn't be installed — Manta UI doesn't have permission to replace itself. Move the app to /Applications and try again.";
    default:
      return "Couldn't check for updates.";
  }
}
