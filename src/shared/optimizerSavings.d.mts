// Type declarations for optimizerSavings.mjs (the pure per-model savings
// pricing shared by the optimizer series + card, BET-1370).

// opencode's normalised per-model cost, $/Mtok. `undefined` means unknown
// (NOT zero — "free" is a deliberate declared 0).
export interface OptimizerCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// The resolved per-model prompt-side rate, plus the cache rates used for the
// re-warm subtraction (missing cache rates bill at the full input rate).
export interface PromptSideRate {
  rate: number;
  known: boolean;
  cacheRead: number;
  cacheWrite: number;
}

export type SavingsBasis = "measured" | "partial" | "unpriced";

// savedUsd's result. `usd` is null only for the "unpriced" set (tokens exist
// but none are priceable); the genuinely-empty set is 0 with basis "measured".
export interface SavingsResult {
  usd: number | null;
  basis: SavingsBasis;
  pricedShare: number;
}

export function promptSideRate(cost?: OptimizerCost | null, mix?: unknown): PromptSideRate;

export function savedUsd(args: {
  byModel?: Record<string, number>;
  rewarmTokens?: number;
  rates?: Record<string, PromptSideRate>;
}): SavingsResult;
