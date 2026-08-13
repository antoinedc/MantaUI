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

import { forwardRef, useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Virtuoso, type ListProps, type VirtuosoHandle } from "react-virtuoso";
import { TaskContext, type TaskContextValue, presentVerbFor } from "./chatShared";
import { ActiveTodos, MessageRow } from "./MessageRow";
import { MantaLoader } from "./MantaLoader";
import { CardMount } from "./components/CardMount";
import { WORKING_TICK_MS, nowMs, useClockTick } from "./clock";
import { QuestionCard } from "./Cards";
import { Button } from "./Button";
import { ErrorBoundary } from "./ErrorBoundary";
import { TRANSCRIPT_TAIL_LIMIT } from "./hooks/useTranscriptState";
import type { OpencodeMessage, QuestionRequest } from "../shared/types";
import {
  createEntryMotionState,
  isBackgroundJobCompletionTurn,
  updateEntryMotion,
  formatDuration,
  formatTokens,
  type EntryMotionState,
  type LiveTurn,
} from "./chatUtils";

// ===== Virtuoso context =====
//
// Virtuoso's Header/Footer/List components receive their data through the
// `context` prop (passed once to <Virtuoso>). This keeps their identities
// stable at module scope so Virtuoso doesn't remount them on every parent
// render, while still letting them read the live tail state (todos, question
// cards, the working indicator) and the load-earlier state.

export type TranscriptContext = {
  running: boolean;
  liveTurn: LiveTurn | null;
  showLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  activeTodos: Array<Record<string, unknown>> | null;
  onDismissTodos?: () => void;
  questions: QuestionRequest[];
  onReplyQuestion: (q: QuestionRequest, answers: string[][]) => void;
  onRejectQuestion: (q: QuestionRequest) => void;
};

// ===== The reading inset =====
//
// NEVER put horizontal padding on the <Virtuoso> root. Virtuoso renders its
// viewport as `position: absolute` sized against the scroller's PADDING box:
// with `padding-inline: 48px` on the scroller the viewport computes to
// `left: 48px; right: -48px; width: <clientWidth>`. The left inset survives,
// the RIGHT inset is cancelled, every row is 2×inset too wide, and the
// scroller's own `overflow-x: hidden` clips the overhang — which reads as
// "text cut off at the right edge with no margin" (measured 2026-08-07:
// scroller clientWidth 1183 vs true content width 1087, scrollWidth 1268).
// Padding was correct on the hand-rolled block scroller this replaced; it is
// not on a Virtuoso root. The inset therefore lives on the IN-FLOW children —
// List, Header, Footer — where padding behaves normally, and where it also
// gives the hover timestamp its gutter instead of letting it overflow.
const TRANSCRIPT_INSET: React.CSSProperties = {
  paddingInline: "var(--transcript-inset)",
};

// ===== List (spacing) =====
//
// Preserves the reading-column layout: messages laid out as a flex column with
// `--turn-gap` between rows, plus the reading inset.
//
// NEVER set paddingTop / paddingBottom / paddingBlock / padding here.
// react-virtuoso writes the virtualization offsets into THIS element's inline
// style (`paddingTop: offsetTop`, `paddingBottom: offsetBottom`); overwriting
// them makes the list report a box shorter than its content, and the Footer is
// then drawn inside the last rendered row (the "loader overlaps the last
// message" bug). The transcript's vertical breathing room lives on Header and
// Footer instead, where padding is ours to set.
export const TranscriptList = forwardRef<HTMLDivElement, ListProps>(function TranscriptList(
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
        maxWidth: "100%",
        ...TRANSCRIPT_INSET,
      }}
    >
      {children}
    </div>
  );
});

// ===== Header: Load earlier =====
//
// The slim centered "Load earlier messages" button shown once a tail-first
// fetch has filled the list (>= TRANSCRIPT_TAIL_LIMIT) and the full history
// hasn't been loaded yet. On click it pulls the WHOLE transcript.
//
// Shared additively between the main transcript (which passes the current
// tail state from its Virtuoso context) and TaskCard's child transcript
// (which passes a per-child bound context) — one component, never forked.
// The main transcript's prepend is preserved via Virtuoso's firstItemIndex;
// the child's lives inline inside the parent's card (see TaskCard).
export type LoadEarlierHeaderProps = {
  showLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
};
export function LoadEarlierHeader({
  showLoadEarlier,
  loadingEarlier,
  onLoadEarlier,
}: LoadEarlierHeaderProps) {
  if (!showLoadEarlier) return null;
  return (
    <div className="flex justify-center py-3">
      <Button
        type="button"
        tone="default"
        onClick={onLoadEarlier}
        disabled={loadingEarlier}
      >
        {loadingEarlier ? "Loading…" : "Load earlier messages"}
      </Button>
    </div>
  );
}

// Virtuoso Header adapter: Virtuoso invokes its Header component with the
// TranscriptContext (the `context` prop), so bridge it to the shared
// LoadEarlierHeader's discrete props. Carries the reading inset because
// Virtuoso renders Header OUTSIDE the List (see TRANSCRIPT_INSET); the shared
// component stays inset-free so TaskCard can render it inside an already-
// inset column.
const LoadEarlier = ({ context }: { context: TranscriptContext }) => (
  <div style={{ ...TRANSCRIPT_INSET, paddingTop: "var(--sp-6)" }}>
    <LoadEarlierHeader
      showLoadEarlier={context.showLoadEarlier}
      loadingEarlier={context.loadingEarlier}
      onLoadEarlier={context.onLoadEarlier}
    />
  </div>
);

// The live "working" indicator (BET-677). A real status line at the tail of
// the transcript, rendered only while a turn is in flight: the loader, a
// present-tense verb, the elapsed time ticking once per second, and the
// turn's tokens so far. It mounts and unmounts (animated by CardMount) rather
// than reserving a permanent slot, so the idle transcript collapses to zero
// extra height — the opposite of the pre-BET-664 reserved-band design. Lives
// in the virtualized footer (BET-679) so it sits at the tail and scrolls with
// the conversation. Deliberately presentational: `running` comes from the
// event stream, `liveTurn` (the trailing turn's metrics) from computeLiveTurn
// — this component only renders.
export function WorkingIndicator({
  running,
  liveTurn,
}: {
  running: boolean;
  liveTurn: LiveTurn | null;
}) {
  // Re-render (and thus re-read the clock during render) once per second so
  // the elapsed label advances on its own. The component is only mounted
  // while running — CardMount unmounts it when idle — so no ticker runs
  // between turns.
  useClockTick(WORKING_TICK_MS);
  return (
    <CardMount show={running} k="working">
      <div className="manta-working-indicator flex items-center gap-2 shrink-0">
        <MantaLoader />
        <span className="text-text-faint text-xs">
          {liveTurn ? (
            <>
              {presentVerbFor(liveTurn.verbSeedId)}…
              {" · "}
              {formatDuration(nowMs() - liveTurn.startedAt)}
              {liveTurn.tokens > 0 && (
                <>
                  {" · "}
                  {formatTokens(liveTurn.tokens)}
                </>
              )}
            </>
          ) : (
            "Working…"
          )}
        </span>
      </div>
    </CardMount>
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
export function TranscriptTail({ context }: { context: TranscriptContext }) {
  return (
    // Inset + bottom breathing room: Virtuoso renders Footer OUTSIDE the List,
    // so it needs its own copy of the reading inset (see TRANSCRIPT_INSET) and
    // the trailing gap the scroller's now-removed padding used to imply.
    <div
      style={{
        ...TRANSCRIPT_INSET,
        // The tail is a stacked column and owns the spacing between its own
        // children — the working row, the todo checklist and the question
        // cards — exactly like TranscriptList owns --turn-gap between message
        // rows. Do NOT push this back onto a child as a margin: a child-owned
        // gap disappears with that child (the working row unmounts when the
        // turn ends, and its margin used to take the whole tail's spacing with
        // it) and only ever spaces one side.
        display: "flex",
        flexDirection: "column",
        gap: "var(--block-gap)",
        // `gap` only applies BETWEEN children, so the gap to the last message
        // row above is padding on the container. It is needed because Virtuoso
        // renders Footer OUTSIDE List, so the List's flex gap never crosses
        // into here. Unconditional on purpose — one code path, no "does the
        // tail have content" branch that would have to fight CardMount's
        // 220ms exit animation.
        paddingTop: "var(--block-gap)",
        paddingBottom: "var(--sp-6)",
      }}
    >
      <WorkingIndicator running={context.running} liveTurn={context.liveTurn} />
      {context.activeTodos && context.activeTodos.length > 0 && (
        <ActiveTodos todos={context.activeTodos} onDismiss={context.onDismissTodos} />
      )}
      {context.questions.length > 0 && (
        <div className="flex flex-col" style={{ gap: "var(--block-gap)" }}>
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
    </div>
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
  liveTurn: LiveTurn | null;
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
    {
      turnDurationMs: number | null;
      turnTokens: number | null;
      verbSeedId: string | null;
    }
  >;
  finishByMessageId: Map<string, import("./chatUtils").TruncationKind>;
  userCommandInfo: Map<string, { name: string; arguments: string }>;
  onReplyQuestion: (q: QuestionRequest, answers: string[][]) => void;
  onRejectQuestion: (q: QuestionRequest) => void;
  onAtBottomChange: (atBottom: boolean) => void;
  // The shared entry-motion state (owned by ChatPanel, registered to here and
  // to useTranscriptState's reconcile path). Using the parent's ref keeps the
  // reconcile registration and the render fold on the SAME state object.
  motionStateRef: React.MutableRefObject<EntryMotionState | null>;
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
  liveTurn,
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
  motionStateRef,
}: TranscriptProps) {
  // Entry motion (transcript-motion). A message that arrives while the user is
  // watching animates in; a transcript they merely LOADED does not. The whole
  // gate lives in `updateEntryMotion` (chatUtils, pure + tested) — see the
  // comment there for the two invariants (primed / sticky) and the two earlier
  // bugs that made this feature fire on history and never on new messages.
  //
  // The state lives in the parent-provided ref (shared with useTranscriptState,
  // which registers reconciled ids against the same object) rather than a
  // local one. Held in a ref, not state: it must not schedule a render, and
  // folding the current message list into it during render is idempotent.
  motionStateRef.current ??= createEntryMotionState();
  const entryMotion = updateEntryMotion(
    motionStateRef.current,
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
    liveTurn,
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
      {/* BET-680 step 5: the "Welcome" empty state fades out (0.15s) when the
          first message arrives instead of being hard-replaced. It renders
          INSTEAD of the virtualized list; the populated list below stays OUT
          of the AnimatePresence so Virtuoso's lifecycle is untouched. */}
      <AnimatePresence initial={false}>
        {!hasMessages && (
          <motion.div
            key="empty"
            className="flex-1 min-h-0 flex flex-col"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "tween", duration: 0.15 }}
          >
            {/* Empty state: full width, matching the populated flow below so
                both states share a left edge (BET-646).

                It sits at the BOTTOM of the empty transcript, right above the
                composer — the transcript grows upward from the composer, so the
                first line of a conversation must start where every later line
                will be, not stranded at the top of an empty panel. `mt-auto` in
                a flex column is what does it: unlike `justify-end` it survives
                on a scroll container (a taller-than-viewport child stays
                reachable) and, unlike `min-height:100%`, it needs no percentage
                to resolve against the flex-sized parent. */}
            <div
              className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col"
              style={{
                padding: "var(--sp-6) 0",
                marginBottom: "var(--sp-2)",
                paddingInline: "var(--transcript-inset)",
              }}
            >
              <div className="mt-auto text-text-faint">
                <span style={{ color: "var(--accent)" }}>✻</span>{" "}
                Welcome. Type a message below to start.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {hasMessages && (
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
              className="flex-1 overflow-x-hidden max-w-full"
              // NO padding here — Virtuoso's absolute viewport ignores it and
              // the right inset is cancelled (see TRANSCRIPT_INSET). The inset
              // and the vertical breathing room live on List/Header/Footer.
              // `marginBottom` is safe (it is outside the scroller box) and is
              // the gap between the transcript and the composer.
              style={{ marginBottom: "var(--sp-2)" }}
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
                    turnTokens={turnInfo.get(m.info.id)?.turnTokens ?? null}
                    verbSeedId={turnInfo.get(m.info.id)?.verbSeedId ?? null}
                    truncation={finishByMessageId.get(m.info.id) ?? null}
                    commandInfo={cmdInfo}
                    // The message being written right now: last in the
                    // transcript, assistant, and the turn still running.
                    streaming={isLastInTranscript && running}
                    entering={entryMotion.entering.has(m.info.id)}
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
                Header: LoadEarlier,
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
