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
//
// The `TaskContext.Provider` also lives here (wrapping the scroll body) so
// TaskBody descendants can read subagent state without prop-drilling; the
// provider VALUE is memoized by ChatPanel (`taskContextValue`) for keystroke
// stability, so passing it through as a prop keeps that identity intact.

import type { OpencodeMessage, QuestionRequest } from "../shared/types";
import { TaskContext, type TaskContextValue } from "./chatShared";
import { MeasureColumn } from "./MeasureColumn";
import { ActiveTodos, MessageRow } from "./MessageRow";
import { QuestionCard } from "./Cards";
import { isBackgroundJobCompletionTurn } from "./chatUtils";

export type TranscriptProps = {
  messages: OpencodeMessage[];
  scrollRef: React.RefObject<HTMLDivElement>;
  questionCardRef: React.RefObject<HTMLDivElement>;
  taskContextValue: TaskContextValue;
  showThinking: boolean;
  running: boolean;
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
  questionCardRef,
  taskContextValue,
  showThinking,
  running,
  activeTodos,
  questions,
  turnInfo,
  finishByMessageId,
  userCommandInfo,
  onReplyQuestion,
  onRejectQuestion,
}: TranscriptProps) {
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
      style={{ paddingTop: "3.5rem", paddingBottom: "var(--sp-6)", marginBottom: "var(--sp-2)" }}
    >
      <TaskContext.Provider value={taskContextValue}>
        <div className="flex flex-col justify-end min-h-full">
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
                    persistentTodos={
                      isLastInTranscript && !running ? activeTodos : null
                    }
                    truncation={finishByMessageId.get(m.info.id) ?? null}
                    commandInfo={cmdInfo}
                    // The message being written right now: last in the
                    // transcript, assistant, and the turn still running.
                    streaming={isLastInTranscript && running}
                  />
                );
              })}
              {/* Live todos while a turn is running — rendered INSIDE the */}
              {/* scroll container at the tail of the transcript so the list */}
              {/* scrolls with the rest of the chat instead of sitting in a */}
              {/* shrink-0 row above the input (which made it feel "sticky" */}
              {/* and ate vertical space on long checklists). The */}
              {/* `!running` branch above still attaches activeTodos to the */}
              {/* last assistant message via persistentTodos — same data, */}
              {/* same rendering, just owned by MessageRow once idle. */}
              {running && activeTodos && activeTodos.length > 0 && (
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
                    <QuestionCard
                      key={q.id}
                      request={q}
                      onReply={(answers) => onReplyQuestion(q, answers)}
                      onReject={() => onRejectQuestion(q)}
                    />
                  ))}
                </div>
              )}
            </MeasureColumn>
          )}
        </div>
      </TaskContext.Provider>
    </div>
  );
}
