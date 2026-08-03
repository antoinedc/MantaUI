// ===== Per-tool body presenters =====
//
// Extracted from ToolCall.tsx (M0.5) to keep each module under ~500 LoC. These
// are the leaf presenters a tool call dispatches to: the generic output/diff
// renderers plus the per-tool bodies (Read/Bash/Glob/Grep/TodoWrite/WebFetch).
// None of them depend on the message-row rendering stack, so they import
// cleanly. ToolCall.tsx's ToolBody dispatcher wires them to tool names.

import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { resolveToolOutput } from "./chatUtils";
import { type ToolState } from "./chatShared";
import { CopyButton } from "./CopyButton";
import { OutputWell } from "./OutputWell";

// Renders a tool's `output` string. If it looks like a unified diff (starts
// with `--- ` or `@@`, or has multiple `@@` headers), each line is colored
// red/green/neutral. Otherwise we render it as a monospace code block,
// truncated to a sensible height by default.
export const ToolOutput = memo(function ToolOutput({
  output,
  copy = false,
}: {
  output: string;
  /**
   * Render a copy affordance over the well. OFF by default: inside a tool card
   * the copy button lives in the card HEADER (ToolCard's `copyText`), so a
   * second one floating over the body would be a duplicate. Only the callers
   * that render this well WITHOUT a card header around it (the subagent card's
   * "Result:" block) turn it on.
   */
  copy?: boolean;
}) {
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
  // Plain code/text output — recessed well (12.5px mono), scroll on overflow.
  //
  // EXACTLY ONE scroll container. The well used to be given `maxHeight` (which
  // is `max-h-64 overflow-y-auto`) while the `<pre>` inside it declared the
  // same cap again, so the card carried two nested vertical scrollbars over
  // identical content — and because a box with `overflow-y: auto` computes
  // `overflow-x` to `auto` too, the inner `<pre>` also duplicated the well's
  // horizontal scroller. The `<pre>` keeps the cap because it is the element
  // the pin-to-bottom effect above measures; the well must therefore NOT be
  // asked for one. Do not re-add `maxHeight` here.
  return (
    <div className="relative">
      {copy && (
        <CopyButton
          text={output}
          className="absolute top-1 right-1 z-10 text-meta text-text-faint hover:text-text px-1 rounded-xs"
        />
      )}
      <OutputWell variant="attached">
        <pre
          ref={preRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
          className={`max-h-64 overflow-y-auto${copy ? " pr-8" : ""}`}
        >
          <code>{output}</code>
        </pre>
      </OutputWell>
    </div>
  );
});

// Read: collapsed to a one-line summary by default — "Read N lines (ctrl+o)"
// — because most Read calls aren't worth scrolling past. When verbose, render
// the actual content (opencode's output is already line-numbered).
export function ReadBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const output = resolveToolOutput(state);
  const m = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  const body = m ? m[1] : output;
  const lineCount = body.split("\n").filter((l) => l.length > 0).length;
  if (!verbose) {
    return <CollapsedNotice>Read {lineCount} line{lineCount === 1 ? "" : "s"} (ctrl+o to expand)</CollapsedNotice>;
  }
  return <ConnectorOutput body={body} maxLines={Infinity} />;
}

// The one-line "this is collapsed, ctrl+o for the rest" body a tool card shows
// instead of its output (Read, Grep). It lives in the SAME recessed well as
// real output (BET-636's `.tool-b`) so a collapsed card and an expanded one
// have the same silhouette — before this it was a bare row flush against the
// card's inner edge, sharing neither the header's `px-3` nor the well's
// surface, which is what made the card look unfinished.
function CollapsedNotice({ children }: { children: ReactNode }) {
  return (
    <OutputWell variant="attached">
      <div className="whitespace-pre-wrap text-text-quiet">{children}</div>
    </OutputWell>
  );
}

// Bash: output rendered in the tool card's recessed well under the header.
// The command itself is already shown in the header via state.title. Output is
// truncated to 5 lines by default; verbose expands.
export function BashBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  // Prefer the final output; while running, fall back to the live
  // metadata.output stream so a long command tails its latest lines instead
  // of an empty "· running" body. Same ctrl+o (verbose) expand applies.
  const output = resolveToolOutput(state);
  if (!output) return null;
  return <ConnectorOutput body={output} maxLines={verbose ? Infinity : 5} />;
}

// Shared renderer for a tool's line-oriented output (Bash, and Read/Grep when
// expanded). When the body is taller than maxLines we keep the LATEST lines:
// oldest scroll up out of view behind the "+N earlier lines" notice and the
// newest line stays at the bottom. This matches how a terminal tails a
// long-running command's output.
//
// It renders inside the card's recessed OutputWell (BET-636's `.tool-b`), so
// the output shares the header's `px-3` inset, sits on the inset surface, and
// is separated from the header by the well's top border.
//
// THE ⎿ GUTTER IS GONE, deliberately. It came from the pre-card transcript
// where every tool call was a flat bullet list on the page background and the
// corner glyph was the only thing tying output to its header. Inside a bordered
// card the well already does that job, so the glyph plus its 16px column — a
// column that held a single character on ONE row and a blank on every other —
// just pushed every line out of alignment with the header above it and left a
// ragged left edge. Do not reintroduce it here; the flat-list `⎿` in
// ToolCall.tsx (patch/file parts) and ActiveTodos is a different, still-flat
// context and keeps its glyph.
function ConnectorOutput({ body, maxLines }: { body: string; maxLines: number }) {
  const lines = body.split("\n");
  const visibleCount = Math.min(lines.length, maxLines);
  const hidden = lines.length - visibleCount;
  // Take the tail (latest lines), not the head.
  const visible = lines.slice(lines.length - visibleCount);
  return (
    <OutputWell variant="attached">
      {hidden > 0 && (
        <div className="text-text-quiet">
          … {hidden} earlier line{hidden === 1 ? "" : "s"} (ctrl+o to expand)
        </div>
      )}
      <div className="text-text-muted">
        {visible.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {l || " "}
          </div>
        ))}
      </div>
    </OutputWell>
  );
}

// Glob: output is newline-separated paths. Show count + first N.
export function GlobBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const output = state.output ?? "";
  const paths = output.split("\n").filter((l) => l.length > 0);
  return (
    <CollapsibleLines
      lines={paths}
      maxLines={10}
      header={
        pattern ? (
          <div className="text-text-quiet">
            pattern <span className="text-text-muted">{pattern}</span> · {paths.length} match
            {paths.length === 1 ? "" : "es"}
          </div>
        ) : null
      }
    />
  );
}

// Grep: collapsed to a one-line summary by default. When verbose, show hits.
export function GrepBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
  const input = state.input ?? {};
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const output = resolveToolOutput(state);
  const lines = output.split("\n").filter((l) => l.length > 0);
  if (!verbose) {
    return (
      <CollapsedNotice>
        {pattern ? <>Searched <span className="text-accent">{pattern}</span> · </> : null}
        {lines.length} hit{lines.length === 1 ? "" : "s"} (ctrl+o to expand)
      </CollapsedNotice>
    );
  }
  return <ConnectorOutput body={lines.join("\n")} maxLines={Infinity} />;
}

// TodoWrite: input.todos is an array of {content, status, ...}. Render as a
// checklist with status icons. Status values seen: "pending", "in_progress",
// "completed", "cancelled".
export function TodoWriteBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const todos = (input.todos as Array<Record<string, unknown>> | undefined) ?? [];
  if (todos.length === 0) return null;
  return (
    <div className="text-meta space-y-px">
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
            <span className="select-none shrink-0" style={{ color: status === "in_progress" ? "var(--warn)" : undefined }}>
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
export function WebFetchBody({ state }: { state: ToolState }) {
  const input = state.input ?? {};
  const url = typeof input.url === "string" ? input.url : "";
  const output = resolveToolOutput(state);
  return (
    <CollapsibleLines
      lines={output ? output.split("\n") : []}
      maxLines={15}
      header={
        url ? (
          <div className="break-all text-text-quiet">
            <span className="select-none">→ </span>
            <span style={{ color: "var(--accent-tx)" }}>{url}</span>
          </div>
        ) : null
      }
    />
  );
}

// Collapsible line list with an optional header line — Glob's `pattern … · N
// matches` and WebFetch's `→ url`, then the payload, then a "+N more" button.
//
// It draws NO box of its own. It used to (`bg-bg-soft border rounded-xs`),
// which since BET-636 meant a bordered box sitting flush inside a bordered
// card — two nested frames with no gap between them. The card's own recessed
// well (`.tool-b`) is the surface, so this renders into it and the expander is
// a divider row inside that same well.
function CollapsibleLines({
  lines,
  maxLines,
  header,
}: {
  lines: string[];
  maxLines: number;
  header?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (lines.length === 0 && header == null) return null;
  const overflow = lines.length > maxLines && !expanded;
  const shown = overflow ? lines.slice(0, maxLines) : lines;
  const hiddenCount = lines.length - maxLines;
  return (
    <OutputWell variant="attached">
      {header}
      <div className="text-text-muted">
        {shown.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {l || " "}
          </div>
        ))}
      </div>
      {overflow && (
        <button
          onClick={() => setExpanded(true)}
          className="block w-full text-left pt-1 text-text-quiet hover:text-text"
        >
          + {hiddenCount} more line{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </OutputWell>
  );
}

// Unified diff: renders inside the recessed OutputWell (12.5px mono) beneath a
// tool card header. No card of its own — the well's top border separates it
// from the header strip. Background blocks are saturated green/red for proper
// contrast; the copy is the bright cream `text-text` from the well.
//
// Line numbers come from `@@ -A,B +C,D @@` parsed per hunk; `+` and context
// use NEW line numbers, `-` uses OLD.
export function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split("\n");
  let oldLine = 0;
  let newLine = 0;
  return (
    <OutputWell variant="attached">
      {/* `w-max min-w-full` is what makes a +/− row's colored background span
          the WHOLE line, not just the visible viewport. The well scrolls
          horizontally; without this the rows are block-level children sized to
          the well's client width, so scrolling right ran past the end of the
          green/red block and the rest of the line sat on the bare well.
          `w-max` sizes the wrapper to the widest line so every row fills it;
          `min-w-full` keeps short diffs flush to the well's full width. Do NOT
          put `max-w-full` back here — it re-clamps to the viewport. */}
      <div className="leading-snug w-max min-w-full">
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
          bg = "bg-[var(--diff-add)]";
          signCls = "text-ok";
          lnCls = "text-ok/70";
          sign = "+";
          body = line.slice(1);
          ln = newLine++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          bg = "bg-[var(--diff-del)]";
          signCls = "text-danger";
          lnCls = "text-danger/70";
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
              <span className={`select-none shrink-0 text-right pr-2 w-[30px] ${lnCls}`}>
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
    </OutputWell>
  );
}
