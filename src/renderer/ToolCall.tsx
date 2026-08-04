// ===== Tool call + assistant part rendering =====
//
// Extracted from ChatPanel.tsx (M0.5). Renders assistant message parts and the
// per-tool body views:
//   - AssistantPart: switches on part.type (text / reasoning / tool / patch /
//     file) and delegates tool parts to ToolCall.
//   - ToolCall: switches on the tool name and dispatches to a *Body renderer,
//     wrapped in the ToolCard primitive (BET-636).
//   - ToolOutput / UnifiedDiff / Collapsible*: shared output presenters.
//   - TaskCard: the subagent card (extracted to ./TaskCard, BET-636), which
//     renders the child transcript inline using MessageRow (an intentional
//     module cycle that is safe because both references are used only at
//     render time).

import { memo, useState } from "react";
import type { OpencodePart } from "../shared/types";
import { resolveToolOutput, cssVar } from "./chatUtils";
import { type ToolState } from "./chatShared";
import { renderMarkdown } from "./MarkdownBody";
import {
  BashBody,
  GlobBody,
  GrepBody,
  ReadBody,
  ToolOutput,
  UnifiedDiff,
  WebFetchBody,
} from "./ToolBodies";
import { ToolCard } from "./ToolCard";
import { OutputWell } from "./OutputWell";
import { TaskCard } from "./TaskCard";

// Terse `+38 −4` summary of an Edit/Write/MultiEdit diff, matching the spec's
// right-hand meta (`.tool-h .r`). `+N` in ok, `−N` in danger, each omitted
// when zero. The minus is U+2212 MINUS SIGN, matching the diff renderer's
// existing convention. The meta slot's own internal spacing separates them.
export function formatFileDiff(additions: number, deletions: number): React.ReactNode {
  return (
    <>
      {additions > 0 && <span className="text-ok">+{additions}</span>}
      {deletions > 0 && <span className="text-danger">−{deletions}</span>}
    </>
  );
}

// Bullet color/animation by part kind + tool status. Text gets grey; tools
// blink grey while running/pending, turn green on completion, red on error.
export function bulletStyle(part: OpencodePart): { color: string; pulse: boolean } {
  if (part.type !== "tool") {
    return { color: cssVar("--tx4"), pulse: false };           // text/other: grey
  }
  const status = String(((part as Record<string, unknown>).state as { status?: string } | undefined)?.status ?? "");
  if (status === "completed") return { color: cssVar("--ok"), pulse: false }; // green
  if (status === "error") return { color: cssVar("--danger"), pulse: false };     // red
  // "running" / "pending" / unknown-but-active → blinking grey
  return { color: cssVar("--tx4"), pulse: true };
}

// Memoized so re-renders of a memo'd MessageRow whose parts haven't
// changed identity don't re-render every child part (and re-tokenize
// every code block). `part` references are stable across renders
// because the messages array uses object spread for updates and
// unchanged parts keep their identity. `first` and `showThinking` are
// primitives. Safe to use the default shallow comparator.
export const AssistantPart = memo(function AssistantPart({
  part,
  showThinking,
  streaming = false,
  entering = false,
}: {
  part: OpencodePart;
  showThinking: boolean;
  // True ONLY for the text part currently being written (last part of the last
  // assistant message while the turn runs). Adds `manta-streaming`, which owns
  // the per-block fade-in and the trailing caret in index.css. A primitive so
  // the memo chain is untouched; false everywhere else, so a settled transcript
  // never animates and never shows a caret.
  streaming?: boolean;
  // True when the parent message ARRIVED while the user was watching, so this
  // part should slide up as it appears (transcript-motion). This is where the
  // "cards slide in" effect actually lives: during a turn the parts of one
  // assistant message mount one at a time, so the PART is the unit that enters,
  // not the row. A loaded transcript passes false and stays still.
  entering?: boolean;
}) {
  const body = renderAssistantPart(part, showThinking, streaming);
  // The streaming text part is exempt: its markdown blocks already fade in
  // individually via `.manta-streaming > *`, and sliding the whole container on
  // top of that would animate the same content twice.
  //
  // The slide goes on a WRAPPER rather than the part's own root because the
  // roots are shared primitives (ToolCard, OutputWell) that deliberately expose
  // no className escape hatch. The wrapper is a plain block inside the row's
  // existing flex column, so it inherits the gap and changes no layout.
  if (body == null || !entering || streaming) return body;
  return <div className="manta-part-in">{body}</div>;
});

function renderAssistantPart(
  part: OpencodePart,
  showThinking: boolean,
  streaming: boolean,
): React.ReactElement | null {
  if (part.type === "text") {
    const text = (part.text ?? "").replace(/^\n+|\n+$/g, "");
    if (!text) return null;
    // Per the spec (.amsg) the assistant text is plain paragraphs at the
    // reading size with no leading gutter — the old `●` bullet column is gone
    // (BET-637), so the markdown body sits flush with the reading column.
    return (
      <div className={`break-words text-text${streaming ? " manta-streaming" : ""}`}>
        {renderMarkdown(text)}
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
            <span style={{ color: "var(--accent)", opacity: 0.6 }}>✻ </span>
          </span>
          <div className="flex-1 min-w-0 flex flex-col" style={{ gap: "var(--sp-1)" }}>
            <div className="text-text-faint not-italic">Thinking…</div>
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
  //
  // CARD, NOT A FLAT ROW. These three tail cases (patch / file / unrecognized
  // part) used to render as bare `⎿ …` mono rows on the page background —
  // the pre-BET-636 flat-list style. Next to a transcript where every machine
  // action is a bordered card, a mono row of absolute paths hanging under the
  // last card reads as tool output that escaped its container. They are the
  // same kind of thing as a tool call, so they get the same chrome.
  if (part.type === "patch") {
    const files = ((part as Record<string, unknown>).files as string[] | undefined) ?? [];
    return (
      <ToolCard
        tone="ok"
        name="Patch"
        arg={files.length === 0 ? undefined : `${files.length} file${files.length === 1 ? "" : "s"}`}
        copyText={files.join("\n")}
      >
        {files.length > 0 && (
          <OutputWell variant="attached">
            {files.map((f) => (
              <div key={f} className="whitespace-pre-wrap break-all text-text-muted">
                {f}
              </div>
            ))}
          </OutputWell>
        )}
      </ToolCard>
    );
  }

  // File reference (attached file in a prompt, or returned by a tool).
  if (part.type === "file") {
    const filename = String((part as Record<string, unknown>).filename ?? "");
    const mime = String((part as Record<string, unknown>).mime ?? "");
    return <ToolCard tone="ok" name="File" arg={`${filename || "(file)"}${mime ? ` · ${mime}` : ""}`} />;
  }

  return <ToolCard name={part.type} />;
}

// ===== Tool call rendering =====
//
// One `ToolCall` switches on `state.input.tool` and dispatches to per-tool
// body renderers. Each body is small enough to inline; the shared header —
// the status dot, tool name + argument and the status/diff meta — lives in the
// ToolCard primitive (BET-636).
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

  const status = state.status;
  const tone = status === "completed" ? "ok" : status === "error" ? "error" : "running";
  const summary =
    filediff && (filediff.additions || filediff.deletions)
      ? formatFileDiff(filediff.additions ?? 0, filediff.deletions ?? 0)
      : null;
  const running = status != null && status !== "completed";
  const metaNode =
    summary != null || running
      ? (
          <>
            {summary}
            {running && <span>{status}</span>}
          </>
        )
      : undefined;

  // What the header's copy button yields: the diff for an edit, otherwise the
  // tool's output (live `metadata.output` included, so a long-running command
  // is copyable mid-run). `task` is excluded — its body is a nested card whose
  // content is a whole child transcript, not one copyable blob.
  const copyText =
    rawTool === "task" ? "" : (diffText ?? resolveToolOutput(state));

  // Tool-call cards are collapsible and start collapsed: the body (diff /
  // output) is hidden behind the disclosure header until the user expands it.
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((v) => !v);

  return (
    <div className="flex flex-col" style={{ gap: "var(--block-gap)" }}>
      <ToolCard
        tone={tone}
        name={toolName}
        arg={state.title}
        meta={metaNode}
        copyText={copyText || undefined}
        expanded={expanded}
        onToggle={toggle}
      >
        {expanded && <ToolBody tool={rawTool} state={state} diffText={diffText} verbose={verbose} />}
      </ToolCard>
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

  // Per-tool body. Default fall-through is the generic output well.
  switch (tool) {
    case "read":
      return <ReadBody state={state} verbose={verbose} />;
    case "bash":
      return <BashBody state={state} verbose={verbose} />;
    case "glob":
      return <GlobBody state={state} />;
    case "grep":
      return <GrepBody state={state} verbose={verbose} />;
    // The checklist has exactly ONE renderer: the ActiveTodos card at the tail
    // of the transcript. `MessageRow`'s part filter already drops todowrite
    // parts, so this case is normally unreachable — it stays as a belt-and-
    // braces guard so that if the filter ever changes, a todowrite call falls
    // through to NOTHING rather than to the default generic-output well, which
    // would dump the raw todo JSON into the transcript under a second,
    // divergent treatment. (There used to be a real TodoWriteBody here that
    // drew the same list with a different glyph set — `◐ ☒ ☐` vs the card's
    // marks — and struck through completed items when the card did not.)
    case "todowrite":
    case "todo_write":
      return null;
    case "webfetch":
    case "web_fetch":
      return <WebFetchBody state={state} />;
    case "task":
      return <TaskCard state={state} />;
    default: {
      // Unknown tool — show output (if any) as a generic block. Falls back to
      // the live metadata.output stream while running so any long-running tool
      // surfaces progress, not just bash/grep/read.
      const output = resolveToolOutput(state);
      return output ? <ToolOutput output={output} /> : null;
    }
  }
}

