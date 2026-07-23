// pairPayload.ts — pure parser + builder for the pairing deeplink/QR payload
// (BET-73, M3.1; extended BET-156 for box-paired flows). No DOM, no fetch,
// no camera: this is the pure-before-wired foundation that stage 2 (camera →
// auto-connect) imports, and that the desktop's box-paired onboarding reuses
// for a single-paste "pair link" input.
//
// Post-BET-198, phones connect DIRECTLY to https://<box_id>.boxes.mantaui.com
// (Caddy on the box reverse-proxies 127.0.0.1:8787). The only live payload
// shape is the box form:
//   • Custom scheme (primary — what the desktop panel + install heredoc render):
//       manta://pair?box=<box_id>&code=<6-digit>
//   • Deferred-deeplink https form (Branch/Firebase style):
//       https://<host>/m/<payload>?box=<box_id>&code=<6-digit>
//
// The earlier direct-HTTPS `server=` form (and the ambiguous legacy `id=`
// alias) are relay/pre-direct-era back-compat that no live emitter produces;
// they are intentionally rejected here.
//
// The validation contract (32-hex boxId shape, 6-digit code) is SINGLE-SOURCED:
// we delegate to normalizeCode (../../shared/claim.mjs) and isValidBoxToken
// (../../shared/transport.mjs — the SAME 32-hex gate as
// src/server/webhooks.mjs isValidToken, kept in sync there for exactly this
// use case; the renderer cannot import from src/server/* because the box
// server pulls Node built-ins, which Vite's renderer build externalizes
// and the import then fails at build time).

import { normalizeCode } from "../../shared/claim.mjs";
import { isValidBoxToken } from "../../shared/transport.mjs";

export type PairPayload = {
  boxId: string;
  code: string;
};

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
 * malformed / foreign input: not a manta pair URL, missing box, or code not
 * exactly 6 digits. Whitespace is trimmed.
 *
 * Accepts the box form only (`box` + `code`, or `box` + `token` — the code
 * param has both spellings) and both URL shapes (custom `manta://pair` scheme
 * and the `https://host/m/...` deferred-deeplink form). The deprecated
 * `server=` and `id=` addressing forms are intentionally rejected.
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
    // manta://pair — the "pair" authority segment lands in DIFFERENT URL fields
    // depending on the engine, because `manta:` is a NON-SPECIAL scheme:
    //   • Node's URL           → url.hostname === "pair", pathname === ""
    //   • Chromium (renderer)  → url.hostname === "",     pathname === "//pair"
    // The parser originally checked only `url.hostname === "pair"`, which is
    // true in Node (where the unit tests run) but FALSE in the packaged
    // Electron renderer — so every real deep-link / pasted manta:// link was
    // rejected in-app with "Couldn't read that pair link". Accept the segment
    // from either field (BET-240 regression).
    const host = url.hostname;
    const pathSeg = url.pathname.replace(/^\/+/, ""); // "//pair" → "pair"
    if (host !== "pair" && pathSeg !== "pair") return null;
  } else if (isHttps) {
    if (!isDeferredPath) return null;
  } else {
    return null;
  }

  const q = url.searchParams;
  const rawBox = q.get("box") ?? "";
  const rawCode = q.get("code") ?? q.get("token") ?? "";

  const boxId = coerceBoxId(rawBox);
  if (!boxId) return null;

  const code = normalizeCode(rawCode);
  // normalizeCode strips non-digits and clamps to 6, so a 7-digit input would
  // pass length-6 but silently drop a digit. Guard against that by requiring
  // the raw code to contain exactly 6 digits (no more, no fewer).
  if (!/^\d{6}$/.test(code)) return null;
  if ((String(rawCode).match(/\d/g) ?? []).length !== 6) return null;

  return { boxId, code };
}

/**
 * Inverse of parsePairPayload: produce the canonical box-form custom-scheme
 * string
 *   manta://pair?box=<url-encoded box_id>&code=<code>
 * Used as a round-trip oracle in tests and by the desktop QR panel +
 * install.sh heredoc. The boxId is URL-encoded so reserved characters
 * survive the query (32-hex has none today, but the encoder is the safe
 * default).
 */
export function buildPairPayload(p: PairPayload): string {
  return `manta://pair?box=${encodeURIComponent(p.boxId)}&code=${p.code}`;
}
