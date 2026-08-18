// UpdateBar.tsx — the ONE unified update banner (stage 3, BET-1098).
//
// All update states (desktop update, server/box update, CLI updates, the
// mandatory "must update" skew guard, and an update failure) render through a
// single component. Its copy — text, action label, tone, dismissibility — is
// produced by `describeUpdateBanner` in src/shared/updateTargets.mjs and
// passed straight through as props. One component, one usage; props carry the
// whole surface area.
//
// `tone` selects the semantic tint:
//   - "accent" (default) — today's look, byte-identical. Available/mandatory
//     updates read as normal app events.
//   - "danger" — an update FAILED. Swaps the accent tint (which read as "here
//     is something nice for you") for `--danger` at the same 0.10 / 0.30 /
//     0.20 alphas. This is the ONLY visual change of the whole stage.
//
// `dismissible` defaults to true — most update rows are user-dismissible (a
// "remind me later" semantic). The mandatory skew-guard explicitly opts out
// (`dismissible: false`) so the banner sticks until the client is on a
// supported version.

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { BANNER_BTN } from "./Toast";

export type UpdateBarProps = {
  /** Main message text. Keep it under ~80 chars so it fits the titlebar width. */
  text: ReactNode;
  /** Visible version string (e.g. "0.4.1"). Rendered inside `text` if you
   *  pass plain string; for the skew guard this is usually left out. */
  version?: ReactNode;
  /** Primary button label. */
  actionLabel: string;
  /** Primary button click. Fire-and-forget; the component doesn't await. */
  onAction: () => void;
  /** Optional dismiss callback (× button). Required if `dismissible` is true;
   *  ignored when `dismissible` is false (no × button rendered). */
  onDismiss?: () => void;
  /** When true (default), show the × button. Skew guard passes false. */
  dismissible?: boolean;
  /** Semantic tint. "accent" (default) is today's look; "danger" renders a
   *  failed update in the danger tone (bg/border/button all swap). */
  tone?: "accent" | "danger";
  /** When set, the bar renders a determinate progress bar in place of the
   *  action button. */
  progress?: { step: number; total: number; label: string };
  /** When true, the bar is in an IN-FLIGHT state: it renders an indeterminate
   *  progress bar (or the determinate `progress` if supplied) and NO action /
   *  dismiss buttons. Used while a box self-upgrade is running, so the restart
   *  phase shows a graceful "Restarting…" state instead of a frozen step. */
  busy?: boolean;
  /** Label shown when `busy` is true and `progress` is absent (e.g. a
   *  determinate step wouldn't make sense during the restart). */
  busyLabel?: string;
};

/**
 * Single update-banner component driven by `describeUpdateBanner`. `tone`
 * picks the semantic tint; everything else is copied verbatim from stage 1.
 */
export function UpdateBar({
  text,
  actionLabel,
  onAction,
  onDismiss,
  dismissible = true,
  tone = "accent",
  progress,
  busy = false,
  busyLabel = "Updating…",
}: UpdateBarProps) {
  const statusLabel = progress
    ? `${progress.label} (${progress.step}/${progress.total})`
    : busy
      ? busyLabel
      : text;
  const danger = tone === "danger";
  const bannerBtn = danger
    ? "shrink-0 rounded-xs bg-danger/20 px-2 py-px text-danger hover:bg-danger/30 font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-danger"
    : BANNER_BTN;
  return (
    // `pr-[…]` (not `px-3`) reserves the OS caption-button strip: this bar
    // renders ABOVE the titlebar row, so on Windows (titleBarOverlay) the
    // minimize/maximize/close buttons are painted over its right edge and sat
    // on top of the action + dismiss buttons — unclickable. The titlebar row
    // already reserves this via `.titlebar-inset-right`; a top-of-window bar
    // needs the same reservation. `--titlebar-inset-right` evaluates to 0 on
    // macOS/Linux (neither defines the `titlebar-area-*` env vars), so this is
    // exactly `px-3` everywhere else. `tone` swaps ONLY the tint classes.
    <div
      className={`shrink-0 ${
        danger ? "bg-danger/10 border-danger/30" : "bg-accent/10 border-accent/30"
      } border-b pl-3 pr-[calc(var(--sp-3)+var(--titlebar-inset-right))] py-2 text-meta text-text flex items-center gap-2`}
    >
      <span className="flex-1 truncate">{statusLabel}</span>
      {busy || progress ? (
        <div
          className="shrink-0 w-32 h-1.5 rounded-full bg-accent/20 overflow-hidden relative"
          role="progressbar"
          aria-label={busyLabel}
          aria-valuenow={progress ? progress.step : undefined}
          aria-valuemin={progress ? 1 : undefined}
          aria-valuemax={progress ? progress.total : undefined}
        >
          {progress ? (
            <div
              className="h-full bg-accent"
              style={{ width: `${(progress.step / progress.total) * 100}%` }}
            />
          ) : (
            <div className="absolute h-full manta-sweep rounded-full bg-accent" />
          )}
        </div>
      ) : (
        <>
          <button
            onClick={() => {
              onAction();
            }}
            className={bannerBtn}
          >
            {actionLabel}
          </button>
          {dismissible && onDismiss && (
            <button
              onClick={() => onDismiss()}
              className="shrink-0 text-text-faint hover:text-text leading-none inline-flex items-center focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              title="Dismiss"
              aria-label="Dismiss update"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
