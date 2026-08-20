// routingCatalog.ts — the provider-agnostic model catalogue for the renderer.
//
// The box caches models.dev and exposes the entries over `opencode:model-catalog`
// (BET-1249). The renderer fetches that ONCE, builds the SHARED pure matcher
// (../shared/modelCatalog.mjs — the same code the server's routing core uses),
// and serves it to the "Models we couldn't identify" block. Cached module-level
// so re-opening Settings doesn't re-download the catalogue every time.
//
// Unlike modelCatalog.ts (the per-provider opencode model list), this is the
// provider-AGNOSTIC catalogue — it answers "what IS this model, wherever it is
// served", which is what makes an opaque endpoint alias resolvable and powers
// the typeahead over every known model.

import { useEffect, useState } from "react";
import {
  createModelIndex,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "../shared/modelCatalog.mjs";

export type RoutingCatalog = {
  supported: boolean;
  matcher: ModelCatalog | null;
  entries: ModelCatalogEntry[];
};

// How long a fetched catalogue is served without a background refresh. The
// catalogue changes rarely (opencode's own list); a day is fine.
const STALE_MS = 6 * 60 * 60 * 1000;

let cache: RoutingCatalog = { supported: false, matcher: null, entries: [] };
let fetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

// GUARD (same reason as modelCatalog.ts): `opencodeModelCatalog` lives ONLY on
// httpApi. On a fresh/unpaired desktop boot `window.api` is the raw preload
// subset where it is undefined; calling it throws synchronously.
function load(): void {
  if (inFlight) return;
  const api = window.api as Partial<typeof window.api>;
  if (!api.opencodeModelCatalog) return;
  inFlight = window.api
    .opencodeModelCatalog()
    .then((res) => {
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      cache = {
        supported: !!res?.supported,
        entries,
        matcher: entries.length ? createModelIndex(entries) : null,
      };
      fetchedAt = Date.now();
      emit();
    })
    .catch(() => {
      // Keep the previous value (possibly an earlier success); a transient
      // network error must not blank a catalogue we already have.
      fetchedAt = Date.now();
    })
    .finally(() => {
      inFlight = null;
    });
}

export function refreshRoutingCatalog(): void {
  fetchedAt = 0;
  if (!inFlight) load();
}

export function useRoutingCatalog(): RoutingCatalog {
  const [snapshot, setSnapshot] = useState<RoutingCatalog>(cache);
  useEffect(() => {
    const onChange = () => setSnapshot(cache);
    listeners.add(onChange);
    if (cache.matcher == null || Date.now() - fetchedAt > STALE_MS) load();
    return () => {
      listeners.delete(onChange);
    };
    // Mount-only: the catalogue is session-independent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return snapshot;
}
