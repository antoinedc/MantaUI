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
import { measureEffectiveTtl } from "./ttl.mjs";
import { summaryFields } from "./counterfactual.mjs";

const WINDOW_DAYS = 30;
const TTL_MS = 60_000;

export { WINDOW_DAYS };

/**
 * PURE. Build the optimizer summary over the last WINDOW_DAYS of ledger rows
 * (fetched via the injected `fetchRows(sinceMs)`). `totals`/`cacheShare` reuse
 * the existing `aggregate` — no re-derivation. `ttl` is measured from the same
 * rows (BET-1334); `windows` stays a `null` placeholder child 4 fills;
 * `counterfactual` (BET-1335) fills its placeholder by injecting the observe-
 * only masking counterfactual into `dailySeries` (a `maskedTokens` per day,
 * 0 where absent — the "raw vs optimized" graph's second line) and into
 * `bySession` (a `savedPct` per top-20 session, 0 when no counterfactual), and
 * by populating the `counterfactual` key itself with the raw store fields.
 */
export async function buildOptimizerSummary({ fetchRows, now = Date.now(), counterfactualStore = null }) {
  const nowMs = num(now);
  const raw = await fetchRows(nowMs - WINDOW_DAYS * 86_400_000);
  const rows = Array.isArray(raw) ? raw : [];
  const { totals, cacheShare } = aggregate(rows);
  const cf = counterfactualStore
    ? await summaryFields(counterfactualStore, { days: WINDOW_DAYS, now: nowMs })
    : null;
  const cfDaily = new Map((cf?.dailySeries ?? []).map((d) => [d.day, d.maskedTokens ?? 0]));
  const dailySeries = aggregateDailySeries(rows, WINDOW_DAYS, nowMs).map((d) => ({
    ...d,
    maskedTokens: cfDaily.get(d.day) ?? 0,
  }));
  const bySession = aggregateBySession(rows).map((e) => ({
    ...e,
    savedPct: savedPctFor(e, cf?.bySession),
  }));
  return {
    supported: true,
    windowDays: WINDOW_DAYS,
    totals,
    cacheShare,
    dailySeries,
    bySession,
    counterfactual: cf ? { dailySeries: cf.dailySeries, bySession: cf.bySession } : null,
    windows: null,
    ttl: measureEffectiveTtl(rows, nowMs),
  };
}

// savedPct = maskedTokens / (maskedTokens + tokensSent), 0 when there is no
// counterfactual for the session or nothing to save against.
function savedPctFor(entry, cfBySession) {
  const m = cfBySession?.[entry.sessionID]?.maskedTokens ?? 0;
  const denom = m + entry.tokensSent;
  return denom > 0 ? m / denom : 0;
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
 * is the clock used for both the window and the TTL; `counterfactualStore` is
 * the observe-mode store from counterfactual.mjs (null when not wired — the
 * summary then degrades to empty counterfactual). The returned async
 * function memoizes the built summary for TTL_MS with an in-flight guard.
 */
export function createOptimizerSummary({ getDb, now, counterfactualStore = null }) {
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
          counterfactualStore,
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
