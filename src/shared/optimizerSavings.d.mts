// Type declarations for optimizerSavings.mjs (the pure per-report pricing and
// window summing shared by the optimizer store + series, sticky-trims §5.2).

// The exact $/Mtok the plugin's gate used for one request.
export interface TrimRates {
  cacheRead: number;
  cacheWrite: number;
}

export type SavingsBasis = "measured" | "partial" | "unpriced";

// A stored per-model entry of a bucket half (actual | potential).
export interface SavingsEntry {
  trimmed?: number;
  rewarm?: number;
  usd?: number;
  pricedReports?: number;
  unpricedReports?: number;
}

// summarizeSaved's result. `usd` is null only when reports exist but none was
// priced; the genuinely-empty window is 0 with basis "measured". May be negative.
export interface SavingsResult {
  usd: number | null;
  basis: SavingsBasis;
  pricedShare: number;
  trimmed: number;
  rewarm: number;
}

// null when the rates are unusable (the report is then UNPRICED).
export function reportUsd(args?: {
  trimmed?: number;
  rewarm?: number;
  rates?: Partial<TrimRates> | null;
}): number | null;

export function summarizeSaved(entries?: Iterable<SavingsEntry | null | undefined> | null): SavingsResult;
