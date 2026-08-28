// BET-1384: pure CTO-pane & sidebar derivation, extracted for testability.
// The CTO pane (§10) renders from a single `{kind:"ctoState"}` bus event
// (payload shape below) plus a `GET /api/cto/state` initial read. This module
// holds only deterministic mapping — no window.api, no React.

export type CtoDot = "active" | "disabled" | "thrifty" | "paused";

export type CtoState = {
  enabled: boolean;
  dot: CtoDot;
  needsYouCount: number;
  generationInFlight: boolean;
  tonightCount: number;
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
