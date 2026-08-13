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
  //       <scheme>://pair?box=<box_id>&code=<6-digit>
  //       scheme ∈ {manta, manta-staging, manta-dev} — the box + desktop emit
  //       the scheme their CHANNEL registered with the OS as a URL handler
  //       (BET-370 channel table; BET-373 thread this through pair links so
  //       staging-desktop users scanning a staging-box QR land in staging, not
  //       whatever other channel happened to register `manta://` last).
  //       The four-char two-sided confirm (`verify`) was retired (BET-700);
  //       a stray `verify` in an old QR is ignored on parse.
//   • Deferred-deeplink https form (Branch/Firebase style):
//       https://<host>/m/<payload>?box=<box_id>&code=<6-digit>
//
// BET-336 (Tailscale pair link): the link MAY also carry an optional
// `server=<url>` parameter — the box's listener URL, so a Tailscale box
// (no public hostname) can ship a working one-click / QR pair link. The
// server URL is gated by `isPrivateServerUrl` (../../shared/transport.mjs):
// only loopback, RFC 1918 private, CGNAT/Tailscale (100.64/10), and
// .ts.net MagicDNS hostnames are accepted. A link carrying a public
// address is REFUSED outright (we return null for the whole payload,
// never silently drop the parameter and fall back to the public hostname
// — that fallback is exactly the "crafted link points the app at an
// attacker's server" attack the gate prevents).
//
// BET-373 (channel-aware wire format): the parser and builder accept a
// `scheme` arg (default "manta" — unchanged wire shape for callers that
// don't care about channels). The parser only accepts the configured
// scheme (the receiver's own URL handler), so a `manta-staging://pair?…`
// link cannot accidentally be claimed by a `manta://`-registered app —
// the OS shouldn't have routed it there in the first place, but the
// parser enforces the same boundary defensively. The build side picks
// up the channel's scheme via `channelConfig(channel).urlScheme` (the
// single source of truth, shared with the box emitter).
//
// The validation contract (32-hex boxId shape, 6-digit code, private
// server URL) is SINGLE-SOURCED: we delegate to normalizeCode
// (../../shared/claim.mjs), isValidBoxToken (../../shared/transport.mjs —
// the SAME 32-hex gate as src/server/webhooks.mjs isValidToken, kept in
// sync there for exactly this use case; the renderer cannot import from
// src/server/* because the box server pulls Node built-ins, which Vite's
// renderer build externalizes and the import then fails at build time),
// and isPrivateServerUrl (../../shared/transport.mjs — single source of
// truth for the ranges; every other consumer imports it from there).

import { normalizeCode } from "./claim.mjs";
import {
  isValidBoxToken,
  isPrivateServerUrl,
} from "./transport.mjs";
import { normalizeServerUrl } from "./setupLogic";

export type PairPayload = {
  boxId: string;
  code: string;
  /**
   * Optional server URL (BET-336, Tailscale path). When present, the
   * pairing flow claims against THIS URL instead of the derived public
   * hostname (`https://<boxId>.boxes.mantaui.com`) — so a Tailscale box
   * (no public hostname) can ship a working one-click / QR link.
   * Always set to the `normalizeServerUrl`-normalized form on the way
   * out, and gated by `isPrivateServerUrl` on the way in. Absent on
   * pre-BET-336 payloads and on any non-Tailscale emitter.
   */
  serverUrl?: string;
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
 * malformed / foreign input: not the expected pair URL (wrong scheme, wrong
 * host segment), missing box, or code not exactly 6 digits. Whitespace is
 * trimmed.
 *
 * Accepts the box form only (`box` + `code`, or `box` + `token` — the code
 * param has both spellings) and both URL shapes (custom `<scheme>://pair`
 * — see `scheme` below — and the `https://host/m/...` deferred-deeplink
 * form). The deprecated `server=` and `id=` addressing forms are
 * intentionally rejected.
 *
 * BET-373 (channel-aware wire format): the custom-scheme half only accepts
 * the configured `scheme` (default "manta" — unchanged for legacy callers).
 * The OS hands a URL to the app whose registered scheme matches, so a
 * `manta://` link landing in a `manta-staging://`-registered app would
 * already be a routing bug — but the parser enforces the same boundary
 * defensively so a wrong-channel payload can't sneak through. The query is
 * scheme-agnostic: the same `{boxId, code, serverUrl}` shape comes out
 * regardless of which scheme was used to deliver it.
 */
export function parsePairPayload(
  raw: string,
  scheme: string = "manta",
): PairPayload | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  // Only two families are pairing payloads:
  //   • <scheme>://pair?...      (custom scheme; host is "pair")
  //   • https://<host>/m/...   (deferred deeplink; path starts with /m/ or /m)
  // BET-373: the custom-scheme family now keys off the caller's `scheme`
  // arg (channel-aware), not a hardcoded `manta:` literal.
  const isChannelScheme = url.protocol === `${scheme}:`;
  const isHttps = url.protocol === "https:" || url.protocol === "http:";
  const isDeferredPath = /^\/m(\/|$)/.test(url.pathname);

  if (isChannelScheme) {
    // <scheme>://pair — the "pair" authority segment lands in DIFFERENT URL
    // fields depending on the engine, because custom schemes are
    // NON-SPECIAL schemes:
    //   • Node's URL           → url.hostname === "pair", pathname === ""
    //   • Chromium (renderer)  → url.hostname === "",     pathname === "//pair"
    // The parser originally checked only `url.hostname === "pair"`, which is
    // true in Node (where the unit tests run) but FALSE in the packaged
    // Electron renderer — so every real deep-link / pasted <scheme>:// link
    // was rejected in-app with "Couldn't read that pair link". Accept the
    // segment from either field (BET-240 regression).
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
  const rawServer = q.get("server") ?? "";

  const boxId = coerceBoxId(rawBox);
  if (!boxId) return null;

  const code = normalizeCode(rawCode);
  // normalizeCode strips non-digits and clamps to 6, so a 7-digit input would
  // pass length-6 but silently drop a digit. Guard against that by requiring
  // the raw code to contain exactly 6 digits (no more, no fewer).
  if (!/^\d{6}$/.test(code)) return null;
  if ((String(rawCode).match(/\d/g) ?? []).length !== 6) return null;

  // BET-336 (Tailscale pair link): when the link carries a server URL, it
  // MUST be a private / tailnet address — anything reachable from inside the
  // user's own network. A non-private server URL means the link is asking us
  // to point the app at an arbitrary host: we REFUSE the whole payload (not
  // silently drop the param), so a crafted link can never smuggle an
  // attacker-chosen address past the public-hostname default.
  let serverUrl: string | undefined;
  if (rawServer !== "") {
    const normalized = normalizeServerUrl(rawServer);
    if (normalized === null || !isPrivateServerUrl(normalized)) return null;
    serverUrl = normalized;
  }

  // A stray `verify` query param (old desktop QRs / deeplinks still in the
  // wild) is intentionally IGNORED — a present or even malformed value must
  // never refuse the payload anymore. The field is simply not read.
  return { boxId, code, serverUrl };
}

/**
 * Inverse of parsePairPayload: produce the canonical box-form custom-scheme
 * string
 *   <scheme>://pair?box=<url-encoded box_id>&code=<code>
 * Used as a round-trip oracle in tests and by the desktop QR panel +
 * install.sh heredoc. The boxId is URL-encoded so reserved characters
 * survive the query (32-hex has none today, but the encoder is the safe
 * default).
 *
 * BET-373 (channel-aware wire format): the `scheme` arg (default "manta")
 * lets the emitter pick the channel's own URL scheme — `manta://` for prod,
 * `manta-staging://` for staging, `manta-dev://` for dev — so the OS
 * routes the link back to the channel that scanned it. Callers should
 * pass `channelConfig(channel).urlScheme` (src/shared/channel.mjs) so
 * the literal lives in exactly one place.
 *
 * BET-336: when the payload carries a `serverUrl` (Tailscale pair link),
 * a `server=<url-encoded serverUrl>` query param is appended so the
 * receiving device can claim against the private/tailnet listener instead
 * of the derived public hostname. The current callers only feed this
 * helper with server URLs that have already passed `isPrivateServerUrl`,
 * so we do NOT re-validate here (the constructor is a thin encoder).
 */
export function buildPairPayload(p: PairPayload, scheme: string = "manta"): string {
  let base = `${scheme}://pair?box=${encodeURIComponent(p.boxId)}&code=${p.code}`;
  if (p.serverUrl) {
    base += `&server=${encodeURIComponent(p.serverUrl)}`;
  }
  return base;
}

/**
 * The accepted host for the Manta universal (https) pairing link. Universal
 * links have ONE registered host — there is deliberately no per-channel
 * variant (BET-703). Reused here so `buildUniversalPairLink` and the Swift
 * parser share the literal even though they live in different repos.
 */
export const UNIVERSAL_LINK_HOST = "app.mantaui.com";

/**
 * Build the deferred-deeplink https form of a pairing payload:
 *   https://<UNIVERSAL_LINK_HOST>/m?box=<url-encoded box_id>&code=<code>[&server=<url-encoded serverUrl>]
 *
 * This is what a camera scan of a QR opens when the Manta app is NOT yet
 * installed — the OS resolves the universal link and hands off to the App
 * Store / app (BET-703). The path is `/m` (the Swift parser accepts both
 * `/m` and `/m/`), and the host is the single `UNIVERSAL_LINK_HOST` — never
 * parameterized by channel, unlike the custom-scheme `buildPairPayload`.
 *
 * BET-336: when the payload carries a `serverUrl` (Tailscale / tailnet
 * path, a box with no public hostname), a `server=<url-encoded serverUrl>`
 * query param is appended so the receiving device claims against the
 * private/tailnet listener instead of the derived public hostname. As with
 * `buildPairPayload`, callers only feed server URLs that already passed
 * `isPrivateServerUrl`, so we do NOT re-validate here (thin encoder).
 */
export function buildUniversalPairLink(p: PairPayload): string {
  let base = `https://${UNIVERSAL_LINK_HOST}/m?box=${encodeURIComponent(p.boxId)}&code=${p.code}`;
  if (p.serverUrl) {
    base += `&server=${encodeURIComponent(p.serverUrl)}`;
  }
  return base;
}
