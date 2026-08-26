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
import { summaryFields } from "./counterfactual.mjs";
import { forecastAtReset } from "./forecast.mjs";
import { measureEffectiveTtl, verifyCacheTtl, cacheTtlLabelMs } from "./ttl.mjs";
import { SUMMARY_ACTIVITY_CAP } from "./activityLog.mjs";

const WINDOW_DAYS = 30;
const TTL_MS = 60_000;

export { WINDOW_DAYS };

/**
 * PURE. Build the optimizer summary over the last WINDOW_DAYS of ledger rows
 * (fetched via the injected `fetchRows(sinceMs)`). `totals`/`cacheShare` reuse
 * the existing `aggregate` — no re-derivation. `windows` stays a `null`
 * placeholder child 4 fills; `counterfactual` (BET-1335) fills its placeholder
 * by injecting the observe-only masking counterfactual into `dailySeries` (a
 * `maskedTokens` per day, 0 where absent — the "raw vs optimized" graph's
 * second line) and into `bySession` (a `savedPct` per top-20 session, 0 when
 * no counterfactual), and by populating the `counterfactual` key itself with
 * the raw store fields.
 */
export async function buildOptimizerSummary({
  fetchRows,
  now = Date.now(),
  counterfactualStore = null,
  // BET-1336: the quota-window forecast-at-reset lives here. Injected, like
  // fetchRows/counterfactualStore, so the arithmetic stays pure. `usageSnapshots`
  // returns the CURRENT stored UsageSnapshot[] (production wires usage.mjs
  // listSnapshots); `usageHistory` returns the observation history
  // `{[key]: [{ts,pct}]}` (production wires usage.mjs getUsageHistory).
  usageSnapshots = () => [],
  usageHistory = () => ({}),
  // BET-1340: injected read of what opencode is CONFIGURED to send for the
  // cache TTL ("5m" | "1h"). null on any failure. Injected (like fetchRows)
  // so the verifier stays testable; the 60s memo in createOptimizerSummary
  // bounds this I/O to one call per window, so it is null-cost to wire.
  readCacheTtl = async () => null,
  // BET-1347: the activity log store (optimizer/activityLog.mjs). The
  // summary exposes the newest SUMMARY_ACTIVITY_CAP entries so the dashboard
  // renders the trust surface without a second fetch. Null when not wired →
  // an empty feed (the documented empty state), never a fabricated zero.
  activityStore = null,
  // BET-1347: per-window pacing pressure `{ "<provider>:<kind>": { deficit,
  // tokensPerPct } }` for the pressure chips under each gauge. Null/incomplete
  // → the chip renders its neutral "no pressure signal yet" state.
  pressureWindows = async () => ({}),
  // BET-1347: the compaction scheduler's "X of Y in background" stat, or null
  // until the scheduler has attempted anything.
  compactionStat = async () => null,
  // BET-1347: metered (pay-per-token) endpoints, rendered as a slim role+price
  // row (no gauge). [] → the section is absent.
  meteredEndpoints = async () => [],
} = {}) {
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

  // BET-1340: `ttl` carries the measured effective TTL plus, when the
  // measurement is conclusive and a configured TTL is readable, whether it
  // matches what opencode is set to send. A mismatch is logged once as an
  // [optimizer] line: config and measured reality have drifted apart. The
  // renderer consumes `measuredMs` + `confidence` to draw the OptimizerCard
  // Cache-hit TTL detail ("TTL 5m measured" / "TTL 1h measured" / "TTL 5m
  // default", BET-1341); `observations`/`configuredMs`/`matched` stay as
  // diagnostic surface for the verifier.
  const measured = measureEffectiveTtl(rows, nowMs);
  let configuredTtl = null;
  try {
    configuredTtl = (await readCacheTtl()) ?? null;
  } catch (e) {
    console.warn("[optimizer] cache-TTL read failed:", e?.message ?? e);
  }
  const verification = verifyCacheTtl(measured, configuredTtl);
  if (verification && !verification.matched) {
    console.warn(
      `[optimizer] cache-TTL mismatch: measured ${cacheTtlLabelMs(verification.measuredMs)} vs configured ${cacheTtlLabelMs(verification.configuredMs)}`,
    );
  }
  const ttl = {
    measuredMs: measured.ms,
    confidence: measured.confidence,
    observations: measured.observations,
    configuredMs: verification ? verification.configuredMs : null,
    matched: verification ? verification.matched : null,
  };

  const windows = windowsFor(usageSnapshots(), usageHistory(), nowMs, await pressureWindows());

  return {
    supported: true,
    windowDays: WINDOW_DAYS,
    totals,
    cacheShare,
    dailySeries,
    bySession,
    ttl,
    counterfactual: cf ? { dailySeries: cf.dailySeries, bySession: cf.bySession } : null,
    windows,
    activity: await activityFor(activityStore),
    compaction: await compactionFor(compactionStat),
    metered: await meteredFor(meteredEndpoints, { windows, cacheShare }),
  };
}

// The compaction "X of Y in background" stat, or null when the scheduler has
// nothing to report (never a fabricated zero).
async function compactionFor(compactionStat) {
  if (typeof compactionStat !== "function") return null;
  try {
    const s = await compactionStat();
    if (!s || typeof s.total !== "number" || s.total <= 0) return null;
    return { background: typeof s.background === "number" ? s.background : 0, total: s.total };
  } catch {
    return null;
  }
}

// The metered-endpoints row, or [] when none are wired (the section is then
// absent — "never render a control whose backing data isn't there"). `ctx`
// carries the context the summary already computed (`{ windows, cacheShare }`)
// so the metered-read does NOT re-await the summary it is a dependency of
// (BET-1359: that re-entry was a self-await deadlock).
async function meteredFor(meteredEndpoints, ctx) {
  if (typeof meteredEndpoints !== "function") return [];
  try {
    const m = await meteredEndpoints(ctx);
    return Array.isArray(m) ? m : [];
  } catch {
    return [];
  }
}

// The activity slice for the summary: the newest SUMMARY_ACTIVITY_CAP entries,
// most recent first, or an EMPTY feed when no store is wired (the documented
// empty state). Never a fabricated zero.
async function activityFor(activityStore) {
  if (!activityStore || typeof activityStore.recent !== "function") return { entries: [] };
  try {
    const entries = await activityStore.recent(SUMMARY_ACTIVITY_CAP);
    return { entries: Array.isArray(entries) ? entries : [] };
  } catch {
    return { entries: [] };
  }
}

// Map the current stored usage snapshots to the summary's `windows` slice —
// one entry per quota window, in the same order the UsageDial popover lists
// them (each snapshot's `windows` array is already shortest-first, and
// snapshots are iterated in provider order). `forecastPct` is the forecast-at-
// reset from history, or null when there isn't enough history to trust it (the
// UI then hides the tick). `pressureMap` (`{ "<provider>:<kind>": { deficit,
// tokensPerPct } }`) supplies the pacing pressure the chips render; it may be
// incomplete or empty (the chip then shows its neutral "no pressure signal"
// state).
function windowsFor(snapshots, history, nowMs, pressureMap = {}) {
  const out = [];
  for (const snap of snapshots ?? []) {
    for (const w of snap.windows ?? []) {
      const key = `${snap.provider}:${w.kind}`;
      const pressure = pressureMap?.[key] ?? null;
      out.push({
        provider: snap.provider,
        planLabel: typeof snap.planLabel === "string" ? snap.planLabel : undefined,
        windowLabel: w.label,
        kind: w.kind ?? undefined,
        pct: w.pct,
        resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null,
        forecastPct: forecastAtReset(history, key, {
          now: nowMs,
          resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : undefined,
          currentPct: w.pct,
        }),
        // BET-1347: pacing pressure for the chip. `tokensPerPct` is the
        // measured signal; null means no pressure signal yet (neutral chip).
        deficit: pressure && typeof pressure.deficit === "number" ? pressure.deficit : null,
        tokensPerPct: pressure && typeof pressure.tokensPerPct === "number" ? pressure.tokensPerPct : null,
      });
    }
  }
  return out;
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
// Clears the memo + in-flight slot. Test-only: not part of the runtime API.
export function _resetSummaryMemo() {
  cache = null;
  inflight = null;
}

export function createOptimizerSummary({ getDb, now, counterfactualStore = null, usageSnapshots, usageHistory, readCacheTtl, activityStore = null, pressureWindows, compactionStat, meteredEndpoints }) {
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
          usageSnapshots,
          usageHistory,
          readCacheTtl,
          activityStore,
          pressureWindows,
          compactionStat,
          meteredEndpoints,
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
