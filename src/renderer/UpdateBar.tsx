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
}: UpdateBarProps) {
  return (
    <div className="shrink-0 bg-accent/10 border-b border-accent/30 px-3 py-1.5 text-[12px] text-text flex items-center gap-2">
      <span className="flex-1 truncate">{text}</span>
      <button
        onClick={() => {
          onAction();
        }}
        className="shrink-0 rounded bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30 font-medium"
      >
        {actionLabel}
      </button>
      {dismissible && onDismiss && (
        <button
          onClick={() => onDismiss()}
          className="shrink-0 text-text-faint hover:text-text leading-none"
          title="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
