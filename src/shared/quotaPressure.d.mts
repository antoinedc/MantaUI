// quotaPressure.mjs — pure deficit-queue / shadow-price / eco math (Optimizer
// P2.3, BET-1345). Typed for the renderer/TS consumer; the implementation is
// the shared .mjs.

export const OPTIMIZER_LYAPUNOV_V: number;
export const PROTECTION_V_LOW: number;
export const PROTECTION_V_HIGH: number;
export const PROTECTION_QUANTILE: number;
export const PROTECTION_LAMBDA_MULTIPLIER: number;
export const MIN_TOKENS_PER_PCT_SAMPLE: number;
export const ECO_THRESHOLDS: number[];

export interface SeedDeficitInput {
  pct?: number;
  startedAt?: number;
  resetsAt?: number;
  now?: number;
}
export function seedDeficit(input?: SeedDeficitInput): number;

export interface AdvanceDeficitInput {
  prev?: number;
  pct?: number;
  prevPct?: number;
  resetsAt?: number;
  now?: number;
  prevNow?: number;
}
export function advanceDeficit(input?: AdvanceDeficitInput): number;

export function shadowPrice(deficit: number): number;
export function ecoLevel(maxDeficit: number): 0 | 1 | 2 | 3;
export function quantile(sorted: number[], q: number): number | null;

export interface ProtectionActiveInput {
  rates?: number[];
  hoursUntilReset?: number;
  remainingPct?: number;
}
export function protectionActive(input?: ProtectionActiveInput): boolean;
