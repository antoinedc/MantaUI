// ===== Task (subagent) card =====
//
// Extracted from ToolCall.tsx (BET-636). This is the subagent/task tool body:
// a ToolCard with a disclosure header (description + agent arg + a live
// status summary carrying a StatusDot) that, on expand, renders the child
// session's full transcript inline via MessageRow — full fidelity, including
// tool calls, reasoning (Ctrl+O), text markdown, active todos, etc. (Nested
// subagents recurse for free because the task tool case just re-enters the
// same flow on the inner ToolBody.)
//
// Data sources:
//   - The parent's task tool part (`state` prop here) gives us the headline
//     metadata: status, title, duration, child id, agent type, model, output.
//   - The child's transcript is fetched lazily on first expand via the
//     `toggle` callback in TaskContext (registered by ChatPanel as
//     `toggleTaskExpand`); subsequent SSE traffic for that child triggers
//     a debounced re-fetch (also in ChatPanel) so the expanded card stays
//     live.
//   - Live status from child's session.idle/status events (in liveStatus
//     map) overrides the parent's stale `state.status` for the badge.
//
// When no TaskContext is provided (defensive — shouldn't happen in ChatPanel
// but might in a future test harness), renders the static header + final
// output only, no expand affordance.

import { useContext, useMemo } from "react";
import {
  extractSubagentInfo,
  formatDuration,
  formatTokens,
  summarizeChildSession,
} from "./chatUtils";
import { TaskContext, type ToolState } from "./chatShared";
import { MessageRow } from "./MessageRow";
import { ToolOutput } from "./ToolBodies";
import { StatusDot } from "./StatusDot";
import { ToolCard } from "./ToolCard";

export function TaskCard({ state }: { state: ToolState }) {
  const ctx = useContext(TaskContext);
  const info = useMemo(
    () => extractSubagentInfo({ type: "tool", tool: "task", state }),
    [state],
  );
  // HOOK ORDER: every hook used by this component must run BEFORE the `!info`
  // early return below. Previously `summary` was computed after the return,
  // so a render that flipped from `info === null` (1 hook) to `info !== null`
  // (2 hooks) crashed with "Rendered more hooks than during the previous
  // render" and blanked the whole panel. Resolve `childMsgs` here
  // (independent of `info`) so the memo's input is stable across both
  // branches.
  const childMsgsForSummary = info
    ? ctx?.childMessages.get(info.childSessionId)
    : undefined;
  const summary = useMemo(
    () => summarizeChildSession(childMsgsForSummary),
    [childMsgsForSummary],
  );
  if (!info) {
    // No child id yet (very brief window between tool-input.started and the
    // first metadata write). Fall back to whatever output is present.
    return state.output ? <ToolOutput output={state.output} /> : null;
  }
  const isExpanded = ctx?.expanded.has(info.childSessionId) ?? false;
  const childMsgs = childMsgsForSummary;
  const liveState = ctx?.liveStatus.get(info.childSessionId);
  // Prefer live SSE status over the parent's transcript snapshot (which lags
  // by one refetch cycle). Maps "running" → still going, "idle" → finished.
  // The transcript status acts as the initial value before any live event
  // lands AND the source of truth for completed/error.
  const effectiveStatus =
    liveState === "idle" && info.status === "running"
      ? "completed"
      : liveState === "running" && info.status === "completed"
        ? "running"
        : info.status;
  const showThinking = ctx?.showThinking ?? false;
  const tone =
    effectiveStatus === "completed"
      ? "ok"
      : effectiveStatus === "error"
        ? "error"
        : "running";

  const onToggle = ctx ? () => ctx.toggle(info.childSessionId) : null;

  const meta = (
    <span className="flex items-center gap-2">
      <StatusDot tone={tone} />
      <span>{effectiveStatus}</span>
      {summary.toolCount > 0 && (
        <span>
          {summary.toolCount} tool{summary.toolCount === 1 ? "" : "s"}
          {effectiveStatus === "running" && summary.lastToolName
            ? ` (${summary.lastToolName})`
            : ""}
        </span>
      )}
      {info.durationMs != null && (
        <span>{formatDuration(info.durationMs)}</span>
      )}
      {summary.tokens > 0 && (
        <span>{formatTokens(summary.tokens)}</span>
      )}
      {info.truncated && (
        // Matches the truncation badge elsewhere (warn token).
        <span style={{ color: "var(--warn)" }}>⚠ truncated</span>
      )}
    </span>
  );

  return (
    <ToolCard
      name={info.description ? String(info.description) : String(info.agent)}
      arg={info.description ? info.agent : undefined}
      meta={meta}
      expanded={isExpanded}
      onToggle={onToggle ?? undefined}
    >
      {/* Expanded body: child transcript (full fidelity, indented + bordered)
          followed by the final output. While loading, a small spinner. */}
      {isExpanded && (
        <div className="px-4 pb-3 border-l-2 border-border flex flex-col" style={{ gap: "var(--sp-2)" }}>
          {childMsgs && childMsgs.length > 0 && (
            <div className="flex flex-col gap-2">
              {childMsgs.map((m) => (
                <MessageRow
                  key={m.info.id}
                  msg={m}
                  showThinking={showThinking}
                  // Subagent transcripts have their own footers; don't paint
                  // turn-duration / persistent-todo / truncation overlays
                  // designed for the top-level conversation.
                  turnDurationMs={null}
                  persistentTodos={null}
                  truncation={null}
                  commandInfo={null}
                />
              ))}
            </div>
          )}
          {childMsgs && childMsgs.length === 0 && (
            <div className="text-text-faint italic">
              (no messages — subagent finished without producing a transcript)
            </div>
          )}
          {/* Final output, shown below the transcript for completed runs.
              Same visual treatment as the generic ToolOutput so users
              recognize "this is what the subagent returned to its parent". */}
          {info.output && effectiveStatus !== "running" && (
            <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
              <div className="text-text-faint">Result:</div>
              {/* `copy` because this well has no card header above it to hold
                  the affordance — the enclosing card's header is a disclosure
                  button and cannot nest one. */}
              <ToolOutput output={info.output} copy />
            </div>
          )}
        </div>
      )}
    </ToolCard>
  );
}
