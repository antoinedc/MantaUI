// windowSecurity.ts — shared window-hardening helpers for the Electron main
// process (BET-1324).
//
// Both BrowserWindows (the main one in index.ts and the call window in
// callWindow.ts) apply the same two guards, so the logic lives here once
// instead of being duplicated across two files:
//
//   • will-navigate   — deny any top-level navigation away from the app's own
//                       URL, so embedded/foreign content can't replace the
//                       whole window with a page of its choosing.
//   • setWindowOpenHandler — only hand http:/https: URLs to the OS; drop
//                       everything else (file:, smb:, javascript:, custom
//                       schemes, unparseable strings) instead of launching it.
//
// Both helpers are pure (no Electron import) so they can be unit-tested in
// isolation.

/**
 * Whether a `will-navigate` target is the app's own URL and may be allowed.
 *
 * The renderer is a single-page app that never initiates a top-level
 * navigation, so the only URL it legitimately navigates to is the page it
 * already holds. Returning true only for an exact match of the current URL
 * (allowing reloads) denies everything else — https://evil.example, a
 * file:///etc/passwd path, a differing same-origin path — while still
 * permitting the app to reload its own page.
 *
 * An unparseable current or target string is denied (fail closed), never
 * passed through.
 */
export function shouldAllowNavigation(currentUrl: string, targetUrl: string): boolean {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  return target.href === current.href;
}

/**
 * Returns the parsed URL when `raw` is an http: or https: URL, else null.
 *
 * `shell.openExternal` hands an arbitrary string to the operating system, so
 * it must only ever receive user-meaningful web URLs. A file:, smb:,
 * javascript:, registered-custom-scheme URL, or an unparseable string must be
 * dropped (return null), never launched.
 */
export function externalUrlOrNull(raw: string): URL | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}
