export const TIERS: string[];

export const FAMILY_SEED_SCORES: Record<string, number>;

export const AGENT_FLOOR_SCORE: Record<string, number>;

export type QualityBasis = "benchmark" | "family" | "structural";

export interface QualityResult {
  score: number;
  basis: QualityBasis;
  known: boolean;
}

export interface Benchmark {
  name: string;
  score: number;
  metric?: string;
}

export interface QualityModel {
  family?: string;
  capabilities?: { reasoning?: boolean };
  limit?: { context?: number | null; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface CatalogEntry {
  family?: string;
  benchmarks?: Benchmark[];
  reasoning?: boolean;
  limit?: number;
}

export interface Field {
  benchmarkPercentile?(name: string, score: number): number | null | undefined;
}

export function qualityScore(
  model: QualityModel | null | undefined,
  catalogEntry?: CatalogEntry | null,
  field?: Field | null
): QualityResult;

export function tierForScore(score: number | undefined): string;

export function meetsFloor(score: number | undefined, agent: string): boolean;
