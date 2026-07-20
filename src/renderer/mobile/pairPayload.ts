// pairPayload.ts — pure parser + builder for the pairing deeplink/QR payload
// (BET-73, M3.1; extended BET-156 for box-paired flows). No DOM, no fetch,
// no camera: this is the pure-before-wired foundation that stage 2 (camera →
// auto-connect) imports, and that the desktop's box-paired onboarding reuses
// for a single-paste "pair link" input.
//
// A desktop "Pair phone" panel encodes a payload into a QR; the mobile app
// scans it (or resolves it from a deferred deeplink) and auto-connects. The
// payload carries ONE of two addressing shapes, both keyed by a 6-digit pairing
// code:
//   • serverUrl (direct-HTTPS):  manta://pair?server=<url>&code=<6-digit>
//   • boxId     (direct box):    manta://pair?box=<box_id>&code=<6-digit>
// This module normalizes either into a single { serverUrl, boxId, code } and
// provides the inverse builders used as round-trip oracles in tests (and by
// the desktop QR panel + the install.sh heredoc).
//
//   1. Custom scheme (primary — what the desktop panel renders):
//        manta://pair?server=<url>&code=<6-digit>
//        manta://pair?box=<box_id>&code=<6-digit>
//      M6-spec alias, also accepted (serverUrl form):
//        manta://pair?id=<serverUrl>&token=<code>
//   2. Deferred-deeplink https form (Branch/Firebase style):
//        https://<host>/m/<payload>?server=<url>&code=<6-digit>
//        https://<host>/m/<payload>?box=<box_id>&code=<6-digit>
//
// The validation contract (server URL shape, 6-digit code, box_id 32-hex
// shape) is SINGLE-SOURCED: we delegate to normalizeServerUrl /
// isValidServerUrl (../pairStepLogic) and normalizeCode (../../shared/claim.mjs)
// rather than re-implementing it here. boxId shape is checked with
// isValidBoxToken from src/shared/transport.mjs (the SAME 32-hex gate as
// src/server/webhooks.mjs isValidToken, kept in sync there for exactly this
// use case — the renderer cannot import from src/server/* because the box
// server pulls Node built-ins, which Vite's renderer build externalizes
// and the import then fails at build time).

import { normalizeServerUrl, isValidServerUrl } from "../pairStepLogic";
import { normalizeCode } from "../../shared/claim.mjs";
import { isValidBoxToken } from "../../shared/transport.mjs";

export type PairPayload = {
  serverUrl: string | null;
  boxId: string | null;
  code: string;
};

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
 * Coerce a raw boxId value to a validated 32-hex string, or null. The shape is
 * the same 32-hex token the box handshake / `loadAuth` use; reusing
 * isValidBoxToken keeps the box-credential shape in ONE renderer-safe place
 * (mirrored from src/server/webhooks.mjs isValidToken). Trims whitespace.
 */
function coerceBoxId(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  return isValidBoxToken(trimmed) ? trimmed : null;
}

/**
 * Parse a raw scanned/deeplinked string into a PairPayload, or null for any
 * malformed / foreign input: not a bui pair URL, missing both server and box,
 * code not exactly 6 digits, or an unparseable URL. Whitespace is trimmed.
 *
 * Accepts either query spelling — `server`/`code` (primary), the M6 alias
 * `id`/`token`, or the box form `box`/`code` — and both URL shapes (custom
 * `manta://pair` scheme and the `https://host/m/...` deferred-deeplink form).
 *
 * Exactly ONE of server / box must be present. Both or neither → null.
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
  const rawServer = q.get("server") ?? "";
  const rawBox = q.get("box") ?? "";
  const rawCode = q.get("code") ?? q.get("token") ?? "";
  // The legacy `id` param (pre-BET-177 desktop QR: `manta://pair?id=<X>&token=`)
  // is AMBIGUOUS — early builds put a serverUrl there, but the box-era desktop
  // (still shipping in some installed apps) puts the 32-hex BOX ID there. Route
  // by shape: a 32-hex value is a boxId (direct claim against the box's own
  // hostname); anything else is a serverUrl (direct). WITHOUT this, a boxId
  // under `id` gets http://-prefixed and mis-parsed as a bogus direct server URL
  // → the claim network-fails against a non-existent host (the exact symptom on
  // an old desktop QR).
  const rawId = q.get("id") ?? "";

  let serverUrl = coerceServerUrl(rawServer);
  let boxId = coerceBoxId(rawBox);

  // Resolve the legacy `id` only if neither explicit spelling was given.
  if (!serverUrl && !boxId && rawId) {
    const idAsBox = coerceBoxId(rawId);
    if (idAsBox) boxId = idAsBox;
    else serverUrl = coerceServerUrl(rawId);
  }

  // Exactly one of {server, box} must be present. Both or neither → reject.
  if ((serverUrl ? 1 : 0) + (boxId ? 1 : 0) !== 1) return null;

  const code = normalizeCode(rawCode);
  // normalizeCode strips non-digits and clamps to 6, so a 7-digit input would
  // pass length-6 but silently drop a digit. Guard against that by requiring
  // the raw code to contain exactly 6 digits (no more, no fewer).
  if (!/^\d{6}$/.test(code)) return null;
  if ((String(rawCode).match(/\d/g) ?? []).length !== 6) return null;

  return { serverUrl: serverUrl ?? null, boxId: boxId ?? null, code };
}

/**
 * Inverse of parsePairPayload for the direct-HTTPS form: produce the canonical
 * custom-scheme string
 *   manta://pair?server=<url-encoded>&code=<code>
 * Used as a round-trip oracle in tests and by the desktop QR panel.
 * The server URL is URL-encoded so reserved characters survive the query.
 */
export function buildPairPayload(p: PairPayload): string {
  if (p.boxId) {
    return `manta://pair?box=${encodeURIComponent(p.boxId)}&code=${p.code}`;
  }
  const serverUrl = normalizeServerUrl(p.serverUrl ?? "");
  return `manta://pair?server=${encodeURIComponent(serverUrl)}&code=${p.code}`;
}
