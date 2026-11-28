// "Open this task's session" for the pages (Fleet cell, profile's seat row): the box opens (or re-creates) the task's window,
// the tree is re-listed, the window selected. It reports its own outcome: a refusal is a sentence, never silence. Same
// action the run cards' "Open session →" runs (`openJobSession`).

import { useCallback, useRef, useState } from "react";
import { backgroundApi, openJobSession } from "../backgroundRun";
import { useStore } from "../store";

/** The part of a Fleet row Open session needs. */
export type OpenableRow = { key?: string; kind?: "chat" | "task"; jobId: string; window?: { tmuxSession: string; index: number } | null };

export function useOpenTask(): { open: (jobId: string) => Promise<void>; openRow: (row: OpenableRow) => Promise<void>; canOpen: (row: OpenableRow) => boolean; busyId: string | null; error: string | null } {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const run = useCallback(async (id: string, go: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    if (!id || busy.current) return;
    busy.current = true;
    setBusyId(id);
    setError(null);
    let r: { ok: true } | { ok: false; error: string };
    try {
      r = await go();
    } catch (e) {
      r = { ok: false, error: e instanceof Error && e.message ? e.message : "Couldn’t open it." };
    }
    busy.current = false;
    setBusyId(null);
    if (!r.ok) setError(r.error);
  }, []);
  const open = useCallback(
    (jobId: string) =>
      run(jobId, () =>
        openJobSession(jobId, {
          open: (input) => backgroundApi().delegateOpenSession(input),
          select: async (tmuxSession, windowIndex) => {
            const st = useStore.getState();
            await st.refresh();
            await st.activateWindow(tmuxSession, windowIndex);
          },
        }),
      ),
    [run],
  );
  // a chat row has a window the box named: select it. A row that is a job opens through its job (the box re-creates a closed window).
  const openRow = useCallback(
    (row: OpenableRow) => {
      const id = row.key || row.jobId;
      if (row.kind === "chat" && row.window) {
        const w = row.window;
        return run(id, async () => {
          const st = useStore.getState();
          await st.refresh();
          await st.activateWindow(w.tmuxSession, w.index);
          return { ok: true } as const;
        });
      }
      return open(row.jobId);
    },
    [open, run],
  );
  /** A row with neither a window nor a job has nothing to open: the control is not drawn. */
  const canOpen = useCallback((row: OpenableRow) => !!row.jobId || (row.kind === "chat" && !!row.window), []);
  return { open, openRow, canOpen, busyId, error };
}

/** An agent's direct chat window: the box made (or found) it; re-list the tree (it may be new), select it, or throw why not. */
export async function openChatWindow(tmuxSession: string, windowIndex: number): Promise<void> {
  await useStore.getState().refresh();
  const found = useStore.getState().projects.some((p) => p.tmuxSession === tmuxSession && p.windows.some((w) => w.index === windowIndex));
  if (!found) throw new Error("its chat window did not appear — try again");
  await useStore.getState().activateWindow(tmuxSession, windowIndex);
}
