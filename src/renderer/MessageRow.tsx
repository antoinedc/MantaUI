// ===== Message / transcript row rendering =====
//
// Extracted from ChatPanel.tsx (M0.5). Renders one transcript row and the
// small status/todo widgets that sit around the running turn:
//   - MessageRow: user bar vs. assistant part list, with turn-duration and
//     truncation footers.
//   - UserCommandBar: collapsed `/name args` pill for slash-command turns.
//   - ActiveTodos: the TodoWrite checklist card, mounted once at the tail of
//     the transcript by Transcript.tsx (running or idle).
//
// AssistantPart lives in ./ToolCall; importing it here (and MessageRow back
// there for subagent transcripts) forms an intentional, render-time-only
// module cycle.

import { memo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { OpencodeMessage } from "../shared/types";
import {
  describeTruncation,
  formatClockTime,
  formatDuration,
  formatTokens,
  formatHiddenTodosSummary,
  selectVisibleTodos,
  summarizeTodoProgress,
  todoStatusOf,
  type TodoStatus,
  type TruncationKind,
} from "./chatUtils";
import { pastVerbFor } from "./chatShared";
import { AssistantPart } from "./ToolCall";
import { MantaMark } from "./MantaLoader";
import { MessageBubble } from "./MessageBubble";

// ===== Active todos =====
//
// The TodoWrite checklist, rendered at the TAIL of the transcript inside the
// scroll container (see Transcript.tsx) — it scrolls with the conversation
// rather than sitting in a shrink-0 row above the composer. As the assistant
// marks items in_progress/completed and updates the list via subsequent
// TodoWrite calls, this re-renders automatically.
//
// The card replaces the original terminal-transcript treatment (a `⎿` gutter
// glyph plus `■ ✓ ☐ ⊘` box-drawing characters). Three reasons that had to go:
// the corner glyph implied a parent tool call that does not exist; the glyphs
// render at a different size and baseline in every font, and never matched the
// SwiftUI client's SF Symbols; and nothing in the row communicated PROGRESS —
// you had to count ticks. The shell (`rounded-sm border bg-bg-elev`) is the
// same one RetryCard / CompactionCard use, so the checklist now reads as one
// of the panel's cards instead of as leaked tool output.
//
// Status marks are CSS + one inline SVG rather than text glyphs, so they are
// font-independent and centre exactly: every mark is the SAME 12px circle
// whose content is centred by `inline-flex items-center justify-center`,
// which is what keeps the check optically inside the disc at any zoom.

function TodoMark({ status }: { status: TodoStatus }) {
  // One 12px disc for all four states; only the fill/border/child changes.
  // `justify-center` + `items-center` is doing the centring for BOTH the
  // check and the in-progress pip — no magic offsets to drift.
  const base =
    "inline-flex items-center justify-center w-3 h-3 shrink-0 rounded-full border";
  if (status === "completed") {
    return (
      <span
        className={base}
        style={{ borderColor: "var(--ok)", backgroundColor: "var(--ok)" }}
        aria-hidden
      >
        <svg viewBox="0 0 10 10" className="w-2 h-2" fill="none">
          <path
            d="M2 5.2 4.1 7.2 8 2.9"
            stroke="var(--canvas)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span
        className={base}
        style={{
          borderColor: "var(--warn)",
          boxShadow: "0 0 0 3px var(--warn-bg)",
        }}
        aria-hidden
      >
        <span
          className="w-1 h-1 rounded-full"
          style={{ backgroundColor: "var(--warn)" }}
        />
      </span>
    );
  }
  if (status === "cancelled") {
    // Dashed + empty: settled, but deliberately not a success mark.
    return (
      <span
        className={`${base} border-dashed border-border-subtle`}
        aria-hidden
      />
    );
  }
  return <span className={`${base} border-border-strong`} aria-hidden />;
}

export const ActiveTodos = memo(function ActiveTodos({
  todos,
  onDismiss,
}: {
  todos: Array<Record<string, unknown>>;
  onDismiss?: () => void;
}) {
  // Render at most VISIBLE_TODOS_CAP items inline. Order: current
  // (in_progress) → pending → done so the row the model is actively
  // working on is always on screen even when the list grows past the cap.
  // Overflow collapses into a single faint summary row at the bottom:
  // "+ N pending & M done" / "+ N pending" / "+ M done".
  const { visible, hiddenPending, hiddenDone } = selectVisibleTodos(todos);
  const summary = formatHiddenTodosSummary(hiddenPending, hiddenDone);
  // Progress counts the WHOLE list, not the visible slice — the bar exists to
  // report the part the 5-row cap hides.
  const progress = summarizeTodoProgress(todos);
  return (
    <div className="rounded-sm border border-border-subtle bg-bg-elev overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span className="text-micro uppercase text-text-faint">Todo</span>
        <span
          className="ml-auto text-meta tabular-nums"
          style={{
            color: progress.allSettled ? "var(--ok)" : "var(--tx4)",
          }}
        >
          {progress.label}
        </span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            title="Dismiss todo list"
            aria-label="Dismiss todo list"
            className="text-text-faint hover:text-text transition-colors -mr-1 rounded-xs p-1 hover:bg-bg-soft"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* Two-segment progress rail. Settled runs green, the in-flight item
          runs amber; the remainder is the track showing through. 2px so it
          reads as a rule under the header rather than as a control. */}
      <div className="flex h-0.5 bg-border-subtle" aria-hidden>
        <span
          className="h-full bg-ok"
          style={{ width: `${progress.settledPct}%` }}
        />
        <span
          className="h-full bg-warn"
          style={{ width: `${progress.activePct}%` }}
        />
      </div>
      <div className="flex flex-col gap-1 px-3 pt-2 pb-2 text-label">
        {visible.map((t, i) => {
          const status = todoStatusOf(t);
          const textCls =
            status === "in_progress"
              ? "text-text font-semibold"
              : status === "completed"
                ? "text-text-quiet"
                : status === "cancelled"
                  ? "text-text-quiet line-through"
                  : "text-text-muted";
          return (
            <div key={i} className="flex items-start gap-2">
              {/* mt-px lifts the 12px disc onto the 13px/1.4 text's optical
                  centre for the first line of a wrapping row. */}
              <span className="mt-px shrink-0">
                <TodoMark status={status} />
              </span>
              <span
                className={`flex-1 min-w-0 max-w-full whitespace-pre-wrap break-words ${textCls}`}
              >
                {String(t.content ?? "")}
              </span>
            </div>
          );
        })}
        {summary && <div className="text-meta text-text-quiet">{summary}</div>}
      </div>
    </div>
  );
});

const UserCommandBar = memo(function UserCommandBar({
  name,
  args,
  expandedText,
}: {
  name: string;
  args: string;
  expandedText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const trimmedArgs = args.trim();
  return (
    <div className="-mx-4 px-4 py-px bg-bg-soft">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-baseline gap-2 w-full text-left hover:bg-bg-elev/40 -mx-1 px-1 rounded-xs transition-colors"
        title={expanded ? "Collapse" : "Show expanded prompt"}
      >
        <span className="text-text-quiet select-none shrink-0">›</span>
        <span className="text-text-quiet shrink-0 w-3 inline-flex items-center">
          {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        </span>
        <span className="font-mono text-text shrink-0">/{name}</span>
        {trimmedArgs && (
          <span className="font-mono text-text-muted truncate">{trimmedArgs}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-6 pl-2 border-l border-border whitespace-pre-wrap break-words text-text-muted text-code font-mono max-w-full">
          {expandedText}
        </div>
      )}
    </div>
  );
});

// React.memo guards against the dominant per-keystroke cost: the chat
// input lives in ChatPanel and forces a re-render on every keystroke,
// which (without memo) cascades to re-rendering every MessageRow in the
// transcript — re-running react-markdown + Prism for every assistant
// message and producing visible input lag past ~50 messages. All props
// passed in messages.map() are either primitives or stable references
// (msg from a stable identity; turnInfo / commandInfo / finishBy*
// Maps are memoized at panel scope). The default shallow-equals check
// is what we want — no custom comparator needed.
export const MessageRow = memo(function MessageRow({
  msg,
  showThinking,
  turnDurationMs,
  turnTokens,
  verbSeedId,
  truncation,
  commandInfo,
  entering = false,
}: {
  msg: OpencodeMessage;
  showThinking: boolean;
  // Set ONLY on the final assistant message of a turn — duration spans the
  // whole turn (all consecutive assistant messages since the last user msg).
  // Intermediate messages get null so they don't show a footer at all.
  turnDurationMs: number | null;
  // Tokens produced by this whole turn (`output + reasoning`, summed across
  // every assistant step). Appended to the duration footer. Transcript-derived,
  // so it survives refresh. null/0 → omitted.
  turnTokens: number | null;
  // Seed id the footer verb is derived from — the turn's FIRST assistant
  // message, so the live working-row verb (seeded the same way) and the
  // finished-footer verb agree for one turn.
  verbSeedId: string | null;
  // Per-message truncation classification from finishByMessageId. Drives the
  // "truncated" badge appended to the turn-duration footer (or as a
  // standalone footer when there's no duration, e.g. mid-turn assistant
  // messages within a multi-step turn that hit max_tokens). null = no
  // truncation, no badge.
  truncation: TruncationKind | null;
  // Slash-command provenance from commandByMessageId. When set on a user
  // message, the row shows a collapsed `/name args` pill with an expand
  // chevron instead of the full expanded template body.
  commandInfo: { name: string; arguments: string } | null;
  // True when this message ARRIVED while the user was watching, as opposed to
  // being part of the transcript they loaded (transcript-motion). Decided once
  // in Transcript by `updateEntryMotion` and sticky for the row's whole life —
  // an earlier version recomputed it per render, which tore the animation's
  // class off one frame after it started and made the effect invisible.
  //
  // The row itself never animates: the user bubble pops (MessageBubble) and an
  // assistant row's PARTS slide in individually (AssistantPart), because during
  // a live turn those parts appear one at a time and sliding the container
  // would mean animating a box that is already on screen. Primitive prop, so
  // the MessageRow memo chain is untouched.
  entering?: boolean;
}) {
  const isUser = msg.info.role === "user";

  // Subtle wall-clock timestamp for each message/action. Sourced from the
  // message's own time.created — no new prop, so the MessageRow memo chain is
  // untouched.
  //
  // IN THE GUTTER, level with the row's first line — not above it. Two earlier
  // shapes were wrong in opposite ways: an absolute `-top-[18px]` overlay read
  // as a glyph stuck to the top edge of the following card, and an in-flow
  // label above the row cost every turn a whole extra line of height for
  // something you glance at once. Positioning it OUT of the reading column
  // costs no layout at all, which is why `--transcript-inset` is wider than
  // the composer's: the margin is the stamp's home. `right-full` / `left-full`
  // means the offset is derived from the content edge, not a magic number that
  // has to be kept in sync with the inset.
  //
  // Hover-gated on purpose. A timestamp on every row, always on, is a column
  // of numbers down the side of a conversation nobody asked to read; the
  // information is worth having on demand, not worth the permanent noise.
  //
  // Type: sans (it is chrome, not code — the transcript's mono is reserved for
  // commands, paths and output), 10px, tabular so the digits don't jitter.
  const ts = formatClockTime(msg.info.time?.created);
  const stampedRow = (children: React.ReactNode) => (
    <div className="group relative" data-message-id={msg.info.id}>
      {ts && (
        <span
          className={
            "pointer-events-none absolute select-none whitespace-nowrap " +
            "text-[10px] leading-none tabular-nums text-text-faint " +
            "opacity-0 group-hover:opacity-100 transition-opacity " +
            // The offset centres the 10px stamp on the row's FIRST LINE, and
            // that line sits at a different depth per side: a user row always
            // opens with the bubble (1px border + 11px padding + a 23px line
            // box → centre ≈ 23px), while an assistant row opens with prose
            // (centre ≈ 12px) or a tool-card header (centre ≈ 16px). One
            // number cannot serve both, so each side gets its own.
            (isUser ? "left-full ml-2 top-[18px]" : "right-full mr-2 top-[8px]")
          }
          aria-hidden
        >
          {ts}
        </span>
      )}
      {children}
    </div>
  );

  // User message: the spec draws a right-aligned pill bubble capped at 88%
  // of the reading column (`.umsg`, a LOCKED spec decision — Q7). Rendered
  // through the MessageBubble primitive, which owns the chrome.
  // FileParts attached to the message render as chips ABOVE the bubble, in the
  // same flex justify-end flow so they right-align with it.
  if (isUser) {
    const text = msg.parts
      .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
      .map((p) => p.text ?? "")
      .join("\n")
      .replace(/\s+$/, "");
    const fileParts = msg.parts.filter((p) => p.type === "file");
    if (!text && fileParts.length === 0) return null;
    return stampedRow(
      <div className="flex flex-col" style={{ gap: "var(--block-gap)" }}>
        {fileParts.length > 0 && (
          <div className="flex justify-end">
            <div className="flex flex-wrap justify-end gap-1 text-label font-mono">
              {fileParts.map((p) => {
                const raw = p as Record<string, unknown>;
                const url = typeof raw.url === "string" ? raw.url : "";
                const filename =
                  (typeof raw.filename === "string" && raw.filename) ||
                  url.split("/").pop() ||
                  "file";
                return (
                  <span
                    key={p.id}
                    className="rounded-sm border border-border-strong px-2 py-px bg-bg-elev text-text-muted truncate max-w-[260px]"
                    title={url}
                  >
                    {filename}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {text && (
          commandInfo ? (
            <UserCommandBar
              name={commandInfo.name}
              args={commandInfo.arguments}
              expandedText={text}
            />
          ) : (
            <MessageBubble entering={entering}>{text}</MessageBubble>
          )
        )}
      </div>,
    );
  }

  // Assistant: render each part on its own. Per the spec (.amsg) the text is
  // plain paragraphs at the reading size with no leading gutter; the bullet
  // column no longer exists (BET-637). todowrite invocations are filtered out —
  // the latest checklist already renders once as the ActiveTodos card at the
  // tail of the transcript, so inlining each call too would repeat the same
  // list for every turn that touches todos.
  const visibleParts = msg.parts.filter((p) => {
    if (p.type === "text") return !p.synthetic && !p.ignored && (p.text ?? "").length > 0;
    if (p.type === "step-start" || p.type === "step-finish") return false;
    if (p.type === "tool") {
      const tool = String((p as Record<string, unknown>).tool ?? "");
      if (tool === "todowrite" || tool === "todo_write") return false;
    }
    return true;
  });
  if (visibleParts.length === 0) return null;

  return stampedRow(
    <div className="flex flex-col" style={{ gap: "var(--block-gap)" }}>
      {visibleParts.map((p) => (
        <AssistantPart
          key={p.id}
          part={p}
          showThinking={showThinking}
          // Slide this part in only when the whole message is new to the user.
          // A loaded transcript passes `entering=false`, so history is still.
          entering={entering}
        />
      ))}
      {/* Turn-level duration footer — only on the FINAL assistant message */}
      {/* of a turn. Vertical spacing is owned by the turn wrapper's */}
      {/* `gap: var(--block-gap)` (BET-411) — no per-child mt/mb. The old */}
      {/* -ml-[8px] nudge is gone with the assistant bullet gutter (BET-637). */}
      {/* Truncation badge piggy-backs onto the same line when both are set */}
      {/* (most common case: end-of-turn truncation). For mid-turn step */}
      {/* truncations there's no duration footer, so the badge renders on */}
      {/* its own row using the same baseline style. */}
      {/* Sans, not mono: this is a sentence about the turn ("Ruminated for
          1m44s · 12.4k output"), not a command or a path. In mono it read as
          terminal output that had leaked into the transcript. */}
      {(turnDurationMs != null || truncation != null) && (
        <div className="text-label text-text-muted">
          {turnDurationMs != null && (
            <>
              {/* The finished turn keeps the mark the working row was built
                  around, held still — the arcs are what meant "in flight". */}
              <MantaMark />{" "}
              {pastVerbFor(verbSeedId ?? msg.info.id)} for {formatDuration(turnDurationMs)}
              {turnTokens != null && turnTokens > 0 && (
                <>
                  {" · "}
                  {formatTokens(turnTokens)}
                </>
              )}
            </>
          )}
          {truncation != null && (
            <>
              {turnDurationMs != null && (
                <span className="text-text-quiet mx-2">·</span>
              )}
              {/* File-chip-style pill tinted with the warn token — visually */}
              {/* coherent with CompactionCard / RetryCard / QuestionCard, */}
              {/* the existing "something needs your attention" color. */}
              <span
                className="rounded-sm border px-2 py-px text-label inline-flex items-center gap-1"
                style={{
                  borderColor: "rgb(var(--warn-rgb) / 0.33)",
                  backgroundColor: "var(--warn-bg)",
                  color: "var(--warn)",
                }}
                title={describeTruncation(truncation).hint}
              >
                <span aria-hidden>⚠</span>
                {describeTruncation(truncation).label}
              </span>
            </>
          )}
        </div>
      )}
    </div>,
  );
});
