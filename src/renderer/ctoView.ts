// BET-1384: pure CTO-pane & sidebar derivation, extracted for testability.
// The CTO pane (§10) renders from a single `{kind:"ctoState"}` bus event
// (payload shape below) plus a `GET /api/cto/state` initial read. This module
// holds only deterministic mapping — no window.api, no React.

export type CtoDot = "active" | "disabled" | "thrifty" | "paused";

// Cold-start backfill (§10.6-4): informational progress for the learning card.
// Never a needs-you item — it does not count into the sidebar badge.
export type BackfillState = {
  done: number;
  total: number;
  startedAt: number | null;
  stopped: boolean;
  reason: string | null;
  stoppedAtDepthDays: number | null;
  active: boolean;
};

export type CtoState = {
  enabled: boolean;
  dot: CtoDot;
  pausedAt: number | null;
  needsYouCount: number;
  generationInFlight: boolean;
  tonightCount: number;
  backfill?: BackfillState;
};

// Server payload may omit backfill on older bridges; treat absent as idle.
export const idleBackfill: BackfillState = {
  done: 0,
  total: 0,
  startedAt: null,
  stopped: false,
  reason: null,
  stoppedAtDepthDays: null,
  active: false,
};

// A Health-card P1 row (§10.5 card 2). `n` = samples seen, `min` = minimum
// sample size before the value may be trusted. While `n < min` the renderer
// shows `collecting (n/k)` and never the number — a stat never displays noise
// as signal.
export type CtoHealthStat = {
  id: "ambientSpendToday" | "digestOpens" | "pipelineLag";
  label: string;
  value: string | null;
  n: number;
  min: number;
};

// Pure stat-display selector (§10.5): when a stat has not reached its minimum
// sample size, render `collecting (n / min)` instead of the (possibly noisy)
// value. Returns the ready flag so the caller can de-emphasize collecting rows.
export function statDisplay(stat: CtoHealthStat): { text: string; ready: boolean } {
  const ready = stat?.n >= stat?.min && typeof stat?.value === "string" && stat.value !== "";
  if (!ready) {
    return {
      text: `collecting (${stat?.n ?? 0} / ${stat?.min ?? 0})`,
      ready: false,
    };
  }
  return { text: stat.value as string, ready: true };
}

// Pure state→banner selector (§10.6-5): the paused banner (paused-at time +
// "no probes, no jobs…" + Resume) REPLACES the overview header exactly when
// the engine reports the kill switch is active (`dot === "paused"`). A null /
// pre-pairing state (dot undefined) is never paused. `pausedAt` is the
// epoch-ms the kill switch was thrown, for the banner's "paused at" line.
export function showPausedBanner(state: CtoState | null): boolean {
  return state?.dot === "paused";
}

// State-dot tone (§10.1): active/disabled/thrifty/paused → ok/tx4/warn/danger.
// StatusDot's tones are ok/running/error/warn/idle; disabled maps to idle
// (bg-text-quiet = the quiet text tier), which is the tx4 analogue.
export function dotTone(dot: CtoDot | undefined): "ok" | "idle" | "warn" | "error" {
  switch (dot) {
    case "active":
      return "ok";
    case "thrifty":
      return "warn";
    case "paused":
      return "error";
    case "disabled":
    default:
      return "idle";
  }
}

// Sidebar badge (§10.1): count of open needs-you items only, hidden at zero.
// Returns null when there is nothing to show so the caller can omit the badge.
export function badgeLabel(state: CtoState | null | undefined): number | null {
  const n = state?.needsYouCount ?? 0;
  return n > 0 ? n : null;
}

// Status-dot visibility, independent of tone: always shown on the sidebar
// entry (the dot reflects enabled/disabled/thrifty/paused), so a null state
// defaults to the disabled (gray) tone rather than disappearing.
export function showDot(): boolean {
  return true;
}

// Digest-now button (§10.2): joins/starts the single-flight generation and
// renders the server's generation-in-flight flag as its spinner, so two
// views/devices can never double-generate. Busy ⇒ clicking is a no-op.
export function digestBusy(state: CtoState | null | undefined): boolean {
  return state?.generationInFlight === true;
}

// The backfill learning-card view (§10.6-4) — derived purely from the state
// so the component stays a dumb renderer. Returns null when there is nothing
// to show (never started, or completed cleanly).
export type BackfillCardView = {
  done: number;
  total: number;
  pct: number; // 0..1
  etaMs: number | null; // extrapolated wall ETA
  stopped: boolean;
  reason: string | null;
  stoppedAtDepthDays: number | null;
  // Active = a backfill is running right now. When stopped, the card still
  // renders (with the reason) so the "stopped at depth" is visible; a clean
  // completion shows nothing.
  show: boolean;
};

export function backfillCardView(state: CtoState | null | undefined): BackfillCardView | null {
  const b = state?.backfill;
  if (!b) return null;
  const total = Math.max(0, b.total || 0);
  const done = Math.max(0, Math.min(b.done || 0, total || b.done || 0));
  let etaMs: number | null = null;
  if (done > 0 && total > done && b.startedAt && Date.now() > b.startedAt) {
    const rate = (Date.now() - b.startedAt) / done;
    etaMs = Math.max(0, Math.round(rate * (total - done)));
  }
  return {
    done,
    total,
    pct: total > 0 ? done / total : 0,
    etaMs,
    stopped: !!b.stopped,
    reason: b.reason ?? null,
    stoppedAtDepthDays: b.stoppedAtDepthDays ?? null,
    show: !!b.active || !!b.stopped,
  };
}

// Human "~1h 12m" style ETA for the learning card.
export function formatEta(etaMs: number | null): string | null {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return null;
  const totalMin = Math.max(1, Math.round(etaMs / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `~${m}m`;
  if (m === 0) return `~${h}h`;
  return `~${h}h ${m}m`;
}

// BET-1385: overview sections (§10.3/§10.4/§10.6). Only deterministic mapping
// lives here — no window.api, no React; the components in `ctoSections.tsx`
// consume these pure derivations.

// The open needs-you card a Blocker section row renders (§10.3). Kept as a
// structural subset of the wire `CtoCard` so the component + tests don't need
// every field.
export type BlockerCard = {
  id: string;
  title: string;
  body: string;
  sourceKind: string;
  sourceId: string | null;
  sessionID: string | null;
  pendingSince: number;
  refs: string[];
};

// Readable relative time (age stamps, Just-finished relative time). Short
// forms: "<1m", "<Nm", "<Nh", "Nd". Pure + deterministic for a given clock.
export function relativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return "";
  const d = Math.max(0, now - ts);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (d < MIN) return "<1m";
  if (d < HOUR) return `<${Math.floor(d / MIN)}m`;
  if (d < DAY) return `<${Math.floor(d / HOUR)}h`;
  return `${Math.floor(d / DAY)}d`;
}

// The Blocker card's Answer-now action (§10.3). Pure resolution:
//   - question/permission → navigate to the owning session (the in-session
//     question card is focused via the existing manta-scroll-to-question
//     bridge in the component).
//   - inbox-note / health → no fix-surface navigation exists in the renderer
//     yet, so these resolve to the ledger fallback (the §10.3 honest route).
// When the card's target session no longer exists (or is absent), fall back
// to opening the matching ledger entry via an inline modal.
export type BlockerAction =
  | { action: "session"; sessionID: string }
  | { action: "ledger" };

export function blockerTarget(
  card: BlockerCard,
  knownSessions: Set<string>,
): BlockerAction {
  const sourceKind = card?.sourceKind ?? "";
  const isSessionTarget = sourceKind !== "inbox" && sourceKind !== "health";
  if (isSessionTarget) {
    return card.sessionID && knownSessions.has(card.sessionID)
      ? { action: "session", sessionID: card.sessionID }
      : { action: "ledger" };
  }
  return { action: "ledger" };
}

// A Just-finished rail entry (§10.4) drives its primary action ("open" a turn's
// session; "logs" a gate-failed job's failure detail in an inline surface) or,
// for a done job, NO action yet — branch/PR-open has no surface until the
// settings/forge page lands, so a done job renders no dead button.
export type FinishedVariant =
  | { action: "open" }
  | { action: "logs" }
  | { action: "none" };

export function finishedVariant(item: {
  kind: string;
  status?: string | null;
}): FinishedVariant {
  if (item?.kind === "job") {
    return item.status === "failed" ? { action: "logs" } : { action: "none" };
  }
  return { action: "open" };
}

// Digest tier → chip tone (§10.4). Maps the tier lattice blessedly collapsibly
// onto the statusdot/status-chip fill tones.
export function digestTone(tier: string | undefined): "ok" | "info" | "warn" | "danger" | "idle" {
  const t = tier && tier.trim().toLowerCase();
  if (!t) return "idle";
  if (["need", "blocker", "urgent"].includes(t)) return "danger";
  if (["tonight", "plan"].includes(t)) return "warn";
  if (["great", "progress", "met", "done"].includes(t)) return "ok";
  if (["info", "aware", "fact"].includes(t)) return "info";
  return "idle";
}

// Is an item expandable (has a `deep` technical layer)? §10.4.
export function digestExpandable(item: { deep?: string | null } | null | undefined): boolean {
  return typeof item?.deep === "string" && item.deep.trim().length > 0;
}

// Resting state (§10.6-1): "Nothing needs you ✓" renders only when there are
// no open needs-you cards AND all rails/digest are empty. Digest presence is
// passed as `digestHasItems` so an empty-but-present digest counts as empty.
export function resting(
  inputs: {
    cards?: BlockerCard[] | null;
    nowActive?: unknown[] | null;
    finished?: unknown[] | null;
    digestHasItems?: boolean;
  } = {},
): boolean {
  const cards = inputs.cards ?? [];
  const nowActive = inputs.nowActive ?? [];
  const finished = inputs.finished ?? [];
  return cards.length === 0 && nowActive.length === 0 && finished.length === 0 && !inputs.digestHasItems;
}

// Now-rail/digest shared: does the list of sessions have any blocked one — the
// "blocked — question above ↑" chip on a blocked Now card (never repeats the
// question).
export function stateTone(state: "working" | "blocked"): "ok" | "warn" {
  return state === "blocked" ? "warn" : "ok";
}

// Now-rail cost formatting (§10.4). A session's accumulated cost (USD) as a
// short `$X.XX` label, or null when absent/zero/NaN so the caller can omit the
// segment entirely (component may also choose how granular to show it).
export function nowCostLabel(cost: number | null | undefined): string | null {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
  return `$${cost.toFixed(2)}`;
}

// Now-rail meta composition (§10.4): `project · cost · elapsed`. The cost
// segment sits between the project name and the elapsed time and is dropped
// when absent (no `· ·` gap in the line). Pure + deterministic for tests.
export function nowRailMeta(project: string, cost: string | null, elapsed: string | null): string {
  return [project, cost, elapsed].filter((s): s is string => Boolean(s && s.length > 0)).join(" · ");
}
