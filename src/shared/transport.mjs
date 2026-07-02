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
