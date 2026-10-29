export function isBackgroundResultMessage(message: unknown): boolean;
export function computeTurns(
  messages: unknown[],
  opts?: { running?: boolean },
): Map<string, { durationMs: number | null; tokens: number | null; verbSeedId: string }>;
export function truncationOf(message: unknown): { kind: "output-cap" | "context-wall" | "tool-cutoff"; label: string; hint: string } | null;
export function annotateView<T>(messages: T[], opts?: { running?: boolean }): T[];
export function annotateSingle<T>(message: T): T;
export function beginHandle(output: string): string | null;
export function parseShowOutput(output: string): { path: string; mime: string; width: number | null; height: number | null; size: number } | null;
export function mediaId(a: { handle: string | null | undefined; showMessageId: string; path: string }): string;
export function filePartMedia(part: unknown): { kind: "image" | "video"; path: string } | null;
export type CanonicalMediaEntry = {
  id: string; ownerMessageId: string; kind: "image" | "video"; path: string | null; mime: string | null;
  width: number | null; height: number | null; aspectRatio: number | null; count: number | null;
  size: number | null; title: string | null; handle: string | null;
};
export function canonicalMediaEntries(messages: unknown[]): CanonicalMediaEntry[];
