// transport.mjs — pure transport-mode detection + per-box URL helpers +
// pairing-response parsing.
//
// BET-82 (M6 desktop HTTP-only) removed the SSH main path. BET-198 dropped the
// relay — every box now serves its own public hostname directly. The desktop
// (and mobile) only ever use httpApi (Bearer token, /rpc, /events WS) against
// manta-server, pointed at `https://<boxId>.boxes.mantaui.com` (see
// `boxDirectUrl` below). `resolveTransportMode` collapses to two states:
// "http" (paired, valid boxToken) or "onboarding" (fresh install → full-screen
// onboarding flow).
//
// Pure + framework-free (no Electron, no Node built-ins beyond nothing) so both
// the `.ts` sides (renderer entry, main config) and any `.mjs` server code can
// import it. Tested in src/shared/transport.test.ts. The 32-hex token rule is
// the SAME shape as src/server/auth.mjs `isValidToken` — kept in sync here so
// the desktop rejects a malformed claim response before persisting it.

// A box_id / box_token is exactly 32 lowercase hex chars (128 bits). Strict, so
// a malformed value can never smuggle a path-traversal / header-injection
// payload into a Bearer header. Mirrors src/server/auth.mjs isValidToken.
export function isValidBoxToken(token) {
  return typeof token === "string" && /^[0-9a-f]{32}$/.test(token);
}

// ---------------------------------------------------------------------------
// Per-box direct hostname (BET-198 — relay dropped)
// ---------------------------------------------------------------------------
//
// Post-BET-198 the relay is gone: every box now serves its own public hostname
// (`<boxId>.boxes.mantaui.com`) which terminates TLS at the gateway and
// proxies to the box's local manta-server. The desktop + mobile clients point
// httpApi at this URL directly — there is no intermediary relay hop.
//
// `BOXES_DOMAIN` is the single source for the suffix; `boxDirectUrl` builds
// the canonical `https://<boxId>.<BOXES_DOMAIN>` shape that every direct-mode
// caller persists (desktop config.serverUrl, mobile localStorage "manta_server").
// Throws on a malformed boxId so a junk value can never smuggle a
// path-traversal / host-injection payload into a fetch URL.
//
// Mirrors the BOXES_DOMAIN constant in src/gateway/index.mjs (server-side,
// non-exported) — the two are intentionally kept as plain string literals so
// neither side has to import the other.
export const BOXES_DOMAIN = "boxes.mantaui.com";

export function boxDirectUrl(boxId) {
  if (!isValidBoxToken(boxId)) {
    throw new Error("boxDirectUrl: boxId must be a 32-hex token");
  }
  return `https://${boxId}.${BOXES_DOMAIN}`;
}

// Decide which transport a config should use. Post-BET-82 there is only one
// transport path (httpApi) — this function exists to let App.tsx decide whether
// to show the onboarding shell or the normal app shell:
//
//   1. boxToken set (valid 32-hex)  → "http"       (paired to a manta-server)
//   2. else                         → "onboarding" (fresh install → full-screen
//                                                    onboarding flow)
//
// "ssh" is gone — the SSH main path was deleted in BET-82. `onboardingSkipped`
// is no longer consulted; a skipped-onboarding config without a boxToken still
// resolves to "onboarding" (the flow re-runs via "Run setup again" in Settings).
export function resolveTransportMode(config) {
  const cfg = config && typeof config === "object" ? config : {};
  if (isValidBoxToken(cfg.boxToken)) return "http";
  return "onboarding";
}

// ---------------------------------------------------------------------------
// Desktop transport SELECTION (BET-82: always httpApi)
// ---------------------------------------------------------------------------
//
// Post-BET-82 the desktop always uses httpApi. `selectDesktopTransport` is
// kept as a thin wrapper for API compatibility — it always returns "http".
// The real preload (Electron-local affordances: clipboard, reveal-in-folder,
// OS notifications) is preserved as `window.__mantaPreload`; `window.api` is
// replaced with httpApi unconditionally.
//
// `hasPreload` is passed in (the caller checks `!!window.api`) so this stays
// framework-free and unit-testable. When there is NO preload at all (the mobile
// /web build), the caller never reaches here — main.tsx branches on that first.
export function selectDesktopTransport(_config, hasPreload) {
  // No preload → not a desktop context; the mobile/web entry path owns this.
  // Defensive: report "http" so a caller that mis-invokes us still gets the
  // server-backed client rather than a non-existent preload.
  if (!hasPreload) return "http";
  // SSH main path is gone (BET-82); desktop always uses httpApi.
  return "http";
}

// The two localStorage keys the httpApi client reads for its base URL + token
// (see src/renderer/api/httpApi.ts serverBase()/clientToken(): "manta_server" and
// "manta_token"). On the desktop the paired credentials live in config.json
// (serverUrl + boxToken), not localStorage — so before installing httpApi we
// SEED these keys from config. Pure: returns the {key,value} pairs to write so
// the seeding is testable without a DOM. Returns null when the config isn't a
// valid paired http config (missing serverUrl or an invalid boxToken), so the
// caller can refuse to install a broken client.
export function desktopHttpClientSeed(config) {
  const cfg = config && typeof config === "object" ? config : {};
  const serverUrl = typeof cfg.serverUrl === "string" ? cfg.serverUrl.trim() : "";
  if (serverUrl === "" || !isValidBoxToken(cfg.boxToken)) return null;
  return {
    manta_server: serverUrl.replace(/\/+$/, ""),
    manta_token: cfg.boxToken,
  };
}

// ---------------------------------------------------------------------------
// Private-network server-URL gate (BET-336 — Tailscale pair-link carry).
// ---------------------------------------------------------------------------
//
// The pairing link `manta://pair?box=&code=&server=` may carry the box's
// listener URL so a Tailscale box (no public hostname) can ship a
// one-click / QR pair link. The risk: a crafted link could point the app at
// an attacker's server. Mitigation: the link-supplied URL must be a
// PRIVATE / tailnet address — anything reachable from inside the user's own
// network, where an attacker already has better options than a pair link.
// This is consistent with how these boxes already work: plain HTTP inside
// the WireGuard tunnel, where the network IS the trust boundary.
//
// Accepted host families (single source of truth — every consumer in
// parsePairPayload, pair.html, pairPage.mjs, and scripts/install-lib.mjs
// imports THIS function; do not copy the ranges elsewhere or the rule will
// silently drift):
//   • localhost
//   • IPv4 in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (RFC 1918 private)
//   • IPv4 in 100.64.0.0/10 (CGNAT — the range Tailscale allocates from)
//   • IPv4 in 127.0.0.0/8 (loopback, in case the box is the same machine)
//   • hostnames ending in .ts.net (Tailscale MagicDNS)
//
// Explicitly REJECTED:
//   • any other IPv4 (public addresses — they have a real public hostname
//     path, never need this link-supplied override)
//   • all IPv6 literals (out of scope — rejecting them is the intended
//     behaviour, not an oversight)
//   • non-http(s) schemes (file://, ftp://, ws://, …)
//   • unparseable input, non-string input, bare hosts with no scheme
//
// Returns true only when the input parses as an http(s) URL AND its host
// is in one of the accepted families above. Pure; no I/O.
//
// IPv4 ranges are checked by parsing the dotted-quad ourselves (four
// integer octets, each 0–255) — no dependency, no library; mirrors the
// hand-rolled shape-gates elsewhere in this file (isValidBoxToken).
export function isPrivateServerUrl(raw) {
  if (typeof raw !== "string" || raw === "") return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  if (host === "") return false;
  if (host === "localhost") return true;
  if (host.endsWith(".ts.net")) return true;
  return isPrivateIPv4(host);
}

// True iff `host` is a dotted-quad IPv4 in one of the accepted ranges.
// Returns false for IPv6 literals, hostnames, and dotted-quads outside the
// private/CGNAT/loopback ranges. Public IPv4 → false (those have their own
// boxes.mantaui.com hostname path; the link-supplied override must never
// reach them).
function isPrivateIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = new Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (p.length === 0 || p.length > 3) return false;
    // No leading zeros — "01" is not a valid IPv4 octet per WHATWG URL
    // parser semantics and we want consistent rejection.
    if (p.length > 1 && p[0] === "0") return false;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    octets[i] = n;
  }
  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 172.16.0.0/12 (172.16 – 172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (CGNAT — Tailscale allocates from here)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// Validate + normalize the JSON body of a successful POST /auth/claim response.
// The server returns { ok, box_token, box_id } (see src/server/auth.mjs claim()).
// We only trust it once BOTH tokens match the 32-hex shape — a wrong shape means
// the endpoint is misbehaving (or is not a manta-server at all), and persisting a
// junk boxToken would flip the config into a broken "http" mode with an
// unusable Bearer credential.
//
// Returns:
//   { ok: true,  boxToken, boxId }                       — valid claim
//   { ok: false, error: "invalid_response" }             — missing/malformed fields
//
// Note: this does NOT interpret HTTP status codes (403 wrong code, 429 rate
// limit, network error) — the caller handles transport-level failures and only
// hands a parsed JSON body here. A non-object body is treated as invalid.
export function parseClaimResponse(json) {
  if (!json || typeof json !== "object") {
    return { ok: false, error: "invalid_response" };
  }
  const boxToken = json.box_token;
  const boxId = json.box_id;
  if (!isValidBoxToken(boxToken) || !isValidBoxToken(boxId)) {
    return { ok: false, error: "invalid_response" };
  }
  return { ok: true, boxToken, boxId };
}
