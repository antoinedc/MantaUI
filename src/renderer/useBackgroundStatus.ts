// The background work budget status (`background:status`): one read on mount, then every 30 s while the
// window is visible. Shared by the Settings card, the Knowledge card's and the CTO pane's one-line status
// and the CTO thrifty banner, plus the "open Settings at the budget card" bridge those surfaces use.

import { useCallback, useEffect, useRef, useState } from "react";
import type { BudgetStatus } from "../shared/api";
import { isBudgetStatus } from "./backgroundWorkFormat";

export const BACKGROUND_STATUS_POLL_MS = 30_000;

export type BackgroundStatusState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ok"; status: BudgetStatus };

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "") || "Something went wrong.";

export function useBackgroundStatus(enabled = true): {
  state: BackgroundStatusState;
  refresh: () => Promise<void>;
  /** Replace the status with a fresher one the caller already has (after a save). */
  adopt: (s: BudgetStatus) => void;
} {
  const [state, setState] = useState<BackgroundStatusState>({ kind: "loading" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await window.api.backgroundStatus();
      if (!alive.current) return;
      setState(isBudgetStatus(s) ? { kind: "ok", status: s } : { kind: "unsupported" });
    } catch (e) {
      if (!alive.current) return;
      const message = errText(e);
      if (/unknown rpc channel/i.test(message)) setState({ kind: "unsupported" });
      // A failed poll keeps the last good reading; only a first read (or a retry) reports the failure.
      else setState((cur) => (cur.kind === "ok" ? cur : { kind: "error", message }));
    }
  }, []);

  const adopt = useCallback((s: BudgetStatus) => {
    if (alive.current) setState({ kind: "ok", status: s });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, BACKGROUND_STATUS_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, refresh]);

  return { state, refresh, adopt };
}

// ---- "open Settings → Background work at the budget card" bridge --------------------------------
//
// The Knowledge card and the CTO pane ask App (which owns the Settings modal) to open on the Background work
// section via the `manta-open-settings` window event; the card scrolls itself into view and focuses its heading. The Settings modal may not be
// mounted yet when the event fires, so the request is also parked in a module flag the card consumes on
// mount (the same shape as accountsData's openAccountsSettings).

export const BACKGROUND_WORK_ANCHOR_ID = "background-work";

let pendingFocus = false;

export function openBackgroundWorkSettings(): void {
  pendingFocus = true;
  window.dispatchEvent(new CustomEvent("manta-open-settings", { detail: { section: "background", backgroundWork: true } }));
}

/** True (once) when a link asked for the budget card. */
export function consumeBackgroundWorkFocus(): boolean {
  const was = pendingFocus;
  pendingFocus = false;
  return was;
}

/** Test seam. */
export function clearBackgroundWorkFocus(): void {
  pendingFocus = false;
}
