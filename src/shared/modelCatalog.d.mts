// Types for src/shared/modelCatalog.mjs — the shared provider-agnostic
// catalogue matcher used by both the server routing core and the renderer's
// "Models we couldn't identify" block.

export interface ModelCatalogEntry {
  id?: string;
  name?: string;
  family?: string;
  description?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  weights?: { label?: string; url?: string }[];
  benchmarks?: { name: string; score: number; metric?: string }[];
  // Test-only: when false, the corpus generator skips this entry as an alias
  // source. Used for dated aliases of an existing model (the same model) and
  // for over-collapse guard siblings, which are pinned by targeted rows
  // instead (BET-1307).
  synthesize?: boolean;
}

// The endpoint's own declared facts, used to corroborate a layer-4 structural
// match. All optional; absent/zero on either side is no evidence.
export interface EndpointFacts {
  modalities?: string[];
  context?: number;
  output?: number;
}

export interface ModelCatalogMatch {
  kind: "exact" | "ambiguous" | "none";
  candidates: ModelCatalogEntry[];
  // "certain" for the exact-data lookups (layers 1-3); "probable" for layer 4
  // inference; absent when kind === "none".
  confidence?: "certain" | "probable";
  evidence?: string;
}

export interface ModelCatalog {
  readonly size: number;
  lookupModel(catalogId: string): ModelCatalogEntry | null;
  matchModel(localModelId: string, endpointFacts?: EndpointFacts): ModelCatalogMatch;
  allModels(): ModelCatalogEntry[];
}

export function normalize(modelsId: string): string;
export function entryHandles(entry: ModelCatalogEntry): Set<string>;
export function createModelIndex(entries: ModelCatalogEntry[]): ModelCatalog;
