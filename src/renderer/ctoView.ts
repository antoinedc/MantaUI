// BET-1384: pure CTO-pane & sidebar derivation, extracted for testability.
// The CTO pane (§10) renders from a single `{kind:"ctoState"}` bus event
// (payload shape below) plus a `GET /api/cto/state` initial read. This module
// holds only deterministic mapping — no window.api, no React.

export type CtoDot = "active" | "disabled" | "thrifty" | "paused";

export type CtoState = {
  enabled: boolean;
  dot: CtoDot;
  pausedAt: number | null;
  needsYouCount: number;
  generationInFlight: boolean;
  tonightCount: number;
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
