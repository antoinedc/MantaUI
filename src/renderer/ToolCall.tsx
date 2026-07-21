// ===== Tool call + assistant part rendering =====
//
// Extracted from ChatPanel.tsx (M0.5). Renders assistant message parts and the
// per-tool body views:
//   - AssistantPart: switches on part.type (text / reasoning / tool / patch /
//     file) and delegates tool parts to ToolCall.
//   - ToolCall: switches on the tool name and dispatches to a *Body renderer.
//   - ToolOutput / UnifiedDiff / Collapsible*: shared output presenters.
//   - TaskBody: subagent card that renders the child transcript inline using
//     MessageRow (imported from ./MessageRow — an intentional module cycle that
//     is safe because both references are used only at render time).

import { memo, useContext, useMemo } from "react";
import type { OpencodePart } from "../shared/types";
import {
  extractSubagentInfo,
  formatDuration,
  formatTokens,
  resolveToolOutput,
  summarizeChildSession,
} from "./chatUtils";
import { CLAUDE_ORANGE, TaskContext, type ToolState } from "./chatShared";
import { renderMarkdown } from "./MarkdownBody";
import { MessageRow } from "./MessageRow";
import {
  BashBody,
  GlobBody,
  GrepBody,
  ReadBody,
  ToolOutput,
  TodoWriteBody,
  UnifiedDiff,
  WebFetchBody,
} from "./ToolBodies";

// Verbose summary of an Edit/Write/MultiEdit diff: "Added 5 lines",
// "Removed 3 lines", or "Added 5 lines, removed 3 lines". Replaces the
// terse `+5 −3` header so the tool row reads more naturally at a glance.
// First letter capitalized — only the lead verb, not both (natural prose).
export function formatFileDiff(additions: number, deletions: number): React.ReactNode {
  const aLead = `Added ${additions} line${additions === 1 ? "" : "s"}`;
  const dLead = `Removed ${deletions} line${deletions === 1 ? "" : "s"}`;
  const dTail = `removed ${deletions} line${deletions === 1 ? "" : "s"}`;
  if (additions > 0 && deletions > 0) {
    return (
      <>
        <span className="text-green-400">{aLead}</span>,{" "}
        <span className="text-red-400">{dTail}</span>
      </>
    );
  }
  if (additions > 0) return <span className="text-green-400">{aLead}</span>;
  if (deletions > 0) return <span className="text-red-400">{dLead}</span>;
  return null;
}

// Bullet color/animation by part kind + tool status. Text gets grey; tools
// blink grey while running/pending, turn green on completion, red on error.
export function bulletStyle(part: OpencodePart): { color: string; pulse: boolean } {
  if (part.type !== "tool") {
    return { color: "#5C6578", pulse: false };           // text/other: grey
  }
  const status = String(((part as Record<string, unknown>).state as { status?: string } | undefined)?.status ?? "");
  if (status === "completed") return { color: "#22C79A", pulse: false }; // green
  if (status === "error") return { color: "#F0505F", pulse: false };     // red
  // "running" / "pending" / unknown-but-active → blinking grey
  return { color: "#5C6578", pulse: true };
}

// Memoized so re-renders of a memo'd MessageRow whose parts haven't
// changed identity don't re-render every child part (and re-tokenize
// every code block). `part` references are stable across renders
// because the messages array uses object spread for updates and
// unchanged parts keep their identity. `first` and `showThinking` are
// primitives. Safe to use the default shallow comparator.
export const AssistantPart = memo(function AssistantPart({
  part,
  first,
  showThinking,
}: {
  part: OpencodePart;
  first: boolean;
  showThinking: boolean;
}) {
  // Single bullet on the very first line of the very first content part;
  // everything else gets a 2-space indent to align under it.
  const Prefix = ({ char, color, pulse }: { char: string; color: string; pulse?: boolean }) => (
    <span
      className={"select-none " + (pulse ? "animate-pulse" : "")}
      style={{ color }}
    >
      {char}{" "}
    </span>
  );

  if (part.type === "text") {
    const text = (part.text ?? "").replace(/^\n+|\n+$/g, "");
    if (!text) return null;
    const { color, pulse } = bulletStyle(part);
    // No `whitespace-pre-wrap` here — react-markdown handles block structure
    // and would otherwise stack raw newlines from the source on top of its
    // own paragraph spacing, leaving huge visual gaps around code blocks.
    return (
      <div className="break-words text-text">
        <div className="flex">
          <span className="select-none w-4 shrink-0">
            {first ? <Prefix char="●" color={color} pulse={pulse} /> : <span className="invisible">●</span>}
          </span>
          <div className="flex-1 min-w-0">{renderMarkdown(text)}</div>
        </div>
      </div>
    );
  }

  if (part.type === "reasoning") {
    const text = (part.text ?? "").replace(/^\n+|\n+$/g, "");
    if (!text) return null;
    // Hidden entirely by default — the running indicator already signals
    // that thinking happened. Ctrl+O reveals the full content for debugging
    // or curiosity. No placeholder when collapsed.
    if (!showThinking) return null;
    return (
      <div className="whitespace-pre-wrap break-words text-text-muted italic">
        <div className="flex">
          <span className="select-none w-4 shrink-0">
            <span style={{ color: CLAUDE_ORANGE, opacity: 0.6 }}>✻ </span>
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-text-faint not-italic mb-1">Thinking…</div>
            <div>{text}</div>
          </div>
        </div>
      </div>
    );
  }

  if (part.type === "tool") {
    return <ToolCall part={part} verbose={showThinking} />;
  }

  // Patch (savepoint after one or more file edits): show the files touched.
  if (part.type === "patch") {
    const files = ((part as Record<string, unknown>).files as string[] | undefined) ?? [];
    return (
      <div className="flex text-text-faint text-xs">
        <span className="select-none w-4 shrink-0">
          <span style={{ color: CLAUDE_ORANGE, opacity: 0.6 }}>⎿ </span>
        </span>
        <div className="flex-1 min-w-0">
          {files.length === 0
            ? "patched"
            : `patched ${files.length} file${files.length === 1 ? "" : "s"}: ${files.join(", ")}`}
        </div>
      </div>
    );
  }

  // File reference (attached file in a prompt, or returned by a tool).
  if (part.type === "file") {
    const filename = String((part as Record<string, unknown>).filename ?? "");
    const mime = String((part as Record<string, unknown>).mime ?? "");
    return (
      <div className="flex text-text-faint text-xs">
        <span className="select-none w-4 shrink-0">
          <span style={{ color: CLAUDE_ORANGE, opacity: 0.6 }}>⎿ </span>
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-text-muted">{filename || "(file)"}</span>
          {mime && <span className="text-text-faint"> · {mime}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex text-text-faint">
      <span className="select-none w-4 shrink-0">
        <span style={{ color: CLAUDE_ORANGE, opacity: 0.5 }}>○ </span>
      </span>
      <div className="flex-1 min-w-0 text-xs">[{part.type}]</div>
    </div>
  );
});

// ===== Tool call rendering =====
//
// One `ToolCall` switches on `state.input.tool` and dispatches to per-tool
// body renderers. Each body is small enough to inline; the shared header
// (the `● Toolname(title)` line + status/diff stats) lives in ToolHeader.
//
// Add a new tool: write a `<ToolnameBody>` function, add a case in the switch.
// Falls back to GenericBody when the tool is unrecognized.

export const ToolCall = memo(function ToolCall({ part, verbose }: { part: OpencodePart; verbose: boolean }) {
  const rawTool = String((part as Record<string, unknown>).tool ?? "tool");
  // Title-case: "edit" → "Edit", "todo_write" → "TodoWrite".
  const toolName = rawTool
    .split(/[_-]/)
    .map((t) => (t ? t[0].toUpperCase() + t.slice(1) : t))
    .join("");
  const state = ((part as Record<string, unknown>).state ?? {}) as ToolState;
  const meta = state.metadata ?? {};
  const filediff = meta.filediff as
    | { additions?: number; deletions?: number }
    | undefined;
  // Pre-extract diff text (used by Edit/Write/MultiEdit).
  const diffText =
    typeof meta.diff === "string"
      ? (meta.diff as string)
      : typeof (meta.filediff as Record<string, unknown> | undefined)?.patch === "string"
        ? ((meta.filediff as Record<string, unknown>).patch as string)
        : null;

  const { color: bulletColor, pulse } = bulletStyle(part);
  return (
    <div>
      <div className="flex">
        <span className="select-none w-4 shrink-0">
          <span
            className={pulse ? "animate-pulse" : ""}
            style={{ color: bulletColor }}
          >
            ●{" "}
          </span>
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-text">{toolName}</span>
          {state.title && (
            <span className="text-text-muted">({state.title})</span>
          )}
          {filediff && (filediff.additions || filediff.deletions) ? (
            <span className="text-text-faint ml-1">
              {" · "}
              {formatFileDiff(filediff.additions ?? 0, filediff.deletions ?? 0)}
            </span>
          ) : null}
          {state.status && state.status !== "completed" && (
            <span className="text-text-faint"> · {state.status}</span>
          )}
        </div>
      </div>
      <div className="ml-4 mt-0.5">
        <ToolBody tool={rawTool} state={state} diffText={diffText} verbose={verbose} />
      </div>
    </div>
  );
});

function ToolBody({
  tool,
  state,
  diffText,
  verbose,
}: {
  tool: string;
  state: ToolState;
  diffText: string | null;
  verbose: boolean;
}) {
  // Edit/Write/MultiEdit: prefer the unified diff (lives in metadata.diff).
  if (diffText) return <UnifiedDiff text={diffText} />;

  // Per-tool body. Default fall-through is the generic monospace block.
  switch (tool) {
    case "read":
      return <ReadBody state={state} verbose={verbose} />;
    case "bash":
      return <BashBody state={state} verbose={verbose} />;
    case "glob":
      return <GlobBody state={state} />;
    case "grep":
      return <GrepBody state={state} verbose={verbose} />;
    case "todowrite":
    case "todo_write":
      return <TodoWriteBody state={state} />;
    case "webfetch":
    case "web_fetch":
      return <WebFetchBody state={state} />;
    case "task":
      return <TaskBody state={state} />;
    default: {
      // Unknown tool — show output (if any) as a generic block. Falls back to
      // the live metadata.output stream while running so any long-running tool
      // surfaces progress, not just bash/grep/read.
      const output = resolveToolOutput(state);
      return output ? <ToolOutput output={output} /> : null;
    }
  }
}

// Task (subagent) body. Collapsed by default to a one-line summary
// (description · agent · status · duration · live tool count). On expand,
// renders the child session's full transcript inline, indented under the
// header with a left border accent so the nesting is visually unambiguous.
//
// The child transcript uses the SAME MessageRow components as the parent —
// full fidelity, including tool calls, reasoning (Ctrl+O), text markdown,
// active todos, etc. (Nested subagents would recurse for free because the
// task tool case here just re-enters the same flow on the inner ToolBody.)
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
// When no TaskContext is provided (defensive — shouldn't happen in
// ChatPanel but might in a future test harness), renders the static
// header + final output only, no expand affordance.
function TaskBody({ state }: { state: ToolState }) {
  const ctx = useContext(TaskContext);
  const info = useMemo(
    () => extractSubagentInfo({ type: "tool", tool: "task", state }),
    [state],
  );
  // HOOK ORDER: every hook used by this component must run BEFORE the
  // `!info` early return below. Previously `summary` was computed after
  // the return, so a render that flipped from `info === null` (1 hook)
  // to `info !== null` (2 hooks) crashed with "Rendered more hooks than
  // during the previous render" and blanked the whole panel. Resolve
  // `childMsgs` here (independent of `info`) so the memo's input is
  // stable across both branches.
  const childMsgsForSummary = info
    ? ctx?.childMessages.get(info.childSessionId)
    : undefined;
  const summary = useMemo(
    () => summarizeChildSession(childMsgsForSummary),
    [childMsgsForSummary],
  );
  if (!info) {
    // No child id yet (very brief window between tool-input.started and
    // the first metadata write). Fall back to whatever output is present.
    return state.output ? <ToolOutput output={state.output} /> : null;
  }
  const isExpanded = ctx?.expanded.has(info.childSessionId) ?? false;
  const childMsgs = childMsgsForSummary;
  const childFetch = ctx?.childFetchState.get(info.childSessionId);
  const liveState = ctx?.liveStatus.get(info.childSessionId);
  // Prefer live SSE status over the parent's transcript snapshot (which
  // lags by one refetch cycle). Maps "running" → still going, "idle" →
  // finished. The transcript status acts as the initial value before any
  // live event lands AND the source of truth for completed/error.
  const effectiveStatus =
    liveState === "idle" && info.status === "running"
      ? "completed"
      : liveState === "running" && info.status === "completed"
        ? "running"
        : info.status;
  const showThinking = ctx?.showThinking ?? false;

  const statusColor =
    effectiveStatus === "completed"
      ? "#22C79A"
      : effectiveStatus === "error"
        ? "#F0505F"
        : "#5C6578"; // running / pending / unknown
  const statusPulse = effectiveStatus === "running" || effectiveStatus === "pending";

  const onToggle = ctx ? () => ctx.toggle(info.childSessionId) : null;

  return (
    <div className="text-[12px] text-text-muted">
      {/* Header row: description + meta line. Click anywhere on the row to
          toggle when context is available. */}
      <div
        className={
          "flex items-start " +
          (onToggle ? "cursor-pointer hover:text-text" : "")
        }
        onClick={onToggle ?? undefined}
      >
        <span className="select-none w-4 shrink-0 text-text-faint">
          {onToggle ? (isExpanded ? "▾" : "▸") : "⎿"}
        </span>
        <div className="flex-1 min-w-0">
          {info.description && (
            <div className="text-text truncate">{info.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-1 text-text-faint">
            <span style={{ color: statusColor }} className={statusPulse ? "animate-pulse" : ""}>
              ●
            </span>
            <span>{info.agent}</span>
            <span>·</span>
            <span>{effectiveStatus}</span>
            {summary.toolCount > 0 && (
              <>
                <span>·</span>
                <span>
                  {summary.toolCount} tool{summary.toolCount === 1 ? "" : "s"}
                  {effectiveStatus === "running" && summary.lastToolName
                    ? ` (${summary.lastToolName})`
                    : ""}
                </span>
              </>
            )}
            {info.durationMs != null && (
              <>
                <span>·</span>
                <span>{formatDuration(info.durationMs)}</span>
              </>
            )}
            {summary.tokens > 0 && (
              <>
                <span>·</span>
                <span>{formatTokens(summary.tokens)}</span>
              </>
            )}
            {info.truncated && (
              <>
                <span>·</span>
                {/* Inline hex matches `CACHE_WRITE_COLOR` / the truncation
                    badge elsewhere; the theme has no `warning` token. */}
                <span style={{ color: "#F0A934" }}>⚠ truncated</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Expanded body: child transcript (full fidelity, indented + bordered)
          followed by the final output. While loading, a small spinner. */}
      {isExpanded && (
        <div className="mt-1 ml-4 pl-3 border-l-2 border-border">
          {childFetch === "loading" && !childMsgs && (
            <div className="text-text-faint italic">Loading subagent transcript…</div>
          )}
          {childFetch === "error" && !childMsgs && (
            // Inline hex — theme has no `error` token; matches bulletStyle()'s
            // red used for failed tool calls.
            <div style={{ color: "#F0505F" }}>Failed to load subagent transcript.</div>
          )}
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
            <div className="mt-2">
              <div className="text-text-faint mb-1">Result:</div>
              <ToolOutput output={info.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
