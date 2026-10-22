// Types only (erased at transpile). Mirror src/shared/maskPlan.d.mts — plan.ts is
// a verbatim copy of plain JS, so its types live here.

export type PriceTier = {
  minPromptTokens?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
};
export type PriceRecord = PriceTier & { tiers?: PriceTier[]; source?: "config" | "catalog" };

export type PlanUnit = {
  /** The tool-call id shared by the call and its result; null → never trimmed. */
  id: string | null;
  kind: "tool" | "text";
  tool?: string;
  input?: unknown;
  text: string;
  msgIndex: number;
  ref?: unknown;
  inTok?: number;
};

export type Adapted = {
  units: PlanUnit[];
  messageCount: number;
  messageKeyAt: (i: number) => string | null;
  partCount: number;
  assistantCount: number;
  lastCompletedMs: number;
};

export type Boundary = { messageCount: number; lastMessageKey: string };

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
