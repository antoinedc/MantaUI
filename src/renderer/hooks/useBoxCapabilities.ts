// useBoxCapabilities.ts — the ONE desktop accessor for the box's server-first
// capability ids (master D25). The box advertises `capabilities: string[]` on
// `server:version` (src/server/boxCapabilities.mjs); a client on an older box
// finds an id missing and hides / disables the dependent feature with
// "Update your box to use this" — no fallback copy of the moved logic.
//
//   useBoxCapability(id) → true  (the box has it)
//                          false (the box answered and does not — an older box)
//                          null  (not known yet / the box could not be asked)

import { useEffect, useState } from "react";
import { useStore } from "../store";

export const UPDATE_BOX_NOTE = "Update your box to use this";

let known: ReadonlySet<string> | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

async function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const v = await window.api.getServerVersion();
      // An older box answers without the field: that is "has none", not "unknown".
      known = new Set(Array.isArray(v?.capabilities) ? v.capabilities : []);
      notify();
    } catch {
      // Could not ask the box: keep the last known answer (null stays null).
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam: forget what the box said. */
export function resetBoxCapabilities(): void {
  known = null;
  inflight = null;
  notify();
}

export function useBoxCapability(id: string): boolean | null {
  const connection = useStore((s) => s.connectionState.state);
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  // Ask once on first use and again on every connection edge (a reconnect after a
  // box upgrade carries the new list).
  useEffect(() => {
    if (connection === "connected" || connection === "idle") void load();
  }, [connection]);
  return known === null ? null : known.has(id);
}
