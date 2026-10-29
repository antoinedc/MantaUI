export function formatEndpointStateLine(detail: { state: string; [k: string]: unknown } | null | undefined, nowMs: number): string;
export function accountsErrorMessage(code: string | undefined): string;
export function seatSignInFailureMessage(a: { error?: string; timedOut?: boolean }): string;
export function resignFailureMessage(a: {
  error?: string;
  timedOut?: boolean;
  expectedEmail?: string | null;
  gotEmail?: string | null;
  seatLabel?: string;
  email?: string | null;
}): string;
