// ReconnectingBanner.tsx — surface the events-WebSocket reconnect state from
// the shared ConnectionState machine (src/shared/net/state.ts) as a prominent
// bar above the titlebar.
//
// Replaces the prior "tiny pill in the titlebar" with a full-width bar that
// shows:
//   • a plain-language status ("Reconnecting…" / "Trying to reconnect…" /
//     "Connection lost — controller has stopped")
//   • the current attempt count
//   • the next-backoff delay (so the user knows how long until the next try)
//   • a "Retry now" button that calls window.api.connectionRetryNow() —
//     resets the backoff + total-window deadline and reconnects immediately
//
// Visibility:
//   • connected / idle            → hidden (no signal needed when healthy)
//   • connecting | stalled | reconnecting → shown (the link is degraded)
//   • closed (reason: "reconnect window exceeded") → shown, with copy that
//     reflects the give-up so the user knows the controller stopped trying
//     and a manual retry is the only way forward
//
// The component is presentational — state is read from the Zustand store
// (which httpApi populates via setConnectionState) and the retry action
// goes through the typed api. No timer of its own; the banner updates
// whenever the controller transitions.

import { describe as describeConnection, type ConnectionState } from "../shared/net/state.js";

export type ReconnectingBannerProps = {
  /** Live connection state from the store. */
  state: ConnectionState;
  /** Fires when the user clicks "Retry now". Wired by App.tsx to call
   *  window.api.connectionRetryNow(). */
  onRetryNow: () => void;
};

export function ReconnectingBanner({ state, onRetryNow }: ReconnectingBannerProps) {
  // Visibility: every state except `connected` and `idle` surfaces a banner.
  // `idle` is the "no controller has been asked to start yet" state — not a
  // problem worth showing. `closed` is included because a closed controller
  // IS the user-visible "stuck" signal the banner exists to surface.
  if (state.state === "connected" || state.state === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Same top-of-window caption-button reservation as UpdateBar — this
      // banner also renders above the titlebar row and also carries a
      // right-aligned button ("Retry now"), which the Windows caption buttons
      // covered. 0 on macOS/Linux, so identical to `px-3` there.
      className="shrink-0 bg-accent/10 border-b border-accent/30 pl-3 pr-[calc(var(--sp-3)+var(--titlebar-inset-right))] py-2 text-meta text-text flex items-center gap-2"
    >
      <span className="flex-1 truncate">
        {renderCopy(state)}
      </span>
      <button
        onClick={onRetryNow}
        className="shrink-0 rounded-xs bg-accent/20 px-2 py-px text-accent hover:bg-accent/30 font-medium"
        title="Reset backoff and reconnect immediately"
      >
        Retry now
      </button>
    </div>
  );
}

function renderCopy(state: ConnectionState): React.ReactNode {
  switch (state.state) {
    case "connecting":
      return <>Connecting… (attempt {state.attempt})</>;
    case "stalled":
      return (
        <>
          Connection dropped, retrying…
          <span className="text-text-faint">
            {" "}
            · {formatSince(state.since)}
          </span>
        </>
      );
    case "reconnecting":
      return (
        <>
          Reconnecting… attempt {state.attempt} · next try in{" "}
          <span className="font-medium text-text">
            {formatBackoff(state.backoffMs)}
          </span>
        </>
      );
    case "closed":
      return (
        <>
          {state.reason === "reconnect window exceeded"
            ? "Connection lost — stopped retrying. Click Retry now to try again."
            : `Disconnected (${state.reason})`}
        </>
      );
    // exhaustive — connected/idle are filtered above and ConnectionState
    // has no other variants.
    case "connected":
    case "idle":
      return null;
    default: {
      // unreachable, but keeps the typecheck honest if ConnectionState grows.
      const _exhaustive: never = state;
      void _exhaustive;
      return describeConnection(state);
    }
  }
}

function formatBackoff(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  }
  const m = Math.round(ms / 60_000);
  return `${m}m`;
}

function formatSince(since: Date): string {
  const ms = Date.now() - since.getTime();
  if (ms < 1000) return "just now";
  return `${formatBackoff(ms)} ago`;
}
