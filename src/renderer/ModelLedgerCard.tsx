// ===== ModelLedgerCard (BET-1221) =====
//
// Read-only "Where your spend goes" ledger card in Settings → Models. Renders
// the `ledger:summary` channel (window.api.ledgerSummary, BET-1219) so the
// user can finally SEE that most of their bill is prompt cache, and which
// model / agent runs on what. No routing, no controls that mutate anything.
//
// Four states, each honest:
//   - loading  → "Reading your history…"
//   - fetch rejected (network error) → render nothing (hide the card entirely)
//     — no card, no numbers, no sentence. A transient network glitch must not
//     read as "your runtime is outdated".
//   - { supported:false } → "Spend history needs a newer box runtime." — NO
//     zeros. A card full of $0.00 would read "you spent nothing", which is a
//     lie.
//   - loaded   → the cache-split bar + by-model + by-agent tables.
//
// Fetches once on mount (the Models section mounts this card only when it
// becomes visible). No polling — spend history does not move second to second.

import { useEffect, useState } from "react";
import { Card } from "./Card";
import type { LedgerSummary } from "../shared/types";

const money = (n: number) => `$${n.toFixed(2)}`;
const wholePct = (f: number) => `${Math.round(f * 100)}%`;

// Order + colour of the cache-split bar segments, and the legend that mirrors
// them above the bar. `cls` is the only visual the contract grants the segment.
const SEGMENTS = [
  { key: "cacheRead", label: "cache read", cls: "bg-danger" },
  { key: "cacheWrite", label: "cache write", cls: "bg-warn" },
  { key: "output", label: "output", cls: "bg-accent" },
  { key: "input", label: "fresh input", cls: "bg-fill-active" },
] as const;

type LedgerData = LedgerSummary | { supported: false };

function Numeric({
  children,
  fallback = "—",
}: {
  children: number | null | undefined;
  fallback?: string;
}) {
  if (children == null) return <span>{fallback}</span>;
  return <span>{children}</span>;
}

export function ModelLedgerCard() {
  // loading=true until the first resolution below; data is null until then.
  const [state, setState] = useState<{
    loading: boolean;
    data: LedgerData | null;
    fetchError: boolean;
  }>({ loading: true, data: null, fetchError: false });

  useEffect(() => {
    let alive = true;
    window.api
      .ledgerSummary()
      .then((r: LedgerData) => {
        if (alive) setState({ loading: false, data: r, fetchError: false });
      })
      .catch(() => {
        // Fetch failed (not "unsupported" — that comes back as a resolved
        // { supported:false }). Don't show the upgrade sentence for a network
        // error; hide the card entirely rather than fabricate a bill or mislead
        // the user into thinking their runtime is outdated.
        if (alive) setState({ loading: false, data: null, fetchError: true });
      });
    return () => {
      alive = false;
    };
  }, []);

  const header = (
    <span className="text-micro uppercase text-text-faint">Where your spend goes</span>
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

  const d = data as LedgerSummary;
  const share = d.cacheShare;
  const cacheSharePct = share.cacheRead + share.cacheWrite;

  const numCell = "font-mono tabular-nums text-right";

  return (
    <Card header={header}>
      {/* Block 1 — the cache split. */}
      <div>
        <div className="flex gap-4 flex-wrap text-meta text-text-faint">
          {SEGMENTS.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-2">
              <span className={`h-[9px] w-[9px] rounded-xs ${s.cls}`} aria-hidden="true" />
              {s.label}
              <span className="font-mono tabular-nums">{wholePct(share[s.key])}</span>
            </span>
          ))}
        </div>
        <div className="mt-2 flex h-6 rounded-md overflow-hidden">
          {SEGMENTS.map((s) => {
            const pct = Math.round(share[s.key] * 100);
            return (
              <div
                key={s.key}
                className={`${s.cls} flex items-center justify-center overflow-hidden`}
                style={{ width: `${pct}%` }}
              >
                {pct >= 4 && (
                  <span className="text-on-accent font-mono text-meta">{pct}%</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-1 text-meta text-text-faint">
          Cache is {wholePct(cacheSharePct)} of your bill — carrying the conversation,
          not generating answers.
        </div>
      </div>

      {/* Block 2 — by model. */}
      <div className="mt-4">
        <table className="w-full text-meta">
          <thead>
            <tr className="text-micro uppercase text-text-faint border-b border-border">
              <th className="text-left font-semibold py-1 pr-3">Model</th>
              <th className="text-right font-semibold py-1 px-3">Turns</th>
              <th className="text-right font-semibold py-1 px-3">$/turn</th>
              <th className="text-right font-semibold py-1 px-3">tok/s</th>
              <th className="text-right font-semibold py-1 pl-3">Total</th>
            </tr>
          </thead>
          <tbody>
            {d.byModel.slice(0, 6).map((m, i) => (
              <tr
                key={m.key}
                className={i === d.byModel.slice(0, 6).length - 1 ? "" : "border-b border-border-subtle"}
              >
                <td className="text-label text-text py-2 pr-3">{m.key}</td>
                <td className={`py-2 px-3 ${numCell}`}>{m.turns.toLocaleString()}</td>
                <td className={`py-2 px-3 ${numCell}`}>{money(m.costPerTurn)}</td>
                <td className={`py-2 px-3 ${numCell}`}>
                  <Numeric>{m.tokensPerSec}</Numeric>
                </td>
                <td className={`py-2 pl-3 ${numCell}`}>{money(m.cost)}</td>
              </tr>
            ))}
            {d.byModel.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-meta text-text-faint">
                  No model spend recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Block 3 — by agent. */}
      <div className="mt-4">
        <table className="w-full text-meta">
          <thead>
            <tr className="text-micro uppercase text-text-faint border-b border-border">
              <th className="text-left font-semibold py-1 pr-3">Agent</th>
              <th className="text-right font-semibold py-1 px-3">Turns</th>
              <th className="text-right font-semibold py-1 px-3">$/turn</th>
              <th className="text-right font-semibold py-1 pl-3">Total</th>
            </tr>
          </thead>
          <tbody>
            {d.byAgent.map((a, i) => (
              <tr
                key={a.agent ?? "main"}
                className={i === d.byAgent.length - 1 ? "" : "border-b border-border-subtle"}
              >
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <span className="text-label text-text">{a.agent ?? "main"}</span>
                    {a.isChild && (
                      <span className="font-mono text-meta rounded-full border border-border bg-raised px-3 py-1 text-text-muted">
                        subagent
                      </span>
                    )}
                  </span>
                </td>
                <td className={`py-2 px-3 ${numCell}`}>{a.turns.toLocaleString()}</td>
                <td className={`py-2 px-3 ${numCell}`}>{money(a.costPerTurn)}</td>
                <td className={`py-2 pl-3 ${numCell}`}>{money(a.cost)}</td>
              </tr>
            ))}
            {d.byAgent.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-meta text-text-faint">
                  No agent spend recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
