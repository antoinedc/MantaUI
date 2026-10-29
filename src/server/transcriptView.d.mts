export function isBackgroundResultMessage(message: unknown): boolean;
export function computeTurns(
  messages: unknown[],
  opts?: { running?: boolean },
): Map<string, { durationMs: number | null; tokens: number | null; verbSeedId: string }>;
export function truncationOf(message: unknown): { kind: "output-cap" | "context-wall" | "tool-cutoff"; label: string; hint: string } | null;
export function annotateView<T>(messages: T[], opts?: { running?: boolean }): T[];
export function annotateSingle<T>(message: T): T;
