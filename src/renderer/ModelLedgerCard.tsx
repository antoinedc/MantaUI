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
import { UPDATE_YOUR_BOX } from "./modelsPicker";

const money = (n: number) => `$${n.toFixed(2)}`;

// Colour of each cache-split segment. The box decides the order, labels, whole
// percentages and the in-bar threshold (`view.segments`); only the colour is
// presentation.
const SEGMENT_CLASS = {
  cacheRead: "bg-danger",
  cacheWrite: "bg-warn",
  output: "bg-accent",
  input: "bg-fill-active",
} as const;

type LedgerData = LedgerSummary | { supported: false };

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

  const header = <span className="text-micro uppercase text-text-faint">Where your spend goes</span>;

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

  // `supported:true` without a `view` = a box older than the ledger view (D24 wire compat).
  const view = (data as LedgerSummary).view;
  if (!view) {
    return (
      <Card header={header}>
        <div className="text-meta text-text-faint">{UPDATE_YOUR_BOX}</div>
      </Card>
    );
  }

  const numCell = "font-mono tabular-nums text-right";

  return (
    <Card header={header}>
      {/* Block 1 — the cache split. */}
      <div>
        <div className="flex gap-4 flex-wrap text-meta text-text-faint">
          {view.segments.map((s) => (
            <span key={s.kind} className="inline-flex items-center gap-2">
              <span className={`h-[9px] w-[9px] rounded-xs ${SEGMENT_CLASS[s.kind]}`} aria-hidden="true" />
              {s.label}
              <span className="font-mono tabular-nums">{s.pct}%</span>
            </span>
          ))}
        </div>
        <div className="mt-2 flex h-6 rounded-md overflow-hidden">
          {view.segments.map((s) => (
            <div
              key={s.kind}
              className={`${SEGMENT_CLASS[s.kind]} flex items-center justify-center overflow-hidden`}
              style={{ width: `${s.pct}%` }}
            >
              {s.inline && <span className="text-on-accent font-mono text-meta">{s.pct}%</span>}
            </div>
          ))}
        </div>
        <div className="mt-1 text-meta text-text-faint">{view.caption}</div>
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
            {view.topModels.map((m, i) => (
              <tr key={m.key} className={i === view.topModels.length - 1 ? "" : "border-b border-border-subtle"}>
                <td className="text-label text-text py-2 pr-3">{m.key}</td>
                <td className={`py-2 px-3 ${numCell}`}>{m.turns.toLocaleString()}</td>
                <td className={`py-2 px-3 ${numCell}`}>{money(m.costPerTurn)}</td>
                <td className={`py-2 px-3 ${numCell}`}>{m.tokensPerSec ?? "—"}</td>
                <td className={`py-2 pl-3 ${numCell}`}>{money(m.cost)}</td>
              </tr>
            ))}
            {view.topModels.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-meta text-text-faint">
                  {view.emptyModels}
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
            {view.agents.map((a, i) => (
              <tr key={a.label} className={i === view.agents.length - 1 ? "" : "border-b border-border-subtle"}>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <span className="text-label text-text">{a.label}</span>
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
            {view.agents.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-meta text-text-faint">
                  {view.emptyAgents}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
