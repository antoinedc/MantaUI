export const CREDIT_PREMIUM: number;
export const CREDIT_DEPLETION_FLOOR: number;
export const CREDIT_DEPLETION_SLOPE: number;
export const CREDIT_DEPLETION_EPSILON: number;
export const RESET_RAMP_MS: number;
export const SUBSCRIPTION_PACE_EXPONENT: number;
export const PACING_EPSILON: number;

export interface WindowState {
  kind?: string;
  pct?: number;
  startedAt?: number;
  resetsAt?: number;
  binding?: boolean;
  stale?: boolean;
}

export interface AccountState {
  kind?: "subscription" | "credit" | "none" | string;
  windows?: WindowState[];
  balance?: number;
  overagePrice?: number;
  exhausted?: boolean;
}

export interface MargCostModel {
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface MarginalCostResult {
  cost: number;
  exhausted: boolean;
  basis: string;
  reason: string;
}

/** Optimizer P2.3 (BET-1345): the pacing shadow price, additive on the
 *  subscription pace curve. Absent on a credit account and anywhere the deficit
 *  queue does not exist. */
export interface ShadowPriceInput {
  lambda: number;
  tokensPerPct: number | null;
  protection?: boolean;
}

export function depletionFactor(balance: number | undefined): number;

export function marginalCost(input: {
  model?: MargCostModel | null;
  account?: AccountState | null;
  nowMs?: number;
  mix?: unknown;
  reference?: unknown;
  replacementCost?: number;
  expectedTurnTokens?: number;
  isLowStakes?: boolean;
  shadowPrice?: ShadowPriceInput;
}): MarginalCostResult;
