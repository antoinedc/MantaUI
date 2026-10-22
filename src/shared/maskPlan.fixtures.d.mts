// Types for the shared sticky-trims test fixtures (maskPlan.fixtures.mjs).
// Fixtures are test data: messages are deliberately loosely typed.
import type { PriceRecord, Rates, TrimState } from "./maskPlan.mjs";

export type FixtureCall = { id: string; tool: string; input: unknown; output: string };

export const PROVIDER: string;
export const MODEL: string;
export const MODEL_KEY: string;
export const POLICY: Readonly<{
  enabled: boolean;
  maskAfterUses: number;
  batchTokens: number;
  margin: number;
  protectTailTokens: number;
  placeholderFormat: string;
  cacheTtlMs: number;
  maxTransformParts: number;
  transformBudgetMs: number;
}>;
export const PRICE_OPUS: Readonly<PriceRecord>;
export const PRICE_NO_PREMIUM: Readonly<PriceRecord>;
export function ratesOf(record: PriceRecord): Rates & { source?: string; fetchedAt: number };
export function emptyState(over?: Partial<TrimState>): TrimState;
export function calls(n: number, opts?: { outTokens?: number; tool?: string; from?: number }): FixtureCall[];
export function toV1(list: FixtureCall[], opts?: { sessionID?: string; completedAt?: number; withId?: boolean }): any[];
export function toV2(list: FixtureCall[]): any[];
export function applyV1(messages: any[], real: Record<string, string>): void;
export function v1Outputs(messages: any[]): string[];
export function v2Outputs(messages: any[]): string[];
export function boundaryV1(messages: any[]): { messageCount: number; lastMessageKey: string };
