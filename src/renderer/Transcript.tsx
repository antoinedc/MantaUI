// ===== Transcript =====
//
// Extracted from ChatPanel.tsx (BET-63). The scrolling message list: the
// scroll container, the per-message `MessageRow` map, the tail-of-transcript
// live-todos card, and the pending-question cards. Purely presentational —
// every piece of state (messages, the derived per-message maps, running,
// activeTodos, questions) and every callback (replyQuestion / rejectQuestion)
// is passed in by ChatPanel.
//
// Two DOM refs are FORWARDED from ChatPanel rather than owned here, because
// the container's effects read them directly:
//   - `scrollRef` — the pin-to-bottom machinery (wasAtBottomBeforeCommit,
//     classifyScrollForPin, the scroll listener, resizeInput) all read this
//     element's scrollTop/scrollHeight/clientHeight. It MUST be the same node
//     ChatPanel measures, so it's passed down, not created here.
//   - `questionCardRef` — a notification deep-link scrolls the pending
//     QuestionCard(s) into view; ChatPanel's deferred-scroll effect reads it.
//   - `contentRef` — forwarded for the same reason: the transcript-state hook's
//     ResizeObserver measures the inner content node to follow the tail when
//     content grows without a `messages` commit (markdown laying out, a card
//     expanding, the working indicator appearing). It MUST be the same node the
//     hook observes, so it's created by the hook and passed down, not owned here.
//
// The `TaskContext.Provider` also lives here (wrapping the scroll body) so
// TaskBody descendants can read subagent state without prop-drilling; the
// provider VALUE is memoized by ChatPanel (`taskContextValue`) for keystroke
// stability, so passing it through as a prop keeps that identity intact.

import type { OpencodeMessage, QuestionRequest } from "../shared/types";
import { useRef } from "react";
import { TaskContext, type TaskContextValue } from "./chatShared";
import { MeasureColumn } from "./MeasureColumn";
import { ActiveTodos, MessageRow } from "./MessageRow";
import { QuestionCard } from "./Cards";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  createEntryMotionState,
  isBackgroundJobCompletionTurn,
  updateEntryMotion,
  type EntryMotionState,
} from "./chatUtils";

export type TranscriptProps = {
  messages: OpencodeMessage[];
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  questionCardRef: React.RefObject<HTMLDivElement>;
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
  questions: QuestionRequest[];
  // Per-message derived lookups (all memoized at ChatPanel scope so the
  // React.memo on MessageRow isn't defeated by fresh object identities).
  turnInfo: Map<string, { turnDurationMs: number | null }>;
  finishByMessageId: Map<string, import("./chatUtils").TruncationKind>;
  userCommandInfo: Map<string, { name: string; arguments: string }>;
  onReplyQuestion: (q: QuestionRequest, answers: string[][]) => void;
  onRejectQuestion: (q: QuestionRequest) => void;
};

export function Transcript({
  messages,
  scrollRef,
  contentRef,
  questionCardRef,
  taskContextValue,
  showThinking,
  running,
  isActive,
  activeTodos,
  questions,
  turnInfo,
  finishByMessageId,
  userCommandInfo,
  onReplyQuestion,
  onRejectQuestion,
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

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden"
      // Horizontal padding moved onto the MeasureColumn (BET-637) so the
      // transcript shares one reading-column edge with the composer and the
      // working indicator; the container keeps only its vertical sp-6 padding.
      //
      // The MARGIN is not the same thing as that bottom padding and does not
      // replace it. Padding is inside the scroller, so it only shows at the
      // scroll extremes — mid-scroll the content is clipped flush against the
      // container's bottom edge, which is exactly where the composer starts, so
      // scrolling up ran a line of text right into the composer's top border.
      // The margin sits OUTSIDE the scroller and is therefore always there. It
      // matches the composer's own internal rhythm (the sp-2 between the input
      // box and the model/effort row).
      style={{ padding: "var(--sp-6) 0", marginBottom: "var(--sp-2)" }}
    >
      <TaskContext.Provider value={taskContextValue}>
        {/* Defensive boundary around the whole transcript body: a single */}
        {/* MessageRow / card that throws must not white out the app. */}
        <ErrorBoundary>
        <div ref={contentRef} className="flex flex-col justify-end min-h-full">
          {messages.length === 0 ? (
            // Full width, matching the populated flow below so both states
            // share a left edge (BET-646).
            <MeasureColumn width="full">
              <div className="text-text-faint">
                <span style={{ color: "var(--accent)" }}>✻</span>{" "}
                Welcome. Type a message below to start.
              </div>
            </MeasureColumn>
          ) : (
            // BET-646 (supersedes BET-413/BET-637's single-edge goal): the
            // transcript runs the full width of the session panel by owner
            // decision — 28px inset from each edge, no measure cap, no
            // centring. The 72ch measure now caps only the composer stack and
            // the user bubble; the left edge of the centred composer no longer
            // meets the transcript's edge on a wide window, which is intended.
            <MeasureColumn stacked width="full">
              {messages.map((m, idx) => {
                // BET-418 §C: a background job's completion report is injected
                // as a fake user turn whose first line is the machine marker
                // `[background job "<name>" <status>]`. The model still sees it,
                // but the user must not — skip rendering the row entirely so it
                // never appears as a right-aligned user bubble.
                if (isBackgroundJobCompletionTurn(m)) return null;
                const isLastInTranscript =
                  idx === messages.length - 1 && m.info.role === "assistant";
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
                    key={m.info.id}
                    msg={m}
                    showThinking={showThinking}
                    turnDurationMs={turnInfo.get(m.info.id)?.turnDurationMs ?? null}
                    truncation={finishByMessageId.get(m.info.id) ?? null}
                    commandInfo={cmdInfo}
                    // The message being written right now: last in the
                    // transcript, assistant, and the turn still running.
                    streaming={isLastInTranscript && running}
                    entering={motion.entering.has(m.info.id)}
                  />
                );
              })}
              {/* The todo checklist — rendered INSIDE the scroll container at */}
              {/* the tail of the transcript, so it scrolls with the rest of */}
              {/* the chat instead of sitting in a shrink-0 row above the */}
              {/* input (which made it feel "sticky" and ate vertical space on */}
              {/* long checklists). */}
              {/* */}
              {/* ONE mount, running or idle. It used to switch owners at the */}
              {/* end of a turn — live under this branch, then re-parented into */}
              {/* the last assistant MessageRow via a `persistentTodos` prop */}
              {/* once idle. Same data drawn by the same component in two */}
              {/* places, which cost a prop threaded through MessageRow and */}
              {/* TaskCard, moved the card by a turn-gap the instant a turn */}
              {/* ended, and dropped it entirely whenever the last row was a */}
              {/* USER turn (the prop was gated on the last message being an */}
              {/* assistant). Anchoring it here keeps it at the bottom of the */}
              {/* transcript in every state. */}
              {activeTodos && activeTodos.length > 0 && (
                <ActiveTodos todos={activeTodos} />
              )}
              {/* Pending question cards. Rendered INSIDE the scroll */}
              {/* container at the tail of the transcript so they scroll */}
              {/* with the rest of the chat instead of sitting in a shrink-0 */}
              {/* row above the input. They still surface prominently (Claude */}
              {/* is blocked until answered) but feel like part of the */}
              {/* conversation — scrolling up through history doesn't keep */}
              {/* the card glued to the bottom. Same pattern as ActiveTodos. */}
              {questions.length > 0 && (
                <div className="space-y-2 pt-1" ref={questionCardRef}>
                  {questions.map((q) => (
                    // A malformed question payload must not kill the app — each
                    // card gets its own boundary so a bad card degrades to an
                    // inline error while its siblings still render.
                    <ErrorBoundary key={q.id}>
                      <QuestionCard
                        request={q}
                        onReply={(answers) => onReplyQuestion(q, answers)}
                        onReject={() => onRejectQuestion(q)}
                      />
                    </ErrorBoundary>
                  ))}
                </div>
              )}
            </MeasureColumn>
          )}
        </div>
        </ErrorBoundary>
      </TaskContext.Provider>
    </div>
  );
}
