// Shared model catalog — the model list + server default, cached ONCE for the
// whole renderer instead of per ChatPanel.
//
// WHY THIS EXISTS. The catalog is a box-level resource: it does not depend on
// which session is open. But it used to be fetched by each ChatPanel from its
// own `useState(null)`, and `/clear` swaps in a NEW opencode session id, which
// mounts a BRAND-NEW ChatPanel. So every clear restarted the fetch from
// `models == null` and the composer's model control fell back to its stub label
// while the dropdown showed "Loading…" — a visible flash of an empty picker on
// an action that changed nothing about the available models.
//
// The cache is module-level so a freshly-mounted panel renders the already-known
// catalog synchronously on its first paint. A background re-fetch still runs
// when the cached copy is older than STALE_MS, so a model added in Settings
// shows up shortly after without a reload — it just never blanks the UI while
// it's in flight.

import { useEffect, useState } from "react";
import type { OpencodeModel } from "../shared/types";
import { mergeModelOverrides } from "./chatUtils";

export type ServerDefaultModel = { providerID: string; modelID: string } | null;

type Snapshot = {
  models: OpencodeModel[] | null;
  defaultModel: ServerDefaultModel;
};

// How long a cached catalog is served without a background refresh. Short
// enough that a Settings change lands on the next session switch; long enough
// that flipping between sessions doesn't hammer the box.
const STALE_MS = 10_000;

let cache: Snapshot = { models: null, defaultModel: null };
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// Fetch both halves, deduped: concurrent callers share one round trip.
//
// GUARD (same reason as NewSessionScreen's): both methods live ONLY on
// httpApi. On a fresh/unpaired desktop boot `window.api` is still the raw
// preload OS-bridge subset where they are undefined, and calling them throws
// synchronously from the commit phase — which `.catch` cannot see and which
// unmounts the whole tree.
function load(): void {
  if (inFlight) return;
  // The `as` cast is deliberate: the `Api` type declares both as present, but
  // the pre-pairing preload subset installed on `window.api` does not have
  // them, so the runtime check is real even though TS thinks it is redundant.
  const api = window.api as Partial<typeof window.api>;
  if (!api.opencodeModels || !api.opencodeDefaultModel || !api.configGet) return;
  inFlight = Promise.allSettled([
    window.api.opencodeModels(),
    window.api.opencodeDefaultModel(),
    window.api.configGet(),
  ])
    .then(([modelsRes, defaultRes, cfgRes]) => {
      // Keep the previous value for whichever half failed — a transient error
      // must not blank a catalog we already have.
      // Model display overrides are applied CLIENT-SIDE (in addition to any
      // server-side merge) so the composer picker reflects persisted
      // name/description/context overrides even when the running box's
      // manta-server predates the server-side merge. Idempotent — a current
      // server that already merged them yields a no-op here.
      const overrides =
        cfgRes.status === "fulfilled" ? cfgRes.value?.modelOverrides : undefined;
      const next: Snapshot = {
        models: mergeModelOverrides(
          modelsRes.status === "fulfilled" ? modelsRes.value : cache.models,
          overrides,
        ),
        defaultModel: defaultRes.status === "fulfilled" ? defaultRes.value : cache.defaultModel,
      };
      const changed =
        next.models !== cache.models || next.defaultModel !== cache.defaultModel;
      cache = next;
      // Only mark fresh once something actually resolved, so a fully-failed
      // attempt retries on the next mount instead of caching the failure.
      if (
        modelsRes.status === "fulfilled" ||
        defaultRes.status === "fulfilled" ||
        cfgRes.status === "fulfilled"
      ) {
        fetchedAt = Date.now();
      }
      if (changed) emit();
    })
    .finally(() => {
      inFlight = null;
    });
}

/**
 * The shared catalog. Returns the cached value synchronously on first render
 * (so a remount — e.g. after `/clear` — never flashes an empty picker) and
 * re-renders when a background refresh brings something new.
 */
export function useModelCatalog(): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>(cache);
  useEffect(() => {
    const onChange = () => setSnapshot(cache);
    listeners.add(onChange);
    if (cache.models == null || Date.now() - fetchedAt > STALE_MS) load();
    // Adopt anything that landed between this component's render and its
    // effect (another panel's in-flight fetch resolving).
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
 * Force the shared model catalog to re-fetch from the server without waiting
 * for STALE_MS. Called by Settings → Models after saving a model override so
 * the composer's model dropdown reflects the new name / description / context
 * on the next load (the settings table updates its own local copy in the same
 * tick; this reconciles every other reader — chiefly ChatPanel's picker).
 */
export function refreshModelCatalog(): void {
  fetchedAt = 0;
  if (!inFlight) load();
}
