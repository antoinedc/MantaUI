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
 * - "feed"       — the published feed does not describe an artifact this
 *                  platform's updater can install. Terminal, and NOT the user's
 *                  fault: only a new release can fix it.
 * - "transient"  — offline, DNS, timeout, 5xx. Resolves itself. Stay quiet.
 *
 * @typedef {"integrity" | "permission" | "feed" | "transient"} UpdateErrorKind
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

// The feed itself is unusable on this platform. This class exists because the
// "default to transient" rule below, which is right for network noise, hid a
// PERMANENT failure for the entire life of the macOS updater.
//
// electron-updater's macOS path (Squirrel.Mac) can only install from a ZIP: it
// calls findFile(files, "zip", ["pkg", "dmg"]) — note that dmg is on the
// EXCLUDED list, so it is not a fallback — and throws
// ERR_UPDATER_ZIP_FILE_NOT_FOUND / "ZIP file not provided" when the feed has
// none. `latest-mac.yml` published only a DMG, so every download attempt on
// every Mac threw instantly, and the message contains no "sha512"/"checksum"/
// "signature" keyword, so it classified as transient and was swallowed in
// silence. Same shape of bug as 0.0.13/0.0.14 (see the header), different
// cause: there, the digest was wrong; here, the artifact was of a kind the
// updater will never accept.
//
// The feed now ships a zip (electron-builder.yml mac.target), so this should be
// unreachable in a correct release — which is exactly why it must be loud if it
// ever comes back, rather than resuming the silence it was found in.
const FEED_PATTERNS = [
  /zip file not provided/i,
  /ERR_UPDATER_ZIP_FILE_NOT_FOUND/i,
  /no files provided/i,
  /ERR_UPDATER_NO_FILES_PROVIDED/i,
  /ERR_UPDATER_INVALID_UPDATE_INFO/i,
  /cannot parse update info/i,
];

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
  // FEED IS CHECKED FIRST, AND THE ORDER IS LOAD-BEARING.
  //
  // electron-updater's "ZIP file not provided" message embeds the feed's whole
  // file list as JSON — which contains each file's `sha512` — so the bare
  // /sha512/ integrity pattern below matches it. Classified as "integrity" the
  // user is told the download "failed its integrity check", sending them to
  // re-download an app that is fine, when the actual fault is a release that
  // published no installable artifact and only a new release can fix.
  //
  // The feed patterns are explicit error codes and phrases, so they are far
  // more specific than a substring search for a hash name; the specific test
  // must run before the general one.
  if (FEED_PATTERNS.some((re) => re.test(m))) return "feed";
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
    case "feed":
      return "A newer version exists but this release can't update itself automatically. Download the latest version manually.";
    default:
      return "Couldn't check for updates.";
  }
}
