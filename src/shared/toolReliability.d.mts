export type ToolCall = {
  name?: string;
  /** May be a JSON string or an already-parsed object. */
  arguments?: unknown;
};

export type ToolDef = {
  name?: string;
  input_schema?: unknown;
  parameters?: unknown;
  schema?: unknown;
  function?: { parameters?: unknown; input_schema?: unknown };
};

export type ToolCallKind = "valid" | "invalid-json" | "unknown-name" | "schema-mismatch";

export type RequestAggregate = { toolCalls?: ToolCall[]; tools?: ToolDef[] };

export type ReliabilitySample = { requests: number; errored: number; rate: number };

export type ReliabilityBaseline = { rate: number; n: number };

export type DerankDecision = { penalise: boolean; reason: string };

export const MIN_SAMPLE_REQUESTS: number;
export const DERANK_MARGIN_SIGMA: number;

export function classifyToolCall(
  call: ToolCall | null | undefined,
  toolsById: Record<string, ToolDef> | Map<string, ToolDef> | null | undefined,
): ToolCallKind;

export function aggregateReliability(requests: RequestAggregate[] | null | undefined): ReliabilitySample;

export function shouldDerank(
  sample: ReliabilitySample | null | undefined,
  baseline: ReliabilityBaseline | null | undefined,
): DerankDecision;
