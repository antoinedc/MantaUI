// ===== OptimizerCard (BET-1337) =====
//
// Read-only phase-1 "Observe" card in Settings → Models: the quota-window
// fuel gauges (with their forecast-at-reset tick), the "sent vs raw
// counterfactual" consumption chart, and the 30-day stats row. EVERYTHING it
// renders is backed by the `optimizer:summary` read model (BET-1333 + children
// 2–4). It renders NOTHING from phase 2 — no switch, no activity feed, no
// pressure chips, no metered endpoints, no "optimizer on" graph marker.
// Observe and report only; nothing actuates.
//
// State handling mirrors ModelLedgerCard exactly (BET-1221):
//   - loading  → "Reading your history…"
//   - fetch rejected (network) → render nothing (hide the card entirely; a
//     transient glitch must not read as "your runtime is outdated")
//   - { supported:false } → "…needs a newer box runtime." — NO zeros.
//   - loaded   → the card.
//
// Fetches once on mount (the Models section mounts this card only when it
// becomes visible). No polling — the server memoizes the summary for 60s.

import { useEffect, useState } from "react";
import { Card } from "./Card";
import { buildCumulativePath, formatResetAt, formatTokens } from "./chatUtils";
import type { OptimizerSummary } from "../shared/types";

type OptimizerData = OptimizerSummary | { supported: false };

const wholePct = (v: number): string => `${Math.round(v)}%`;

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

export function OptimizerCard() {
  const [state, setState] = useState<{
    loading: boolean;
    data: OptimizerData | null;
    fetchError: boolean;
  }>({ loading: true, data: null, fetchError: false });

  useEffect(() => {
    let alive = true;
    window.api
      .optimizerSummary()
      .then((r: OptimizerData) => {
        if (alive) setState({ loading: false, data: r, fetchError: false });
      })
      .catch(() => {
        // Fetch failed (not "unsupported" — that returns as a resolved
        // { supported:false }). Hide the card, don't mislead into an upgrade
        // sentence for a transient network problem.
        if (alive) setState({ loading: false, data: null, fetchError: true });
      });
    return () => {
      alive = false;
    };
  }, []);

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

  // 30-day aggregates over the zero-filled daily series.
  const sent30d = d.dailySeries.reduce((s, e) => s + (e.tokensSent || 0), 0);
  const masked30d = d.dailySeries.reduce((s, e) => s + (e.maskedTokens || 0), 0);
  const raw30d = sent30d + masked30d;

  // Consumption chart series (cumulative), scaled together by the peak.
  const maxTokens = Math.max(raw30d, 1);
  const sentPath = buildCumulativePath(
    d.dailySeries.map((e) => e.tokensSent || 0),
    CHART.width,
    CHART.height,
    maxTokens,
  );
  const rawPath = buildCumulativePath(
    d.dailySeries.map((e) => (e.tokensSent || 0) + (e.maskedTokens || 0)),
    CHART.width,
    CHART.height,
    maxTokens,
  );

  // Flat $3/Mtok counterfactual saving estimate (refined per-model in phase 2).
  const saved = Math.round((masked30d * 3) / 1_000_000);

  const cs = d.cacheShare;
  const hitDenom = cs.cacheRead + cs.cacheWrite + cs.input;
  const cacheHitPct = hitDenom > 0 ? (cs.cacheRead / hitDenom) * 100 : 0;

  const costPerTurn = d.totals.turns > 0 ? `$${(d.totals.cost / d.totals.turns).toFixed(2)}` : "—";

  return (
    <Card header={header}>
      {hasWindows && (
        <>
          <div className="text-label text-text">Subscription windows</div>
          <p className="opt-sub">
            Forecast from your recent usage. Tick = forecast at reset (hidden until enough
            history).
          </p>
          <div className="opt-wins">
            {windows.map((w) => {
              const title = [w.planLabel, w.windowLabel].filter(Boolean).join(" — ");
              const pct = Number.isFinite(w.pct) ? w.pct : 0;
              const fp = typeof w.forecastPct === "number" ? w.forecastPct : null;
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
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="opt-chart-head">
        Token consumption — with &amp; without optimization
      </div>
      <svg
        className="opt-chart"
        viewBox={`0 0 ${CHART.left + CHART.width + 6} ${CHART.top + CHART.height + 18}`}
        role="img"
        aria-label="Token consumption with and without optimization"
      >
        <g transform={`translate(${CHART.left} ${CHART.top})`}>
          {/* Baseline (zero) + dashed gridlines at half and full scale. */}
          <line x1="0" y1={CHART.height} x2={CHART.width} y2={CHART.height} stroke="var(--border-subtle)" />
          <line x1="0" y1={CHART.height / 2} x2={CHART.width} y2={CHART.height / 2} stroke="var(--border-subtle)" strokeDasharray="2 5" opacity=".6" />
          <line x1="0" y1="0" x2={CHART.width} y2="0" stroke="var(--border-subtle)" strokeDasharray="2 5" opacity=".6" />
          {/* Y-axis (left edge of the plot). */}
          <line x1="0" y1="0" x2="0" y2={CHART.height} stroke="var(--border-subtle)" />

          {/* Axis labels — tokens only, inline mono, 10px. */}
          <text x="-8" y={CHART.height + 12} textAnchor="end" fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">0</text>
          <text x="-8" y={CHART.height / 2 + 4} textAnchor="end" fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">{axisTokens(maxTokens / 2)}</text>
          <text x="-8" y="4" textAnchor="end" fill="var(--tx4)" fontSize="10" fontFamily="var(--font-mono)">{axisTokens(maxTokens)}</text>

          {/* Raw counterfactual line (dashed) + sent line (accent) + area fill. */}
          <path d={rawPath} fill="none" stroke="var(--tx4)" strokeWidth="2" strokeDasharray="5 4" />
          <path d={sentPath} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
          <path
            d={`${sentPath} L ${CHART.width} ${CHART.height} L 0 ${CHART.height} Z`}
            fill="rgb(var(--accent-rgb) / 0.08)"
            stroke="none"
          />

          {/* Saving annotation — the vertical gap is masked tokens. */}
          {masked30d > 0 && (
            <text x={CHART.width} y="24" textAnchor="end" fill="var(--ok)" fontSize="10" fontFamily="var(--font-mono)">
              −{formatTokens(masked30d)} · ≈ ${saved} est.
            </text>
          )}
        </g>
      </svg>
      <div className="opt-legend">
        <span className="opt-legend-item">
          <i style={{ background: "var(--accent)" }} />
          sent
        </span>
        <span className="opt-legend-item">
          <i style={{ background: "var(--tx4)" }} />
          raw counterfactual — same turns, nothing trimmed (est.)
        </span>
      </div>

      <div className="opt-stats">
        <div className="opt-stat">
          <div className="opt-stat-l">Sent (30d)</div>
          <div className="opt-stat-v">{formatTokens(sent30d)}</div>
          <div className="opt-stat-d">raw {formatTokens(raw30d)}</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-l">Saved</div>
          <div className="opt-stat-v ok">≈ ${saved}</div>
          <div className="opt-stat-d">est. · counterfactual</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-l">Cache hit</div>
          <div className="opt-stat-v">{wholePct(cacheHitPct)}</div>
          {/* TTL detail is intentionally absent: optimizer:summary.ttl is null on
              current runtimes (the measured-TTL feature was reverted; see
              BET-1334/#1339). Render nothing rather than a fabricated TTL. */}
          <div className="opt-stat-d" />
        </div>
        <div className="opt-stat">
          <div className="opt-stat-l">Cost / turn</div>
          <div className="opt-stat-v">{costPerTurn}</div>
          <div className="opt-stat-d">30d average</div>
        </div>
        <div className="opt-stat">
          <div className="opt-stat-l">Sessions</div>
          <div className="opt-stat-v">{d.bySession.length}</div>
          <div className="opt-stat-d">30d</div>
        </div>
      </div>
    </Card>
  );
}
