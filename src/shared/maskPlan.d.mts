// Type declarations for the pure shared maskPlan.mjs (BET-1344). Mirrors
// optimizerPolicy.d.mts: shared .mjs modules consumed from .ts must ship a
// hand-written .d.mts (the .mjs itself has no bundled types). The plugin
// (docs/opencode-tools/manta-optimizer-plugin.ts) inlines a copy of this
// module and is not type-checked.

export type OptimizerPolicy = {
  enabled: boolean;
  maskAfterUses: number;
  batchTokens: number;
  protectTailTokens: number;
  placeholderFormat: string;
  cacheTtlMs: number;
  maxTransformParts: number;
  transformBudgetMs: number;
};

// A part that the scan found eligible for masking: m/i index into
// messages[m].parts[i] (original, non-reversed arrays).
export type EligiblePart = {
  m: number;
  i: number;
  tool: string;
  output: string;
  input: unknown;
};

export type ScanResult = {
  bailed: "budget" | null;
  maskedTokens: number;
  maskedParts: number;
  eligible: EligiblePart[];
};

export type PlanResult = {
  bailed: "parts" | "budget" | null;
  apply: boolean;
  cacheDead: boolean;
  lastAssistantCompletedMs: number;
  maskedTokens: number;
  maskedParts: number;
  eligible: EligiblePart[];
  reclaimable: number;
};

export type MaskBudget = {
  now: () => number;
  t0: number;
  budgetMs: number;
  checkEvery: number;
};

// The opencode message/part surface maskPlan reads (role + time.completed for
// cache freshness, parts for the scan).
export type MaskMessage = {
  info?: {
    role?: string;
    time?: { created?: number; completed?: number };
  };
  parts?: Array<{
    type?: string;
    tool?: string;
    text?: string;
    state?: { status?: string; input?: unknown; output?: unknown };
  }>;
};

export const PLACEHOLDER_ARGS_MAX: number;
export const PLACEHOLDER_PREFIX: string;
export const DEFAULT_PLACEHOLDER_FORMAT: string;

export function estTokens(s: unknown): number;
export function renderPlaceholder(tool: unknown, input: unknown, format?: unknown): string;
export function lastAssistantCompleted(messages: MaskMessage[] | null | undefined): number;
export function countParts(messages: MaskMessage[] | null | undefined): number;
export function scanEligible(
  messages: MaskMessage[],
  policy: OptimizerPolicy,
  budget?: MaskBudget,
): ScanResult;
export function decideApply(input: {
  reclaimable: number;
  batchTokens: number;
  lastAssistantCompletedMs: number;
  cacheTtlMs: number;
  now: number;
}): { apply: boolean; cacheDead: boolean };
export function planMask(input: {
  messages: MaskMessage[];
  policy: OptimizerPolicy;
  now?: () => number;
}): PlanResult;
