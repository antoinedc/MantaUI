export interface BlendedCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface BlendedModel {
  cost?: BlendedCost;
}

export type Mix = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type MixSource = "measured" | "default";
export type ReferenceFlag = "catalogue" | "absent";

export interface PriceBits {
  price: number;
  known: boolean;
  mixSource: MixSource;
  reference: ReferenceFlag;
}

export const DEFAULT_MIX: Mix;

export function blendedPrice(
  model: BlendedModel | null | undefined,
  mix?: Partial<Mix> | null,
  reference?: { input?: number; output?: number } | null,
): PriceBits;

export function mixFromCounts(
  counts?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>,
): Mix;
