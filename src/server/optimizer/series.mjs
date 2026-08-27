// optimizer/series.mjs — the `optimizer:series` windowed consumption read.
//
// BET-1369: the optimizer card's consumption chart was hardwired to 30 days
// via a module constant in summary.mjs, and `optimizer:summary` (the single
// 60s memo slot SHARED by four consumers besides the card) must NOT be
// parameterised — its window must not change because somebody clicked a chip
// in Settings. This module is a separate, NARROWER read: a per-range
// (24h / 7d / 30d) windowed series of sent-vs-counterfactual tokens, fetched
// over ONLY the requested window (a 24h view reads one day of rows, not thirty
// and slice — a cold 30-day ledger read was measured in seconds).
//
// Split strictly into pure (`buildOptimizerSeries`) and I/O/memoized
// (`createOptimizerSeries`), mirroring summary.mjs:
//   • buildOptimizerSeries — all arithmetic. Pure; `fetchRows` and the
//     counterfactual store are injected. Exported for tests.
//   • createOptimizerSeries — resolves the DB via getDb(), memoizes per range
//     behind a short TTL with an in-flight guard.
//
// Degradation mirrors summary.mjs: a null DB yields { supported:false } and
// never throws; a query error logs once and yields { supported:false }; an
// error is never cached. Read-only is a hard invariant.

import { aggregate, aggregateDailySeries, aggregateHourlySeries, fetchLedgerRows } from "../modelLedger.mjs";
import { bucketSeries } from "./counterfactual.mjs";
import { bucketKeyToMs } from "../../shared/timeBuckets.mjs";

// The supported ranges and their bucketing. Bucket keys zip the sent series
// (from the ledger) with the counterfactual series (from the store) — both are
// built from the shared recentBucketKeys, so they align on the same key.
export const RANGES = Object.freeze({
  "24h": { bucket: "hour", count: 24 },
  "7d": { bucket: "day", count: 7 },
  "30d": { bucket: "day", count: 30 },
});

const BUCKET_MS = Object.freeze({ hour: 3_600_000, day: 86_400_000 });
const TTL_MS = 60_000;

export { TTL_MS };

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Unknown range → fall back to the default 24h. Never throws.
function normalizeRange(range) {
  return Object.prototype.hasOwnProperty.call(RANGES, range) ? range : "24h";
}

/**
 * PURE. Build the windowed consumption series for a range.
 *
 * Reads history scoped to the range — `fetchRows(now - count * bucketMs)` — so
 * a 24h view reads one day of ledger rows, NOT thirty and slice (the cold
 * 30-day read was measured in seconds). The sent series comes from the ledger
 * bucket aggregation; the counterfactual series from `bucketSeries` on the
 * injected store (a null store yields zeros, never a throw). The two are zipped
 * on the bucket KEY so they are always the same length and aligned, even when
 * the two sources have different sparse keys.
 */
export async function buildOptimizerSeries({ range, fetchRows, counterfactualStore = null, now = Date.now() }) {
  const r = normalizeRange(range);
  const { bucket, count } = RANGES[r];
  const nowMs = num(now);
  const bucketMs = BUCKET_MS[bucket];

  const raw = await fetchRows(nowMs - count * bucketMs);
  const rows = Array.isArray(raw) ? raw : [];

  // Sent series over the window, oldest→newest, per the range's bucket.
  const sent =
    bucket === "hour"
      ? aggregateHourlySeries(rows, count, nowMs)
      : aggregateDailySeries(rows, count, nowMs);

  // Counterfactual over the same bucket keys. A null store → zeros (a series
  // of zero maskedTokens), never a throw.
  const cf = counterfactualStore
    ? await bucketSeries(counterfactualStore, { bucket, count, now: nowMs })
    : [];
  const cfByKey = new Map((Array.isArray(cf) ? cf : []).map((e) => [e.key, num(e.maskedTokens)]));

  // Zip on the bucket key so both series are the same length and aligned.
  const series = sent.map((e) => {
    const key = bucket === "hour" ? e.hour : e.day;
    return {
      t: bucketKeyToMs(key),
      tokensSent: num(e.tokensSent),
      maskedTokens: cfByKey.get(key) ?? 0,
    };
  });

  const tokensSent = series.reduce((s, p) => s + p.tokensSent, 0);
  const maskedTokens = series.reduce((s, p) => s + p.maskedTokens, 0);

  // turns/cost reuse the existing aggregate over exactly the window's rows.
  const { totals } = aggregate(rows);

  return {
    supported: true,
    range: r,
    bucket,
    startMs: series.length ? series[0].t : nowMs,
    endMs: series.length ? series[series.length - 1].t : nowMs,
    series,
    counterfactualAvailable: series.some((p) => p.maskedTokens > 0),
    totals: {
      turns: totals.turns,
      cost: totals.cost,
      tokensSent,
      maskedTokens,
    },
  };
}

// Memo slots per range — a Map<range, {at, value}> plus a Map<range, promise>
// in-flight guard, so a 7d call never returns a cached 24h value and concurrent
// calls for the same range share one build instead of stampeding the DB.
const memo = new Map();
const inFlight = new Map();

// Clears the memo + in-flight slots. Test-only: not part of the runtime API.
export function _resetSeriesMemo() {
  memo.clear();
  inFlight.clear();
}

/**
 * I/O. Wrapper factory. `getDb` resolves the read-only opencode.db handle
 * (null → { supported:false }); `counterfactualStore` is the observe-mode store
 * from counterfactual.mjs (null when not wired); `now` (a number or a zero-arg
 * fn, for tests) is the clock. The returned async function takes a range and
 * memoizes the built series per range for TTL_MS with an in-flight guard.
 */
export function createOptimizerSeries({ getDb, counterfactualStore = null, now }) {
  const nowMs = () => (typeof now === "function" ? num(now()) : num(now ?? Date.now()));
  return function optimizerSeries(range) {
    const r = normalizeRange(range);
    const t = nowMs();
    const hit = memo.get(r);
    if (hit && t - hit.at < TTL_MS) return Promise.resolve(hit.value);

    const pending = inFlight.get(r);
    if (pending) return pending;

    const p = (async () => {
      const db = await getDb();
      if (!db) return { supported: false };
      try {
        const value = await buildOptimizerSeries({
          range: r,
          fetchRows: (since) => fetchLedgerRows(db, since),
          counterfactualStore,
          now: t,
        });
        memo.set(r, { at: t, value });
        return value;
      } catch (e) {
        // Query error: log once, degrade to { supported:false } — never an
        // exception, and never a cached error (the NEXT call retries).
        console.error("[optimizer] series build failed:", e?.message ?? e);
        return { supported: false };
      } finally {
        // Only clear OUR slot — a stale build must never clear a newer one.
        if (inFlight.get(r) === p) inFlight.delete(r);
      }
    })();
    inFlight.set(r, p);
    return p;
  };
}
