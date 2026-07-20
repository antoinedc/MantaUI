// transport.mjs — pure transport-mode detection + per-box URL helpers +
// pairing-response parsing.
//
// BET-82 (M6 desktop HTTP-only) removed the SSH main path. BET-198 dropped the
// relay — every box now serves its own public hostname directly. The desktop
// (and mobile) only ever use httpApi (Bearer token, /rpc, /events WS) against
// bui-server, pointed at `https://<boxId>.boxes.mantaui.com` (see
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
// proxies to the box's local bui-server. The desktop + mobile clients point
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
//   1. boxToken set (valid 32-hex)  → "http"       (paired to a bui-server)
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
// OS notifications) is preserved as `window.__buiPreload`; `window.api` is
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

// Validate + normalize the JSON body of a successful POST /auth/claim response.
// The server returns { ok, box_token, box_id } (see src/server/auth.mjs claim()).
// We only trust it once BOTH tokens match the 32-hex shape — a wrong shape means
// the endpoint is misbehaving (or is not a bui-server at all), and persisting a
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
