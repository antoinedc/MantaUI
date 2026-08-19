export type Tier = "fast" | "balanced" | "deep";

export const PRESETS: string[];
export const AGENT_FLOOR: Record<string, Tier>;
export const AGENT_TIER: Record<string, Record<string, Tier>>;
export const REFERENCE_PRICE: number;
export const FREE_FLOOR: number;

export interface Model {
  providerID?: string;
  id?: string;
  status?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  capabilities?: {
    toolcall?: boolean;
    input?: { image?: boolean; pdf?: boolean };
  };
}

export interface QuotaWindow {
  providerIDs?: string[];
  pct?: number;
  stale?: boolean;
  resetsAt?: number;
  period?: string;
}

export function filterByConstraints(
  models: Model[],
  opts?: {
    contextTokens?: number;
    needs?: { tools?: boolean; image?: boolean; pdf?: boolean };
  }
): Model[];

export function scarcity(window: unknown, nowMs: number): number;

export function effectivePrice(model: Model, quota: QuotaWindow[], nowMs: number): number;

export interface ChooseInput {
  intent?: {
    kind?: string;
    agent?: string;
    needs?: { tools?: boolean; image?: boolean; pdf?: boolean };
    contextTokens?: number;
    incumbent?: Model | null;
  };
  catalog?: Model[];
  telemetry?: Record<string, { tokensPerSec?: number; p50Ms?: number }>;
  quota?: QuotaWindow[];
  policy?: { enabled?: boolean; preset?: string; perAgent?: Record<string, string> };
  nowMs?: number;
}

export interface ChooseResult {
  model: Model | null;
  reason: string;
  alternatives: Model[];
  changed: boolean;
}

export function chooseModel(input?: ChooseInput): ChooseResult;
