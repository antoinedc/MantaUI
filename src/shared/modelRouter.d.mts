import type { AccountState } from "./marginalCost.d.mts";
import type { ModelDeclaration, ModelCatalog, CatalogEntry } from "./modelIdentity.d.mts";
import type { Field as QualityField } from "./modelQuality.d.mts";
import type {
  ReliabilityBaseline,
  ReliabilitySample,
} from "./toolReliability.d.mts";

export type Tier = "fast" | "balanced" | "deep";

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
  p90TokensPerSec?: number;
  p50Ms?: number;
  p90Ms?: number;
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
  /** Keyed by "providerID/modelID" — the measured token mix per endpoint. */
  mix?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
  /** The box's overall measured mix, for an endpoint with no history of its own. */
  mixDefault?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** Keyed by model id — the catalogue's typical input/output rate. */
  referenceByModel?: Record<string, { input?: number; output?: number }>;
  /** Optimizer P2.3 (BET-1345) — keyed by providerID. The pacing shadow price
   *  per provider, folded into marginalCost's subscription branch. Absent →
   *  route exactly as today. */
  pressure?: Record<
    string,
    { lambda: number; tokensPerPct: number | null; deficit: number; ecoLevel: number; protection: boolean }
  >;
  /** Optimizer P2.3 (BET-1345) — the max eco level across providers (0-3).
   *  >= 2 moves the effective preset to "economy" (target tier only, never the
   *  quality floor). Absent → the configured preset is used verbatim. */
  ecoLevel?: number;
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

export type QualityBasis = "benchmark" | "family" | "structural";
export type MixSource = "measured" | "default";
export type ReferenceFlag = "catalogue" | "absent";

export interface RoutingSignals {
  quality: { score: number; basis: QualityBasis; known: boolean };
  cost: { value: number; basis: string; mixSource: MixSource; reference: ReferenceFlag };
  reliability: "measured" | "unmeasured";
  telemetry: { p50Ms: number | null; p90Ms: number | null; tokensPerSec: number | null };
}

export interface RoutingTrace {
  considered: number;
  dropped: { stage: "eligible" | "capable"; reason: string; n: number }[];
  intent: { contextTokens: number; needs: { tools: boolean; image: boolean; pdf: boolean } };
  target: { tier: string; floorTier: string; widened: boolean; eco?: number };
  winner: RoutingSignals | null;
}

export interface ChooseResult {
  model: Model | null;
  reason: string;
  alternatives: Model[];
  changed: boolean;
  /** Optimizer P2.3 (BET-1345) — the assessed-cost accessor for the wiring
   *  (savingsPerTurn / rewarmCost) without a second assess() call. Present on
   *  the win-and-switch path; absent elsewhere. */
  costs?: {
    winner: number;
    incumbent: number | null;
    winnerCacheWritePrice: number | null;
  };
  trace: RoutingTrace;
}

export function chooseModel(input?: ChooseInput): ChooseResult;

export function incumbentStillEligible(
  candidate: Model | null | undefined,
  services?: RoutingServices,
): boolean;

export interface RoutedDecisionInput {
  model?: Model | null;
  reason?: string;
  trace?: {
    considered?: number;
    dropped?: { n?: number }[];
    intent?: { contextTokens?: number; needs?: Record<string, boolean> };
    winner?: { cost?: { basis?: string; mixSource?: string } } | null;
  };
}

export function describeDecision(
  decision: RoutedDecisionInput | null | undefined,
  ctx: { surface: "main" | "sub"; agent: string },
): string;
