// "Open this task's session" for the pages (Fleet cell, profile's seat row): the box opens (or re-creates) the task's window,
// the tree is re-listed, the window selected. It reports its own outcome: a refusal is a sentence, never silence. Same
// action the run cards' "Open session →" runs (`openJobSession`).

import { useCallback, useRef, useState } from "react";
import { backgroundApi, openJobSession } from "../backgroundRun";
import { useStore } from "../store";

export function useOpenTask(): { open: (jobId: string) => Promise<void>; busyId: string | null; error: string | null } {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const open = useCallback(async (jobId: string) => {
    if (!jobId || busy.current) return;
    busy.current = true;
    setBusyId(jobId);
    setError(null);
    const r = await openJobSession(jobId, {
      open: (input) => backgroundApi().delegateOpenSession(input),
      select: async (tmuxSession, windowIndex) => {
        const st = useStore.getState();
        await st.refresh();
        await st.activateWindow(tmuxSession, windowIndex);
      },
    });
    busy.current = false;
    setBusyId(null);
    if (!r.ok) setError(r.error);
  }, []);
  return { open, busyId, error };
}

/** An agent's direct chat window: the box made (or found) it; re-list the tree (it may be new), select it, or throw why not. */
export async function openChatWindow(tmuxSession: string, windowIndex: number): Promise<void> {
  await useStore.getState().refresh();
  const found = useStore.getState().projects.some((p) => p.tmuxSession === tmuxSession && p.windows.some((w) => w.index === windowIndex));
  if (!found) throw new Error("its chat window did not appear — try again");
  await useStore.getState().activateWindow(tmuxSession, windowIndex);
}
