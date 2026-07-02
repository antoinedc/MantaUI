// Hand-written type declarations for claim.mjs. Implementation is plain JS so
// both the renderer tsconfig and the main tsconfig import it without crossing
// the process boundary. Keep in sync with src/shared/claim.mjs.

// Why a claim attempt failed, mapped to a stable UI category.
export type ClaimFailureKind =
  | "wrong_code" // 400/403 — invalid / expired / already-used code
  | "rate_limited" // 429 — too many attempts
  | "invalid_response" // 200 but body wasn't a valid { box_token, box_id }
  | "network" // fetch rejected / server unreachable
  | "server_error"; // 5xx or any other unexpected status

// The outcome of a POST /auth/claim, classified for the UI to render. On
// success the tokens are validated 32-hex (via parseClaimResponse).
export type ClaimOutcome =
  | { ok: true; boxToken: string; boxId: string }
  | { ok: false; kind: ClaimFailureKind; message: string };

// Strip non-digits and clamp to the first 6 digits.
export function normalizeCode(raw: string): string;

// True when `code` is exactly 6 digits.
export function isSubmittableCode(code: string): boolean;

// Map an /auth/claim HTTP outcome (status + parsed body) to a ClaimOutcome.
export function classifyClaimResult(status: number, body: unknown): ClaimOutcome;

// The ClaimOutcome for a fetch that never produced an HTTP response.
export function networkFailure(): ClaimOutcome;
