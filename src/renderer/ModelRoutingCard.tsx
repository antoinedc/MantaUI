// ===== Model routing card (BET-1222) =====
//
// Settings → Models → Routing. The two things routing surfaces must show in
// one place: which agent gets which tier (Block A), and which plan windows are
// driving today's decision (Block B). Below them, Block C is the with-why chip
// — a warn-toned notice when a window is nearly spent, a neutral one-liner
// otherwise.
//
// Tiers are READ from the pure router module (`AGENT_TIER`) and the quality
// floors from `modelQuality` (`AGENT_FLOOR_SCORE`), never hardcoded here, so
// the card and the router cannot drift. Plan usage is the SAME state the
// composer's usage dial reads (`store.usage`) — no second fetch, no second
// percentage bar (the bar IS `UsageWindowRow`, reused).

import { useState } from "react";
import { AGENT_TIER } from "../shared/modelRouter.mjs";
import { AGENT_FLOOR_SCORE, tierForScore } from "../shared/modelQuality.mjs";
import { tierRank } from "../shared/modelGuide.mjs";
import { useStore } from "./store";
import { Card } from "./Card";
import { providerLabel, UsageWindowRow } from "./UsageDial";

// The four agents, in the fixed display order. The tier comes from the router;
// the sub-label copy is fixed by the design contract (won't drift from it).
const AGENT_ROWS: { agent: string; sub: string }[] = [
  {
    agent: "build",
    sub: "main conversation · switches at session start, never mid-task",
  },
  { agent: "explore", sub: "file search & codebase questions · fresh context" },
  { agent: "general", sub: "multi-step research · fresh context" },
  { agent: "plan", sub: "reasoning-heavy, low token volume" },
];

// The tier the router would actually use for an agent under a preset: the
// preset's preferred tier, raised to the agent's floor. Mirrors chooseModel's
// target computation (modelRouter.mjs) so the card never lies about a floor.
function effectiveTier(preset: string | undefined, agent: string): string {
  const presetTier = AGENT_TIER?.[preset ?? ""]?.[agent] ?? "balanced";
  const floor = tierForScore(AGENT_FLOOR_SCORE?.[agent] ?? 0);
  return tierRank(presetTier) >= tierRank(floor) ? presetTier : floor;
}

const PILL_BASE = "font-mono text-meta rounded-full border border-border bg-raised px-3 py-1 text-text-muted";
const PILL_ACCENT = " border-accent bg-accent-bg text-accent-tx";
const CHIP_NEUTRAL = "rounded-md border border-border-subtle bg-inset px-3 py-2 text-meta text-text-faint";
const CHIP_WARN = "rounded-md border border-warn bg-warn-bg px-3 py-2 text-meta text-text";

export function ModelRoutingCard() {
  const modelRouting = useStore((s) => s.modelRouting);
  const snapshots = useStore((s) => s.usage) ?? [];
  // Snapshot taken once (like the usage dial popover's `nowMs`), so the reset
  // lines don't re-render constantly inside Settings.
  const [nowMs] = useState(() => Date.now());

  const preset = modelRouting?.preset ?? "balanced";
  const perAgent = modelRouting?.perAgent;

  // The first non-stale window at or past 80% — the plan state that is "nearly
  // spent". Stale readings (past reset, waiting replacement numbers) never
  // trigger the warn chip, matching the dial's "never escalate off a stale
  // reading" invariant.
  let nearlySpent: { provider: string; label: string } | null = null;
  outer: for (const s of snapshots) {
    for (const w of s.windows) {
      if (w.stale === true || typeof w.pct !== "number" || w.pct < 80) continue;
      nearlySpent = { provider: providerLabel(s.provider), label: w.label };
      break outer;
    }
  }

  let chipClass: string;
  let chipText: string;
  if (nearlySpent) {
    chipClass = CHIP_WARN;
    chipText = `${nearlySpent.provider} ${nearlySpent.label} is nearly spent — new subagents are routing to cheaper models until it resets.`;
  } else {
    const presetLabel = preset.charAt(0).toUpperCase() + preset.slice(1);
    chipClass = CHIP_NEUTRAL;
    chipText = `${presetLabel} — cheapest model that clears the quality floor for each kind of work.`;
  }

  return (
    <Card header={<span className="text-micro uppercase text-text-faint">Routing</span>}>
      <div>
        {/* Block A — per-agent pills */}
        <div>
          {AGENT_ROWS.map((row, i) => {
            const tier = effectiveTier(preset, row.agent);
            const source = perAgent?.[row.agent] ? "you choose" : "auto";
            const isLast = i === AGENT_ROWS.length - 1;
            return (
              <div
                key={row.agent}
                className={
                  "flex items-center justify-between gap-4 py-3" +
                  (isLast ? "" : " border-b border-border-subtle")
                }
              >
                <div className="min-w-0">
                  <div className="text-label text-text">{row.agent}</div>
                  <div className="text-meta text-text-faint">{row.sub}</div>
                </div>
                <span className={PILL_BASE + (row.agent === "build" ? PILL_ACCENT : "")}>
                  {`${tier} · ${source}`}
                </span>
              </div>
            );
          })}
        </div>

        {/* Block B — plan usage (the same data the composer dial shows) */}
        <div className="text-micro uppercase text-text-faint mt-4 mb-2">Plan usage</div>
        <div className="flex flex-col gap-3">
          {snapshots.map((s) =>
            s.windows.map((w) => (
              <UsageWindowRow
                key={`${s.provider}/${w.kind}`}
                usageWindow={w}
                nowMs={nowMs}
              />
            )),
          )}
        </div>
      </div>

      {/* Block C — explanation chip (never greyed; the off-state has its own copy) */}
      <div className={chipClass}>{chipText}</div>
    </Card>
  );
}
