// ===== useCatchUp =====
//
// The catch-up pill + held send (spec 2026-10-30-session-catch-up). When a chat
// panel becomes visible again after its session kept working, useTranscriptState
// runs the catch-up fetch; this hook owns everything the user sees and does
// while that runs: the pill state and its timers, the one held message, the
// release once the fresh transcript is committed, and the hold-aware submit
// wrappers the Composer is handed. ChatPanel only wires it.
//
// Which submits are held is decided by CALL PATH, never by looking at
// `textOverride`: only the wrappers returned here (what the Composer's Enter,
// ⌥Enter and Send button reach) can hold. ChatPanel-internal programmatic
// submits keep calling the raw submit through their own refs and are never held.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../chatShared";
import { CATCH_UP_HELD_FAILED_COPY, type CatchUpPillState } from "../chatUtils";
import type { CatchUpResult, CatchUpStatus } from "./useTranscriptState";

/** A fast catch-up never shows the plain "Catching up…" pill. */
export const CATCH_UP_PILL_DELAY_MS = 200;

type Delivery = "steer" | "queue";
type Hold = { textOverride?: string; attachmentsOverride?: Attachment[]; delivery?: Delivery };

export type CatchUpPillProps = {
  state: CatchUpPillState;
  onCancel: () => void;
  onRetry: () => void;
};

export function useCatchUp(params: {
  sessionId: string;
  isActive: boolean;
  status: CatchUpStatus;
  catchUp: () => Promise<CatchUpResult>;
  resetCatchUp: () => void;
  /** The panel's RAW send (its `submit`): assigned by the host each render. */
  sendRef: React.MutableRefObject<
    ((textOverride?: string, attachmentsOverride?: Attachment[], delivery?: Delivery) => void) | null
  >;
  /** Whether the composer holds something submit() would send right now (text, or a path-ref attachment). */
  hasDraftRef: React.MutableRefObject<boolean>;
  setSendError: (v: string | null) => void;
}) {
  const { sessionId, isActive, status, catchUp, resetCatchUp, sendRef, hasDraftRef, setSendError } = params;

  const statusRef = useRef(status);
  statusRef.current = status;
  const setSendErrorRef = useRef(setSendError);
  setSendErrorRef.current = setSendError;
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  // One hold at a time. The ref is what the wrappers and the release read; the
  // boolean state only drives the render.
  const holdRef = useRef<Hold | null>(null);
  const [sendHeld, setSendHeld] = useState(false);
  const dropHold = useCallback(() => {
    holdRef.current = null;
    setSendHeld(false);
  }, []);

  const [show200, setShow200] = useState(false);
  // Bumped on each successful catch-up; the release effect runs after it commits.
  const [caught, setCaught] = useState(0);
  // Bumped by every run() and by deactivation: a continuation whose token is no
  // longer current applies nothing.
  const tokenRef = useRef(0);

  // The ≥ 200 ms rule, re-armed whenever `catching` (re)starts (a Retry too).
  useEffect(() => {
    setShow200(false);
    if (status !== "catching") return;
    const t = setTimeout(() => setShow200(true), CATCH_UP_PILL_DELAY_MS);
    return () => clearTimeout(t);
  }, [status]);

  // Run the catch-up fetch and carry its outcome into the pill / hold.
  const run = useCallback(async () => {
    const token = ++tokenRef.current;
    // Read synchronously by a submit that lands before the status commit.
    statusRef.current = "catching";
    const r = await catchUpRef.current();
    if (token !== tokenRef.current) return;
    if (r.ok) {
      setCaught((c) => c + 1);
      return;
    }
    if (r.stale) return;
    // Failed: a held message is NOT sent; the text stays and the strip says so.
    if (holdRef.current) {
      dropHold();
      setSendErrorRef.current(CATCH_UP_HELD_FAILED_COPY);
    }
  }, [dropHold]);

  // Release the hold once the fresh transcript is COMMITTED (this runs after the
  // commit that rendered `caught`, which includes the transcript update queued
  // before it), through the LATEST raw send so it reads the current `running`,
  // composer, model, plan and background box.
  useEffect(() => {
    if (!caught) return;
    const h = holdRef.current;
    if (!h) return;
    dropHold();
    const willSend = h.textOverride !== undefined ? h.textOverride.trim() !== "" : hasDraftRef.current;
    if (willSend) sendRef.current?.(h.textOverride, h.attachmentsOverride, h.delivery);
  }, [caught, dropHold, sendRef, hasDraftRef]);

  // Deactivation / session change: the in-flight result is stale, the hold is
  // dropped silently (the text stays in this panel's composer), the pill goes.
  useEffect(() => {
    if (!isActive) return;
    return () => {
      tokenRef.current++;
      resetCatchUp();
      dropHold();
    };
  }, [isActive, sessionId, resetCatchUp, dropHold]);

  // The composer's hold-aware submits. While `catching` they record a hold
  // (exactly as received); otherwise — including `failed`, which is the "send
  // anyway" — they send normally.
  const trySend = useCallback(
    (textOverride?: string, attachmentsOverride?: Attachment[], delivery?: Delivery) => {
      if (statusRef.current === "catching") {
        if (!holdRef.current) {
          holdRef.current = { textOverride, attachmentsOverride, delivery };
          setSendHeld(true);
        }
        return;
      }
      sendRef.current?.(textOverride, attachmentsOverride, delivery);
    },
    [sendRef],
  );
  const submit = useCallback(
    (textOverride?: string, attachmentsOverride?: Attachment[]) => trySend(textOverride, attachmentsOverride, undefined),
    [trySend],
  );
  const submitAfterTurn = useCallback(() => trySend(undefined, undefined, "queue"), [trySend]);

  const state: CatchUpPillState | null =
    !isActive
      ? null
      : status === "catching"
        ? sendHeld
          ? "held"
          : show200
            ? "catching"
            : null
        : status === "failed"
          ? "error"
          : null;

  const pill: CatchUpPillProps | null = state
    ? {
        state,
        onCancel: dropHold,
        onRetry: () => void run(),
      }
    : null;

  return { run, pill, sendHeld, cancelHold: dropHold, submit, submitAfterTurn };
}
