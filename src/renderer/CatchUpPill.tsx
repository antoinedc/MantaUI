// ===== Catch-up pill =====
//
// The floating status pill shown at the bottom-centre of the transcript while a
// panel that was hidden catches up (spec 2026-10-30-session-catch-up, B2;
// visual source: docs/session-catch-up/mockup.html). Purely presentational: the
// state, copy and timers come from useCatchUp / describeCatchUpPill.

import { describeCatchUpPill } from "./chatUtils";
import type { CatchUpPillProps } from "./hooks/useCatchUp";

export const SPINNER_CLASS =
  "w-3 h-3 shrink-0 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none";

export function CatchUpPill({ state, onCancel, onRetry }: CatchUpPillProps) {
  const view = describeCatchUpPill({ state });
  return (
    <div
      className="manta-catchup-pill"
      data-testid="catchup-pill"
      data-tone={view.tone === "error" ? "error" : undefined}
      role="status"
      aria-live="polite"
    >
      {state !== "error" && <span className={SPINNER_CLASS} aria-hidden="true" />}
      <span className="manta-catchup-pill__label">{view.label}</span>
      {view.action && (
        <button
          type="button"
          className="manta-catchup-pill__action"
          onClick={view.action === "cancel" ? onCancel : onRetry}
        >
          {view.action === "cancel" ? "Cancel" : "Retry"}
        </button>
      )}
    </div>
  );
}
