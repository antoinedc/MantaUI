// ===== Routines — data hooks =====
//
// The pane, the detail and the run view all follow one rule (spec §5.1): the
// box's `routines.updated` bus event is only a HINT, so each view refetches
// (debounced 250 ms) and also polls while it is open, because desktop bus
// delivery is best-effort. The sidebar badge shares App's single summary.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutinesSummary } from "../shared/routines";
import { useStore } from "./store";

export const ROUTINES_REFETCH_DEBOUNCE_MS = 250;

/** Call `load` (debounced) on every `routines.updated` hint and every `pollMs`. */
export function useRoutinesRefetch(load: () => void, pollMs: number | null, generation = 0): void {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = window.api.onRoutinesUpdated?.(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadRef.current(), ROUTINES_REFETCH_DEBOUNCE_MS);
    });
    const poll = pollMs ? setInterval(() => loadRef.current(), pollMs) : null;
    return () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      off?.();
    };
  }, [pollMs, generation]);
}

/** The routines summary: on mount, on every hint, and every `pollMs`. */
export function useRoutinesSummary(pollMs: number, generation = 0): {
  summary: RoutinesSummary | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [summary, setSummary] = useState<RoutinesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    if (!window.api.routinesSummary) return;
    try {
      const s = await window.api.routinesSummary();
      if (!alive.current || !s) return;
      setSummary(s);
      setError(null);
    } catch (e) {
      if (alive.current) setError(errMessage(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, generation]);
  useRoutinesRefetch(() => void reload(), pollMs, generation);
  return { summary, error, reload };
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A user-visible outcome: a success note or an error the user can act on. */
export function routinesToast(tone: "info" | "error", message: string): void {
  useStore.getState().pushAppToast({ tone, message });
}

/** Run an async user action; failures surface as an error toast ("Couldn't <what> — <reason>"). */
export async function runAction<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    routinesToast("error", `Couldn't ${what} — ${errMessage(e)}`);
    return undefined;
  }
}
