export type OptimizerTunerEntry = {
  maskAfterUses?: number;
  batchTokens?: number;
  protectTailTokens?: number;
};

export type OptimizerRepoTable = {
  repos: Record<string, OptimizerTunerEntry>;
};

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

export type OptimizerSummaryTtl = {
  measuredMs?: number;
  configuredMs?: number | null;
  confidence?: string;
};

export const MASK_AFTER_TOOL_USES: number;
export const MIN_BATCH_TOKENS: number;
export const PROTECT_TAIL_TOKENS: number;
export const PLACEHOLDER_ARGS_MAX: number;
export const POLICY_CACHE_MS: number;
export const MAX_TRANSFORM_PARTS: number;
export const TRANSFORM_BUDGET_MS: number;
export const DEFAULT_POLICY: OptimizerPolicy;

export function resolvePolicy(input?: {
  config?: { optimizerEnabled?: unknown } | null;
  repoTable?: OptimizerRepoTable | null;
  directory?: string | null;
  cacheTtlMs?: number | null;
}): OptimizerPolicy;

export function validateRepoTable(raw: unknown): OptimizerRepoTable;

export function optimizerCacheTtlMs(ttl?: OptimizerSummaryTtl | null): number;
