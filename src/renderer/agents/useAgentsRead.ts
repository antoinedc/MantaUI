// A read of the agent screens' box data, kept fresh (agent screens spec §2.1, §4.4, contract §States).
//
// The box publishes hints — `agentFleet` (jobs, changes, seats or questions changed), `taskQuestion`, `agentChange` — and the
// stream's `resync` frame says events may have been missed. The hook subscribes to all of them BEFORE the first read, then
// refetches on a hint, debounced (FLEET_REFETCH_DEBOUNCE_MS), so a burst is one read. A read that lands after a newer one never
// rolls the data back. A failed refetch keeps what is shown (it is a read, not the user's action); only a first read that
// failed is an error. A channel an older box doesn't have — or the demo transport's null — is `unsupported`, not an error.

import { useCallback, useEffect, useRef, useState } from "react";
import { FLEET_REFETCH_DEBOUNCE_MS, errText, isUnknownChannel } from "./agentsView";

export type AgentsRead<T> = {
  data: T | null;
  /** A first read that failed (the sentence); null once data is shown. */
  error: string | null;
  /** The box has no such channel (older box) or answered nothing. */
  unsupported: boolean;
  /** No answer yet. */
  loading: boolean;
  reload: () => Promise<void>;
};

type State<T> = { data: T | null; error: string | null; unsupported: boolean; loading: boolean };

/**
 * `read` is called for every (re)read and may be null while there is nothing to ask. `key` restarts the hook (another agent,
 * another connection): its data is dropped and the first read happens again.
 */
export function useAgentsRead<T>(read: (() => Promise<T | null | undefined>) | null, key: unknown): AgentsRead<T> {
  const [state, setState] = useState<State<T>>({ data: null, error: null, unsupported: false, loading: read != null });
  const readRef = useRef(read);
  readRef.current = read;
  const alive = useRef(true);
  const tickets = useRef({ issued: 0, applied: 0 });

  const load = useCallback(async () => {
    const fn = readRef.current;
    if (!fn) return;
    const ticket = ++tickets.current.issued;
    try {
      const got = await fn();
      if (!alive.current || ticket < tickets.current.applied) return;
      tickets.current.applied = ticket;
      if (got == null) setState({ data: null, error: null, unsupported: true, loading: false });
      else setState({ data: got, error: null, unsupported: false, loading: false });
    } catch (e) {
      if (!alive.current || ticket < tickets.current.applied) return;
      if (isUnknownChannel(e)) {
        tickets.current.applied = ticket;
        setState({ data: null, error: null, unsupported: true, loading: false });
      } else {
        setState((s) => (s.data ? s : { data: null, error: errText(e), unsupported: false, loading: false }));
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    tickets.current.applied = tickets.current.issued;
    setState({ data: null, error: null, unsupported: false, loading: readRef.current != null });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hint = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, FLEET_REFETCH_DEBOUNCE_MS);
    };
    const offs: Array<() => void> = [];
    const keep = (off: unknown) => {
      if (typeof off === "function") offs.push(off as () => void);
    };
    const api = window.api as Partial<typeof window.api> | undefined;
    keep(api?.onAgentFleet?.(hint));
    keep(api?.onTaskQuestion?.(hint));
    keep(api?.onAgentChange?.(hint));
    keep(
      api?.onStreamEvent?.((ev) => {
        if (ev.sub === "resync") hint();
      }),
    );
    void load();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the restart signal; `load` is stable
  }, [key, load]);

  return { ...state, reload: load };
}

/** True once `active` has stayed true for `ms` (a skeleton that doesn't flash for a fast answer). */
export function useAfter(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return late;
}
