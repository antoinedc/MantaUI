// ===== Message / transcript row rendering =====
//
// Extracted from ChatPanel.tsx (M0.5). Renders one transcript row and the
// small status/todo widgets that sit around the running turn:
//   - MessageRow: user bar vs. assistant part list, with turn-duration,
//     truncation, and persistent-todo footers.
//   - UserCommandBar: collapsed `/name args` pill for slash-command turns.
//   - ActiveTodos: the pinned TodoWrite checklist (under the running
//     indicator while live; under the last assistant message when idle).
//   - RunningIndicator: the ✻ spinner + elapsed / token line.
//
// AssistantPart lives in ./ToolCall; importing it here (and MessageRow back
// there for subagent transcripts) forms an intentional, render-time-only
// module cycle.

import { memo, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { OpencodeMessage } from "../shared/types";
import {
  describeTruncation,
  formatClockTime,
  formatDuration,
  formatTokens,
  formatHiddenTodosSummary,
  selectVisibleTodos,
  type TruncationKind,
} from "./chatUtils";
import {
  pastVerbFor,
  SPINNER_VERBS,
  type TokenUsage,
} from "./chatShared";
import { AssistantPart } from "./ToolCall";
import { MessageBubble } from "./MessageBubble";
import { nowMs } from "./clock";

export function RunningIndicator({ tokens, atBottom }: { tokens: TokenUsage | null; atBottom: boolean }) {
  // Tick once per second to drive the elapsed-time re-render.
  const [, setTick] = useState(0);
  // `nowMs()` returns the demo mode's deterministic clock when the hero
  // video is rendering (see src/renderer/clock.ts). Real apps fall back to
  // Date.now(). This is the *reference* timestamp the elapsed-time label
  // measures against, so two consecutive renders of the same frame use
  // the same value (no `Date.now()` label drift).
  const startRef = useRef<number>(nowMs());
  // Pick a verb once per indicator mount so it doesn't shuffle between
  // renders.
  const verb = useRef<string>(
    SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)],
  );

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = nowMs() - startRef.current;

  const outTokens = tokens != null ? tokens.output + tokens.reasoning : 0;

  // pt-0 + pb-3: the scroll container above already has pb-3 (12px), so
  // dropping the indicator's top padding gives 12px between the last
  // message and the ✻ glyph. pb-3 matches it on the other side (12px
  // between context bar / ✻ line and the input divider). No horizontal
  // padding: the indicator sits inside a MeasureColumn (padded 28px) so it
  // shares the reading column's left edge with the transcript (BET-637).
  return (
    <div className={`shrink-0 pb-3 text-meta font-mono ${atBottom ? "pt-0" : "pt-1"}`}>
      <div>
        <span style={{ color: "var(--accent)" }}>
          <span className="inline-block animate-pulse">✻</span>{" "}
          {verb.current}…
        </span>{" "}
        <span className="text-text-faint">
          ({formatDuration(elapsedMs)}
          {outTokens > 0 && <> · ↓ {formatTokens(outTokens)}</>})
        </span>
      </div>
    </div>
  );
}

// ===== Active todos =====
//
// Pinned right under the running indicator while a turn is in flight, showing
// the most recent TodoWrite tool's checklist. As the assistant marks items
// in_progress/completed and updates the list via subsequent TodoWrite calls,
// this re-renders automatically (messages refetch on message.part.updated).
//
// Visible items show their per-status icon (same as the inline TodoWriteBody);
// completed items collapse to a count summary so the active focus stays
// dominant when the list grows.

export const ActiveTodos = memo(function ActiveTodos({ todos }: { todos: Array<Record<string, unknown>> }) {
  // Render at most VISIBLE_TODOS_CAP items inline. Order: current
  // (in_progress) → pending → done so the row the model is actively
  // working on is always on screen even when the list grows past the cap.
  // Overflow collapses into a single faint summary row at the bottom:
  // "+ N pending & M done" / "+ N pending" / "+ M done".
  // Icons: in_progress = filled orange square, pending = empty square,
  // completed = green ✓ in dim text, cancelled = ⊘ struck through.
  const { visible, hiddenPending, hiddenDone } = selectVisibleTodos(todos);
  const summary = formatHiddenTodosSummary(hiddenPending, hiddenDone);
  const lastVisibleIdx = visible.length - 1;
  return (
    <div className="pb-2 text-label">
      {visible.map((t, i) => {
        const content = String(t.content ?? "");
        const status = String(t.status ?? "pending");
        const isInProgress = status === "in_progress";
        const isCompleted = status === "completed";
        const isCancelled = status === "cancelled";

        let icon = "☐";
        let iconColor: string | undefined;
        let textCls = "text-text-muted";
        if (isInProgress) {
          icon = "■";
          iconColor = "var(--warn)";
          textCls = "text-text font-semibold";
        } else if (isCompleted) {
          icon = "✓";
          iconColor = "var(--ok)";
          textCls = "text-text-faint";
        } else if (isCancelled) {
          icon = "⊘";
          textCls = "text-text-faint line-through opacity-60";
        }
        // Show the ⎿ corner only on the very first row of the card. The
        // summary row (when present) replaces the last todo row's leading
        // slot with a blank so the gutter stays aligned.
        return (
          <div key={i} className="flex">
            <span className="select-none w-5 shrink-0 text-text-faint">
              {i === 0 ? "⎿" : " "}
            </span>
            <span
              className="select-none w-4 shrink-0"
              style={{ color: iconColor }}
            >
              {icon}
            </span>
            <span className={`flex-1 min-w-0 whitespace-pre-wrap break-words ${textCls}`}>
              {content}
            </span>
          </div>
        );
      })}
      {summary && (
        <div className="flex">
          <span className="select-none w-5 shrink-0 text-text-faint">
            {lastVisibleIdx < 0 ? "⎿" : " "}
          </span>
          <span className="select-none w-4 shrink-0" />
            <span className="flex-1 min-w-0 text-text-faint">{summary}</span>
        </div>
      )}
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
        <div className="mt-1 ml-6 pl-2 border-l border-border whitespace-pre-wrap break-words text-text-muted text-code font-mono">
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
// Maps are memoized at panel scope; persistentTodos comes from
// memoized activeTodos). The default shallow-equals check is what we
// want — no custom comparator needed.
export const MessageRow = memo(function MessageRow({
  msg,
  showThinking,
  turnDurationMs,
  persistentTodos,
  truncation,
  commandInfo,
}: {
  msg: OpencodeMessage;
  showThinking: boolean;
  // Set ONLY on the final assistant message of a turn — duration spans the
  // whole turn (all consecutive assistant messages since the last user msg).
  // Intermediate messages get null so they don't show a footer at all.
  turnDurationMs: number | null;
  // Set ONLY on the LAST assistant message in the entire transcript when not
  // running — renders the latest TodoWrite list permanently below the footer.
  // Same data ChatPanel pins under the running indicator while a turn is live.
  persistentTodos: Array<Record<string, unknown>> | null;
  // Per-message truncation classification from finishByMessageId. Drives
  // the "truncated" badge appended to the turn-duration footer (or as a
  // standalone footer when there's no duration, e.g. mid-turn assistant
  // messages within a multi-step turn that hit max_tokens). null = no
  // truncation, no badge.
  truncation: TruncationKind | null;
  // Slash-command provenance from commandByMessageId. When set on a user
  // message, the row shows a collapsed `/name args` pill with an expand
  // chevron instead of the full expanded template body.
  commandInfo: { name: string; arguments: string } | null;
}) {
  const isUser = msg.info.role === "user";

  // Subtle wall-clock timestamp for each message/action. Sourced from the
  // message's own time.created — no new prop, so the MessageRow memo chain is
  // untouched. It sits at the row's top-left, absolutely positioned INSIDE the
  // content box (left-0, not overflowing into the transcript's px-4 padding —
  // that zone is clipped by the scroller's overflow). It stays out of the way
  // (faint, fades in on hover) and never shifts the message layout.
  const ts = formatClockTime(msg.info.time?.created);
  const stampedRow = (children: React.ReactNode) => (
    <div className="group relative">
      {ts && (
        <span
          className={`pointer-events-none absolute ${isUser ? "right-0" : "left-0"} -top-2 z-10 select-none whitespace-nowrap text-meta font-mono leading-none tabular-nums text-text-faint opacity-0 group-hover:opacity-60 transition-opacity`}
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
            <MessageBubble>{text}</MessageBubble>
          )
        )}
      </div>,
    );
  }

  // Assistant: render each part on its own. Per the spec (.amsg) the text is
  // plain paragraphs at the reading size with no leading gutter; the bullet
  // column no longer exists (BET-637). todowrite invocations are filtered out —
  // the latest checklist is already pinned under the running indicator + final
  // assistant footer (ActiveTodos), so inlining each call too would duplicate
  // the same list multiple times for any turn that updates todos.
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
        <AssistantPart key={p.id} part={p} showThinking={showThinking} />
      ))}
      {/* Turn-level duration footer — only on the FINAL assistant message */}
      {/* of a turn. Vertical spacing is owned by the turn wrapper's */}
      {/* `gap: var(--block-gap)` (BET-411) — no per-child mt/mb. The old */}
      {/* -ml-[8px] nudge is gone with the assistant bullet gutter (BET-637). */}
      {/* Truncation badge piggy-backs onto the same line when both are set */}
      {/* (most common case: end-of-turn truncation). For mid-turn step */}
      {/* truncations there's no duration footer, so the badge renders on */}
      {/* its own row using the same baseline style. */}
      {(turnDurationMs != null || truncation != null) && (
        <div className="text-code font-mono text-text-muted">
          {turnDurationMs != null && (
            <>
              <span style={{ color: "var(--accent)" }}>✻</span>{" "}
              {pastVerbFor(msg.info.id)} for {formatDuration(turnDurationMs)}
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
      {/* Persistent todo list — only on the LAST assistant message in the */}
      {/* transcript, after the turn has ended. While running, the same data */}
      {/* renders under the RunningIndicator instead (handled by ChatPanel). */}
      {persistentTodos && persistentTodos.length > 0 && (
        <ActiveTodos todos={persistentTodos} />
      )}
    </div>,
  );
});
