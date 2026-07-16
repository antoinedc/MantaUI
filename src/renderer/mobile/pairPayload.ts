// pairPayload.ts — pure parser + builder for the pairing deeplink/QR payload
// (BET-73, M3.1). No DOM, no fetch, no camera: this is the pure-before-wired
// foundation that stage 2 (camera → auto-connect) imports.
//
// A desktop "Pair phone" panel encodes a payload into a QR; the mobile app
// scans it (or resolves it from a deferred deeplink) and auto-connects. Two URL
// shapes carry the SAME two fields (server + code); this module normalizes both
// into a single { serverUrl, code } and provides the inverse builder used as a
// round-trip oracle in tests (and later by the desktop QR panel in M6).
//
//   1. Custom scheme (primary — what the desktop panel renders):
//        manta://pair?server=<url>&code=<6-digit>
//      M6-spec alias, also accepted:
//        manta://pair?id=<serverUrl-or-boxId>&token=<code>
//   2. Deferred-deeplink https form (Branch/Firebase style):
//        https://<host>/m/<payload>?server=<url>&code=<6-digit>
//
// The validation contract (server URL shape, 6-digit code) is SINGLE-SOURCED:
// we delegate to normalizeServerUrl / isValidServerUrl (../pairStepLogic) and
// normalizeCode (../../shared/claim.mjs) rather than re-implementing it here.

import { normalizeServerUrl, isValidServerUrl } from "../pairStepLogic";
import { normalizeCode } from "../../shared/claim.mjs";

export type PairPayload = { serverUrl: string; code: string };

/**
 * Coerce a raw server value into a normalized, valid http(s) URL string, or
 * null if it can't be. A scheme-less bare host ("box:8787") gets an http://
 * prefix before validation so QR payloads that carry only host:port still
 * resolve; trailing slashes are stripped by normalizeServerUrl. Returns null
 * for empty / unparseable input so the caller can reject the whole payload.
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
 * `id`/`token` — and both URL shapes (custom `manta://pair` scheme and the
 * `https://host/m/...` deferred-deeplink form).
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
  //   • manta://pair?...          (custom scheme; host is "pair")
  //   • https://<host>/m/...    (deferred deeplink; path starts with /m/ or /m)
  const isMantaScheme = url.protocol === "manta:";
  const isHttps = url.protocol === "https:" || url.protocol === "http:";
  const isDeferredPath = /^\/m(\/|$)/.test(url.pathname);

  if (isMantaScheme) {
    // manta://pair — the host segment must be "pair" (URL puts it in .hostname).
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
  // pass length-6 but silently drop a digit. Guard against that by requiring
  // the raw code to contain exactly 6 digits (no more, no fewer).
  if (!/^\d{6}$/.test(code)) return null;
  if ((String(rawCode).match(/\d/g) ?? []).length !== 6) return null;

  return { serverUrl, code };
}

/**
 * Inverse of parsePairPayload: produce the canonical custom-scheme string
 *   manta://pair?server=<url-encoded>&code=<code>
 * Used as a round-trip oracle in tests and later by the desktop QR panel (M6).
 * The server URL is URL-encoded so reserved characters survive the query.
 */
export function buildPairPayload(p: PairPayload): string {
  const serverUrl = normalizeServerUrl(p.serverUrl);
  const code = normalizeCode(p.code);
  return `manta://pair?server=${encodeURIComponent(serverUrl)}&code=${code}`;
}
