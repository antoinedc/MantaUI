// unpair.mjs — pure, framework-free classification of a "remove box" outcome.
//
// One wire shape (BET-357 §2): the desktop sends DELETE <serverUrl>/auth/revoke
// with the current box_token as a Bearer header, and the box server (see
// src/server/auth.mjs revoke() + index.mjs DELETE /auth/revoke handler) does
// one of:
//
//   200 { ok: true, box_id }       — revoke succeeded; the box rotated its
//                                    identity and the old token is dead. The
//                                    desktop's local config is cleared.
//   400 { error: "malformed token"} — the presented token wasn't 32-hex. The
//                                    desktop couldn't have produced this from
//                                    its own stored token (which the store
//                                    validates on write), so this signals
//                                    drift between desktop and box config
//                                    shapes — a manual debug aid, not a
//                                    normal flow.
//   401 { error: "unauthorized" }   — no Authorization header, or the
//                                    presented token doesn't match. The desktop
//                                    surfaces this as "auth rejected" so the
//                                    user knows their local token is stale and
//                                    a re-pair is the only path forward.
//   429 { error: "rate limited" }   — too many attempts. The /auth/* surface
//                                    is rate-limited per client IP.
//   5xx                              — server-side error.
//   fetch rejected (no response)    — offline, DNS, TLS, connection refused,
//                                    timeout. The "unreachable box" path that
//                                    the desktop must handle gracefully
//                                    (BET-357 §2 — "still succeed locally with
//                                    a note").
//
// Reached from two places that must agree on how an HTTP outcome maps to a
// user-facing result:
//   • the desktop main process (src/main/unpair.ts) — does the fetch, then
//     classifies via this helper.
//   • any future mobile or web caller — same wire, same shape.
//
// Pure (no fetch, no DOM, no Node built-ins) → unit-tested in
// src/shared/unpair.test.ts.

// User-facing copy for each failure category. Kept short — rendered inline
// next to the "Remove box" action.
const FAILURE_MESSAGE = {
  network: "Couldn't reach the box. The box's token will be cleared locally only — re-pair to use it again.",
  bad_request: "The local token is malformed. Remove this box and re-pair from scratch.",
  auth_rejected: "The box rejected this device's token. Clear locally and re-pair.",
  server_error: "The box had a problem. Clear locally and try again later.",
  unexpected: "Unexpected response from the box. Clear locally and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  method_not_allowed: "The box doesn't support removing boxes this way.",
};

function fail(kind) {
  return { ok: false, kind, message: FAILURE_MESSAGE[kind] };
}

/**
 * Classify a DELETE /auth/revoke outcome into a typed UnpairOutcome.
 *
 * The signature follows the issue spec (`remoteOk, remoteError`) so the
 * caller's job is purely "translate the fetch result into these two values":
 *
 *   on HTTP 200                 → classifyUnpairResult(true, null)
 *   on HTTP 400 (malformed)     → classifyUnpairResult(false, "bad_request")
 *   on HTTP 401 (no/wrong tok)  → classifyUnpairResult(false, "auth_rejected")
 *   on HTTP 429                 → classifyUnpairResult(false, "rate_limited")
 *   on HTTP 405                 → classifyUnpairResult(false, "method_not_allowed")
 *   on HTTP 5xx                 → classifyUnpairResult(false, "server_error")
 *   on fetch rejected (any)     → classifyUnpairResult(false, "network")
 *   on any other status         → classifyUnpairResult(false, "unexpected")
 *
 * @param {boolean} remoteOk     True ONLY for a successful 200. A successful
 *                                revoke means the server rotated its identity
 *                                and the desktop's local credentials are dead
 *                                on the box side too.
 * @param {string|null} remoteError  The classified error kind. One of
 *                                "network" | "bad_request" | "auth_rejected"
 *                                | "server_error" | "unexpected" |
 *                                "rate_limited" | "method_not_allowed".
 *                                Ignored when remoteOk is true (defensive —
 *                                a buggy caller that passes both true and an
 *                                error still gets a clean ok result).
 * @returns {UnpairOutcome}
 */
export function classifyUnpairResult(remoteOk, remoteError) {
  if (remoteOk === true) return { ok: true };
  if (remoteError == null) {
    // remoteOk=false but no error tag → treat as network (the safest
    // fallback — never mis-attribute a "no response" as a server-side fault).
    return fail("network");
  }
  switch (remoteError) {
    case "network":
    case "bad_request":
    case "auth_rejected":
    case "server_error":
    case "unexpected":
    case "rate_limited":
    case "method_not_allowed":
      return fail(remoteError);
    default:
      // Unknown error tag → surface as "unexpected" rather than crashing the
      // renderer's Settings panel with an unmapped kind.
      return fail("unexpected");
  }
}

/**
 * Convenience: produce the (remoteOk, remoteError) tuple from a raw fetch
 * result. The caller performs the fetch, then hands the parsed pieces here
 * to get a UnpairOutcome in one step. Mirrors `classifyClaimResult`'s shape
 * (status + body) so the two classifier entry points look the same to readers.
 *
 * @param {object} args
 *   @param {number|null} args.status       HTTP status, or null when fetch
 *                                          never produced a response.
 *   @param {string|null} [args.networkError] Optional tag for the fetch-level
 *                                          failure ("timeout", "connection_refused",
 *                                          "dns", "tls", …). Surfaced as
 *                                          "network" regardless of the tag —
 *                                          the desktop's UX collapses all
 *                                          fetch failures into one outcome.
 * @returns {UnpairOutcome}
 */
export function classifyUnpairHttp({ status, networkError } = {}) {
  // A non-null networkError means fetch rejected BEFORE producing an HTTP
  // response (TLS / DNS / connection refused / timeout). It trumps any status
  // — even a coincidental 200 wouldn't be trustworthy when the request never
  // reached the wire.
  if (status == null || networkError) return fail("network");
  if (status === 200) return { ok: true };
  if (status === 400) return fail("bad_request");
  if (status === 401) return fail("auth_rejected");
  if (status === 405) return fail("method_not_allowed");
  if (status === 429) return fail("rate_limited");
  if (status >= 500 && status < 600) return fail("server_error");
  return fail("unexpected");
}
