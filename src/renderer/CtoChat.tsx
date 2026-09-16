// ===== CtoChat =====
//
// The primary conversation surface of the CTO tab (unified-cto-spec §3.1 +
// §8.3, P3b). Renders the ONE durable CTO role session as a normal chat
// transcript + composer, reusing the existing chat pipeline (Transcript,
// MessageRow, useTranscriptState, useSseBus) — it does NOT copy it.
//
// What is deliberately DIFFERENT from ChatPanel (the admission seam):
//  - Sends go through `ctoConversationSubmit` with a STABLE client-generated
//    submission id + expectedGeneration (docs/cto-admission-contract.md).
//    A retry after a timeout / lost response reuses the SAME id + payload so
//    the server's dedup makes the retry idempotent.
//  - NO queued-message drain, NO implicit abort. A send while a turn runs is
//    accepted by the server and QUEUED there; the client renders the server's
//    queue projection instead of managing its own queue.
//  - Explicit interruption goes through `ctoConversationInterrupt` with the
//    ADMISSION RECORD id, never an opencode abort.
//  - The session is opened lazily on the tab's first visit via
//    `ctoConversationOpen` (no model invocation) and reused afterwards.
//    Loading/error are explicit states — never a blank "empty" transcript.
//  - The queue projection is polled cheaply (`ctoConversationState` — a pure
//    store read, no model turn) and drives pending-send bubbles + the
//    collapsible work inspector.
//  - No tmux window, no sidebar session, no session ops (fork/clear/delete),
//    no attachments, no slash commands. The model picker IS retained — the
//    submit API accepts a per-turn `model` (PromptModel).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { ChevronDown, ChevronUp, Send, Square } from "lucide-react";
import type {
  CtoConversationState,
  CtoSubmissionProjection,
} from "../shared/api";

// Same shape as shared/api.ts's (unexported) PromptModel — the per-turn model
// override `ctoConversationSubmit` accepts.
type PromptModel = { providerID: string; modelID: string; variant?: string };
import type { QuestionRequest } from "../shared/types";
import { Transcript } from "./Transcript";
import { PermissionCard, QuestionCard, RetryCard } from "./Cards";
import { MantaLoader } from "./MantaLoader";
import { ModelPicker } from "./ModelPicker";
import { VoicePlaybackProvider } from "./hooks/useVoicePlayback";
import { useTranscriptState } from "./hooks/useTranscriptState";
import { useSseBus } from "./hooks/useSseBus";
import { useModelCatalog } from "./modelCatalog";
import { setSessionChoice, useSessionModelChoice } from "./modelPrefs";
import {
  computeLiveTurn,
  computeTurnInfo,
  type EntryMotionState,
} from "./chatUtils";
import type { ModelSelection, TaskContextValue } from "./chatShared";
import { useStore } from "./store";

const EMPTY_STRINGS: string[] = [];
// Every question renders ONCE, in the pinned stack above the composer — the
// same split ChatPanel enforces with its plan-exit filter (each question is
// EXCLUDED from the inline transcript rendering so it never appears twice).
const NO_QUESTIONS: QuestionRequest[] = [];

// Human submissions get a client-minted id so a retry of a lost response
// dedups server-side instead of creating a second queue entry. `ceo_` marks
// the human (CEO) origin, mirroring the `bg_` background prefix.
function newSubmissionId(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ceo_${rnd}`;
}

// Errors that mean "the send was definitively rejected — nothing durable
// happened". A retry must mint a fresh id (the payload itself was the
// problem); everything else (timeout, network, transport) keeps the id.
//
// The server's CtoAdmissionError.code is NOT transported over /rpc (only
// String(e.message) is), so classification reads the message text against the
// merged server's wording (src/server/ctoAdmission.mjs submit()). Included:
//  - "different payload" / "invalid" / "empty" — caller/payload errors
//  - "binding unavailable — refusing to admit against unresolved role
//    identity" — a DEFINITIVE refusal, nothing admitted (code
//    binding-unavailable)
//  - "admission store at cap … nothing evictable / … yield" — a DEFINITIVE
//    refusal (code at-cap). Both would otherwise fall into the "outcome
//    unknown" bubble, whose retry could then never succeed (nothing persisted
//    ⇒ the projection never dissolves it) — mislabelling a definitive no as
//    "reconciling" forever.
function isDefinitiveSubmitError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("different payload") ||
    m.includes("invalid") ||
    m.includes("empty") ||
    m.includes("binding unavailable") ||
    m.includes("at cap")
  );
}

function isStaleGenerationError(msg: string): boolean {
  return msg.toLowerCase().includes("generation");
}

// A submission still on its way through the admission seam — the states where
// the text is NOT yet visible in the opencode transcript and must be shown as
// a pending bubble so the send doesn't look lost.
const PENDING_STATUSES = new Set([
  "queued",
  "dispatching",
  "accepted",
  "unknown",
  "cancel_requested",
  "interrupt_pending",
]);

// The uncertain-abort barrier: an interrupt whose abort could not be
// proven (abortState "uncertain" / abort_outcome_unknown). PERMANENT and
// non-self-healing — admission for the session stays held until an explicit
// external recovery (a future queue management op; none exists yet). The UI
// must present it as such, never as transient
// (docs/cto-admission-contract.md limitation 1a).
function isUncertainAbort(
  s: Pick<CtoSubmissionProjection, "status" | "abortState" | "abortOutcomeReason">,
): boolean {
  return (
    s.status === "interrupt_pending" &&
    s.abortState === "uncertain" &&
    s.abortOutcomeReason === "abort_outcome_unknown"
  );
}

// Visible per-state labels for the admission seam. Every state the contract
// defines gets an explicit rendering — never guessed.
function submissionStatusLabel(
  s: Pick<CtoSubmissionProjection, "status" | "abortState" | "abortOutcomeReason">,
): string {
  if (isUncertainAbort(s)) {
    return "Abort outcome unknown — admission held for this session";
  }
  switch (s.status) {
    case "queued":
      return "Queued — after the current turn";
    case "dispatching":
      return "Sending…";
    case "accepted":
      return "Delivered";
    case "unknown":
      return "Outcome unknown — reconciling";
    case "cancel_requested":
      // A cancel of an unknown send does NOT release the queue — the
      // nonterminal barrier is retained until reconcile proves the outcome.
      return "Cancel requested — held until reconciled";
    case "interrupt_pending":
      return "Interrupt pending";
    default:
      return s.status;
  }
}

type QueueSummary = {
  active: CtoSubmissionProjection | null;
  waiting: CtoSubmissionProjection[];
  canInterrupt: boolean;
  // A permanent uncertain-abort barrier exists in the queue. While held, the
  // server's pump dispatches NOTHING (any unresolved record holds the gate —
  // src/server/ctoAdmission.mjs pump()), so "sends queue up" copy would lie.
  held: boolean;
};

// Derive what the composer/interrupt need from the server-owned queue: the
// newest non-terminal human submission (the interrupt target) and any still-
// waiting queued sends. Terminal statuses are ignored.
function summarizeQueue(state: CtoConversationState | null): QueueSummary {
  if (!state) return { active: null, waiting: [], canInterrupt: false, held: false };
  const terminal = new Set(["completed", "interrupted", "cancelled", "failed"]);
  const live = state.submissions.filter(
    (s) => s.origin === "human" && !terminal.has(s.status),
  );
  // Newest first — the interrupt op targets the most recent record.
  live.reverse();
  // The uncertain-abort barrier is NOT an interrupt target: the server's
  // interrupt on it is an idempotent no-op with no visible change (a dead
  // control if rendered as one), and while it holds nothing else dispatches.
  // It is excluded from targeting so Stop only ever offers actions with an
  // observable outcome.
  const interruptible = live.filter((s) => !isUncertainAbort(s));
  const held = interruptible.length !== live.length;
  const active =
    interruptible.find((s) => s.status !== "queued" && s.status !== "dispatching") ??
    null;
  const waiting = interruptible.filter(
    (s) => s.status === "queued" || s.status === "dispatching",
  );
  return {
    active,
    waiting,
    canInterrupt: interruptible.length > 0,
    held,
  };
}

export function CtoChat({ onOpenDashboard }: { onOpenDashboard?: () => void }) {
  // ---- Lazy open: the tab's first visit creates/recovers the ONE session ----
  const [open, setOpen] = useState<{
    phase: "loading" | "ready" | "error";
    sessionId: string | null;
    generation: number | null;
    error: string | null;
  }>({ phase: "loading", sessionId: null, generation: null, error: null });
  const [rebinding, setRebinding] = useState(false);

  const doOpen = useCallback(() => {
    setOpen({ phase: "loading", sessionId: null, generation: null, error: null });
    window.api
      .ctoConversationOpen()
      .then((r) =>
        setOpen({ phase: "ready", sessionId: r.sessionId, generation: r.generation, error: null }),
      )
      .catch((e) =>
        setOpen({
          phase: "error",
          sessionId: null,
          generation: null,
          error: String((e as Error)?.message ?? e),
        }),
      );
  }, []);

  // LAZY open on the tab's FIRST VISIT (§8.3): the pane lives inside a
  // display:none PanelShell from app start, so opening must wait until the
  // surface is actually shown. An IntersectionObserver fires exactly then;
  // jsdom (tests) has no IO → open immediately, as the tab is "shown" there.
  // FALLBACK: if the observer never reports (display quirks, nested
  // overflow) the pane must not show "Opening…" forever — a 5s timer opens
  // anyway. An open while hidden is a cheap store read, never a model turn.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    const el = rootRef.current;
    const fire = () => {
      if (openedRef.current) return;
      openedRef.current = true;
      doOpen();
    };
    if (typeof IntersectionObserver === "undefined" || !el) {
      fire();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fire();
      }
    });
    io.observe(el);
    const fallback = setTimeout(fire, 5_000);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, [doOpen]);

  // ---- Cheap queue poll: a pure store read; never a model turn ----
  const [queue, setQueue] = useState<CtoConversationState | null>(null);
  const [queueError, setQueueError] = useState(false);
  const refreshQueueNow = useCallback(() => {
    window.api
      .ctoConversationState()
      .then((s) => {
        setQueue(s);
        setQueueError(false);
      })
      .catch(() => setQueueError(true));
  }, []);

  const sessionId = open.sessionId;
  const generationRef = useRef<number | null>(open.generation);
  generationRef.current = open.generation;

  useEffect(() => {
    if (open.phase !== "ready") return;
    refreshQueueNow();
    const t = setInterval(refreshQueueNow, 5_000);
    // A returning window is a two-client freshness signal: poll immediately.
    window.addEventListener("focus", refreshQueueNow);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refreshQueueNow);
    };
  }, [open.phase, refreshQueueNow]);

  // Role-binding generation change (another client rebound the session):
  // adopt the new binding and reload the transcript. Submissions are NOT
  // re-sent — the durable records stay in the server queue, and the composer
  // keeps its text; a later explicit send reuses its stable id so dedup
  // prevents any duplicate of the old submission.
  useEffect(() => {
    const b = queue?.binding;
    if (!b || open.phase !== "ready") return;
    generationRef.current = b.generation;
    if (b.sessionId && sessionId && b.sessionId !== sessionId) {
      setRebinding(true);
      setOpen({
        phase: "ready",
        sessionId: b.sessionId,
        generation: b.generation,
        error: null,
      });
      const t = setTimeout(() => setRebinding(false), 1200);
      return () => clearTimeout(t);
    }
  }, [queue, open.phase, sessionId]);

  // ---- Stable-id send bookkeeping (kept in the controller so a remount of
  // the transcript on rebind can't lose the retryable id) ----
  const retryRef = useRef<{ id: string; text: string } | null>(null);
  // Unknown barrier: a send whose outcome we could not confirm (timeout /
  // lost response / transport). Ephemeral + local — cleared as soon as the
  // server's queue projection shows the record, or the user retries /
  // dismisses. This is the "unknown — reconciling" state the contract asks
  // clients to render faithfully instead of guessing.
  const [unknownPending, setUnknownPending] = useState<{ id: string; text: string } | null>(
    null,
  );
  const dismissedUnknownRef = useRef<Set<string>>(new Set());
  // Ephemeral text the THIS client submitted, keyed by submission id — the
  // queue projection deliberately strips payloads, so pending-send bubbles
  // render the text from here until the message lands in the transcript.
  const localTextsRef = useRef<Map<string, string>>(new Map());
  const [sending, setSending] = useState<string | null>(null);
  const submitBusyRef = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [staleGenNotice, setStaleGenNotice] = useState<string | null>(null);
  // Draft restore: a declined or stale-generation send is NOT lost — the
  // text is returned to the composer (it was optimistically cleared on
  // submit, and the rebind path REMOUNTS this conversation, so the notice
  // must never claim "kept" without doing it).
  const [draftRestore, setDraftRestore] = useState<{ text: string; nonce: number } | null>(
    null,
  );
  const draftRestoreNonceRef = useRef(0);
  // Interrupt ack: the server receipt ("cancelled" / "interrupt_pending" /
  // "cancel_requested") confirmed visibly — a silent interrupt reads as a
  // dead control. Ephemeral: auto-dismisses once it has been seen.
  const [interruptAck, setInterruptAck] = useState<string | null>(null);
  // The controller → conversation receipt hook (per-instance, no globals).
  const onReceiptRef = useRef<(() => void) | null>(null);

  // Model picker wiring (per-session choice keyed by the CTO session id, the
  // same box-backed store the ordinary composer uses). Read during render so
  // submitTurn always sees the current pick; the hook itself is unconditional.
  const sessionChoice = useSessionModelChoice(sessionId ?? "");

  const submitTurn = useCallback(
    async (text: string, opts?: { reuseId?: string }): Promise<void> => {
      if (!text.trim() || !open.sessionId) return;
      // Double-submit guard: while a send is in flight a second Enter must
      // not mint a second queue entry.
      if (submitBusyRef.current) return;
      submitBusyRef.current = true;
      setSendError(null);
      setStaleGenNotice(null);
      setSending(text);
      // Stable id: a retry of a timed-out/lost send reuses the SAME id +
      // payload so the server dedups. The id for a retry comes from the
      // PENDING RECORD ITSELF (unknownPending already holds {id, text}) —
      // NOT from the single-slot retryRef, which an intervening successful
      // send clears (a fresh id could double-run a send the server actually
      // accepted with a lost response).
      let id: string;
      if (opts?.reuseId) {
        id = opts.reuseId;
      } else if (retryRef.current && retryRef.current.text === text) {
        id = retryRef.current.id;
      } else {
        retryRef.current = null;
        id = newSubmissionId();
      }
      retryRef.current = { id, text };
      localTextsRef.current.set(id, text);
      const input: {
        id: string;
        text: string;
        expectedGeneration?: number;
        model?: PromptModel;
      } = { id, text };
      if (generationRef.current != null) input.expectedGeneration = generationRef.current;
      if (sessionChoice.kind === "model") input.model = sessionChoice.model;
      try {
        await window.api.ctoConversationSubmit(input);
        // Definitive server ack — the id is consumed; a NEW message must mint
        // a fresh id (a replay with the same id would dedup to nothing).
        retryRef.current = null;
        setSending(null);
        if (unknownPending?.id === id) setUnknownPending(null);
        refreshQueueNow();
        onReceiptRef.current?.();
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (isDefinitiveSubmitError(msg)) {
          retryRef.current = null;
          localTextsRef.current.delete(id);
          setSending(null);
          setSendError(`The CTO declined the send: ${msg}`);
          // The text was optimistically cleared — give it back (nothing was
          // admitted; the user edits/resends, not retypes).
          draftRestoreNonceRef.current += 1;
          setDraftRestore({ text, nonce: draftRestoreNonceRef.current });
        } else if (isStaleGenerationError(msg)) {
          // The binding was rebound under us. Nothing was accepted. Keep the
          // id (dedup-safe). The composer was optimistically cleared AND the
          // rebind remounts this conversation — so the text is explicitly
          // RESTORED to the composer before the notice claims it.
          draftRestoreNonceRef.current += 1;
          setDraftRestore({ text, nonce: draftRestoreNonceRef.current });
          setSending(null);
          setStaleGenNotice(
            "The conversation was just rebound by another device — the send was not accepted. Your text is back in the composer; submit it again.",
          );
          refreshQueueNow();
        } else {
          // Timeout / network / lost response: the outcome is UNKNOWN. Keep
          // the id + payload so a retry dedups; the unknown barrier (or the
          // queue projection, if the server did record the send) now shows
          // what actually happened instead of guessing.
          setSending(null);
          if (!dismissedUnknownRef.current.has(id)) {
            setUnknownPending({ id, text });
          }
          refreshQueueNow();
          onReceiptRef.current?.();
        }
      } finally {
        submitBusyRef.current = false;
      }
    },
    [open.sessionId, refreshQueueNow, sessionChoice, unknownPending],
  );

  // The unknown barrier dissolves the moment the server's queue projection
  // shows the record — the server truth replaces the local guess.
  useEffect(() => {
    if (!unknownPending || !queue) return;
    if (queue.submissions.some((s) => s.id === unknownPending.id)) {
      setUnknownPending(null);
    }
  }, [queue, unknownPending]);

  const selectModel = useCallback(
    (m: ModelSelection | null) => {
      if (!sessionId) return;
      setSessionChoice(sessionId, m ? { kind: "model", model: m } : { kind: "server-default" });
    },
    [sessionId],
  );

  const interrupt = useCallback(async () => {
    const summary = summarizeQueue(queue);
    if (!summary.canInterrupt) return;
    // The EXPLICIT interruption op: the ADMISSION RECORD id, never an opencode
    // abort. Prefer the dispatched record; else the MOST RECENT queued send
    // (live is newest-first — NOT the oldest, which a [length-1] index would
    // hit and which contradicts the "most recent" contract).
    const target = summary.active ?? summary.waiting[0];
    if (!target) return;
    try {
      const r = await window.api.ctoConversationInterrupt({ id: target.id });
      // Confirm the outcome visibly — the receipt status is the request
      // marker the queue will now show.
      setInterruptAck(
        r.status === "cancelled"
          ? "Queued send cancelled — it will not run."
          : r.status === "cancel_requested"
            ? "Cancel requested for the unconfirmed send — reconciliation will settle it."
            : "Interrupt requested — the abort is being applied to the running turn.",
      );
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    }
    refreshQueueNow();
  }, [queue, refreshQueueNow]);

  // The ack is ephemeral — it confirms a completed action, it is not a state.
  useEffect(() => {
    if (!interruptAck) return;
    const t = setTimeout(() => setInterruptAck(null), 3500);
    return () => clearTimeout(t);
  }, [interruptAck]);

  const qSummary = summarizeQueue(queue);
  const { models, defaultModel } = useModelCatalog();
  const retryUnknown = useCallback(() => {
    if (!unknownPending) return;
    // Retry the EXACT pending record — its own {id, text} pair, not whatever
    // the single-slot retryRef still holds (an intervening successful send
    // clears retryRef; a fresh id could double-run a send the server actually
    // accepted with a lost response).
    void submitTurn(unknownPending.text, { reuseId: unknownPending.id });
  }, [unknownPending, submitTurn]);
  const dismissUnknown = useCallback(() => {
    if (unknownPending) dismissedUnknownRef.current.add(unknownPending.id);
    setUnknownPending(null);
  }, [unknownPending]);

  // Inspector collapsible (§8.3: work metadata/progress secondary).
  const [inspectorOpen, setInspectorOpen] = useState(false);

  return (
    <div
      ref={rootRef}
      className="h-full w-full flex flex-col bg-bg font-sans text-prose relative"
    >
      {/* Slim header: identity + dashboard escape hatch + inspector toggle. */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border-subtle">
        <h1 className="text-body font-semibold text-text">CTO</h1>
        <span className="text-meta text-text-faint truncate">
          {rebinding
            ? "Conversation rebound — reloading…"
            : queueError
              ? "Queue status unavailable — retrying…"
              : "Conversation"}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setInspectorOpen((v) => !v)}
          className="rounded-md px-2 py-1 text-meta text-text-muted hover:bg-fill-hover hover:text-text"
          aria-expanded={inspectorOpen}
        >
          {inspectorOpen ? (
            <ChevronUp size={13} className="inline" />
          ) : (
            <ChevronDown size={13} className="inline" />
          )}{" "}
          Work inspector
          {queue
            ? ` · ${queue.counts.queued.human} queued · ${queue.counts.unresolved} active${
                (queue.droppedByPolicy?.length ?? 0) > 0
                  ? ` · ${queue.droppedByPolicy!.length} dropped by policy`
                  : ""
              }`
            : ""}
        </button>
        {onOpenDashboard && (
          <button
            type="button"
            onClick={onOpenDashboard}
            className="rounded-md px-2 py-1 text-meta text-text-muted hover:bg-fill-hover hover:text-text"
          >
            Dashboard
          </button>
        )}
      </div>

      {open.phase === "loading" && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 text-text-faint text-body">
          <MantaLoader size="screen" label="Opening the CTO conversation" />
          <span>Opening the CTO conversation…</span>
        </div>
      )}
      {open.phase === "error" && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-body text-danger">
            Couldn&rsquo;t open the CTO conversation: {open.error}
          </div>
          <button
            type="button"
            onClick={doOpen}
            className="rounded-md border border-border-subtle px-3 py-1 text-body text-text hover:bg-fill-hover"
          >
            Retry
          </button>
        </div>
      )}
      {open.phase === "ready" && sessionId && (
        <CtoConversation
          key={sessionId}
          sessionId={sessionId}
          queue={queue}
          qSummary={qSummary}
          localTextsRef={localTextsRef}
          dismissedUnknownRef={dismissedUnknownRef}
          sending={sending}
          sendError={sendError}
          setSendError={setSendError}
          staleGenNotice={staleGenNotice}
          setStaleGenNotice={setStaleGenNotice}
          unknownPending={unknownPending}
          onRetryUnknown={retryUnknown}
          onDismissUnknown={dismissUnknown}
          onSubmit={submitTurn}
          onInterrupt={interrupt}
          interruptAck={interruptAck}
          draftRestore={draftRestore}
          submitting={submitBusyRef.current}
          inspectorOpen={inspectorOpen}
          onReceiptRef={onReceiptRef}
          models={models}
          defaultModel={defaultModel}
          modelSelection={sessionChoice.kind === "model" ? sessionChoice.model : null}
          onSelectModel={selectModel}
          modelLabel={
            sessionChoice.kind === "model"
              ? `${sessionChoice.model.providerID}/${sessionChoice.model.modelID}`
              : defaultModel
                ? `${defaultModel.providerID}/${defaultModel.modelID}`
                : null
          }
        />
      )}
    </div>
  );
}

function CtoConversation(props: {
  sessionId: string;
  queue: CtoConversationState | null;
  qSummary: QueueSummary;
  localTextsRef: React.MutableRefObject<Map<string, string>>;
  dismissedUnknownRef: React.MutableRefObject<Set<string>>;
  sending: string | null;
  sendError: string | null;
  setSendError: (v: string | null) => void;
  staleGenNotice: string | null;
  setStaleGenNotice: (v: string | null) => void;
  unknownPending: { id: string; text: string } | null;
  onRetryUnknown: () => void;
  onDismissUnknown: () => void;
  onSubmit: (text: string, opts?: { reuseId?: string }) => Promise<void>;
  onInterrupt: () => Promise<void>;
  interruptAck: string | null;
  draftRestore: { text: string; nonce: number } | null;
  submitting: boolean;
  inspectorOpen: boolean;
  onReceiptRef: React.MutableRefObject<(() => void) | null>;
  models: ReturnType<typeof useModelCatalog>["models"];
  defaultModel: ReturnType<typeof useModelCatalog>["defaultModel"];
  modelSelection: ModelSelection | null;
  onSelectModel: (m: ModelSelection | null) => void;
  modelLabel: string | null;
}) {
  const {
    sessionId,
    queue,
    qSummary,
    localTextsRef,
    dismissedUnknownRef,
    sending,
    sendError,
    setSendError,
    staleGenNotice,
    setStaleGenNotice,
    unknownPending,
    onRetryUnknown,
    onDismissUnknown,
    onSubmit,
    onInterrupt,
    interruptAck,
    draftRestore,
    submitting,
    inspectorOpen,
    onReceiptRef,
    models,
    defaultModel,
    modelSelection,
    onSelectModel,
    modelLabel,
  } = props;

  const motionStateRef = useRef<EntryMotionState | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const setFollowing = useCallback((v: boolean) => {
    followingRef.current = v;
  }, []);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Draft restore (after a declined or stale-generation send): the controller
  // hands the text back and the composer genuinely restores it — the notice
  // may say "your text is back" because it is. The nonce fires the effect on
  // a same-mount restore; a fresh mount (rebind remount) restores immediately.
  useEffect(() => {
    if (!draftRestore) return;
    setInput(draftRestore.text);
  }, [draftRestore]);

  const ts = useTranscriptState({ sessionId, isActive: true, motionStateRef });
  const { messages, setMessages } = ts;
  const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  const providerID = useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.info.role === "assistant" && m.info.providerID) return m.info.providerID;
    }
    return null;
  }, [messages]);

  const submitRef = useRef<(textOverride?: string) => void>(() => {});

  const bus = useSseBus({
    sessionId,
    cwd: "",
    setMessages,
    setRefreshing: ts.setRefreshing,
    scheduleRefetch: ts.scheduleRefetch,
    fetchOpts: ts.fetchOpts,
    spliceMessage: ts.spliceMessage,
    scheduleChildRefetch: (childId: string) => {
      const existing = childRefetchTimers.current.get(childId);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        childRefetchTimers.current.delete(childId);
        window.api
          .opencodeMessages(childId)
          .then((m) => ts.setChildMessages((prev) => new Map(prev).set(childId, m)))
          .catch(() => {
            /* non-fatal */
          });
      }, 300);
      childRefetchTimers.current.set(childId, t);
    },
    childSessionIds: ts.childSessionIds,
    childMessagesRef: ts.childMessagesRef,
    expandedTasksRef: ts.expandedTasksRef,
    childRefetchTimers,
    isActiveRef: ts.isActiveRef,
    refetchOwedWhileInactive: ts.refetchOwedWhileInactive,
    applyStreamFlush: ts.applyStreamFlush,
    providerID,
    setPlanOn: () => {
      /* plan mode is not a CTO surface */
    },
    submit: () => {
      /* dormant — CTO sends never enqueue client-side */
    },
    submitRef,
  });

  // Register the receipt hook: after a submit resolves, reconcile the
  // transcript (the dispatched user message lands within a refetch).
  useEffect(() => {
    onReceiptRef.current = () => {
      setTimeout(() => ts.scheduleRefetch(), 250);
    };
    return () => {
      onReceiptRef.current = null;
    };
  }, [onReceiptRef, ts.scheduleRefetch]);

  // Reconcile an accepted submission whose message hasn't landed in the
  // transcript yet: schedule ONE refetch per messageID (guard ref prevents a
  // refetch loop if the message never lands).
  const reconciledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!messages || !queue) return;
    const messageIds = new Set(messages.map((m) => m.info.id));
    for (const s of queue.submissions) {
      if (s.origin !== "human" || typeof s.messageID !== "string") continue;
      if (messageIds.has(s.messageID)) continue;
      if (reconciledRef.current.has(s.messageID)) continue;
      reconciledRef.current.add(s.messageID);
      ts.scheduleRefetch();
      break;
    }
  }, [messages, queue, ts.scheduleRefetch]);

  // Derived maps (memoized so Transcript's MessageRow memos aren't defeated).
  const running = bus.running;
  const turnInfo = useMemo(() => computeTurnInfo(messages, running), [messages, running]);
  const liveTurn = useMemo(() => computeLiveTurn(messages), [messages]);
  const taskContextValue = useMemo<TaskContextValue>(
    () => ({
      expanded: ts.expandedTasks,
      toggle: ts.toggleTaskExpand,
      childMessages: ts.childMessages,
      childLoadedAllRef: ts.childLoadedAllRef,
      loadEarlierChild: ts.loadEarlierChildTranscript,
      loadingChildEarlier: ts.loadingChildEarlier,
      liveStatus: bus.liveChildStatus,
      showThinking: false,
    }),
    [
      ts.expandedTasks,
      ts.toggleTaskExpand,
      ts.childMessages,
      ts.loadEarlierChildTranscript,
      ts.loadingChildEarlier,
      bus.liveChildStatus,
    ],
  );
  const userCommandInfo = useMemo(
    () => new Map<string, { name: string; arguments: string }>(),
    [],
  );
  const voiceNoteByMessageId = useMemo(() => new Map(), []);
  const mediaByMessageId = useMemo(() => new Map(), []);
  const widgetsByMessageId = useMemo(() => new Map(), []);

  // Permissions/questions replies — same routing as the ordinary composer.
  const replyPermission = useCallback(
    async (
      requestId: string,
      reply: "once" | "always" | "reject",
      recordSessionId?: string,
    ) => {
      bus.setPermissions((prev) => prev.filter((p) => p.id !== requestId));
      useStore.getState().setChatAttention(sessionId, null);
      const sid = recordSessionId ?? sessionId;
      try {
        await window.api.opencodePermissionReply(requestId, reply, sid);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        void bus.refreshPermissions();
      }
    },
    [bus, sessionId, setSendError],
  );
  const replyQuestion = useCallback(
    async (q: QuestionRequest, answers: string[][]) => {
      const que = q.requestId;
      if (!que) {
        bus.setQuestions((prev) => prev.filter((x) => x.id !== q.id));
        useStore.getState().setChatAttention(q.sessionID, null);
        return;
      }
      bus.setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      useStore.getState().setChatAttention(q.sessionID, null);
      try {
        await window.api.opencodeQuestionReply(que, answers, q.sessionID);
      } catch (e) {
        setSendError(String((e as Error)?.message ?? e));
        void bus.refreshQuestions();
      }
    },
    [bus, setSendError],
  );
  const rejectQuestion = useCallback(
    async (q: QuestionRequest) => {
      const que = q.requestId;
      if (!que) {
        bus.setQuestions((prev) => prev.filter((x) => x.id !== q.id));
        return;
      }
      bus.setQuestions((prev) => prev.filter((x) => x.id !== q.id));
      try {
        await window.api.opencodeQuestionReject(que, q.sessionID);
      } catch (e) {
        // A user-initiated control reports its failure (same as replyQuestion
        // above) — a swallowed error reads as a dead dismiss button.
        setSendError(String((e as Error)?.message ?? e));
        void bus.refreshQuestions();
      }
    },
    [bus, setSendError],
  );

  // ---- Composer ----
  const doSubmit = useCallback(() => {
    // One send at a time: while a submission is in flight the composer is
    // disabled (explicit "Sending…" state) — this is the double-click
    // protection, and it never silently drops a draft.
    if (submitting) return;
    const text = input.trim();
    if (!text) return;
    setInput("");
    void onSubmit(text);
  }, [input, onSubmit, submitting]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSubmit();
      }
    },
    [doSubmit],
  );

  // Pending-send bubbles: server-owned truth (queue projection) for anything
  // not yet visible in the transcript, plus the local in-flight send. Text
  // comes from the local ephemeral map — the queue projection strips it —
  // falling back to the transcript's own user message (the server projection
  // REQUIRES messageID for every record that is not queued/cancelled, so a
  // dispatched record's message is usually already in the transcript).
  const messages_ = messages ?? [];
  const messageIds = useMemo(
    () => new Set(messages_.map((m) => m.info.id)),
    [messages_],
  );
  const userTextByMessageId = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of messages_) {
      if (row.info.role !== "user") continue;
      const text = row.parts
        ?.filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join(" ")
        .trim();
      if (text) m.set(row.info.id, text);
    }
    return m;
  }, [messages_]);
  const pendingBubbles = useMemo(() => {
    const rows: Array<{
      key: string;
      text: string;
      status: string;
      unknown: boolean;
      retryable: boolean;
    }> = [];
    if (sending != null) {
      rows.push({ key: "inflight", text: sending, status: "Sending…", unknown: false, retryable: false });
    }
    if (queue) {
      for (const s of queue.submissions) {
        if (s.origin !== "human" || !PENDING_STATUSES.has(s.status)) continue;
        // The uncertain-abort hold is NEVER skipped — its message is ALWAYS
        // already in the transcript (an interrupt_pending record came from
        // accepted, and the merged validator requires sessionId+messageID for
        // it), so the "visible turn covers it" skip below would otherwise
        // make the PERMANENT hold invisible everywhere (the reviewer's P1).
        if (typeof s.messageID === "string" && messageIds.has(s.messageID) && !isUncertainAbort(s)) continue;
        if (sending != null && localTextsRef.current.get(s.id) === sending) continue;
        if (dismissedUnknownRef.current.has(s.id)) continue;
        rows.push({
          key: s.id,
          text:
            localTextsRef.current.get(s.id) ??
            (typeof s.messageID === "string"
              ? userTextByMessageId.get(s.messageID)
              : undefined) ??
            `Submission ${s.id.slice(0, 12)}…`,
          status: submissionStatusLabel(s),
          unknown:
            s.status === "unknown" ||
            s.status === "cancel_requested" ||
            isUncertainAbort(s),
          retryable: false,
        });
      }
    }
    // The unknown barrier: a send whose outcome was never confirmed and that
    // the server's queue projection does not (yet) show. Retry resubmits the
    // SAME id + payload (server dedup makes it idempotent).
    if (unknownPending && !rows.some((r) => r.key === unknownPending.id)) {
      rows.push({
        key: unknownPending.id,
        text: unknownPending.text,
        status: "Outcome unknown — reconciling",
        unknown: true,
        retryable: true,
      });
    }
    return rows;
    // localTextsRef / dismissedUnknownRef mutate without renders — every
    // transition that matters re-renders through sending/queue/unknownPending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, queue, messageIds, userTextByMessageId, localTextsRef, unknownPending]);

  const optInModels = useStore((s) => s.optInModels) ?? EMPTY_STRINGS;
  const deactivatedMainModels = useStore((s) => s.deactivatedMainModels) ?? EMPTY_STRINGS;
  const optInModel = useStore((s) => s.optInModel);
  const modelLabelFromTranscript = useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info;
      if (info.role === "assistant" && info.modelID) {
        return info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID;
      }
    }
    return null;
  }, [messages]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Transcript */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <VoicePlaybackProvider active={true}>
          <Transcript
            messages={messages_}
            virtuosoRef={virtuosoRef}
            sessionId={sessionId}
            setMessages={setMessages}
            loadedAllRef={ts.loadedAllRef}
            taskContextValue={taskContextValue}
            showThinking={false}
            running={bus.running}
            liveTurn={liveTurn}
            progress={null}
            isActive={true}
            activeTodos={null}
            questions={NO_QUESTIONS}
            turnInfo={turnInfo}
            finishByMessageId={bus.finishByMessageId}
            userCommandInfo={userCommandInfo}
            voiceNoteByMessageId={voiceNoteByMessageId}
            mediaByMessageId={mediaByMessageId}
            widgetsByMessageId={widgetsByMessageId}
            pendingVoiceNote={null}
            onRetryVoiceNote={() => {}}
            onReplyQuestion={replyQuestion}
            onRejectQuestion={rejectQuestion}
            scrollerElRef={scrollerElRef}
            followingRef={followingRef}
            onFollowingChange={setFollowing}
            motionStateRef={motionStateRef}
          />
        </VoicePlaybackProvider>
        {bus.transcriptLoadError && (
          <div className="absolute inset-x-0 top-2 z-20 flex justify-center pointer-events-none">
            <div className="pointer-events-auto rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-meta text-danger shadow-md">
              Couldn&rsquo;t load the conversation: {bus.transcriptLoadError}
              <button
                type="button"
                className="ml-2 underline hover:no-underline"
                onClick={bus.retryTranscriptLoad}
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pinned asks: permission + question cards (same components, same
          semantics as the ordinary composer's stack). NEVER gated on a send
          in flight — an ask blocks the whole session on the user's answer,
          and hiding it during a send (or a hung one) would strand it. */}
      {bus.permissions.map((p) => (
        <div key={p.id} className="shrink-0 px-4 pt-2">
          <PermissionCard
            perm={p}
            onReply={(reply) => void replyPermission(p.id, reply, p.sessionID)}
          />
        </div>
      ))}
      {bus.questions.map((q) => (
        <div key={q.id} className="shrink-0 px-4 pt-2">
          <QuestionCard
            request={q}
            onReply={(answers) => void replyQuestion(q, answers)}
            onReject={() => void rejectQuestion(q)}
          />
        </div>
      ))}
      {bus.retryInfo && (
        <div className="shrink-0 px-4 pt-2">
          <RetryCard info={bus.retryInfo} />
        </div>
      )}
      {sendError && (
        <div className="shrink-0 mx-4 mb-1 px-2 py-1 text-meta text-danger bg-danger-bg border border-danger/30 rounded-xs break-words flex items-start gap-2">
          <span className="flex-1">⚠ {sendError}</span>
          <button
            type="button"
            className="text-danger"
            onClick={() => setSendError(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {staleGenNotice && (
        <div className="shrink-0 mx-4 mb-1 px-2 py-1 text-meta text-warn bg-warn-bg border border-warn/30 rounded-xs flex items-start gap-2">
          <span className="flex-1">{staleGenNotice}</span>
          <button
            type="button"
            className="text-warn"
            onClick={() => setStaleGenNotice(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {interruptAck && (
        <div className="shrink-0 mx-4 mb-1 px-2 py-1 text-meta text-text-muted bg-fill-active border border-border-subtle rounded-xs flex items-start gap-2">
          <span className="flex-1">{interruptAck}</span>
        </div>
      )}

      {/* Work inspector (collapsible) — the admission queue, verbatim. */}
      {inspectorOpen && <WorkInspector queue={queue} />}

      {/* Pending sends — acknowledged by the server, not yet in the
          transcript. Ephemeral, reconciled by the queue poll. */}
      {pendingBubbles.length > 0 && (
        <div className="shrink-0 px-4 pt-2 space-y-1">
          {pendingBubbles.map((b) => (
            <div
              key={b.key}
              className={`rounded-md border px-2 py-1 text-meta flex items-center gap-2 ${
                b.unknown
                  ? "border-warn/30 bg-warn-bg text-warn"
                  : "border-border-subtle bg-fill-active text-text-muted"
              }`}
            >
              <span className="truncate flex-1">{b.text}</span>
              <span className="shrink-0">{b.status}</span>
              {b.retryable && (
                <>
                  <button
                    type="button"
                    onClick={onRetryUnknown}
                    disabled={submitting}
                    // Disabled, not silent: submitTurn early-returns on the
                    // in-flight guard, so an enabled Retry mid-send would be
                    // a no-op control.
                    className={`shrink-0 underline hover:no-underline ${submitting ? "opacity-50" : ""}`}
                    aria-label="Retry send"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={onDismissUnknown}
                    className="shrink-0"
                    aria-label="Dismiss unknown send"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Composer — text only. Attachments and slash commands are NOT
          rendered (unsupported in the CTO conversation; hidden, not dead). */}
      <div className="shrink-0 px-4 pb-3 pt-2">
        <div className="flex items-end gap-2 rounded-lg border border-border-subtle bg-fill-active px-3 py-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={submitting}
            placeholder={
              submitting
                ? "Sending…"
                : qSummary.held
                  ? // The permanent hold: nothing is running AND no queued
                    // send will dispatch (the pump holds the whole queue).
                    "Admission is held — sends queue but dispatch nothing until the hold clears"
                  : bus.running || qSummary.canInterrupt
                    ? "Queue a message after the current turn…"
                    : "Message the CTO…"
            }
            className="flex-1 resize-none bg-transparent text-body text-text placeholder:text-text-faint outline-none disabled:opacity-60"
            aria-label="Message the CTO"
          />
          {qSummary.canInterrupt && (
            <button
              type="button"
              onClick={() => void onInterrupt()}
              disabled={submitting}
              title={
                submitting
                  ? "Waiting for the server to accept the send"
                  : "Interrupt the current turn"
              }
              className="shrink-0 rounded-md p-1 text-text-muted hover:bg-fill-hover hover:text-danger disabled:opacity-50"
              aria-label="Interrupt"
            >
              <Square size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={doSubmit}
            disabled={input.trim() === "" || submitting}
            className="shrink-0 rounded-md p-1 text-text-muted hover:bg-fill-hover hover:text-text disabled:opacity-40"
            aria-label="Send"
          >
            <Send size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <ModelPicker
            models={models}
            modelLabel={modelLabel ?? modelLabelFromTranscript}
            modelOverride={modelSelection}
            defaultModel={defaultModel}
            deactivatedMainModels={deactivatedMainModels}
            optInModels={optInModels}
            onOptInModel={optInModel}
            onOpen={() => {}}
            onSelect={onSelectModel}
            onSelectEffort={(m) => onSelectModel(m)}
          />
          <div className="flex-1" />
          <span className="text-meta text-text-faint">
            {qSummary.held
              ? "Admission held — queued sends will not dispatch until the hold clears"
              : bus.running || qSummary.canInterrupt
                ? "Working — sends queue up"
                : "Attachments and slash commands are not available here"}
          </span>
        </div>
      </div>
    </div>
  );
}

function WorkInspector({ queue }: { queue: CtoConversationState | null }) {
  if (!queue) {
    return (
      <div className="shrink-0 mx-4 rounded-lg border border-border-subtle bg-fill-active px-3 py-2 text-meta text-text-faint">
        Queue status unavailable…
      </div>
    );
  }
  const rows = [...queue.submissions].reverse().slice(0, 20);
  const dropped = queue.droppedByPolicy ?? [];
  return (
    <div className="shrink-0 mx-4 rounded-lg border border-border-subtle bg-fill-active px-3 py-2 space-y-1 max-h-56 overflow-y-auto">
      <div className="text-meta text-text-faint">
        {queue.counts.queued.human} human queued · {queue.counts.queued.background}{" "}
        background queued · {queue.counts.unresolved} active · {queue.counts.terminal}{" "}
        done — generation {queue.binding.generation}
        {dropped.length > 0 ? ` · ${dropped.length} dropped by the cap policy` : ""}
      </div>
      {rows.length === 0 && (
        <div className="text-meta text-text-faint">No submissions yet.</div>
      )}
      {rows.map((s) => (
        <div key={s.id} className="text-meta text-text-muted flex items-center gap-2">
          <span className="font-mono">{s.id.slice(0, 16)}</span>
          <span>{s.origin}</span>
          <span
            className={
              s.status === "completed"
                ? "text-teal"
                : s.status === "failed"
                  ? "text-danger"
                  : s.status === "unknown" || isUncertainAbort(s)
                    ? "text-warn"
                    : "text-text-faint"
            }
          >
            {submissionStatusLabel(s)}
            {typeof s.unknownMs === "number"
              ? ` · ${(s.unknownMs / 1000).toFixed(0)}s unknown`
              : ""}
            {s.staleUnknown ? " · stale" : ""}
          </span>
          <span className="flex-1 truncate">
            {typeof s.messageID === "string" ? `msg ${s.messageID.slice(0, 8)}` : ""}
          </span>
        </div>
      ))}
      {dropped.length > 0 && (
        <>
          <div className="text-meta text-warn pt-1">
            Dropped by the admission cap — queued background deliveries the cap
            policy discarded to admit a human send. They were never dispatched
            (their senders may already have been told “queued”).
          </div>
          {dropped.map((d) => (
            <div key={d.id} className="text-meta text-warn flex items-center gap-2">
              <span className="font-mono">{d.id.slice(0, 16)}</span>
              <span>{d.origin}</span>
              <span className="flex-1 truncate">
                {new Date(d.createdAt).toLocaleTimeString()} — never ran
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
