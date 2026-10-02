// ===== Which tool runs are expanded =====
//
// A run of tool calls is drawn by TWO different components over its life: the
// working line while it is the tail of a running turn, then a collapsed
// ToolGroupRow once text follows it or the turn ends. Each remount would reset
// component-local state, so a list the user opened on the working line snapped
// shut the moment the run settled — and Virtuoso unmounting an off-screen row
// did the same on scroll-back. The open/closed state therefore lives here,
// keyed by the run's id (its first part's id), which both owners share.

import { useCallback, useSyncExternalStore } from "react";

const expanded = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isGroupExpanded(id: string): boolean {
  return expanded.has(id);
}

export function setGroupExpanded(id: string, open: boolean): void {
  if (open === expanded.has(id)) return;
  if (open) expanded.add(id);
  else expanded.delete(id);
  for (const fn of listeners) fn();
}

/** Test-only reset. */
export function resetGroupExpansion(): void {
  expanded.clear();
  for (const fn of listeners) fn();
}

/** `[open, toggle]` for one run. A null id (no run) is always closed. */
export function useGroupExpanded(id: string | null): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => (id != null && expanded.has(id)));
  const toggle = useCallback(() => {
    if (id != null) setGroupExpanded(id, !expanded.has(id));
  }, [id]);
  return [open, toggle];
}
