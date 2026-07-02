// Pure exponential backoff with optional full-jitter.
//
// Importable from both the Electron main process and the renderer — no
// Electron/Node-only APIs. Deterministic under an injectable RNG so tests can
// pin jitter bounds.

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
   */
  next(): number {
    const computed = this.base * Math.pow(this.factor, this.attemptCount);
    const capped = Math.min(computed, this.max);
    this.attemptCount += 1;
    if (!this.jitter) return capped;
    return this.rng() * capped;
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
