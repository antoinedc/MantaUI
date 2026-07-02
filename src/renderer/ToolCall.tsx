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

import { memo, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
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
    return { color: "#6b7280", pulse: false };           // text/other: grey
  }
  const status = String(((part as Record<string, unknown>).state as { status?: string } | undefined)?.status ?? "");
  if (status === "completed") return { color: "#22c55e", pulse: false }; // green
  if (status === "error") return { color: "#ef4444", pulse: false };     // red
  // "running" / "pending" / unknown-but-active → blinking grey
  return { color: "#6b7280", pulse: true };
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
          <div className="flex-1">{renderMarkdown(text)}</div>
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
          <div className="flex-1">
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
        <div className="flex-1">
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
        <div className="flex-1">
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
      <div className="flex-1 text-xs">[{part.type}]</div>
    </div>
  );
});

// Renders a tool's `output` string. If it looks like a unified diff (starts
// with `--- ` or `@@`, or has multiple `@@` headers), each line is colored
// red/green/neutral. Otherwise we render it as a monospace code block,
// truncated to a sensible height by default.
const ToolOutput = memo(function ToolOutput({ output }: { output: string }) {
  const looksLikeDiff =
    /^---\s/.test(output) ||
    /\n---\s/.test(output) ||
    /(^|\n)@@ /.test(output);
  // Pin-to-bottom: as a long-running task streams more output, keep the latest
  // lines visible (newest at the bottom, oldest scroll up out of view). Only
  // auto-scroll when the user is already at the bottom so a manual scroll-up to
  // inspect earlier output isn't yanked back down on the next chunk.
  const preRef = useRef<HTMLPreElement | null>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [output]);
  if (looksLikeDiff) {
    return <UnifiedDiff text={output} />;
  }
  // Plain code/text output — small monospace block, scroll on overflow.
  return (
    <pre
      ref={preRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className="text-[12px] bg-bg-soft border border-border rounded px-2 py-1 max-h-64 overflow-auto whitespace-pre"
    >
      <code>{output}</code>
    </pre>
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
        <div className="flex-1">
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
      ? "#22c55e"
      : effectiveStatus === "error"
        ? "#ef4444"
        : "#6b7280"; // running / pending / unknown
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
                <span style={{ color: "#f59e0b" }}>⚠ truncated</span>
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
            <div style={{ color: "#ef4444" }}>Failed to load subagent transcript.</div>
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

// Read: collapsed to a one-line summary by default — "Read N lines (ctrl+o)"
// — because most Read calls aren't worth scrolling past. When verbose, render
// the actual content (opencode's output is already line-numbered).
function ReadBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const output = resolveToolOutput(state);
  const m = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  const body = m ? m[1] : output;
  const lineCount = body.split("\n").filter((l) => l.length > 0).length;
  if (!verbose) {
    return (
      <div className="flex text-[12px] text-text-faint">
        <span className="select-none w-4 shrink-0">⎿</span>
        <span>Read {lineCount} line{lineCount === 1 ? "" : "s"} (ctrl+o to expand)</span>
      </div>
    );
  }
  return <ConnectorOutput body={body} maxLines={Infinity} />;
}

// Bash: output rendered as ⎿-connected monospace lines under the header,
// no boxed background. The command itself is already shown in the header via
// state.title. Output is truncated to 5 lines by default; verbose expands.
function BashBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  // Prefer the final output; while running, fall back to the live
  // metadata.output stream so a long command tails its latest lines instead
  // of an empty "· running" body. Same ctrl+o (verbose) expand applies.
  const output = resolveToolOutput(state);
  if (!output) return null;
  return <ConnectorOutput body={output} maxLines={verbose ? Infinity : 5} />;
}

// Shared renderer for the "⎿ … +N more (ctrl+o)\n  output\n  more lines" style.
// Used by Bash and (any future tool wanting the same look). When the body is
// taller than maxLines we keep the LATEST lines: oldest scroll up out of view
// behind the "+N more" notice and the newest line stays at the bottom. This
// matches how a terminal tails a long-running command's output.
function ConnectorOutput({ body, maxLines }: { body: string; maxLines: number }) {
  const lines = body.split("\n");
  const visibleCount = Math.min(lines.length, maxLines);
  const hidden = lines.length - visibleCount;
  // Take the tail (latest lines), not the head.
  const visible = lines.slice(lines.length - visibleCount);
  return (
    <div className="text-[12px] font-mono leading-snug">
      {hidden > 0 && (
        <div className="flex">
          <span className="select-none w-4 shrink-0 text-text-faint">⎿</span>
          <span className="text-text-faint">
            … +{hidden} earlier line{hidden === 1 ? "" : "s"} (ctrl+o to expand)
          </span>
        </div>
      )}
      {visible.map((l, i) => (
        <div key={i} className="flex">
          <span className="select-none w-4 shrink-0 text-text-faint">
            {hidden === 0 && i === 0 ? "⎿" : " "}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-all text-text-muted">
            {l || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

// Glob: output is newline-separated paths. Show count + first N.
function GlobBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const output = state.output ?? "";
  const paths = output.split("\n").filter((l) => l.length > 0);
  return (
    <div className="text-[12px] text-text-muted">
      {pattern && (
        <div className="text-text-faint mb-1">
          pattern <span className="text-text-muted">{pattern}</span> · {paths.length} match
          {paths.length === 1 ? "" : "es"}
        </div>
      )}
      <CollapsiblePathList paths={paths} maxLines={10} />
    </div>
  );
}

// Grep: collapsed to a one-line summary by default. When verbose, show hits.
function GrepBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const input = state.input ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const output = resolveToolOutput(state);
  const lines = output.split("\n").filter((l) => l.length > 0);
  if (!verbose) {
    return (
      <div className="flex text-[12px] text-text-faint">
        <span className="select-none w-4 shrink-0">⎿</span>
        <span>
          {pattern ? <>Searched <code className="text-accent">{pattern}</code> · </> : null}
          {lines.length} hit{lines.length === 1 ? "" : "s"} (ctrl+o to expand)
        </span>
      </div>
    );
  }
  return <ConnectorOutput body={lines.join("\n")} maxLines={Infinity} />;
}

// TodoWrite: input.todos is an array of {content, status, ...}. Render as a
// checklist with status icons. Status values seen: "pending", "in_progress",
// "completed", "cancelled".
function TodoWriteBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const todos = (input.todos as Array<Record<string, unknown>> | undefined) ?? [];
  if (todos.length === 0) return null;
  return (
    <div className="text-[12px] space-y-0.5">
      {todos.map((t, i) => {
        const content = String(t.content ?? "");
        const status = String(t.status ?? "pending");
        const icon =
          status === "completed"
            ? "☒"
            : status === "in_progress"
              ? "◐"
              : status === "cancelled"
                ? "⊘"
                : "☐";
        const cls =
          status === "completed"
            ? "text-text-faint line-through"
            : status === "in_progress"
              ? "text-text"
              : status === "cancelled"
                ? "text-text-faint line-through opacity-50"
                : "text-text-muted";
        return (
          <div key={i} className={`flex gap-2 ${cls}`}>
            <span className="select-none shrink-0" style={{ color: status === "in_progress" ? CLAUDE_ORANGE : undefined }}>
              {icon}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words">{content}</span>
          </div>
        );
      })}
    </div>
  );
}

// WebFetch: input has {url, prompt?}. Output is the fetched content / summary.
function WebFetchBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const url = typeof input.url === "string" ? input.url : "";
  const output = resolveToolOutput(state);
  return (
    <div className="text-[12px] space-y-1">
      {url && (
        <div className="text-text-faint break-all">
          <span className="select-none">→ </span>
          <span style={{ color: CLAUDE_ORANGE }}>{url}</span>
        </div>
      )}
      {output && <CollapsibleCode body={output} maxLines={15} />}
    </div>
  );
}

// Generic collapsible monospace block — used by Read/Bash/Grep/WebFetch.
// Shows the first maxLines lines; clicking the "(N more)" footer expands.
function CollapsibleCode({ body, maxLines }: { body: string; maxLines: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = body.split("\n");
  const overflow = lines.length > maxLines && !expanded;
  const shown = overflow ? lines.slice(0, maxLines).join("\n") : body;
  const hiddenCount = lines.length - maxLines;
  return (
    <div className="text-[12px] bg-bg-soft border border-border rounded">
      <pre className="px-2 py-1 overflow-x-auto whitespace-pre">
        <code>{shown}</code>
      </pre>
      {overflow && (
        <button
          onClick={() => setExpanded(true)}
          className="block w-full text-left px-2 py-0.5 text-[10px] text-text-faint hover:text-text border-t border-border"
        >
          + {hiddenCount} more line{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}

// Simpler list variant for Glob — just paths, no monospace wrapper styling.
function CollapsiblePathList({ paths, maxLines }: { paths: string[]; maxLines: number }) {
  const [expanded, setExpanded] = useState(false);
  if (paths.length === 0) return null;
  const overflow = paths.length > maxLines && !expanded;
  const shown = overflow ? paths.slice(0, maxLines) : paths;
  const hiddenCount = paths.length - maxLines;
  return (
    <div className="text-[12px] bg-bg-soft border border-border rounded">
      <div className="px-2 py-1 overflow-x-auto">
        {shown.map((p, i) => (
          <div key={i} className="text-text-muted whitespace-pre">
            {p}
          </div>
        ))}
      </div>
      {overflow && (
        <button
          onClick={() => setExpanded(true)}
          className="block w-full text-left px-2 py-0.5 text-[10px] text-text-faint hover:text-text border-t border-border"
        >
          + {hiddenCount} more
        </button>
      )}
    </div>
  );
}

// Unified diff: renders directly on the page background — no card, no border,
// no hunk-header decoration. Same font/size/weight as body text (inherits from
// the panel wrapper); diff bodies use the bright cream `text-text` color.
// Background blocks are saturated green/red for proper contrast.
//
// Line numbers come from `@@ -A,B +C,D @@` parsed per hunk; `+` and context
// use NEW line numbers, `-` uses OLD.
function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split("\n");
  let oldLine = 0;
  let newLine = 0;
  return (
    <div className="font-mono leading-snug my-1 overflow-x-auto">
      {lines.map((line, i) => {
        // Hunk header: parse counters silently. Skip the visible row — the
        // header carries file/range metadata that's noise next to the actual
        // changes. Line numbers from the parsed counters still drive the
        // gutter, so jumps between hunks remain obvious.
        if (line.startsWith("@@")) {
          const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (m) {
            oldLine = parseInt(m[1], 10);
            newLine = parseInt(m[2], 10);
          }
          return null;
        }
        // File markers / Index preamble — drop entirely. opencode emits these
        // for every diff and they're noise next to the actual changes.
        if (
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("Index: ") ||
          /^=+$/.test(line)
        ) {
          return null;
        }

        // +/− /context line classification.
        let bg = "";
        let signCls = "text-text-faint";
        let lnCls = "text-text-faint";
        let sign: string | null = null;
        let body = line;
        let ln: number | null = null;

        if (line.startsWith("+") && !line.startsWith("+++")) {
          // Saturated green block. Text stays the same bright cream as body
          // copy — color comes from the bg, not the text.
          bg = "bg-green-700/55";
          signCls = "text-green-300";
          lnCls = "text-green-300/70";
          sign = "+";
          body = line.slice(1);
          ln = newLine++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          bg = "bg-red-700/55";
          signCls = "text-red-300";
          lnCls = "text-red-300/70";
          sign = "−";
          body = line.slice(1);
          ln = oldLine++;
        } else if (line.startsWith(" ")) {
          sign = " ";
          body = line.slice(1);
          ln = newLine;
          newLine++;
          oldLine++;
        }

        if (sign !== null) {
          return (
            <div key={i} className={`flex whitespace-pre ${bg}`}>
              <span className={`select-none shrink-0 text-right pr-2 w-10 ${lnCls}`}>
                {ln ?? ""}
              </span>
              <span className={`select-none shrink-0 w-3 ${signCls}`}>
                {sign}
              </span>
              <span className="flex-1 text-text">{body || " "}</span>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
