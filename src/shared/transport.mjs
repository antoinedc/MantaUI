// transport.mjs — pure transport-mode detection + pairing-response parsing.
//
// BET-49 (M6 desktop onboarding) adds a second way for the desktop to reach the
// box: HTTP/WS against bui-server (`Authorization: Bearer <box_token>`) instead
// of the legacy SSH+tmux transport. Which one a given config uses is decided
// entirely by which credentials are present. This module is the single source
// of truth for that decision + for validating the /auth/claim response the
// desktop persists.
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

// Decide which transport a config should use. The rule is credential-driven and
// intentionally order-sensitive:
//
//   1. boxToken set (valid 32-hex)  → "http"       (paired to a bui-server)
//   2. else host set (non-empty)    → "ssh"        (legacy / power mode)
//   3. else onboardingSkipped true  → "ssh"        (user opted out of setup;
//                                                    lands in the normal empty
//                                                    app in its SSH-configurable
//                                                    state — no host yet, so the
//                                                    existing cfg.host="" gating
//                                                    keeps the shell empty until
//                                                    they add a host in Settings)
//   4. else                         → "onboarding" (fresh install → full-screen
//                                                    onboarding flow)
//
// Design note (step 3): a skipped-onboarding config has neither a boxToken nor a
// host, so functionally it behaves exactly like today's default empty SSH
// config — store.ts gates all remote calls on cfg.host being set. We report
// "ssh" (not "onboarding") specifically so App.tsx renders the normal shell
// instead of re-triggering the onboarding modal. "http" is impossible without a
// token; "onboarding" is impossible once the user has explicitly skipped.
export function resolveTransportMode(config) {
  const cfg = config && typeof config === "object" ? config : {};
  if (isValidBoxToken(cfg.boxToken)) return "http";
  if (typeof cfg.host === "string" && cfg.host.trim() !== "") return "ssh";
  if (cfg.onboardingSkipped === true) return "ssh";
  return "onboarding";
}

// ---------------------------------------------------------------------------
// Desktop transport SELECTION (BET-49-T6 / BET-58)
// ---------------------------------------------------------------------------
//
// On the DESKTOP (Electron), the preload bridge always sets window.api — that's
// the legacy SSH+tmux transport. But once a user pairs to a bui-server, their
// config resolves to "http" and the desktop should talk to that server over the
// SAME httpApi client the mobile/web build uses (Bearer token, /rpc, /events
// WS), NOT the SSH bridge. So the presence of window.api is NOT sufficient to
// pick the transport — the resolved config mode decides.
//
// `selectDesktopTransport` is the single, pure decision:
//   • "http"    — config is paired (valid boxToken) → install httpApi as
//                 window.api, keeping the real preload for Electron-local
//                 affordances (clipboard, reveal-in-folder, OS notifications).
//   • "preload" — everything else (SSH mode, onboarding, skipped) → keep the
//                 preload bridge exactly as before. SSH users are unaffected.
//
// `hasPreload` is passed in (the caller checks `!!window.api`) so this stays
// framework-free and unit-testable. When there is NO preload at all (the mobile
// /web build), the caller never reaches here — main.tsx branches on that first.
export function selectDesktopTransport(config, hasPreload) {
  // No preload → not a desktop context; the mobile/web entry path owns this.
  // Defensive: report "http" so a caller that mis-invokes us still gets the
  // server-backed client rather than a non-existent preload.
  if (!hasPreload) return "http";
  return resolveTransportMode(config) === "http" ? "http" : "preload";
}

// The two localStorage keys the httpApi client reads for its base URL + token
// (see src/renderer/api/httpApi.ts serverBase()/clientToken(): "bui_server" and
// "bui_token"). On the desktop the paired credentials live in config.json
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
    bui_server: serverUrl.replace(/\/+$/, ""),
    bui_token: cfg.boxToken,
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
