// ===== Per-tool body presenters =====
//
// Extracted from ToolCall.tsx (M0.5) to keep each module under ~500 LoC. These
// are the leaf presenters a tool call dispatches to: the generic output/diff
// renderers plus the per-tool bodies (Read/Bash/Glob/Grep/TodoWrite/WebFetch).
// None of them depend on the message-row rendering stack, so they import
// cleanly. ToolCall.tsx's ToolBody dispatcher wires them to tool names.

import { memo, useLayoutEffect, useRef, useState } from "react";
import { resolveToolOutput } from "./chatUtils";
import { CLAUDE_ORANGE, type ToolState } from "./chatShared";

// Renders a tool's `output` string. If it looks like a unified diff (starts
// with `--- ` or `@@`, or has multiple `@@` headers), each line is colored
// red/green/neutral. Otherwise we render it as a monospace code block,
// truncated to a sensible height by default.
export const ToolOutput = memo(function ToolOutput({ output }: { output: string }) {
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

// Read: collapsed to a one-line summary by default — "Read N lines (ctrl+o)"
// — because most Read calls aren't worth scrolling past. When verbose, render
// the actual content (opencode's output is already line-numbered).
export function ReadBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
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
export function BashBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
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
export function GlobBody({ state }: { state: ToolState }) {
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
export function GrepBody({ state, verbose }: { state: ToolState; verbose: boolean }) {
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
export function TodoWriteBody({ state }: { state: ToolState }) {
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
export function WebFetchBody({ state }: { state: ToolState }) {
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
      <pre className="px-2 py-1 overflow-x-auto max-w-full whitespace-pre">
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
      <div className="px-2 py-1 overflow-x-auto max-w-full">
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
export function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split("\n");
  let oldLine = 0;
  let newLine = 0;
  return (
    <div className="font-mono leading-snug my-1 overflow-x-auto max-w-full">
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
