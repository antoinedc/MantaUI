export type IdentityState = "resolved" | "ambiguous" | "unknown";
export type IdentitySource = "matched" | "declared" | null;

export interface OpencodeModel {
  providerID?: string;
  id?: string;
  family?: string;
  capabilities?: {
    reasoning?: boolean;
    tool_call?: boolean;
    modalities?: { input?: string[]; output?: string[] };
    input?: { image?: boolean; pdf?: boolean };
  };
  limit?: { context?: number | null; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ModelDeclaration {
  catalogId?: string;
  price?: { input?: number; output?: number } | "free";
  caches?: false | { read?: boolean; write?: boolean };
}

export interface CatalogueEntry {
  id?: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  weights?: { label?: string; url?: string }[];
  benchmarks?: { name: string; score: number; metric?: string }[];
}

export interface EndpointFacts {
  modalities?: string[];
  context?: number;
  output?: number;
}

export interface ModelCatalog {
  lookupModel(catalogId: string): CatalogueEntry | null;
  matchModel(
    localModelId: string,
    endpointFacts?: EndpointFacts
  ): {
    kind: "exact" | "ambiguous" | "none";
    candidates: CatalogueEntry[];
    confidence?: "certain" | "probable";
    evidence?: string;
  };
}

export interface IdentityResult {
  state: IdentityState;
  catalogId: string | null;
  candidates: string[];
  source: IdentitySource;
  effective: EffectiveModel;
  confidence?: "certain" | "probable";
  evidence?: string;
}

export interface EffectiveModel extends OpencodeModel {
  catalogId?: string;
  benchmarks?: CatalogueEntry["benchmarks"];
  caches?: false | { read?: boolean; write?: boolean };
}

export function resolveIdentity(
  model: OpencodeModel | null | undefined,
  declared: ModelDeclaration | null | undefined,
  catalog: ModelCatalog | null | undefined
): IdentityResult;
