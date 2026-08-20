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

export function depletionFactor(balance: number | undefined): number;

export function marginalCost(input: {
  model?: MargCostModel | null;
  account?: AccountState | null;
  nowMs?: number;
  mix?: unknown;
  reference?: unknown;
  replacementCost?: number;
}): MarginalCostResult;
