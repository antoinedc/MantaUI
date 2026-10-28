// ledgerView.mjs — the render model for "Where your spend goes" (WS09 SF-M6).
// Wraps `ledger:summary`: the raw summary is untouched and a `view` block is
// added, so the desktop card and the iOS screen render the same segments,
// caption and tables without re-deriving percentages (D23). Money ($1.20) and
// thousands separators stay client formatting.

const SEGMENTS = [
  { kind: "cacheRead", label: "cache read" },
  { kind: "cacheWrite", label: "cache write" },
  { kind: "output", label: "output" },
  { kind: "input", label: "fresh input" },
];
const INLINE_MIN_PCT = 4;
const TOP_MODELS = 6;

const wholePct = (f) => Math.round((Number.isFinite(f) ? f : 0) * 100);

export function ledgerView(summary) {
  const share = summary?.cacheShare ?? {};
  const segments = SEGMENTS.map((s) => {
    const pct = wholePct(share[s.kind]);
    return { kind: s.kind, label: s.label, pct, inline: pct >= INLINE_MIN_PCT };
  });
  const cachePct = wholePct((share.cacheRead ?? 0) + (share.cacheWrite ?? 0));
  return {
    segments,
    caption: `Cache is ${cachePct}% of your bill — carrying the conversation, not generating answers.`,
    topModels: (summary?.byModel ?? []).slice(0, TOP_MODELS).map((m) => ({
      key: m.key,
      turns: m.turns,
      costPerTurn: m.costPerTurn,
      tokensPerSec: m.tokensPerSec ?? null,
      cost: m.cost,
    })),
    agents: (summary?.byAgent ?? []).map((a) => ({
      label: a.agent ?? "main",
      isChild: a.isChild === true,
      turns: a.turns,
      costPerTurn: a.costPerTurn,
      cost: a.cost,
    })),
    emptyModels: "No model spend recorded.",
    emptyAgents: "No agent spend recorded.",
  };
}

/** `ledger:summary` result + `view` (an unsupported box answer is returned untouched). */
export function withLedgerView(summary) {
  return summary?.supported ? { ...summary, view: ledgerView(summary) } : summary;
}
