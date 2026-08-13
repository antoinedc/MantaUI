// UpdateBar.tsx — shared "an update exists" banner used for three prompts:
//
//   1. Desktop auto-update (electron-updater finished downloading a new
//      version): "Update available: {version}" + "Restart to update" button.
//   2. Server update (BET-225 stage 3): "Server update available: {version}"
//      + "Update & restart" button (fires `scripts/self-update.sh` on the box).
//   3. Version-skew guard (BET-225 stage 3 Part C): "This app is out of
//      date and may not work correctly — please update." + a button that
//      triggers an update flow (autoUpdateInstall / autoUpdateDownload on
//      desktop, App Store informational on mobile). This variant is
//      NON-dismissible (`dismissible: false` hides the × button) — the
//      RPC contract on either side has shifted past `minClient`, so the
//      user MUST act before continuing.
//
// One component, three usages; the spec wants this consolidated rather
// than three near-identical inline banners. Props carry the surface area:
// text + action label + action handler + optional dismiss handler.
//
// `dismissible` defaults to true — the desktop auto-update and server-update
// cases are both user-dismissible (a "remind me later" semantic). The skew
// guard explicitly opts out (`dismissible: false`) so the banner sticks
// until the client gets on a supported version.

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
 * Single update-banner component shared by desktop auto-update, server
 * update, and the version-skew guard. Visual style mirrors the original
 * inline banner in App.tsx so the three usages look identical.
 */
export function UpdateBar({
  text,
  actionLabel,
  onAction,
  onDismiss,
  dismissible = true,
  progress,
  busy = false,
  busyLabel = "Updating…",
}: UpdateBarProps) {
  const statusLabel = progress
    ? `${progress.label} (${progress.step}/${progress.total})`
    : busy
      ? busyLabel
      : text;
  return (
    // `pr-[…]` (not `px-3`) reserves the OS caption-button strip: this bar
    // renders ABOVE the titlebar row, so on Windows (titleBarOverlay) the
    // minimize/maximize/close buttons are painted over its right edge and sat
    // on top of the action + dismiss buttons — unclickable. The titlebar row
    // already reserves this via `.titlebar-inset-right`; a top-of-window bar
    // needs the same reservation. `--titlebar-inset-right` evaluates to 0 on
    // macOS/Linux (neither defines the `titlebar-area-*` env vars), so this is
    // exactly `px-3` everywhere else.
    <div className="shrink-0 bg-accent/10 border-b border-accent/30 pl-3 pr-[calc(var(--sp-3)+var(--titlebar-inset-right))] py-2 text-meta text-text flex items-center gap-2">
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
            className={BANNER_BTN}
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
