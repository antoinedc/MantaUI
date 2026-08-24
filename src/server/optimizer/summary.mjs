// optimizer/summary.mjs — the `optimizer:summary` read model.
//
// BET-1333 (Optimizer P1.1): a memoized, server-side summary over the opencode
// message ledger. It is the first slice of the Manta Optimizer; later children
// (TTL, counterfactual, windows) EXTEND this module by filling the three `null`
// placeholder keys, so those keys stay present to keep the renderer contract
// stable.
//
// Split strictly into pure (`buildOptimizerSummary`) and I/O/memoized
// (`createOptimizerSummary`):
//   • buildOptimizerSummary — all arithmetic. Pure; `fetchRows` is injected.
//     Exported for tests.
//   • createOptimizerSummary — resolves the DB via getDb(), memoizes the built
//     summary behind a short TTL with an in-flight guard.
//
// Degradation mirrors modelLedger.mjs: a null DB (no Node 24 runtime, or no
// opencode.db) yields { supported:false } and never throws. Read-only is a
// hard invariant — the shared read-only handle from opencodeDb.mjs is used.

import { aggregate, aggregateBySession, aggregateDailySeries, fetchLedgerRows } from "../modelLedger.mjs";

const WINDOW_DAYS = 30;
const TTL_MS = 60_000;

export { WINDOW_DAYS };

/**
 * PURE. Build the optimizer summary over the last WINDOW_DAYS of ledger rows
 * (fetched via the injected `fetchRows(sinceMs)`). `totals`/`cacheShare` reuse
 * the existing `aggregate` — no re-derivation. The three `ttl`/`counterfactual`/
 * `windows` keys are `null` placeholders children 2–4 fill.
 */
export async function buildOptimizerSummary({ fetchRows, now = Date.now() }) {
  const nowMs = num(now);
  const raw = await fetchRows(nowMs - WINDOW_DAYS * 86_400_000);
  const rows = Array.isArray(raw) ? raw : [];
  const { totals, cacheShare } = aggregate(rows);
  return {
    supported: true,
    windowDays: WINDOW_DAYS,
    totals,
    cacheShare,
    dailySeries: aggregateDailySeries(rows, WINDOW_DAYS, nowMs),
    bySession: aggregateBySession(rows),
    ttl: null,
    counterfactual: null,
    windows: null,
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Memo slot — mirrors the routing-services cache shape (single slot, one ledger
// on the box, keyed on nothing) with an added in-flight guard so concurrent
// calls share one build instead of stampeding the DB.
let cache = null; // { at, value }
let inflight = null;

/**
 * I/O. Wrapper factory. `getDb` resolves the read-only opencode.db handle
 * (null → { supported:false }); `now` (a number or a zero-arg fn, for tests)
 * is the clock used for both the window and the TTL. The returned async
 * function memoizes the built summary for TTL_MS with an in-flight guard.
 */
export function createOptimizerSummary({ getDb, now }) {
  const nowMs = () => (typeof now === "function" ? num(now()) : num(now ?? Date.now()));
  return async function optimizerSummary() {
    const t = nowMs();
    if (cache && t - cache.at < TTL_MS) return cache.value;
    if (inflight) return inflight;
    inflight = (async () => {
      const db = await getDb();
      if (!db) return { supported: false };
      try {
        const value = await buildOptimizerSummary({
          fetchRows: (since) => fetchLedgerRows(db, since),
          now: t,
        });
        cache = { at: t, value };
        return value;
      } catch (e) {
        // Query error: log once, degrade to { supported:false } — never an
        // exception, never a cached error. Mirrors modelLedger.ledgerSummary.
        console.error("[optimizer] summary build failed:", e?.message ?? e);
        return { supported: false };
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
