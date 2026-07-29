// Hand-written type declarations for unpair.mjs. Implementation is plain JS so
// both the renderer tsconfig and the main tsconfig import it without crossing
// the process boundary. Keep in sync with src/shared/unpair.mjs.

// Why an unpair (DELETE /auth/revoke) attempt failed, mapped to a stable UI
// category. The renderer decides whether to surface the note inline (a
// transient "couldn't reach the box" is normal during network blips) versus
// forcing the user through a re-pair flow.
export type UnpairFailureKind =
  | "network" // fetch rejected — offline, DNS, TLS, connection refused, timeout
  | "bad_request" // 400 — the presented token wasn't 32-hex (desktop drift)
  | "auth_rejected" // 401 — the box didn't recognize the device's token
  | "method_not_allowed" // 405 — server doesn't support revoke on this path
  | "rate_limited" // 429 — too many attempts
  | "server_error" // 5xx — server-side error
  | "unexpected"; // any other status (404, 418, ...)

// The outcome of a DELETE /auth/revoke, classified for the UI. On success the
// desktop MUST clear its local config (serverUrl/boxId/boxToken/projects) —
// see src/main/unpair.ts and the "Remove box" Settings action. On a failure
// the desktop also clears locally (the unreachable-box path) but surfaces the
// remoteError kind so the user sees a structured note that remote revocation
// didn't happen.
export type UnpairOutcome =
  | { ok: true }
  | { ok: false; kind: UnpairFailureKind; message: string };

// Map an (remoteOk, remoteError) tuple to a typed UnpairOutcome. The literal
// signature from the issue spec — callers classify the raw fetch result into
// the two args, then hand them here.
export function classifyUnpairResult(
  remoteOk: boolean,
  remoteError: string | null | undefined,
): UnpairOutcome;

// One-step convenience: pass the raw HTTP outcome (status + optional
// networkError tag) and get a UnpairOutcome. Mirrors classifyClaimResult's
// shape so the two classifier entry points read the same way. `status` is
// optional in the type because the implementation falls back to "network"
// for `{}` / `{ status: undefined }` — the desktop's Settings panel relies
// on this defensive behavior so a half-broken fetch can't crash the
// renderer.
export function classifyUnpairHttp(args?: {
  status?: number | null;
  networkError?: string | null;
}): UnpairOutcome;
