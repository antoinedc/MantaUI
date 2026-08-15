// Shared agent catalog — the opencode agent list (`build`/`plan`/general +
// subagents), cached ONCE for the whole renderer instead of per caller.
//
// WHY THIS EXISTS (BET-949). The agent list is a box-level resource: it does
// not depend on which session is open. It used to be fetched ad hoc by the
// @-typeahead (`useTypeahead`) for its own `useState`. Plan mode (the composer
// chip's enablement) needed the same list, and two uncoordinated fetchers of
// one box-level list is the drift this module removes. It mirrors
// `modelCatalog.ts` structurally: module-level cache, background refresh past
// STALE_MS, in-flight dedupe, a listener set, and a `useAgentCatalog()` hook.

import { useEffect, useState } from "react";
import type { OpencodeAgent } from "../shared/types";

type Snapshot = {
  agents: OpencodeAgent[] | null;
};

// How long a cached catalog is served without a background refresh. Short
// enough that a Settings/agent change lands on the next session switch; long
// enough that flipping between sessions doesn't hammer the box.
const STALE_MS = 10_000;

let cache: Snapshot = { agents: null };
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// Fetch the agent list, deduped: concurrent callers share one round trip.
//
// GUARD (same reason as modelCatalog): `opencodeAgents` lives ONLY on
// httpApi. On a fresh/unpaired desktop boot `window.api` is still the raw
// preload OS-bridge subset where it is undefined, and calling it throws
// synchronously from the commit phase — which `.catch` cannot see and which
// unmounts the whole tree.
function load(): void {
  if (inFlight) return;
  // The `as` cast is deliberate: the `Api` type declares it present, but the
  // pre-pairing preload subset installed on `window.api` does not have it, so
  // the runtime check is real even though TS thinks it is redundant.
  const api = window.api as Partial<typeof window.api>;
  if (!api.opencodeAgents) return;
  inFlight = window.api
    .opencodeAgents()
    .then((agents) => {
      cache = { agents };
      fetchedAt = Date.now();
      emit();
    })
    .finally(() => {
      inFlight = null;
    });
}

/**
 * The shared agent catalog. Returns the cached value synchronously on first
 * render and re-renders when a background refresh brings something new.
 */
export function useAgentCatalog(): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>(cache);
  useEffect(() => {
    const onChange = () => setSnapshot(cache);
    listeners.add(onChange);
    if (cache.agents == null || Date.now() - fetchedAt > STALE_MS) load();
    // Adopt anything that landed between this component's render and its
    // effect (another caller's in-flight fetch resolving).
    if (cache !== snapshot) onChange();
    return () => {
      listeners.delete(onChange);
    };
    // Mount-only: the catalog is session-independent, so nothing here varies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return snapshot;
}

/**
 * Force the shared agent catalog to re-fetch from the server without waiting
 * for STALE_MS.
 */
export function refreshAgentCatalog(): void {
  fetchedAt = 0;
  if (!inFlight) load();
}
