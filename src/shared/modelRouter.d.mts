import type { AccountState } from "./marginalCost.d.mts";
import type { ModelDeclaration, ModelCatalog, CatalogEntry } from "./modelIdentity.d.mts";
import type { Field as QualityField } from "./modelQuality.d.mts";
import type {
  ReliabilityBaseline,
  ReliabilitySample,
} from "./toolReliability.d.mts";

export type Tier = "fast" | "balanced" | "deep";

export const PRESETS: string[];
export const AGENT_TIER: Record<string, Record<string, Tier>>;

export interface Model {
  providerID?: string;
  id?: string;
  family?: string;
  status?: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  limit?: { context?: number; output?: number };
  capabilities?: {
    toolcall?: boolean;
    reasoning?: boolean;
    input?: { image?: boolean; pdf?: boolean };
  };
}

export interface TelemetryEntry {
  tokensPerSec?: number;
  p50Ms?: number;
  p90Ms?: number;
  latencyMs?: number;
}

export interface RoutingServices {
  catalogMatcher?: ModelCatalog;
  catalogEntryFor?: (endpoint: Model) => CatalogEntry | null | undefined;
  qualityField?: QualityField;
  /** Keyed by "providerID/modelID". */
  declared?: Record<string, ModelDeclaration>;
  providerClass?: Record<string, "supported" | "custom">;
  /** Keyed by providerID. */
  accounts?: Record<string, AccountState>;
  /** Keyed by providerID — the provider-health state string. */
  health?: Record<string, string>;
  /** Keyed by "providerID/modelID". */
  telemetry?: Record<string, TelemetryEntry>;
  reliability?: {
    samples?: Record<string, ReliabilitySample>;
    baseline?: Record<string, ReliabilityBaseline>;
  };
  mix?: unknown;
  referenceByModel?: Record<string, unknown>;
}

export interface ChooseInput {
  intent?: {
    kind?: string;
    agent?: string;
    needs?: { tools?: boolean; image?: boolean; pdf?: boolean };
    contextTokens?: number;
    incumbent?: Model | null;
  };
  catalog?: Model[];
  policy?: { preset?: string; perAgent?: Record<string, string> };
  nowMs?: number;
  services?: RoutingServices;
}

export interface ChooseResult {
  model: Model | null;
  reason: string;
  alternatives: Model[];
  changed: boolean;
}

export function chooseModel(input?: ChooseInput): ChooseResult;
