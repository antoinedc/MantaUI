// optimizer/view.mjs — the render model of the "Token optimizer" screen
// (WS09 SF-M7). `optimizer:summary` and `optimizer:series` keep their raw
// fields and gain a `view` block holding every string, band, tone and empty
// state the desktop card and the iOS screen show. Chart geometry (cumulative
// path, axis ticks) stays client-side; `rawValues` is the per-bucket input to
// the dashed counterfactual line.

import { formatTokens } from "../../shared/formatTokens.mjs";

const wholePct = (v) => `${Math.round(v)}%`;

// Savings are a NET ESTIMATE and may be negative (the re-cache cost of a trim
// can exceed what it saved); a negative figure reads as a cost, never "≈ $-1.20".
function formatSavedUsd(usd) {
  return usd < 0 ? `−$${(-usd).toFixed(2)}` : `≈ $${usd.toFixed(2)}`;
}

// Anthropic prompt-cache TTL label: "5m" / "1h" / "10m".
export function ttlLabel(ms) {
  if (ms === 3_600_000) return "1h";
  if (ms === 300_000) return "5m";
  return `${Math.round(ms / 60_000)}m`;
}

// Gauge colour band: <60 ok, 60–84 warn, ≥85 danger.
export function gaugeBand(pct) {
  if (pct >= 85) return "danger";
  if (pct >= 60) return "warn";
  return "ok";
}

/** Pacing pressure chip under a window gauge. */
export function describePressure(deficit, hasSignal) {
  if (!hasSignal) return { text: "no pressure signal yet", tone: "neutral" };
  const pts = Math.round(deficit);
  if (deficit > 0) return { text: `+${pts} pts ahead of pace`, tone: "warn" };
  return { text: "on pace", tone: "ok" };
}

const VERDICT_WORD = { kept: "Kept", "rolled-back": "Rolled back", applied: "Applied" };

// "Turns 62 · Hit 74.1%" — joined from counts/measurements, never content.
function evidenceLine(evidence) {
  if (!evidence) return "";
  const parts = [];
  for (const [k, v] of Object.entries(evidence)) {
    if (v === undefined || v === null || String(v) === "") continue;
    const label = k.replace(/([A-Z])/g, " $1").replace(/^[a-z]/g, (c) => c.toUpperCase()).trim();
    parts.push(`${label} ${v}`);
  }
  return parts.join(" · ");
}

/** One activity-log row: headline = verdict word + the change; detail = evidence. */
export function describeActivityEntry(entry) {
  const word = VERDICT_WORD[entry.verdict] ?? entry.verdict ?? "Changed";
  const subject = typeof entry.subject === "string" && entry.subject ? entry.subject : "optimizer change";
  return { headline: `${word} — ${subject}`, detail: evidenceLine(entry.evidence) };
}

const SWITCH_BODY =
  "Manta trims, paces and compacts your conversations to make a plan last longer. It never changes which model you picked by hand. Everything it changes is listed below.";
const WINDOWS_CAPTION =
  "Forecast from your recent usage. Tick = forecast at reset. Pressure chip = how far ahead of pace this window is right now.";
const METERED_CAPTION =
  "Pay-per-token endpoints have no window and never reset, so there is nothing to fill — only a role and the price at which they beat the subscription.";
const ACTIVITY_CAPTION =
  "Every parameter change the optimizer made on its own, with the evidence it used. Rolled-back entries stay — that is the point.";
const ACTIVITY_EMPTY =
  "Nothing changed yet. Manta needs a few days of your usage before it starts tuning anything.";

export function summaryView(summary, { optimizerEnabled = false } = {}) {
  const windows = Array.isArray(summary?.windows) ? summary.windows : [];
  const cs = summary?.cacheShare ?? { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 };
  const hitDenom = cs.cacheRead + cs.cacheWrite + cs.input;
  const cacheHitPct = hitDenom > 0 ? (cs.cacheRead / hitDenom) * 100 : 0;
  const compaction = summary?.compaction && summary.compaction.total > 0 ? summary.compaction : null;
  const ttl = summary?.ttl ?? null;

  const subrows = [];
  const worst = windows.reduce(
    (w, x) => (x.tokensPerPct != null && (w == null || (x.deficit ?? 0) > (w.deficit ?? 0)) ? x : w),
    null,
  );
  if (worst) {
    subrows.push({
      id: "pacing",
      name: "Pacing",
      text: "Cheaper models while a plan window is ahead of pace. Build and plan work keeps its quality floor.",
      chip: `eco · ${describePressure(worst.deficit ?? 0, true).text}`,
    });
  }
  if (compaction) {
    subrows.push({
      id: "compacting",
      name: "Compacting",
      text: "Long idle conversations are summarized in the background, before you come back to them.",
      chip: `${compaction.background} of ${compaction.total} in background`,
    });
  }
  subrows.push({
    id: "cache",
    name: "Prompt cache",
    text: `Reads billed at 0.1×; TTL ${ttl ? ttlLabel(ttl.measuredMs) : "5m"} measured.`,
    chip: `${wholePct(cacheHitPct)} hit`,
  });

  const seen = new Map();
  const windowViews = windows.map((w) => {
    const pct = Number.isFinite(w.pct) ? w.pct : 0;
    const fp = typeof w.forecastPct === "number" ? w.forecastPct : null;
    const base = `${w.provider}:${w.kind ?? w.windowLabel}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return {
      key: n === 0 ? base : `${base}#${n + 1}`,
      title: [w.planLabel, w.windowLabel].filter(Boolean).join(" — "),
      resetsAt: w.resetsAt ?? null,
      pct,
      pctLabel: `${wholePct(pct)} used`,
      band: gaugeBand(pct),
      forecastPct: fp,
      forecastWarn: fp != null && fp >= 85,
      forecastLabel: fp != null ? `forecast ${wholePct(fp)}` : "gathering history…",
      pressure: describePressure(w.deficit ?? 0, typeof w.tokensPerPct === "number"),
    };
  });

  const entries = Array.isArray(summary?.activity?.entries) ? summary.activity.entries : [];
  return {
    switch: { on: optimizerEnabled === true, label: optimizerEnabled === true ? "On" : "Off", body: SWITCH_BODY },
    subrows,
    windowsCaption: WINDOWS_CAPTION,
    windows: windowViews,
    metered: (Array.isArray(summary?.metered) ? summary.metered : []).map((m) => ({
      name: m.name,
      role: m.role,
      price: m.price,
    })),
    meteredCaption: METERED_CAPTION,
    activity: entries.map((e) => {
      const { headline, detail } = describeActivityEntry(e);
      return { id: e.id, ts: e.ts, headline, detail, rolledBack: e.verdict === "rolled-back" };
    }),
    activityCaption: ACTIVITY_CAPTION,
    activityEmpty: ACTIVITY_EMPTY,
    stats: [
      {
        id: "cacheHit",
        label: "Cache hit",
        value: wholePct(cacheHitPct),
        detail: `${ttl ? `TTL ${ttlLabel(ttl.measuredMs)} ${ttl.confidence} · ` : ""}30d`,
        tone: "neutral",
      },
      {
        id: "sessions",
        label: "Sessions",
        value: String(Array.isArray(summary?.bySession) ? summary.bySession.length : 0),
        detail: compaction ? `${compaction.background} of ${compaction.total} in background · 30d` : "30d",
        tone: "neutral",
      },
    ],
  };
}

export function seriesView(series, { range = "24h" } = {}) {
  const points = Array.isArray(series?.series) ? series.series : [];
  const sentTotal = series?.totals?.tokensSent ?? 0;
  const actualTotal = points.reduce((n, p) => n + (p.actualTrimmedTokens || 0), 0);
  const potentialTotal = points.reduce((n, p) => n + (p.potentialTrimmedTokens ?? p.maskedTokens ?? 0), 0);
  const rawTotal = sentTotal + actualTotal;
  const trimmedPct = rawTotal > 0 ? (actualTotal / rawTotal) * 100 : 0;
  const saved = series?.saved ?? { usd: null, potentialUsd: null, pricedShare: 0, basis: "unpriced" };
  const savedUsd = saved.usd ?? null;
  const potentialUsd = saved.potentialUsd ?? null;
  const hasCounterfactual = actualTotal > 0;
  const turns = series?.totals?.turns ?? 0;

  let savedStat;
  if (saved.basis === "unpriced") {
    savedStat = { value: "not priced", detail: "these endpoints declare no price", tone: "neutral" };
  } else if (savedUsd !== null && savedUsd < 0) {
    savedStat = { value: formatSavedUsd(savedUsd), detail: "re-cache cost exceeded savings", tone: "warn" };
  } else {
    const pot = `≈$${potentialUsd !== null ? potentialUsd.toFixed(2) : "0.00"} potential`;
    savedStat = {
      value: `≈ $${savedUsd !== null ? savedUsd.toFixed(2) : "0.00"}`,
      detail: saved.basis === "partial" ? `${pot} · ${Math.round((saved.pricedShare ?? 0) * 100)}% priced` : pot,
      tone: "ok",
    };
  }

  return {
    heading: "Token consumption — with & without optimization",
    trimming:
      trimmedPct > 0
        ? {
            name: "Trimming",
            text: "Old tool output is replaced by a one-line placeholder after a few newer tool uses. The last 40k tokens are never touched.",
            chip: `−${Math.round(trimmedPct)}% sent`,
          }
        : null,
    hasCounterfactual,
    noActivity: sentTotal === 0 && actualTotal === 0 && potentialTotal === 0,
    emptyText: `No model activity in the last ${range}.`,
    legend: {
      sent: "sent",
      raw: "raw counterfactual — same turns, nothing trimmed (est.)",
      noCounterfactual: hasCounterfactual
        ? null
        : range === "24h"
          ? "Hourly comparison starts collecting today."
          : "No trimming recorded in this window.",
    },
    savingLabel:
      actualTotal > 0
        ? {
            text: `−${formatTokens(actualTotal)}${savedUsd !== null ? ` · ${formatSavedUsd(savedUsd)} est.` : ""}`,
            tone: savedUsd !== null && savedUsd < 0 ? "warn" : "ok",
          }
        : null,
    potentialLine:
      potentialTotal > 0
        ? `Potential, not applied: −${formatTokens(potentialTotal)}${potentialUsd !== null ? ` · ≈ $${potentialUsd.toFixed(2)}` : ""} est.`
        : null,
    rawValues: points.map((p) => (p.tokensSent || 0) + (p.actualTrimmedTokens || 0)),
    stats: [
      { id: "sent", label: `Sent (${range})`, value: formatTokens(sentTotal), detail: `raw ${formatTokens(rawTotal)}`, tone: "neutral" },
      { id: "saved", label: "Saved (est.)", ...savedStat },
      {
        id: "costPerTurn",
        label: "Cost / turn",
        value: turns > 0 ? `$${(series.totals.cost / turns).toFixed(2)}` : "—",
        detail: `${range} average`,
        tone: "neutral",
      },
    ],
  };
}

/** `optimizer:summary` + `view` (unsupported answers pass through untouched). */
export function withSummaryView(summary, config) {
  return summary?.supported
    ? { ...summary, view: summaryView(summary, { optimizerEnabled: config?.optimizerEnabled === true }) }
    : summary;
}

/** `optimizer:series` + `view`; the range comes from the series itself, else the request, else 24h. */
export function withSeriesView(series, range) {
  return series?.supported ? { ...series, view: seriesView(series, { range: series.range ?? range ?? "24h" }) } : series;
}
