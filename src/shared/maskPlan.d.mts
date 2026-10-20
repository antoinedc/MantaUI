// Type declarations for the pure shared maskPlan.mjs (sticky trims, priced per
// model — spec docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md, C5).
// Mirrors optimizerPolicy.d.mts: shared .mjs modules consumed from .ts must ship
// a hand-written .d.mts. The plugins (docs/opencode-plugins/manta-optimizer.ts,
// docs/opencode-plugins-v2/manta-optimizer/lib/plan.ts) inline a copy of this
// module and are not type-checked.

export type OptimizerPolicy = {
  enabled: boolean;
  maskAfterUses: number;
  batchTokens: number;
  /** Payback safety factor of the gate; the planner defaults it to 1.5. */
  margin?: number;
  protectTailTokens: number;
  placeholderFormat: string;
  cacheTtlMs: number;
  maxTransformParts: number;
  transformBudgetMs: number;
};

/** A price record: $/Mtok. The C1 payload is already normalized; raw models.dev names are tolerated. */
export type PriceTier = {
  minPromptTokens?: number;
  tier?: { type?: string; size?: number };
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
};
export type PriceRecord = PriceTier & {
  tiers?: PriceTier[];
  context_over_200k?: PriceTier;
  source?: "config" | "catalog";
};
export type Rates = { cacheRead: number; cacheWrite: number };

/** What a per-shape adapter hands the planner for one tool call / text part. */
export type PlanUnit = {
  /** The tool-call id shared by the call and its result; null → never trimmed. */
  id: string | null;
  kind: "tool" | "text";
  tool?: string;
  input?: unknown;
  /** Tool output (kind "tool") or the part's text. */
  text: string;
  msgIndex: number;
  /** Opaque handle the plugin uses to apply a replacement. */
  ref?: unknown;
  inTok?: number;
};

export type Adapted = {
  units: PlanUnit[];
  messageCount: number;
  messageKeyAt: (i: number) => string | null;
  partCount: number;
  /** Completed assistant messages (≈ model calls) since the last compaction: the gate's "N". */
  assistantCount: number;
  /** V1: newest assistant time.completed; V2: 0 (never "known dead"). */
  lastCompletedMs: number;
};

export type Boundary = { messageCount: number; lastMessageKey: string };

/** The committed C4 trim-file object. */
export type TrimState = {
  version: 1;
  renderVersion: number;
  real: Record<string, string>;
  shadow: Record<string, string>;
  reqCount: number;
  nextGrowthAllowedAt: number;
  shadowNextGrowthAllowedAt: number;
  lastModel: string | null;
  updatedAt: number;
};

export type PlanDecision = "none" | "grow" | "clear";

export type PlanResult = {
  decision: PlanDecision;
  add: Record<string, string>;
  R: number;
  T: number;
  N: number;
  breakEven: number;
  reason: string;
  applied: { tokens: number; parts: number };
  shadow: {
    decision: "none" | "grow";
    add: Record<string, string>;
    R: number;
    T: number;
    tokens: number;
    parts: number;
    reason: string;
  };
  rates: (Rates & Record<string, unknown>) | null;
  rewarmTokens: number;
  shadowRewarmTokens: number;
  cacheDead: boolean;
  boundaryValid: boolean;
  compacted: boolean;
  dirty: boolean;
  nextState: TrimState;
};

export const PLACEHOLDER_ARGS_MAX: number;
export const PLACEHOLDER_PREFIX: string;
export const DEFAULT_PLACEHOLDER_FORMAT: string;
export const DEFAULT_MARGIN: number;
export const MAX_EXPECTED_REQUESTS: number;
export const MAX_MAP_ENTRIES: number;
export const ONE_HOUR_CACHE_MS: number;

export function estTokens(s: unknown): number;
export function estInputTokens(input: unknown): number;
export function renderPlaceholder(tool: unknown, input: unknown, format?: unknown): string;
export function lastAssistantCompleted(messages: unknown[] | null | undefined): number;
export function countParts(messages: unknown[] | null | undefined): number;

export function resolveRates(
  record: PriceRecord | null | undefined,
  promptTokens: number,
  opts?: { oneHour?: boolean },
): Rates | null;

export function adaptV1(messages: unknown[] | null | undefined): Adapted;
export function boundaryOf(adapted: Adapted): Boundary | null;
export function appliedStats(
  adapted: Adapted,
  map: Record<string, string> | null | undefined,
): { tokens: number; parts: number };

export function planRequest(input: {
  messages: Adapted;
  policy: Partial<OptimizerPolicy>;
  authoritative: boolean;
  rates: (Rates & Record<string, unknown>) | null | ((promptTokens: number) => (Rates & Record<string, unknown>) | null);
  state: TrimState;
  boundary: Boundary | null | undefined;
  model: { providerID?: string; modelID?: string } | null | undefined;
  now?: () => number;
  lastCompletedMs?: number;
}): PlanResult;
