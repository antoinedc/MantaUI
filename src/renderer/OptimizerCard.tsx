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
// EVERYTHING renders from the box-computed `view` blocks of `optimizer:summary`
// and `optimizer:series` (WS09 SF-M7, src/server/optimizer/view.mjs): every
// string, band, tone and empty state is the box's. Only chart geometry
// (cumulative path, axis ticks) and clock formatting stay here. AGENTS.md "NEVER STUB A CONTROL TO DO NOTHING": a status sub-row
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
import { buildCumulativePath, chartAxisTicks, formatResetAt, formatClockTime } from "./chatUtils";
import type { OptimizerSummary, OptimizerRange, OptimizerSeries } from "../shared/types";
import { UPDATE_YOUR_BOX } from "./modelsPicker";

type OptimizerData = OptimizerSummary | { supported: false };
type OptimizerSeriesData = OptimizerSeries | { supported: false };

// Gauge fill colour for the box's band (<60 ok, 60–84 warn, ≥85 danger).
const BAND_COLOR = { ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)" } as const;

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

export function OptimizerCard() {
  const [state, setState] = useState<{
    loading: boolean;
    data: OptimizerData | null;
    fetchError: boolean;
  }>({ loading: true, data: null, fetchError: false });
  // BET-1369: the window selector + the windowed series read. The summary
  // drives the rest of the card (cache, windows, activity); the chart + the
  // range-scoped stats read exclusively from this series.
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

  const header = <span className="text-micro uppercase text-text-faint">Token optimizer</span>;

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
        <div className="text-meta text-text-faint">Spend history needs a newer box runtime.</div>
      </Card>
    );
  }

  const d = data as OptimizerSummary;
  const sv = d.view;
  // `supported:true` without a `view` = a box older than the optimizer view (D24 wire compat).
  if (!sv) {
    return (
      <Card header={header}>
        <div className="text-meta text-text-faint">{UPDATE_YOUR_BOX}</div>
      </Card>
    );
  }
  const now = Date.now();

  // While a range fetch is in flight we keep the previous chart (opacity-60);
  // if the series read is unsupported/rejected, only the chart block degrades.
  const seriesUnsupported = series.loadError || (series.data ? !series.data.supported : false);
  const sd = !seriesUnsupported && series.data && series.data.supported ? (series.data as OptimizerSeries) : null;
  const rv = sd?.view ?? null;

  // Chart geometry (M8, stays client): cumulative paths scaled together by the peak.
  const rawValues = rv?.rawValues ?? [];
  const sentValues = sd ? sd.series.map((p) => p.tokensSent || 0) : [];
  const rawTotal = rawValues.reduce((n, v) => n + v, 0);
  const maxTokens = Math.max(rawTotal, 1);
  const sentPath = buildCumulativePath(sentValues, CHART.width, CHART.height, maxTokens);
  const rawPath = buildCumulativePath(rawValues, CHART.width, CHART.height, maxTokens);
  const axisTicks = sd ? chartAxisTicks(sd.series.map((p) => p.t), sd.bucket) : [];

  return (
    <Card header={header}>
      {/* ── Switch card: the read-only status sub-rows (BET-1347) ────────── */}
      <div className="opt-switch">
        <div className="opt-switch-head">
          <div className="opt-switch-txt">
            <b>Manta optimized token usage</b>
            <p>{sv.switch.body}</p>
          </div>
          {/* The state reflects the schema-driven optimizerEnabled toggle
              rendered above this card — its status, not a second edit control. */}
          <span className={`opt-switch-state${sv.switch.on ? " on" : ""}`}>{sv.switch.label}</span>
        </div>
        <div className="opt-subrows">
          {[...(rv?.trimming ? [{ id: "trimming", ...rv.trimming }] : []), ...sv.subrows.map((r) => ({ id: r.id, name: r.name, text: r.text, chip: r.chip }))].map(
            (r) => (
              <div className="opt-subrow" key={r.id}>
                <span className="opt-subrow-n">{r.name}</span>
                <span className="opt-subrow-v">{r.text}</span>
                <span className="opt-subrow-k">{r.chip}</span>
              </div>
            ),
          )}
        </div>
      </div>

      {/* ── Subscription windows + pressure chips ────────────────────────── */}
      {sv.windows.length > 0 && (
        <>
          <div className="text-label text-text" style={{ marginTop: "var(--sp-6)" }}>
            Subscription windows
          </div>
          <p className="opt-sub">{sv.windowsCaption}</p>
          <div className="opt-wins">
            {sv.windows.map((w) => (
              <div className="opt-win" key={w.key}>
                <div className="opt-win-t">
                  <b>{w.title}</b>
                  <span className="opt-win-reset">{w.resetsAt != null ? `resets ${formatResetAt(w.resetsAt, now)}` : ""}</span>
                </div>
                <div className="opt-gauge">
                  <span
                    className="opt-gauge-fill"
                    style={{ width: `${Math.min(100, Math.max(0, w.pct))}%`, background: BAND_COLOR[w.band] }}
                  />
                  {w.forecastPct != null && (
                    <span
                      className={`opt-gauge-fc${w.forecastWarn ? " warn" : ""}`}
                      style={{ left: `${Math.min(100, Math.max(0, w.forecastPct))}%` }}
                    />
                  )}
                </div>
                <div className="opt-win-meta">
                  <span>{w.pctLabel}</span>
                  <span>{w.forecastLabel}</span>
                </div>
                <div style={{ marginTop: "var(--sp-2)" }}>
                  <span className={`opt-chip ${w.pressure.tone}`}>{w.pressure.text}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Consumption chart + range selector (BET-1369) ────────────────── */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="opt-chart-head">{rv?.heading ?? "Token consumption — with & without optimization"}</div>
        <ChipGroup label="Consumption window" value={range} options={RANGE_OPTIONS} onChange={setRange} />
      </div>
      {seriesUnsupported ? (
        <div className="text-meta text-text-faint">Spend history needs a newer box runtime.</div>
      ) : !sd ? (
        <div className="text-meta text-text-faint">Reading your history…</div>
      ) : !rv ? (
        <div className="text-meta text-text-faint">{UPDATE_YOUR_BOX}</div>
      ) : (
        <div className={series.loading ? "opacity-60" : undefined}>
          {rv.noActivity ? (
            <div className="opt-empty">{rv.emptyText}</div>
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

                  {rv.hasCounterfactual && <path d={rawPath} fill="none" stroke="var(--tx4)" strokeWidth="2" strokeDasharray="5 4" />}
                  <path d={sentPath} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
                  <path
                    d={`${sentPath} L ${CHART.width} ${CHART.height} L 0 ${CHART.height} Z`}
                    fill="rgb(var(--accent-rgb) / 0.08)"
                    stroke="none"
                  />

                  {rv.savingLabel && (
                    <text
                      x={CHART.width}
                      y="24"
                      textAnchor="end"
                      fill={rv.savingLabel.tone === "warn" ? "var(--warn)" : "var(--ok)"}
                      fontSize="10"
                      fontFamily="var(--font-mono)"
                    >
                      {rv.savingLabel.text}
                    </text>
                  )}
                </g>
              </svg>
              <div className="opt-legend">
                <span className="opt-legend-item">
                  <i style={{ background: "var(--accent)" }} />
                  {rv.legend.sent}
                </span>
                {rv.hasCounterfactual && (
                  <span className="opt-legend-item">
                    <i style={{ background: "var(--tx4)" }} />
                    {rv.legend.raw}
                  </span>
                )}
                {rv.legend.noCounterfactual && <span className="text-text-faint">{rv.legend.noCounterfactual}</span>}
              </div>
              {/* Potential is its own line: trims a shadow run found but that
                  were never applied, so those tokens are inside "sent". */}
              {rv.potentialLine && (
                <div className="opt-sub" data-testid="optimizer-potential">
                  {rv.potentialLine}
                </div>
              )}
            </>
          )}

          <div className="opt-stats">
            {[...rv.stats, ...sv.stats].map((st) => (
              <div className="opt-stat" key={st.id}>
                <div className="opt-stat-l">{st.label}</div>
                <div className={`opt-stat-v${st.tone === "ok" ? " ok" : st.tone === "warn" ? " warn" : ""}`}>{st.value}</div>
                <div className="opt-stat-d" data-testid={st.id === "sessions" ? "compaction-bg" : undefined}>
                  {st.detail}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Metered endpoints: slim role + crossover price, NO gauge ─────── */}
      {sv.metered.length > 0 && (
        <div className="opt-meter">
          <div className="opt-chart-head">Metered endpoints</div>
          <p className="opt-sub">{sv.meteredCaption}</p>
          {sv.metered.map((m) => (
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
      <p className="opt-sub">{sv.activityCaption}</p>
      {sv.activity.length === 0 ? (
        <div className="opt-empty">{sv.activityEmpty}</div>
      ) : (
        <div className="opt-feed">
          {sv.activity.map((e) => (
            <div className={`opt-ev${e.rolledBack ? " rb" : ""}`} key={e.id}>
              <span className="opt-ev-when">{formatClockTime(e.ts)}</span>
              <div className="opt-ev-body">
                <div className="opt-ev-hd">{e.headline}</div>
                {e.detail && <div className="opt-ev-why">{e.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
