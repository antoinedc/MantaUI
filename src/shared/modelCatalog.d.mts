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
  benchmarks?: { name: string; score: number; metric?: string }[];
}

export interface ModelCatalogMatch {
  kind: "exact" | "ambiguous" | "none";
  candidates: ModelCatalogEntry[];
}

export interface ModelCatalog {
  readonly size: number;
  lookupModel(catalogId: string): ModelCatalogEntry | null;
  matchModel(localModelId: string): ModelCatalogMatch;
  allModels(): ModelCatalogEntry[];
}

export function normalize(modelsId: string): string;
export function entryHandles(entry: ModelCatalogEntry): Set<string>;
export function createModelIndex(entries: ModelCatalogEntry[]): ModelCatalog;
