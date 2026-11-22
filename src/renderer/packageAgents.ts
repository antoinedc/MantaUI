// The box's agent packages (Agents Phase 1), cached once for the renderer —
// feeds the @-typeahead, the result-card titles and the sidebar Agents section.
// Same shape as agentCatalog.ts (module cache, in-flight dedupe, listeners), but
// a SEPARATE list: agentCatalog is the OpenCode agent list (Plan discovery).

import { useEffect, useState } from "react";
import type { AgentInfo } from "../shared/types";

type Snapshot = { agents: AgentInfo[] | null };

const STALE_MS = 10_000;

let cache: Snapshot = { agents: null };
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// `agentsList` exists only on httpApi (the pre-pairing preload subset lacks it)
// and only on a box new enough to serve it; the demo transport answers null.
// Every one of those reads as "no agents" rather than a crash.
function load(): void {
  if (inFlight) return;
  const api = window.api as Partial<typeof window.api> | undefined;
  if (!api?.agentsList) return;
  inFlight = Promise.resolve()
    .then(() => window.api.agentsList())
    .then((agents) => {
      cache = { agents: Array.isArray(agents) ? agents : [] };
    })
    .catch(() => {
      cache = { agents: cache.agents ?? [] };
    })
    .finally(() => {
      fetchedAt = Date.now();
      inFlight = null;
      emit();
    });
}

/** The cached package-agent list (null until the first answer). */
export function usePackageAgents(): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>(cache);
  useEffect(() => {
    const onChange = () => setSnapshot(cache);
    listeners.add(onChange);
    if (cache.agents == null || Date.now() - fetchedAt > STALE_MS) load();
    if (cache !== snapshot) onChange();
    return () => {
      listeners.delete(onChange);
    };
    // Mount-only: the list is box-level, nothing here varies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return snapshot;
}

/** Re-fetch now (after a create, or when the typeahead opens). */
export function refreshPackageAgents(): void {
  fetchedAt = 0;
  if (!inFlight) load();
}

/** Test seam: forget the cache. */
export function resetPackageAgentsForTest(): void {
  cache = { agents: null };
  fetchedAt = 0;
  inFlight = null;
}
