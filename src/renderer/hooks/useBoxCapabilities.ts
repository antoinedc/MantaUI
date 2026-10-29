// useBoxCapabilities.ts — the ONE desktop accessor for the box's server-first
// capability ids (master D25, WS11 D1). The box advertises `capabilities:
// string[]` on `GET /api/version` (src/server/boxCapabilities.mjs) — the one
// upgrade-exempt read, so it still answers mid-migration. A client on an older
// box finds an id missing and hides / disables the dependent feature with
// "Update your box to use this" — no fallback copy of the moved logic.
//
//   useBoxCapability(id) → true  (the box has it)
//                          false (the box answered and does not — an older box)
//                          null  (loading, or the box could not be asked — a
//                                 failure is never evidence of an old box)

import { useEffect } from "react";
import { useStore } from "../store";

function isAuthError(e: unknown): boolean {
  return (e as { name?: string })?.name === "AuthRequiredError" || (e as { status?: number })?.status === 401;
}

/** Retry schedule after a failed read: 1 s → 2 s → 5 s → 10 s (cap). */
export const CAPABILITY_RETRY_MS = [1000, 2000, 5000, 10000] as const;

let inflight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/**
 * Ask the box for its capability list and write the store slice. A failed read
 * keeps the last loaded ids (a reconnect blip must not hide features) and
 * schedules a backoff retry; a successful one resets the schedule.
 */
export function refreshBoxCapabilities(): Promise<void> {
  if (inflight) return inflight;
  cancelRetry();
  inflight = (async () => {
    try {
      const v = await window.api.apiVersion();
      attempt = 0;
      // An older box answers without the field: that is "has none", not "unknown".
      useStore.getState().setBoxCapabilities({
        state: "loaded",
        ids: Array.isArray(v?.capabilities) ? v.capabilities : [],
        loadedOnce: true,
      });
    } catch (e) {
      const prev = useStore.getState().boxCapabilities;
      useStore.getState().setBoxCapabilities({ state: "failed", ids: prev.ids, loadedOnce: prev.loadedOnce });
      // A 401 is the existing sign-in path's to handle (App re-opens pairing): retrying here would only
      // hammer the box with a token it has already refused.
      if (isAuthError(e)) return;
      const delay = CAPABILITY_RETRY_MS[Math.min(attempt, CAPABILITY_RETRY_MS.length - 1)];
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        // While the stream is down the reconnect refresh covers it; retrying into a dead link is noise.
        const c = useStore.getState().connectionState.state;
        if (c === "connected" || c === "idle") void refreshBoxCapabilities();
      }, delay);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam / box switch: forget what the box said. */
export function resetBoxCapabilities(): void {
  cancelRetry();
  inflight = null;
  attempt = 0;
  useStore.getState().setBoxCapabilities({ state: "loading", ids: [], loadedOnce: false });
}

export function useBoxCapability(id: string): boolean | null {
  const connection = useStore((s) => s.connectionState.state);
  const caps = useStore((s) => s.boxCapabilities);
  // Ask on first use and again on every connection edge (a reconnect after a box
  // upgrade carries the new list); App.tsx also refreshes on connect so the slice
  // is populated before any gated surface mounts.
  useEffect(() => {
    if (connection === "connected" || connection === "idle") void refreshBoxCapabilities();
  }, [connection]);
  // `failed` with ids from an earlier success keeps answering from them.
  if (!caps.loadedOnce) return null;
  return caps.ids.includes(id);
}
