// ===== OptimizerCard (BET-1337 + P2.5 BET-1347) =====
//
// Phase-1 "Observe" card in Settings → Models (quota-window fuel gauges,
// forecast-at-reset tick, sent-vs-raw consumption chart, 30-day stats), now
// extended by BET-1347 with the legibility surfaces: the switch card's
// read-only status sub-rows, pressure chips under each gauge, the metered-
// endpoints slim row (role + crossover price, DELIBERATELY no gauge — a
// metered endpoint has no window and never resets, so there is nothing to
// fill), and the activity feed that is the optimizer's trust surface.
//
// EVERYTHING renders from the `optimizer:summary` read model (BET-1333 +
// children). AGENTS.md "NEVER STUB A CONTROL TO DO NOTHING": a status sub-row
// appears only when its backing subsystem reports data; absent data renders the
// documented empty state, never a fabricated zero. The editable switch toggle
// is the schema-driven `optimizerEnabled` control (BET-1343) rendered by the
// settings form above this card — this card shows its current state, never a
// second toggle for the same setting.
//
// State handling mirrors ModelLedgerCard / the phase-1 card, unchanged:
//   - loading  → "Reading your history…"
//   - fetch rejected → hide the card (a transient glitch must not read as
//     "your runtime is outdated")
//   - { supported:false } → "…needs a newer box runtime." — NO zeros.
//   - loaded   → the card.

import { useEffect, useState } from "react";
import { Card } from "./Card";
import { ChipGroup } from "./Chip";
import { useStore } from "./store";
import {
  buildCumulativePath,
  chartAxisTicks,
  formatResetAt,
  formatTokens,
  formatClockTime,
  describePressure,
  describeActivityEntry,
} from "./chatUtils";
import type { OptimizerSummary, OptimizerRange, OptimizerSeries } from "../shared/types";

type OptimizerData = OptimizerSummary | { supported: false };
type OptimizerSeriesData = OptimizerSeries | { supported: false };

const wholePct = (v: number): string => `${Math.round(v)}%`;

// Anthropic prompt-cache TTL label for the Cache-hit detail line — matches the
// BET-1337 spec's "5m" / "1h" wording (a default confidence still shows the
// 5-minute baseline, e.g. "TTL 5m default").
function ttlLabel(ms: number): string {
  if (ms === 3_600_000) return "1h";
  if (ms === 300_000) return "5m";
  return `${Math.round(ms / 60_000)}m`;
}

// Gauge fill colour thresholds (BET-1337): <60 ok, 60–84 warn, ≥85 danger.
function gaugeColor(pct: number): string {
  if (pct >= 85) return "var(--danger)";
  if (pct >= 60) return "var(--warn)";
  return "var(--ok)";
}

// Axis-tick token label for the consumption chart (tokens only, matching the
// mockup's "0 / 14M / 28M" scale). This is chart-axis rendering, not a display
// figure — the figures themselves use formatTokens.
function axisTokens(v: number): string {
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${(Math.round(m * 10) / 10).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (v >= 1_000) return `${Math.round(v / 1000)}k`;
  return `${Math.round(v)}`;
}

// Consumption chart geometry — matched to the mockup's structure (left axis
// label column, dashed upper gridlines, solid baseline) but sized for the
// card. Paths are built in a local (0..W, 0..H) space where y=0 is the top
// (max) and y=H the bottom (zero), then translated into the SVG.
const CHART = { left: 50, top: 6, width: 600, height: 200 };

// The range selector's options (BET-1369). Single source of truth beside the
// label suffix lookup below, so the chip set and the stat labels can't drift.
const RANGE_OPTIONS: { value: OptimizerRange; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

// The human suffix used in range-scoped stat labels ("Sent (24h)", "24h average").
const RANGE_LABEL: Record<OptimizerRange, string> = {
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
};

// The muted explanation line under the legend when no counterfactual was
// recorded in the window (BET-1369). Both states are real and reachable.
function noCounterfactualText(range: OptimizerRange): string {
  return range === "24h" ? "Hourly comparison starts collecting today." : "No trimming recorded in this window.";
}

function emptyWindowText(range: OptimizerRange): string {
  return `No model activity in the last ${range}.`;
}

export function OptimizerCard() {
  const optimizerEnabled = useStore((s) => s.optimizerEnabled);
  const [state, setState] = useState<{
    loading: boolean;
    data: OptimizerData | null;
    fetchError: boolean;
  }>({ loading: true, data: null, fetchError: false });
  // BET-1369: the window selector + the windowed series read. The summary
  // drives the rest of the card (cache, sessions, windows, activity); the
  // chart + the range-scoped stats read exclusively from this series.
  const [range, setRange] = useState<OptimizerRange>("24h");
  const [series, setSeries] = useState<{
    loading: boolean;
    data: OptimizerSeriesData | null;
    loadError: boolean;
  }>({ loading: true, data: null, loadError: false });

  useEffect(() => {
    let alive = true;
    window.api
      .optimizerSummary()
      .then((r: OptimizerData) => {
        if (alive) setState({ loading: false, data: r, fetchError: false });
      })
      .catch(() => {
        if (alive) setState({ loading: false, data: null, fetchError: true });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setSeries((s) => ({ ...s, loading: true }));
    window.api
      .optimizerSeries(range)
      .then((r: OptimizerSeriesData) => {
        if (alive) setSeries({ loading: false, data: r, loadError: false });
      })
      .catch(() => {
        if (alive) setSeries((s) => ({ ...s, loading: false, loadError: true }));
      });
    return () => {
      alive = false;
    };
  }, [range]);

  const header = (
    <span className="text-micro uppercase text-text-faint">Token optimizer</span>
  );

  if (state.loading) {
    return (
      <Card header={header}>
        <div className="text-meta text-text-faint">Reading your history…</div>
      </Card>
    );
  }

  if (state.fetchError) {
    return null;
  }

  const data = state.data;
  if (!data || !data.supported) {
    return (
      <Card header={header}>
        <div className="text-meta text-text-faint">
          Spend history needs a newer box runtime.
        </div>
      </Card>
    );
  }

  const d = data as OptimizerSummary;
  const now = Date.now();

  const windows = Array.isArray(d.windows) ? d.windows : [];
  const hasWindows = windows.length > 0;

  // ---- BET-1369: the WINDOWED series drives the consumption chart and the
  // range-scoped stats below. The summary drives everything else on the card.
  // While a range fetch is in flight we keep the previous chart (opacity-60);
  // if the series read is unsupported/rejected, only the chart block degrades.
  const seriesUnsupported = series.loadError || (series.data ? !series.data.supported : false);
  const sd = !seriesUnsupported && series.data && series.data.supported ? (series.data as OptimizerSeries) : null;

  // Range-scoped totals (0 until the series is readable).
  const sentTotal = sd ? sd.totals.tokensSent : 0;
  const maskedTotal = sd ? sd.totals.maskedTokens : 0;
  const rawTotal = sentTotal + maskedTotal;
  const trimmedPct = rawTotal > 0 ? (maskedTotal / rawTotal) * 100 : 0;

  // BET-1370: the window's savings now come from the SERIES — real per-model
  // prompt-side pricing minus the cache re-warm the mask forced, computed
  // server-side (the old whole-dollar per-million-token guess is gone). `usd`
  // is null when the applied turns aren't priceable ("not priced"); negative
  // when the re-warm cost exceeded the saving (never clamped). While the series
  // is in flight / unsupported, fall back to the unpriced state.
  const savedUsd = sd ? sd.saved.usd : null;
  const savedBasis = sd ? sd.saved.basis : "unpriced";
  const savedPricedShare = sd ? sd.saved.pricedShare : 0;
  const potentialUsd = sd ? sd.saved.potentialUsd : null;

  // Consumption chart series (cumulative), scaled together by the peak.
  const maxTokens = Math.max(rawTotal, 1);
  const sentPath = buildCumulativePath(
    sd ? sd.series.map((p) => p.tokensSent || 0) : [],
    CHART.width,
    CHART.height,
    maxTokens,
  );
  const rawPath = buildCumulativePath(
    sd ? sd.series.map((p) => (p.tokensSent || 0) + (p.maskedTokens || 0)) : [],
    CHART.width,
    CHART.height,
    maxTokens,
  );

  // X-axis ticks (BET-1366): bucket-start epoch ms, per the range's bucket.
  const axisTicks = sd ? chartAxisTicks(sd.series.map((p) => p.t), sd.bucket) : [];
  const hasCounterfactual = sd ? sd.counterfactualAvailable : false;
  const noActivity = sd ? sentTotal === 0 && maskedTotal === 0 : false;

  const cs = d.cacheShare;
  const hitDenom = cs.cacheRead + cs.cacheWrite + cs.input;
  const cacheHitPct = hitDenom > 0 ? (cs.cacheRead / hitDenom) * 100 : 0;

  const costPerTurn = sd && sd.totals.turns > 0 ? `$${(sd.totals.cost / sd.totals.turns).toFixed(2)}` : "—";

  // BET-1347 slices.
  const activity = Array.isArray(d.activity?.entries) ? d.activity.entries : [];
  const compaction = d.compaction && d.compaction.total > 0 ? d.compaction : null;
  const metered = Array.isArray(d.metered) ? d.metered : [];
  // Pacing is "reporting" when any window carries a pressure signal.
  const pacingActive = windows.some((w) => typeof w.tokensPerPct === "number");
  const worstWindow = windows.reduce<(typeof windows)[number] | null>(
    (worst, w) => (w.tokensPerPct != null && (worst == null || (w.deficit ?? 0) > (worst.deficit ?? 0)) ? w : worst),
    null,
  );
  const pacingChip = pacingActive && worstWindow ? describePressure(worstWindow.deficit ?? 0, true) : null;

  return (
    <Card header={header}>
      {/* ── Switch card: the read-only status sub-rows (BET-1347) ────────── */}
      <div className="opt-switch">
        <div className="opt-switch-head">
          <div className="opt-switch-txt">
            <b>Manta optimized token usage</b>
            <p>
              Manta trims, paces and compacts your conversations to make a plan last
              longer. It never changes which model you picked by hand. Everything it
              changes is listed below.
            </p>
          </div>
          {/* The state indicator reflects the schema-driven optimizerEnabled
              toggle (BET-1343) rendered above this card — this is its status,
              not a second edit control for the same setting. */}
          <span className={`opt-switch-state${optimizerEnabled ? " on" : ""}`}>
            {optimizerEnabled ? "On" : "Off"}
          </span>
        </div>
        <div className="opt-subrows">
          {trimmedPct > 0 && (
            <div className="opt-subrow">
              <span className="opt-subrow-n">Trimming</span>
              <span className="opt-subrow-v">
                Old tool output is replaced by a one-line placeholder after a few newer
                tool uses. The last 40k tokens are never touched.
              </span>
              <span className="opt-subrow-k">−{Math.round(trimmedPct)}% sent</span>
            </div>
          )}
          {pacingActive && pacingChip && (
            <div className="opt-subrow">
              <span className="opt-subrow-n">Pacing</span>
              <span className="opt-subrow-v">
                Cheaper models while a plan window is ahead of pace. Build and plan work
                keeps its quality floor.
              </span>
              <span className="opt-subrow-k">eco · {pacingChip.text}</span>
            </div>
          )}
          {compaction && (
            <div className="opt-subrow">
              <span className="opt-subrow-n">Compacting</span>
              <span className="opt-subrow-v">
                Long idle conversations are summarized in the background, before you come
                back to them.
              </span>
              <span className="opt-subrow-k">
                {compaction.background} of {compaction.total} in background
              </span>
            </div>
          )}
          <div className="opt-subrow">
            <span className="opt-subrow-n">Prompt cache</span>
            <span className="opt-subrow-v">
              Reads billed at 0.1×; TTL {d.ttl ? ttlLabel(d.ttl.measuredMs) : "5m"} measured.
            </span>
            <span className="opt-subrow-k">{wholePct(cacheHitPct)} hit</span>
          </div>
        </div>
      </div>

      {/* ── Subscription windows + pressure chips ────────────────────────── */}
      {hasWindows && (
        <>
          <div className="text-label text-text" style={{ marginTop: "var(--sp-6)" }}>
            Subscription windows
          </div>
          <p className="opt-sub">
            Forecast from your recent usage. Tick = forecast at reset. Pressure chip = how
            far ahead of pace this window is right now.
          </p>
          <div className="opt-wins">
            {windows.map((w) => {
              const title = [w.planLabel, w.windowLabel].filter(Boolean).join(" — ");
              const pct = Number.isFinite(w.pct) ? w.pct : 0;
              const fp = typeof w.forecastPct === "number" ? w.forecastPct : null;
              const chip = describePressure(w.deficit ?? 0, typeof w.tokensPerPct === "number");
              return (
                <div className="opt-win" key={`${w.provider}:${w.windowLabel}`}>
                  <div className="opt-win-t">
                    <b>{title}</b>
                    <span className="opt-win-reset">
                      {w.resetsAt != null ? `resets ${formatResetAt(w.resetsAt, now)}` : ""}
                    </span>
                  </div>
                  <div className="opt-gauge">
                    <span
                      className="opt-gauge-fill"
                      style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: gaugeColor(pct) }}
                    />
                    {fp != null && (
                      <span
                        className={`opt-gauge-fc${fp >= 85 ? " warn" : ""}`}
                        style={{ left: `${Math.min(100, Math.max(0, fp))}%` }}
                      />
                    )}
                  </div>
                  <div className="opt-win-meta">
                    <span>{wholePct(pct)} used</span>
                    <span>{fp != null ? `forecast ${wholePct(fp)}` : "gathering history…"}</span>
                  </div>
                  <div style={{ marginTop: "var(--sp-2)" }}>
                    <span className={`opt-chip ${chip.tone}`}>{chip.text}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Consumption chart + range selector (BET-1369) ────────────────── */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="opt-chart-head">Token consumption — with &amp; without optimization</div>
        <ChipGroup label="Consumption window" value={range} options={RANGE_OPTIONS} onChange={setRange} />
      </div>
      {seriesUnsupported ? (
        <div className="text-meta text-text-faint">
          Spend history needs a newer box runtime.
        </div>
      ) : !sd ? (
        <div className="text-meta text-text-faint">Reading your history…</div>
      ) : (
        <div className={series.loading ? "opacity-60" : undefined}>
          {noActivity ? (
            <div className="opt-empty">{emptyWindowText(range)}</div>
          ) : (
            <>
              <svg
                className="opt-chart"
                viewBox={`0 0 ${CHART.left + CHART.width + 6} ${CHART.top + CHART.height + 18}`}
                role="img"
                aria-label="Token consumption with and without optimization"
              >
                <g transform={`translate(${CHART.left} ${CHART.top})`}>
                  <line x1="0" y1={CHART.height} x2={CHART.width} y2={CHART.height} stroke="var(--border-subtle)" />
                  <line x1="0" y1={CHART.height / 2} x2={CHART.width} y2={CHART.height / 2} stroke="var(--border-subtle)" strokeDasharray="2 5" opacity=".6" />
                  <line x1="0" y1="0" x2={CHART.width} y2="0" stroke="var(--border-subtle)" strokeDasharray="2 5" opacity=".6" />
                  <line x1="0" y1="0" x2="0" y2={CHART.height} stroke="var(--border-subtle)" />

                  <text x="-8" y={CHART.height + 12} textAnchor="end" fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">0</text>
                  <text x="-8" y={CHART.height / 2 + 4} textAnchor="end" fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">{axisTokens(maxTokens / 2)}</text>
                  <text x="-8" y="4" textAnchor="end" fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">{axisTokens(maxTokens)}</text>

                  {axisTicks.map((t) => {
                    const isFirst = t.index === 0;
                    const isLast = t.index === sd.series.length - 1;
                    const anchor = isFirst ? "start" : isLast ? "end" : "middle";
                    const x = axisTicks.length > 1 ? (t.index / (sd.series.length - 1)) * CHART.width : 0;
                    return (
                      <text key={t.index} x={x} y={CHART.height + 14} textAnchor={anchor} fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">
                        {t.label}
                      </text>
                    );
                  })}

                  {hasCounterfactual && <path d={rawPath} fill="none" stroke="var(--tx4)" strokeWidth="2" strokeDasharray="5 4" />}
                  <path d={sentPath} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
                  <path
                    d={`${sentPath} L ${CHART.width} ${CHART.height} L 0 ${CHART.height} Z`}
                    fill="rgb(var(--accent-rgb) / 0.08)"
                    stroke="none"
                  />

                  {maskedTotal > 0 && (
                    <text x={CHART.width} y="24" textAnchor="end" fill="var(--ok)" fontSize="10" fontFamily="var(--font-mono)">
                      −{formatTokens(maskedTotal)}
                      {savedUsd !== null ? ` · ≈ $${savedUsd.toFixed(2)} est.` : ""}
                    </text>
                  )}
                </g>
              </svg>
              <div className="opt-legend">
                <span className="opt-legend-item">
                  <i style={{ background: "var(--accent)" }} />
                  sent
                </span>
                {hasCounterfactual && (
                  <span className="opt-legend-item">
                    <i style={{ background: "var(--tx4)" }} />
                    raw counterfactual — same turns, nothing trimmed (est.)
                  </span>
                )}
                {!hasCounterfactual && (
                  <span className="text-text-faint">{noCounterfactualText(range)}</span>
                )}
              </div>
            </>
          )}

          <div className="opt-stats">
            <div className="opt-stat">
              <div className="opt-stat-l">Sent ({RANGE_LABEL[range]})</div>
              <div className="opt-stat-v">{formatTokens(sentTotal)}</div>
              <div className="opt-stat-d">raw {formatTokens(rawTotal)}</div>
            </div>
            <div className="opt-stat">
              <div className="opt-stat-l">Saved</div>
              {savedBasis === "unpriced" ? (
                <>
                  <div className="opt-stat-v">not priced</div>
                  <div className="opt-stat-d">these endpoints declare no price</div>
                </>
              ) : savedUsd !== null && savedUsd < 0 ? (
                <>
                  <div className="opt-stat-v warn">−${(-savedUsd).toFixed(2)}</div>
                  <div className="opt-stat-d">re-warm cost exceeded the saving</div>
                </>
              ) : (
                <>
                  <div className="opt-stat-v ok">≈ ${savedUsd !== null ? savedUsd.toFixed(2) : "0.00"}</div>
                  <div className="opt-stat-d">
                    {savedBasis === "partial"
                      ? `≈$${potentialUsd !== null ? potentialUsd.toFixed(2) : "0.00"} potential · ${Math.round(savedPricedShare * 100)}% priced`
                      : `≈$${potentialUsd !== null ? potentialUsd.toFixed(2) : "0.00"} potential`}
                  </div>
                </>
              )}
            </div>
            <div className="opt-stat">
              <div className="opt-stat-l">Cache hit</div>
              <div className="opt-stat-v">{wholePct(cacheHitPct)}</div>
              <div className="opt-stat-d">
                {`${d.ttl ? `TTL ${ttlLabel(d.ttl.measuredMs)} ${d.ttl.confidence}` : ""} · 30d`}
              </div>
            </div>
            <div className="opt-stat">
              <div className="opt-stat-l">Cost / turn</div>
              <div className="opt-stat-v">{costPerTurn}</div>
              <div className="opt-stat-d">{RANGE_LABEL[range]} average</div>
            </div>
            <div className="opt-stat">
              <div className="opt-stat-l">Sessions</div>
              <div className="opt-stat-v">{d.bySession.length}</div>
              {compaction ? (
                <div className="opt-stat-d" data-testid="compaction-bg">
                  {compaction.background} of {compaction.total} in background · 30d
                </div>
              ) : (
                <div className="opt-stat-d">30d</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Metered endpoints: slim role + crossover price, NO gauge ─────── */}
      {metered.length > 0 && (
        <div className="opt-meter">
          <div className="opt-chart-head">Metered endpoints</div>
          <p className="opt-sub">
            Pay-per-token endpoints have no window and never reset, so there is nothing to
            fill — only a role and the price at which they beat the subscription.
          </p>
          {metered.map((m) => (
            <div className="opt-meter-row" key={m.name}>
              <b>{m.name}</b>
              <span className="opt-meter-role">{m.role}</span>
              <span className="opt-meter-px">{m.price}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Activity feed: the trust surface ─────────────────────────────── */}
      <div className="opt-chart-head" style={{ marginTop: "var(--sp-6)" }}>
        Activity
      </div>
      <p className="opt-sub">
        Every parameter change the optimizer made on its own, with the evidence it used.
        Rolled-back entries stay — that is the point.
      </p>
      {activity.length === 0 ? (
        <div className="opt-empty">
          Nothing changed yet. Manta needs a few days of your usage before it starts tuning
          anything.
        </div>
      ) : (
        <div className="opt-feed">
          {activity.map((e) => {
            const { headline, detail } = describeActivityEntry(e);
            return (
              <div className={`opt-ev${e.verdict === "rolled-back" ? " rb" : ""}`} key={e.id}>
                <span className="opt-ev-when">{formatClockTime(e.ts)}</span>
                <div className="opt-ev-body">
                  <div className="opt-ev-hd">{headline}</div>
                  {detail && <div className="opt-ev-why">{detail}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
