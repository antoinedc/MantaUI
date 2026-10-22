// Prices (contract C1) — process-wide, shared by every session. GET
// /api/optimizer/prices, refreshed in the background every 10 minutes, NEVER
// awaited. A model that is not in the map is unpriced → no growth (replay
// continues). The catalog copy is also aged out locally (7 days, from `fetchedAt`)
// for when refreshes keep failing; user-declared "config" prices do not age.

import { authHeaders, CALL_TIMEOUT_MS } from "./server.ts";
import type { PriceRecord } from "./types.ts";

export const PRICES_REFRESH_MS = 600_000;
export const PRICES_STALE_MS = 7 * 24 * 3_600_000;

export interface PricesDeps {
  fetch: typeof fetch;
  base: () => string;
  now?: () => number;
}

export function createPricesClient(deps: PricesDeps) {
  const now = deps.now ?? (() => Date.now());
  let prices: { fetchedAt: number; models: Record<string, PriceRecord> } = { fetchedAt: 0, models: {} };
  let attemptAt = 0;
  let inflight = false;

  function refreshIfDue(): void {
    const t = now();
    if (inflight || t - attemptAt < PRICES_REFRESH_MS) return;
    attemptAt = t;
    inflight = true;
    void deps
      .fetch(`${deps.base()}/api/optimizer/prices`, { headers: authHeaders(), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then((p: any) => {
        if (p && typeof p === "object" && p.models && typeof p.models === "object") {
          prices = { fetchedAt: typeof p.fetchedAt === "number" && Number.isFinite(p.fetchedAt) ? p.fetchedAt : 0, models: p.models };
        }
      })
      .catch(() => {}) // a failed refresh leaves the previous map
      .finally(() => {
        inflight = false;
      });
  }

  return {
    refreshIfDue,
    get fetchedAt(): number {
      return prices.fetchedAt;
    },
    /** The price record for a model, or null (unpriced / catalog copy too old). */
    lookup(model: { providerID?: string; modelID?: string }): PriceRecord | null {
      if (!model.providerID || !model.modelID) return null;
      const key = `${model.providerID}/${model.modelID}`;
      if (!Object.prototype.hasOwnProperty.call(prices.models, key)) return null;
      const rec = prices.models[key];
      if (!rec || typeof rec !== "object") return null;
      if (rec.source !== "config" && now() - prices.fetchedAt > PRICES_STALE_MS) return null;
      return rec;
    },
  };
}
