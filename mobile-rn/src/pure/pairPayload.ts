// pairPayload.ts — pure parser + builder for the pairing deeplink/QR payload.
//
// Ported from the web client's src/renderer/mobile/pairPayload.ts (BET-73) into
// the Expo RN app (BET-74, M3.2). Framework-free: no DOM, no fetch, no camera —
// this is the pure foundation the pairing screen imports to turn a scanned QR
// string into a { serverUrl, code } it can claim against.
//
// The web version delegates URL/code validation to renderer-only modules
// (pairStepLogic, shared/claim.mjs). To keep the RN bundle self-contained (and
// unit-testable under the repo-root vitest without pulling renderer code into
// the RN tsconfig) the same rules are re-implemented here as small pure helpers.
// They are kept BYTE-FOR-BYTE equivalent in behavior:
//   • server URL: scheme-less bare host gets an http:// prefix, then must match
//     https?://.+  after trailing-slash strip.
//   • code: exactly 6 decimal digits (no more, no fewer).
//
// Two URL shapes carry the SAME two fields (server + code); both normalize into
// one { serverUrl, code }. buildPairPayload is the inverse (round-trip oracle in
// tests, and the desktop QR panel's encoder later).
//
//   1. Custom scheme (primary — what the desktop panel renders):
//        bui://pair?server=<url>&code=<6-digit>
//      M6-spec alias, also accepted:
//        bui://pair?id=<serverUrl-or-boxId>&token=<code>
//   2. Deferred-deeplink https form (Branch/Firebase style):
//        https://<host>/m/<payload>?server=<url>&code=<6-digit>

export type PairPayload = { serverUrl: string; code: string };

/**
 * Normalize a server URL: trim surrounding whitespace and any trailing slashes
 * (so "http://box:8787/" and "http://box:8787" are equal). Does NOT inject a
 * scheme — caller decides. Mirrors renderer/pairStepLogic.normalizeServerUrl.
 */
export function normalizeServerUrl(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * True when `raw` looks like a fetchable http(s) URL. Loose on purpose — we only
 * check scheme + non-empty rest; a bad host surfaces later as a network failure.
 * Mirrors renderer/pairStepLogic.isValidServerUrl.
 */
export function isValidServerUrl(raw: string): boolean {
  return /^https?:\/\/.+/i.test(normalizeServerUrl(raw));
}

/**
 * Strip every non-digit and clamp to the first 6 digits. Mirrors
 * shared/claim.mjs normalizeCode. Pure — safe to call on any raw input.
 */
export function normalizeCode(raw: string): string {
  return String(raw ?? "")
    .replace(/\D+/g, "")
    .slice(0, 6);
}

/**
 * Coerce a raw server value into a normalized, valid http(s) URL string, or null
 * if it can't be. A scheme-less bare host ("box:8787") gets an http:// prefix
 * before validation so QR payloads carrying only host:port still resolve.
 * Returns null for empty / unparseable input so the caller rejects the whole
 * payload.
 */
function coerceServerUrl(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  // If there's no scheme at all, assume http:// (bare host:port from a QR).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const normalized = normalizeServerUrl(withScheme);
  return isValidServerUrl(normalized) ? normalized : null;
}

/**
 * Parse a raw scanned/deeplinked string into a PairPayload, or null for any
 * malformed / foreign input: not a bui pair URL, missing server or code, code
 * not exactly 6 digits, or an unparseable URL. Whitespace is trimmed.
 *
 * Accepts either query spelling — `server`/`code` (primary) or the M6 alias
 * `id`/`token` — and both URL shapes (custom `bui://pair` scheme and the
 * `https://host/m/...` deferred-deeplink form). `URL` is a global in both
 * Hermes/React Native and Node/vitest, so no polyfill is needed here.
 */
export function parsePairPayload(raw: string): PairPayload | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  // Only two families are pairing payloads:
  //   • bui://pair?...          (custom scheme; host is "pair")
  //   • https://<host>/m/...    (deferred deeplink; path starts with /m/ or /m)
  const isBuiScheme = url.protocol === "bui:";
  const isHttps = url.protocol === "https:" || url.protocol === "http:";
  const isDeferredPath = /^\/m(\/|$)/.test(url.pathname);

  if (isBuiScheme) {
    // bui://pair — the host segment must be "pair" (URL puts it in .hostname).
    if (url.hostname !== "pair") return null;
  } else if (isHttps) {
    if (!isDeferredPath) return null;
  } else {
    return null;
  }

  const q = url.searchParams;
  // Primary spelling wins; fall back to the id/token alias.
  const rawServer = q.get("server") ?? q.get("id") ?? "";
  const rawCode = q.get("code") ?? q.get("token") ?? "";

  const serverUrl = coerceServerUrl(rawServer);
  if (!serverUrl) return null;

  const code = normalizeCode(rawCode);
  // normalizeCode strips non-digits and clamps to 6, so a 7-digit input would
  // pass length-6 but silently drop a digit. Guard against that by requiring the
  // raw code to contain exactly 6 digits (no more, no fewer).
  if (!/^\d{6}$/.test(code)) return null;
  if ((String(rawCode).match(/\d/g) ?? []).length !== 6) return null;

  return { serverUrl, code };
}

/**
 * Inverse of parsePairPayload: produce the canonical custom-scheme string
 *   bui://pair?server=<url-encoded>&code=<code>
 * Used as a round-trip oracle in tests and later by the desktop QR panel (M6).
 */
export function buildPairPayload(p: PairPayload): string {
  const serverUrl = normalizeServerUrl(p.serverUrl);
  const code = normalizeCode(p.code);
  return `bui://pair?server=${encodeURIComponent(serverUrl)}&code=${code}`;
}
