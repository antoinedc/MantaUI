// Pure exponential backoff delay computation.
//
// Separate from `ExponentialBackoff` (stateful scheduler): this function takes
// the attempt number as a parameter (no internal counter) and the jitter
// value explicitly, so a test can pin the exact delay without driving a
// scheduler forward. The WsReconnectController (renderer/net/wsTransport.ts)
// keeps using ExponentialBackoff to drive the timer loop; this helper is the
// pure, testable "what's the delay for attempt N?" calculation the issue asks
// for — used by new unit tests and as a documented building block for any
// future caller that wants to recompute the next delay without instantiating
// a stateful scheduler.
//
// Semantics:
//   delay(attempt) = min(baseMs * 2^attempt, capMs) * jitterFactor
//
// `jitterFactor` is a multiplier in [0, 1]:
//   jitterFactor = 1.0 → no jitter reduction (full delay)
//   jitterFactor = 0.5 → half the full delay (decorrelated-jitter midpoint)
//   jitterFactor = 0.0 → zero delay (effectively disabled backoff)
//
// Production callers typically pass `Math.random()` so each call produces a
// uniformly-random delay in `[0, min(baseMs * 2^attempt, capMs))`. Tests pass
// a deterministic `jitterFactor` to pin the exact return value.
//
// The function is total — it never throws on extreme inputs. Every field is
// sanitized: NaN → 0, negative → clamped, non-integer attempts are floored,
// `capMs < baseMs` is silently raised to `baseMs` (a cap below the base is
// incoherent — the result would be the base for attempt 0 anyway, so
// promoting the cap makes the function self-consistent for any caller).
// Returns an integer ms (floored) so callers scheduling timers see clean
// numbers regardless of the input floats.

export interface NextBackoffDelayOpts {
  /** 0-indexed attempt number; clamped to a non-negative integer. */
  attempt: number;
  /** Base delay in ms for attempt 0; clamped to ≥ 0. */
  baseMs: number;
  /** Per-attempt cap in ms; the geometric growth is capped here. If below
   *  `baseMs`, silently raised to `baseMs` (see file header). Clamped to ≥ 0. */
  capMs: number;
  /** Jitter multiplier in [0, 1]; values outside the range are clamped. */
  jitterFactor: number;
}

export function nextBackoffDelay(opts: NextBackoffDelayOpts): number {
  const attempt = sanitizeAttempt(opts.attempt);
  const baseMs = sanitizeNonNeg(opts.baseMs);
  const capMs = Math.max(baseMs, sanitizeNonNeg(opts.capMs));
  const jitter = sanitizeUnit(opts.jitterFactor);
  const computed = baseMs * Math.pow(2, attempt);
  const capped = Math.min(computed, capMs);
  return Math.floor(capped * jitter);
}

function sanitizeAttempt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function sanitizeNonNeg(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function sanitizeUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
