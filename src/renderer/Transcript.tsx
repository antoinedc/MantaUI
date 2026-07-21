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
import { CLAUDE_ORANGE, TaskContext, type TaskContextValue } from "./chatShared";
import { ActiveTodos, MessageRow } from "./MessageRow";
import { QuestionCard } from "./Cards";

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
    <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
      <TaskContext.Provider value={taskContextValue}>
        <div className="flex flex-col justify-end min-h-full">
          {messages.length === 0 ? (
            <div className="text-text-faint">
              <span style={{ color: CLAUDE_ORANGE }}>✻</span>{" "}
              Welcome. Type a message below to start.
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((m, idx) => {
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
            </div>
          )}
        </div>
      </TaskContext.Provider>
    </div>
  );
}
