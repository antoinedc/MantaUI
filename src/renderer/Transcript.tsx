// ===== Transcript =====
//
// Extracted from ChatPanel.tsx (BET-63). The scrolling message list: the
// virtualized scroll container, the per-message `MessageRow`, the tail-of-
// transcript live-todos card, the working indicator, and the pending-question
// cards. Purely presentational — every piece of state (messages, the derived
// per-message maps, running, activeTodos, questions) and every callback
// (replyQuestion / rejectQuestion) is passed in by ChatPanel.
//
// BET-679 replaces the hand-rolled v4 scroll/pin machinery (four generations
// of pin-to-bottom bugs, see AGENTS.md "Chat transcript pin-to-bottom") with
// react-virtuoso (MIT). Virtuoso owns scrolling, pinning (followOutput),
// prepending (firstItemIndex) and follow-output. The transcript-state hook no
// longer carries any scroll refs or scroll math.
//
// The `TaskContext.Provider` also lives here (wrapping the Virtuoso) so
// TaskBody descendants can read subagent state without prop-drilling; the
// provider VALUE is memoized by ChatPanel (`taskContextValue`) for keystroke
// stability, so passing it through as a prop keeps that identity intact.

import { forwardRef, useEffect, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { Virtuoso, type ListProps, type VirtuosoHandle } from "react-virtuoso";
import { TaskContext, type TaskContextValue } from "./chatShared";
import { ActiveTodos, MessageRow } from "./MessageRow";
import { MantaLoader } from "./MantaLoader";
import { QuestionCard } from "./Cards";
import { ErrorBoundary } from "./ErrorBoundary";
import { TRANSCRIPT_TAIL_LIMIT } from "./hooks/useTranscriptState";
import type { OpencodeMessage, QuestionRequest } from "../shared/types";
import {
  createEntryMotionState,
  isBackgroundJobCompletionTurn,
  updateEntryMotion,
  type EntryMotionState,
} from "./chatUtils";

// ===== Virtuoso context =====
//
// Virtuoso's Header/Footer/List components receive their data through the
// `context` prop (passed once to <Virtuoso>). This keeps their identities
// stable at module scope so Virtuoso doesn't remount them on every parent
// render, while still letting them read the live tail state (todos, question
// cards, the working indicator) and the load-earlier state.

type TranscriptContext = {
  running: boolean;
  showLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  activeTodos: Array<Record<string, unknown>> | null;
  onDismissTodos?: () => void;
  questions: QuestionRequest[];
  onReplyQuestion: (q: QuestionRequest, answers: string[][]) => void;
  onRejectQuestion: (q: QuestionRequest) => void;
};

// ===== List (spacing) =====
//
// Preserves the reading-column layout the hand-rolled scroller drew: the
// messages are laid out as a flex column with `--turn-gap` between rows. The
// horizontal inset + vertical scroll padding live on the Virtuoso root (below);
// this List only re-introduces the inter-row turn gap that the original single
// `MeasureColumn stacked` flex container provided.
const TranscriptList = forwardRef<HTMLDivElement, ListProps>(function TranscriptList(
  props,
  ref,
) {
  const { style, children, ...rest } = props;
  return (
    <div
      ref={ref}
      {...rest}
      style={{
        ...style,
        display: "flex",
        flexDirection: "column",
        gap: "var(--turn-gap)",
      }}
    >
      {children}
    </div>
  );
});

// ===== Header: Load earlier =====
//
// Renders the slim centered "Load earlier messages" button once the
// tail-first fetch has filled the panel (messages.length >=
// TRANSCRIPT_TAIL_LIMIT) and the full history hasn't been loaded yet. On click
// it pulls the WHOLE transcript and splices it in via `firstItemIndex`, so the
// user's vertical position is preserved by Virtuoso (no scroll math here).
function LoadEarlierHeader({ context }: { context: TranscriptContext }) {
  if (!context.showLoadEarlier) return null;
  return (
    <div className="flex justify-center py-3">
      <button
        type="button"
        onClick={context.onLoadEarlier}
        disabled={context.loadingEarlier}
        className="rounded-full border border-border px-4 py-2 text-meta text-text-muted hover:bg-bg-soft disabled:cursor-not-allowed disabled:opacity-60"
      >
        {context.loadingEarlier ? "Loading…" : "Load earlier messages"}
      </button>
    </div>
  );
}

// The live "working" indicator (BET-677). A constant-height row at the tail of
// the transcript that is ALWAYS rendered and toggles `visibility` instead of
// mounting/unmounting — so flipping `running` on send never reflows the
// reading column (the exact reflow the deleted pre-BET-664 indicator caused).
// The slot stays 28px whether a turn is in flight or not. Lives in the
// virtualized footer (BET-679) so it sits at the tail and scrolls with the
// conversation, exactly where the hand-rolled scroller drew it.
export function WorkingIndicator({ running }: { running: boolean }) {
  return (
    <div
      className="manta-working-indicator flex items-center gap-2 shrink-0"
      style={{
        height: 28,
        // Sit flush under the last message: cancel the transcript column's
        // inter-row `--turn-gap` so the reserved idle slot is EXACTLY its own
        // 28px, not 28px + the turn gap (a stray extra band when idle).
        marginTop: "calc(var(--turn-gap) * -1)",
        visibility: running ? "visible" : "hidden",
      }}
      aria-hidden={!running}
    >
      <MantaLoader />
      <span className="text-text-faint text-xs">Working…</span>
    </div>
  );
}

// ===== Footer: transcript tail =====
//
// Renders everything that appeared after the message rows inside the old
// scroller: the working indicator (BET-677), the live todo checklist, and the
// pending question cards. They scroll with the conversation instead of sitting
// in a shrink-0 row above the input (see the comment history in the old
// Transcript for the design decision — anchoring them at the tail keeps them at
// the bottom of the transcript in every state).
function TranscriptTail({ context }: { context: TranscriptContext }) {
  return (
    <>
      <WorkingIndicator running={context.running} />
      {context.activeTodos && context.activeTodos.length > 0 && (
        <ActiveTodos todos={context.activeTodos} onDismiss={context.onDismissTodos} />
      )}
      {context.questions.length > 0 && (
        <div className="space-y-2 pt-1">
          {context.questions.map((q) => (
            // A malformed question payload must not kill the app — each card
            // gets its own boundary so a bad card degrades to an inline error
            // while its siblings still render.
            <ErrorBoundary key={q.id}>
              <QuestionCard
                request={q}
                onReply={(answers) => context.onReplyQuestion(q, answers)}
                onReject={() => context.onRejectQuestion(q)}
              />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </>
  );
}

export type TranscriptProps = {
  messages: OpencodeMessage[];
  virtuosoRef: React.RefObject<VirtuosoHandle>;
  // Tail-first loading. ChatPanel forwards its sessionId, messages setter and
  // the shared loadedAll ref so "Load earlier" can pull the full history and
  // Virtuoso can anchor-preserve the user's scroll position via firstItemIndex.
  sessionId: string;
  setMessages: React.Dispatch<React.SetStateAction<OpencodeMessage[] | null>>;
  loadedAllRef: React.MutableRefObject<boolean>;
  taskContextValue: TaskContextValue;
  showThinking: boolean;
  running: boolean;
  // Whether the user is actually viewing this panel. App.tsx keeps every
  // ChatPanel mounted and hides the inactive ones with display:none. Entry
  // motion is gated on this — a turn landing in a hidden panel is absorbed as
  // history, not slid in when the user switches to it (updateEntryMotion's
  // third arg). See the comment on `updateEntryMotion` in chatUtils.
  isActive: boolean;
  activeTodos: Array<Record<string, unknown>> | null;
  onDismissTodos?: () => void;
  questions: QuestionRequest[];
  // Per-message derived lookups (all memoized at ChatPanel scope so the
  // React.memo on MessageRow isn't defeated by fresh object identities).
  turnInfo: Map<
    string,
    { turnDurationMs: number | null; outputTokens: number | null }
  >;
  finishByMessageId: Map<string, import("./chatUtils").TruncationKind>;
  userCommandInfo: Map<string, { name: string; arguments: string }>;
  onReplyQuestion: (q: QuestionRequest, answers: string[][]) => void;
  onRejectQuestion: (q: QuestionRequest) => void;
  onAtBottomChange: (atBottom: boolean) => void;
};

export function Transcript({
  messages,
  virtuosoRef,
  sessionId,
  setMessages,
  loadedAllRef,
  taskContextValue,
  showThinking,
  running,
  isActive,
  activeTodos,
  onDismissTodos,
  questions,
  turnInfo,
  finishByMessageId,
  userCommandInfo,
  onReplyQuestion,
  onRejectQuestion,
  onAtBottomChange,
}: TranscriptProps) {
  // Entry motion (transcript-motion). A message that arrives while the user is
  // watching animates in; a transcript they merely LOADED does not. The whole
  // gate lives in `updateEntryMotion` (chatUtils, pure + tested) — see the
  // comment there for the two invariants (primed / sticky) and the two earlier
  // bugs that made this feature fire on history and never on new messages.
  //
  // Held in a ref, not state: it must not schedule a render, and folding the
  // current message list into it during render is idempotent. The ref resets
  // when Transcript remounts, which is exactly the session-switch boundary.
  const motionRef = useRef<EntryMotionState | null>(null);
  motionRef.current ??= createEntryMotionState();
  const motion = updateEntryMotion(
    motionRef.current,
    messages.map((m) => ({ id: m.info.id, role: m.info.role })),
    isActive,
  );

  // Load earlier (tail → full history) via Virtuoso's firstItemIndex. Prepending
  // is Virtual's anchor-preservation mechanism: lowering firstItemIndex by the
  // number of prepended rows keeps the user's scroll position without any
  // scrollHeight/scrollTop math (the old applyFullHistory restore is deleted).
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const onLoadEarlier = () => {
    if (loadingEarlier) return;
    setLoadingEarlier(true);
    window.api
      .opencodeMessages(sessionId, {})
      .then((newMessages: OpencodeMessage[]) => {
        loadedAllRef.current = true;
        const prepended = newMessages.length - messages.length;
        // Same state-update batch (React 18 auto-batches in promise callbacks):
        // the data and the firstItemIndex shift must land together so Virtuoso
        // treats the new rows as pre-pended, not appended.
        setMessages(newMessages);
        setFirstItemIndex((f) => f - prepended);
      })
      .catch(() => { /* non-fatal — keep the tail; the button can be retried */ })
      .finally(() => setLoadingEarlier(false));
  };

  const virtuosoContext: TranscriptContext = {
    running,
    showLoadEarlier:
      !loadedAllRef.current && messages.length >= TRANSCRIPT_TAIL_LIMIT,
    loadingEarlier,
    onLoadEarlier,
    activeTodos,
    onDismissTodos,
    questions,
    onReplyQuestion,
    onRejectQuestion,
  };

  const lastId = messages.length > 0 ? messages[messages.length - 1].info.id : null;

  // Anchor the initial view to the newest turn. A chat transcript opens at the
  // tail. `initialTopMostItemIndex: "LAST"` would do this declaratively, but
  // that prop renders zero rows under react-virtuoso's VirtuosoMockContext
  // (jsdom) that the harness tests rely on — an imperative mount scroll to the
  // last index is functionally equivalent and mock-compatible. `alignToBottom`
  // additionally bottom-aligns content shorter than the viewport. Fires only on
  // the 0→non-empty (or clear→repopulate) transition; refetches and load-earlier
  // prepends are handled by followOutput / firstItemIndex.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!hasMessages) return;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMessages]);

  return (
    // Wrap in reducedMotion="user" so framer-motion disables every chat entry
    // animation for users who prefer reduced motion — the library-native
    // replacement for the old `prefers-reduced-motion` CSS blocks.
    <MotionConfig reducedMotion="user">
    {messages.length === 0 ? (
      // Empty state: rendered INSTEAD of the virtualized list. Full width,
      // matching the populated flow below so both states share a left edge
      // (BET-646).
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{
          padding: "var(--sp-6) 0",
          marginBottom: "var(--sp-2)",
          paddingInline: "var(--transcript-inset)",
        }}
      >
        <div className="text-text-faint">
          <span style={{ color: "var(--accent)" }}>✻</span>{" "}
          Welcome. Type a message below to start.
        </div>
      </div>
    ) : (
      // BET-646 (supersedes BET-413/BET-637's single-edge goal): the transcript
      // runs the full width of the session panel by owner decision — inset from
      // each edge, no measure cap, no centring. The vertical sp-6 padding and
      // horizontal --transcript-inset live on the Virtuoso root (inside the
      // scroller, so they scroll with it, exactly as the old container's own
      // padding did).
      <TaskContext.Provider value={taskContextValue}>
        {/* Defensive boundary around the whole transcript body: a single */}
        {/* MessageRow / card that throws must not white out the app. */}
        <ErrorBoundary>
          <Virtuoso<OpencodeMessage, TranscriptContext>
            ref={virtuosoRef}
            className="flex-1 overflow-x-hidden"
            style={{
              padding: "var(--sp-6) 0",
              marginBottom: "var(--sp-2)",
              paddingInline: "var(--transcript-inset)",
            }}
            data={messages}
            context={virtuosoContext}
            computeItemKey={(_, m) => m.info.id}
            itemContent={(_, m) => {
              // BET-418 §C: a background job's completion report is injected
              // as a fake user turn whose first line is the machine marker
              // `[background job "<name>" <status>]`. The model still sees it,
              // but the user must not — skip rendering the row entirely so it
              // never appears as a right-aligned user bubble.
              if (isBackgroundJobCompletionTurn(m)) return null;
              const isLastInTranscript =
                m.info.id === lastId && m.info.role === "assistant";
              // cmdInfo comes from `userCommandInfo` (memoized at panel
              // scope on [messages, commandByMessageId, commands]).
              // O(1) Map lookup here means MessageRow can be React.memo'd
              // without keystrokes invalidating the prop reference.
              const cmdInfo =
                m.info.role === "user"
                  ? userCommandInfo.get(m.info.id) ?? null
                  : null;
              return (
                <MessageRow
                  msg={m}
                  showThinking={showThinking}
                  turnDurationMs={turnInfo.get(m.info.id)?.turnDurationMs ?? null}
                  outputTokens={turnInfo.get(m.info.id)?.outputTokens ?? null}
                  truncation={finishByMessageId.get(m.info.id) ?? null}
                  commandInfo={cmdInfo}
                  // The message being written right now: last in the
                  // transcript, assistant, and the turn still running.
                  streaming={isLastInTranscript && running}
                  entering={motion.entering.has(m.info.id)}
                />
              );
            }}
            followOutput={(isAtBottom) => (isAtBottom ? "smooth" : false)}
            atBottomStateChange={onAtBottomChange}
            atBottomThreshold={8}
            firstItemIndex={firstItemIndex}
            alignToBottom
            increaseViewportBy={{ top: 600, bottom: 200 }}
            components={{
              Header: LoadEarlierHeader,
              Footer: TranscriptTail,
              List: TranscriptList,
            }}
          />
        </ErrorBoundary>
      </TaskContext.Provider>
    )}
    </MotionConfig>
  );
}
