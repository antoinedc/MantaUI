export type ModelTier = "fast" | "balanced" | "deep";

export interface ModelInfo {
  blurb: string;
  goodFor: string[];
  tier: ModelTier;
}

export function describeModel(
  providerID: string,
  modelID: string
): ModelInfo | null;

export function familyKey(modelID: string): string | null;

export function isDeprecated(m: { status?: string } | null | undefined): boolean;

export function readModalities(value: unknown): string[];

export interface ResolvedModel {
  id?: string;
  name?: string;
  providerID?: string;
}

export function fuzzyMatchModel(
  query: string | null | undefined,
  models: ResolvedModel[]
): ResolvedModel | null;

export function suggestModels(
  query: string | null | undefined,
  models: ResolvedModel[],
  limit?: number
): ResolvedModel[];
