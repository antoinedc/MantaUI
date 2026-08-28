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
