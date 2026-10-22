// useUpgradeGate.ts — feeds the blocking box-upgrade screen (OpenCode V2
// cutover, slice C4). All DECISIONS live in ../upgradeGateLogic.ts; this hook only
// wires the producers into its reducer:
//
//   • `{kind:"upgrade"}` frames on /events         → window.api.onUpgrade
//   • a 503 {upgrade:true} from any data call       → window.api.onBoxUpgrading
//   • GET /api/upgrade: once on mount and on every (re)connect, then once a
//     second for as long as /events is NOT connected — manta-server restarts
//     during an upgrade, and that is exactly when no frame can arrive.
//   • the Retry / Roll back presses                 → run() below
//
// The gate must survive the very restart it is reporting on, so a failed poll
// is never read as "the upgrade is over": only a successful answer (including
// an old box's 404 → null) changes the status.

import { useCallback, useEffect, useReducer, useRef } from "react";
import { useStore } from "../store";
import {
  UPGRADE_POLL_MS,
  gateReducer,
  initialGateState,
  isGateVisible,
  selectGateView,
  type GateView,
} from "../upgradeGateLogic";

export type UpgradeGateInputs = {
  boxNeedsUpgrade: boolean;
  boxUpdating: boolean;
  boxUpdateError: string | null;
  boxUpdateProgress: { step: number; total: number; label: string } | null;
  /** Bumped by the caller when `window.api` is swapped (first pairing). */
  apiGeneration: number;
  /**
   * Called once when the gate goes from covering the app to not covering it
   * (the upgrade completed): the app's state was loaded against a box that was
   * mid-migration, so the caller re-reads it.
   */
  onCleared?: () => void;
};

export type UpgradeGate = {
  view: GateView;
  visible: boolean;
  /** Whether the /events stream is live (drives "restarting…" copy). */
  connected: boolean;
  retry: () => void;
  rollback: () => void;
};

export function useUpgradeGate(inputs: UpgradeGateInputs): UpgradeGate {
  const [state, dispatch] = useReducer(gateReducer, initialGateState);
  const connected = useStore((s) => s.connectionState.state === "connected");

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // One fetch in flight at a time: at 1 Hz a slow answer must not stack. An
  // EVENT-driven request (`urgent`: a 503, a reconnect, a button press) that
  // lands while one is in flight is not dropped — the in-flight answer may
  // predate the event, so it re-reads once that one settles. A poll tick that
  // finds one in flight just skips: the next tick is a second away.
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const fetchStatus = useCallback(async (urgent = false) => {
    const api = window.api;
    if (!api?.upgradeStatus) return;
    if (inFlight.current) {
      if (urgent) rerun.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const status = await api.upgradeStatus();
      if (alive.current) dispatch({ type: "status", status: status ?? null });
    } catch {
      // Box restarting / transport down / 401: NOT an answer. Keep the last
      // status; the poll (or the next frame) will settle it.
    } finally {
      inFlight.current = false;
      if (rerun.current && alive.current) {
        rerun.current = false;
        void fetchStatus(true);
      }
    }
  }, []);

  // Producers 1 + 2: frames and 503s.
  useEffect(() => {
    const api = window.api;
    const offs: Array<() => unknown> = [];
    if (api?.onUpgrade) {
      offs.push(api.onUpgrade((status) => dispatch({ type: "status", status })));
    }
    if (api?.onBoxUpgrading) {
      offs.push(
        api.onBoxUpgrading(() => {
          dispatch({ type: "upgradeModeSeen" });
          void fetchStatus(true);
        }),
      );
    }
    return () => {
      for (const off of offs) off();
    };
  }, [inputs.apiGeneration, fetchStatus]);

  // Producer 3: read on mount and on every (re)connect — the status may have
  // changed while the stream was down and no replay exists.
  useEffect(() => {
    void fetchStatus(true);
  }, [connected, inputs.apiGeneration, fetchStatus]);

  // ...and once a second while the stream is down.
  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => void fetchStatus(), UPGRADE_POLL_MS);
    return () => clearInterval(t);
  }, [connected, inputs.apiGeneration, fetchStatus]);

  const view = selectGateView(state, {
    boxNeedsUpgrade: inputs.boxNeedsUpgrade,
    boxUpdating: inputs.boxUpdating,
    boxUpdateError: inputs.boxUpdateError,
    boxUpdateProgress: inputs.boxUpdateProgress,
    connected,
  });
  const visible = isGateVisible(view);

  // visible → hidden edge.
  const wasVisible = useRef(false);
  const onCleared = useRef(inputs.onCleared);
  onCleared.current = inputs.onCleared;
  useEffect(() => {
    if (wasVisible.current && !visible) onCleared.current?.();
    wasVisible.current = visible;
  }, [visible]);

  const run = useCallback(
    (action: "retry" | "rollback") => {
      const api = window.api;
      void (async () => {
        dispatch({ type: "actionStarted", action });
        const fn = action === "retry" ? api?.upgradeRetry : api?.upgradeRollback;
        let result: Awaited<ReturnType<NonNullable<typeof fn>>>;
        try {
          result = fn
            ? await fn.call(api)
            : { ok: false, error: "This box does not support that action." };
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!alive.current) return;
        dispatch({ type: "actionFinished", action, result });
        // Don't wait for the next frame/poll to show what the press did.
        if (result.ok) void fetchStatus(true);
      })();
    },
    [fetchStatus],
  );

  return {
    view,
    visible,
    connected,
    retry: useCallback(() => run("retry"), [run]),
    rollback: useCallback(() => run("rollback"), [run]),
  };
}
