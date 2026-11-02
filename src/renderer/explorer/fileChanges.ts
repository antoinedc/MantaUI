// Per-session "files may have changed" generation counter
// (spec §Path links → Invalidation, §Explorer panel → Freshness).
//
// Bumped by the SSE bus when a file-changing tool run reaches a terminal
// state in a session (or one of its child sessions), and for every session on
// a `resync`. Consumers: path-link resolution (re-resolve visible candidates)
// and the Explorer (refetch the open file, re-list expanded folders).

import { useSyncExternalStore } from "react";

const generations = new Map<string, number>();
let globalGeneration = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tool names whose completion may have changed files on disk. */
export const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "multiedit",
  "patch",
  "apply_patch",
  "bash",
  "shell",
]);

export function bumpFileGeneration(sessionId: string): void {
  generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
  emit();
}

/** On a stream resync every session's view may be stale. */
export function bumpAllFileGenerations(): void {
  globalGeneration += 1;
  emit();
}

export function getFileGeneration(sessionId: string): number {
  return globalGeneration * 1_000_000 + (generations.get(sessionId) ?? 0);
}

export function useFileGeneration(sessionId: string): number {
  return useSyncExternalStore(subscribe, () => getFileGeneration(sessionId));
}
