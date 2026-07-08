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
