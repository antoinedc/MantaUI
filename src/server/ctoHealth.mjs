// src/server/ctoHealth.mjs
// BET-1386 — Health-card P1 stat composition (§10.5 card 2, P1 rows only: A12).
// Pure over injected stores so it is testable without a live box. Every stat
// row carries how many samples it has seen (`n`) and the minimum sample size
// (`min`) before its value may be trusted. Below `min` the renderer shows
// `collecting (n/k)` and NEVER renders the number — a stat never displays
// noise as signal (§10.5). Other Internals/Health rows ship with the features
// that produce their data (rule 4 in the decomposition) — they are NOT
// rendered here.

import { effectsForVerdict } from "./ctoVerdicts.mjs";
import { todaySpend, roiMonthKey } from "./ctoBudget.mjs";

const DAY_MS = 86_400_000;

// Minimum sample sizes (samples, not days). Chosen so a median is meaningful:
// a week of observed opens for the digest median, a week of summarized
// segments for the pipeline-lag median, and at least one budget meter reading
// for the ambient-spend row. Suggestion acceptance needs ≥ 10
// acceptance-deciding verdicts (BET-1391) so a thumb of a few verdicts never
// reads as signal.
export const HEALTH_STAT_MIN = Object.freeze({
  ambientSpendToday: 1,
  digestOpens: 7,
  pipelineLag: 7,
  suggestionAcceptance: 10,
  forecastAccuracy: 1,
  capHitsCaused: 1,
  reserveFractile: 1,
  roi: 1,
  probeHealth: 1,
});

// EN month labels for ROI row copy — deterministic (server locale must not
// leak into stat text the desktop + mobile render identically).
const MONTH_LABELS = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]);

/** "2026-07" → "Jul 2026"; anything else → the key unchanged. */
export function roiMonthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ""));
  if (!m) return String(key ?? "");
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_LABELS[idx]} ${m[1]}` : String(key);
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function msIntoDay(ts) {
  const d = new Date(ts);
  return (d.getHours() * 60 + d.getMinutes()) * 60_000 + (d.getSeconds() * 1000 + d.getMilliseconds());
}

function formatTimeOfDay(msIntoDay) {
  const totalMin = Math.floor(msIntoDay / 60_000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Compose the three P1 Health-card stats (§10.5 card 2). Pure: all I/O arrives
 * as injected async readers, so tests drive real shapes with fakes.
 *
 * deps:
 *   now           — () => epoch ms (default Date.now)
 *   ledgerRead    — async () => rows[] (the A1 ledger; each row has `.kind`, `.ts`, `.actor`)
 *   budgetRead    — async () => the budget store payload (B1 economics; tolerant of null)
 *   listSegments  — async () => segments[] (each has `.window:[start,end]`, `.summarizedAt`)
 *   ctoAmbientCap — number — the hard daily ambient cap in $ (config, default 2.50)
 */
export async function computeHealthStats({
  now = () => Date.now(),
  ledgerRead = async () => [],
  budgetRead = async () => null,
  listSegments = async () => [],
  verdictsRead = async () => [],
  ctoAmbientCap = 2.5,
  // BET-1405 (§12.4): async () => { month, roll, collectingUntil } — the
  // monthly ROI roll; the endpoint refreshes it before this read.
  roiRead = async () => null,
  // BET-1396 (§7.5/§10.5): async () => { tools, probes, healthy, authFailed,
  // lastRunAt } — the probe runner's snapshot over consented tools.
  probesRead = async () => null,
} = {}) {
  const t = now();
  const stats = [];

  // 1. Ambient spend today / cap.
  let budget = null;
  try {
    budget = (await budgetRead()) ?? null;
  } catch {
    budget = null;
  }
  // The meter is live when the budget store holds any recorded activity —
  // a quiet today then honestly reads "$0.00 of $2.50 / day".
  const todaySpent = budget ? todaySpend(budget, t) : 0;
  const budgetLive =
    budget != null &&
    (budget.updatedMs != null || Object.keys(budget.days ?? {}).length > 0);
  stats.push({
    id: "ambientSpendToday",
    label: "Ambient spend today",
    min: HEALTH_STAT_MIN.ambientSpendToday,
    n: budgetLive ? 1 : 0,
    value: budgetLive
      ? `$${todaySpent.toFixed(2)} of $${Number(ctoAmbientCap).toFixed(2)} / day`
      : null,
  });

  // 2. Digest opens (7d) + median open time (time of day, matching the digest
  //    engine's own learned-timing definition — §5.5/D9 reads the same
  //    `cto.digest_opened` ledger rows as its source of truth).
  let rows = [];
  try {
    rows = (await ledgerRead()) ?? [];
  } catch {
    rows = [];
  }
  const cutoff = t - 7 * DAY_MS;
  const opens = rows
    .filter((r) => r?.kind === "cto.digest_opened" && typeof r?.ts === "number" && r.ts >= cutoff)
    .map((r) => r.ts)
    .sort((a, b) => a - b);
  const medianOpen = medianOf(opens.map(msIntoDay));
  stats.push({
    id: "digestOpens",
    label: "Digest opens · 7d",
    min: HEALTH_STAT_MIN.digestOpens,
    n: opens.length,
    value:
      opens.length >= HEALTH_STAT_MIN.digestOpens && medianOpen != null
        ? `${opens.length} opens · median ${formatTimeOfDay(medianOpen)}`
        : null,
  });

  // 3. Pipeline lag (segment close → summary). Lag per segment is the wall
  //    time between its window close and when its summary was persisted.
  let segments = [];
  try {
    segments = (await listSegments()) ?? [];
  } catch {
    segments = [];
  }
  const lags = segments
    .filter(
      (s) =>
        Array.isArray(s?.window) &&
        typeof s.window[1] === "number" &&
        typeof s?.summarizedAt === "number",
    )
    .map((s) => s.summarizedAt - s.window[1])
    .filter((lag) => lag >= 0);
  const medianLag = medianOf(lags);
  stats.push({
    id: "pipelineLag",
    label: "Pipeline lag (close → summary)",
    min: HEALTH_STAT_MIN.pipelineLag,
    n: lags.length,
    value:
      lags.length >= HEALTH_STAT_MIN.pipelineLag && medianLag != null
        ? `${Math.round(medianLag / 60_000)} min median`
        : null,
  });

  // 4. Suggestion acceptance (30d) — the share of the last 30 days'
  //    acceptance-deciding verdicts that were accepted (accept/edit = success;
  //    dismiss/veto/correct/never = rejection). `open`/`expire` never enter
  //    the acceptance counters (§9.5 — routed through the same single mapping
  //    table the verdict router consumes). Collecting until ≥ 10 verdicts.
  let verdicts = [];
  try {
    verdicts = (await verdictsRead()) ?? [];
  } catch {
    verdicts = [];
  }
  const verdictCutoff = t - 30 * DAY_MS;
  let decided = 0;
  let accepted = 0;
  for (const v of verdicts) {
    if (v?.ts == null || v.ts < verdictCutoff) continue;
    const e = effectsForVerdict(v.verdict, v.never === true);
    if (!(e.success || e.rejection)) continue;
    // A rejection signal (incl. a `never`-flagged verdict) is decided but NOT
    // accepted; only an unambiguous success (+ no rejection) counts as accepted,
    // so a never-again judgment never reads as a confirm.
    decided += 1;
    if (e.success && !e.rejection) accepted += 1;
  }
  const acceptRate = decided > 0 ? accepted / decided : 0;
  stats.push({
    id: "suggestionAcceptance",
    label: "Suggestion acceptance · 30d",
    min: HEALTH_STAT_MIN.suggestionAcceptance,
    n: decided,
    value:
      decided >= HEALTH_STAT_MIN.suggestionAcceptance
        ? `${Math.round(acceptRate * 100)}% accepted`
        : null,
  });

  // 5. Forecast accuracy (MAPE 14d, §14.5) — the best available cached
  //    per-provider 14-day MAPE from the budget's quota/forecast cache
  //    (BET-1400 recomputes each provider's MAPE on every quota evaluation).
  //    The first quota row carrying a numeric MAPE speaks for the box.
  let quota = null;
  try {
    quota = (await budgetRead())?.quota ?? null;
  } catch {
    quota = null;
  }
  const quotaRows = quota && typeof quota === "object" ? Object.values(quota) : [];
  const withMape = quotaRows.find((q) => typeof q?.mape14 === "number" && Number.isFinite(q.mape14));
  stats.push({
    id: "forecastAccuracy",
    label: "Forecast accuracy · MAPE 14d",
    min: HEALTH_STAT_MIN.forecastAccuracy,
    n: withMape ? 1 : 0,
    value: withMape ? `${withMape.mape14.toFixed(1)}%` : null,
  });

  // 6. Cap-hits caused (30d, §14.5) — count of `cto.cap_hit` §14.5 ledger rows
  //    (the user's plan window exhausted) in the last 30 days.
  const capCutoff = t - 30 * DAY_MS;
  const capHits = rows.filter((r) => r?.kind === "cto.cap_hit" && typeof r?.ts === "number" && r.ts >= capCutoff).length;
  stats.push({
    id: "capHitsCaused",
    label: "Cap-hits caused · 30d",
    min: HEALTH_STAT_MIN.capHitsCaused,
    n: capHits,
    value: capHits >= HEALTH_STAT_MIN.capHitsCaused ? `${capHits} window(s) hit` : null,
  });

  // 7. Reserve fractile (§11.3) — the current per-provider fractile, for the
  //    Tonight's-budget reserve line (§10.5-3). The fractile *history* is
  //    ledgered (§14.5); this row is the live value for the gauge.
  //    Windowless providers disable the reserve (§11.2) yet still persist
  //    their P95-init `fractile` on the quota row (BET-1400's windowless
  //    row), so the row must never present that init value as a live reserve:
  //    prefer reserve-enabled (windowed) rows, and when only a windowless row
  //    exists, surface the mode in the value instead of a bare fractile.
  const withFractile =
    quotaRows.find((q) => q?.mode !== "windowless" && typeof q?.fractile === "number") ??
    quotaRows.find((q) => q?.mode === "windowless" && typeof q?.fractile === "number");
  const reserveDisabled = withFractile?.mode === "windowless";
  const fractileLabel =
    withFractile != null
      ? `P${Math.round(withFractile.fractile * 100)}${reserveDisabled ? " (windowless — reserve off)" : ""}`
      : null;
  stats.push({
    id: "reserveFractile",
    label: "Reserve fractile",
    min: HEALTH_STAT_MIN.reserveFractile,
    n: withFractile ? 1 : 0,
    value: withFractile && fractileLabel ? `${fractileLabel} · ${withFractile.provider ?? "provider"}` : null,
  });

  // 8. ROI self-report (§12.4, BET-1405) — the monthly roll: total CTO spend
  //    vs counted outcomes + a copy-only tier recommendation. Until the first
  //    monthly boundary passes the row renders `collecting — first report
  //    <date>`; the recommendation NEVER writes the dial.
  let roi = null;
  try {
    roi = (await roiRead()) ?? null;
  } catch {
    roi = null;
  }
  if (roi && roi.roll) {
    const r = roi.roll;
    const rec = r.recommendation ?? { tier: "stay", reason: "" };
    stats.push({
      id: "roi",
      label: `ROI · ${roiMonthLabel(roi.month ?? r.month)}`,
      min: HEALTH_STAT_MIN.roi,
      n: 1,
      value: `$${Number(r.spendUsd ?? 0).toFixed(2)} · ${r.accepted ?? 0} accepted · ${r.merged ?? 0} merged · ${r.incidents ?? 0} pre-surfaced — recommend ${rec.tier}: ${rec.reason}`,
    });
  } else {
    const firstReport =
      roi?.collectingUntil != null
        ? new Date(roi.collectingUntil)
        : null;
    const firstReportText = firstReport
      ? `${MONTH_LABELS[firstReport.getMonth()]} ${firstReport.getDate()}`
      : null;
    stats.push({
      id: "roi",
      label: "ROI · self-report",
      min: HEALTH_STAT_MIN.roi,
      n: 0,
      value: null,
      collectingText: firstReportText ? `collecting — first report ${firstReportText}` : "collecting",
    });
  }

  // 9. Probe health (BET-1396, §7.5/§10.5 "probe health per consented tool")
  //    — how many §7.5 metadata probes are configured and how many reported
  //    healthy on their last run. Auth-failed probes surface separately (they
  //    carry their own §10.6-7 blocker card); a probe that never ran keeps
  //    the row collecting (n counts configured probes, value needs a run).
  let probes = null;
  try {
    probes = (await probesRead()) ?? null;
  } catch {
    probes = null;
  }
  const probeCount = Number(probes?.probes ?? 0);
  const probeRan = Number(probes?.lastRunAt ?? 0) > 0;
  const probeAuth = Number(probes?.authFailed ?? 0);
  stats.push({
    id: "probeHealth",
    label: "Probe health",
    min: HEALTH_STAT_MIN.probeHealth,
    n: probeCount,
    value:
      probeCount >= HEALTH_STAT_MIN.probeHealth && probeRan
        ? `${Number(probes.healthy ?? 0)}/${probeCount} probes healthy${probeAuth > 0 ? ` · ${probeAuth} auth-failed` : ""}`
        : null,
    ...(probeCount > 0 && !probeRan ? { collectingText: "configured — waiting for first run" } : {}),
  });

  return { stats, generatedAt: t };
}
