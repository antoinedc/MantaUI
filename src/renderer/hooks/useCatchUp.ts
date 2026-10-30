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
import {
  CATCH_UP_HELD_FAILED_COPY,
  countNewSteps,
  firstNewStepMessageId,
  type CatchUpPillState,
} from "../chatUtils";
import type { CatchUpResult, CatchUpStatus } from "./useTranscriptState";

/** A fast catch-up never shows the plain "Catching up…" pill. */
export const CATCH_UP_PILL_DELAY_MS = 200;
/** How long the "N new steps" pill stays before it fades. */
export const NEW_STEPS_DWELL_MS = 2400;
/** The pill's fade (`--motion-slow`) before it is unmounted. */
const NEW_STEPS_FADE_MS = 300;

type Delivery = "steer" | "queue";
type Hold = { textOverride?: string; attachmentsOverride?: Attachment[]; delivery?: Delivery };
type NewPill = { n: number; firstId: string | null; sentInto: "running" | "idle" | null };

export type CatchUpPillProps = {
  state: CatchUpPillState;
  newSteps: number;
  sentInto: "running" | "idle" | null;
  leaving: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onShow: () => void;
  onDwellPause: (paused: boolean) => void;
};

export function useCatchUp(params: {
  sessionId: string;
  isActive: boolean;
  running: boolean;
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
  scrollToMessage: (messageId: string) => string | null;
}) {
  const { sessionId, isActive, running, status, catchUp, resetCatchUp, sendRef, hasDraftRef, setSendError, scrollToMessage } = params;

  const statusRef = useRef(status);
  statusRef.current = status;
  const runningRef = useRef(running);
  runningRef.current = running;
  const scrollRef = useRef(scrollToMessage);
  scrollRef.current = scrollToMessage;
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
  const [caught, setCaught] = useState<{ n: number; firstId: string | null } | null>(null);
  const [newPill, setNewPill] = useState<NewPill | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [dwellPaused, setDwellPaused] = useState(false);
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
    setNewPill(null);
    setLeaving(false);
    setDwellPaused(false);
    const r = await catchUpRef.current();
    if (token !== tokenRef.current) return;
    if (r.ok) {
      setCaught({
        n: r.before ? countNewSteps(r.before, r.after) : 0,
        firstId: r.before ? firstNewStepMessageId(r.before, r.after) : null,
      });
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
    let sentInto: "running" | "idle" | null = null;
    const h = holdRef.current;
    if (h) {
      dropHold();
      const willSend = h.textOverride !== undefined ? h.textOverride.trim() !== "" : hasDraftRef.current;
      if (willSend) {
        sentInto = runningRef.current ? "running" : "idle";
        sendRef.current?.(h.textOverride, h.attachmentsOverride, h.delivery);
      }
    }
    setCaught(null);
    if (caught.n >= 1) setNewPill({ n: caught.n, firstId: caught.firstId, sentInto });
  }, [caught, dropHold, sendRef, hasDraftRef]);

  // "N new steps" dwell: visible, then fade, then unmount. Hover / focus pauses
  // the dwell; leaving restarts it.
  useEffect(() => {
    if (!newPill) return;
    if (leaving) {
      const t = setTimeout(() => {
        setNewPill(null);
        setLeaving(false);
      }, NEW_STEPS_FADE_MS);
      return () => clearTimeout(t);
    }
    if (dwellPaused) return;
    const t = setTimeout(() => setLeaving(true), NEW_STEPS_DWELL_MS);
    return () => clearTimeout(t);
  }, [newPill, leaving, dwellPaused]);

  // Deactivation / session change: the in-flight result is stale, the hold is
  // dropped silently (the text stays in this panel's composer), the pill goes.
  useEffect(() => {
    if (!isActive) return;
    return () => {
      tokenRef.current++;
      resetCatchUp();
      dropHold();
      setCaught(null);
      setNewPill(null);
      setLeaving(false);
      setDwellPaused(false);
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

  const onShow = useCallback(() => {
    const id = newPill?.firstId;
    if (id) scrollRef.current(id);
    setNewPill(null);
    setLeaving(false);
    setDwellPaused(false);
  }, [newPill]);

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
          : newPill
            ? "new"
            : null;

  const pill: CatchUpPillProps | null = state
    ? {
        state,
        newSteps: newPill?.n ?? 0,
        sentInto: newPill?.sentInto ?? null,
        leaving: state === "new" && leaving,
        onCancel: dropHold,
        onRetry: () => void run(),
        onShow,
        onDwellPause: setDwellPaused,
      }
    : null;

  return { run, pill, sendHeld, cancelHold: dropHold, submit, submitAfterTurn };
}
