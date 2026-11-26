// The open questions of the tasks a chat started (agent screens spec §4.4). The box answers `agents:questions` for one
// chat and publishes a `taskQuestion` hint when one is asked, answered, dismissed or lost: subscribe to the hint BEFORE the
// first read, refetch on a hint for this chat and after a reconnect (the stream's `resync` frame). A read that lands after
// a newer one never rolls the list back; a failed read keeps the list as it was (it is a read, not the user's action).

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskQuestion } from "../../shared/types";

export function useTaskQuestions(sessionId: string | null): { questions: TaskQuestion[]; refresh: () => Promise<void> } {
  const [questions, setQuestions] = useState<TaskQuestion[]>([]);
  const alive = useRef(true);
  const tickets = useRef({ issued: 0, applied: 0 });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const ticket = ++tickets.current.issued;
    try {
      const list = await window.api.agentsQuestions?.({ sessionID: sessionId });
      if (!alive.current || ticket < tickets.current.applied) return;
      tickets.current.applied = ticket;
      setQuestions(Array.isArray(list) ? list.filter((q) => q.state === "open") : []);
    } catch {
      /* the list stays as it was: an older box has no such channel, and a dropped read is retried by the next hint */
    }
  }, [sessionId]);

  useEffect(() => {
    // Another chat's questions must not linger while this chat's first read is on its way.
    tickets.current.applied = tickets.current.issued;
    setQuestions([]);
    if (!sessionId) return;
    const offs: Array<() => void> = [];
    const keep = (off: unknown) => {
      if (typeof off === "function") offs.push(off as () => void);
    };
    keep(
      window.api.onTaskQuestion?.((ev) => {
        if (ev.parentSessionID === sessionId) void load();
      }),
    );
    keep(
      window.api.onStreamEvent?.((ev) => {
        if (ev.sub === "resync") void load();
      }),
    );
    void load();
    return () => offs.forEach((off) => off());
  }, [sessionId, load]);

  return { questions, refresh: load };
}
