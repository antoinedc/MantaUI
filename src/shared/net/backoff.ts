// Pure exponential backoff with optional full-jitter.
//
// Importable from both the Electron main process and the renderer — no
// Electron/Node-only APIs. Deterministic under an injectable RNG so tests can
// pin jitter bounds.
//
// The delay formula is centralized in `nextBackoffDelay` (./backoffDelay.ts) —
// this class is a thin stateful wrapper that owns the attempt counter and
// injects the jitter source. Per BET-365 / BET-357 §1, the schedule (when
// does the next retry fire?) is separated from the dispatcher (the controller
// that actually opens the socket). The formula lives in one place so the
// scheduler and any pure test agree on the exact same computation.

import { nextBackoffDelay } from "./backoffDelay.js";

export interface ExponentialBackoffOpts {
  /** Base delay in ms for the first attempt (attempt 0). */
  base: number;
  /** Maximum delay in ms; the computed delay is capped at this value. */
  max: number;
  /** Growth multiplier per attempt. Defaults to 2. */
  factor?: number;
  /** Apply full-jitter (`random(0, computed)`) when true. Defaults to true. */
  jitter?: boolean;
  /** Injectable RNG returning a float in [0, 1). Defaults to Math.random. */
  rng?: () => number;
}

/**
 * Exponential backoff generator.
 *
 * The delay for attempt `n` (0-indexed) is `base * factor ** n`, capped at
 * `max`. With jitter enabled, full-jitter is applied: the returned value is a
 * uniform random in `[0, computed]`. `next()` increments the internal attempt
 * counter each call.
 *
 * NOTE: the actual computation is delegated to the pure `nextBackoffDelay`
 * helper; this class owns only the attempt counter and the jitter source. The
 * helper hard-codes factor=2 — `factor` is currently not honored by the pure
 * helper, so callers wanting a non-binary backoff must instantiate
 * `ExponentialBackoff` (or extend the helper) rather than call
 * `nextBackoffDelay` directly. The helper is intentionally minimal: it covers
 * the common binary-jitter case the BET-357 §1 reconnect path needs, and is
 * the testable schedule the issue asks for.
 */
export class ExponentialBackoff {
  private readonly base: number;
  private readonly max: number;
  private readonly factor: number;
  private readonly jitter: boolean;
  private readonly rng: () => number;
  private attemptCount = 0;

  constructor(opts: ExponentialBackoffOpts) {
    this.base = opts.base;
    this.max = opts.max;
    this.factor = opts.factor ?? 2;
    this.jitter = opts.jitter ?? true;
    this.rng = opts.rng ?? Math.random;
  }

  /**
   * Returns the next delay in ms and increments the attempt counter.
   * The uncapped growth is `base * factor ** attempt`; the result is capped at
   * `max`, then (if jitter is on) reduced to a uniform random in `[0, capped]`.
   *
   * For the default factor=2 binary backoff (the only path the pure
   * `nextBackoffDelay` helper currently supports) we delegate. For custom
   * factors we fall back to the original inline formula to preserve existing
   * behavior (custom factor is an opt-in; callers can rely on this).
   */
  next(): number {
    this.attemptCount += 1;
    if (this.factor !== 2) {
      // Custom factor: keep the original inline math, since the pure helper
      // only supports binary growth.
      const computed = this.base * Math.pow(this.factor, this.attemptCount - 1);
      const capped = Math.min(computed, this.max);
      if (!this.jitter) return capped;
      return this.rng() * capped;
    }
    return nextBackoffDelay({
      attempt: this.attemptCount - 1,
      baseMs: this.base,
      capMs: this.max,
      jitterFactor: this.jitter ? this.rng() : 1,
    });
  }

  /** Reset the attempt counter back to 0. */
  reset(): void {
    this.attemptCount = 0;
  }

  /** Current attempt count (number of times `next()` has been called since reset). */
  attempt(): number {
    return this.attemptCount;
  }
}
