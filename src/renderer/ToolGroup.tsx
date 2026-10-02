// ===== Collapsed tool activity =====
//
// A run of consecutive tool calls renders as ONE quiet line instead of a stack
// of bordered cards: status dot · summary · optional "· N failed" · chevron.
// Clicking it expands the run's tool cards (the existing ToolCall / PatchCard,
// each with its own disclosure for output / diff / subagent transcript).
//
// `ToolActivityList` is shared with the working line (Transcript.tsx), which
// shows the run at the tail of a running turn and expands the very same list.
// The grouping itself is decided by toolActivity.ts; this file only draws it.

import { memo } from "react";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { MESSAGE_IN_ENTER, MESSAGE_IN_IDLE } from "./chatMotion";
import { AssistantPart } from "./ToolCall";
import { StatusDot } from "./StatusDot";
import { CardMount } from "./components/CardMount";
import { useGroupExpanded } from "./toolGroupExpansion";
import { groupTone, summarizeToolGroup, type ToolGroup } from "./toolActivity";

/** The expanded list: the run's cards behind a thin left rule. */
export const ToolActivityList = memo(function ToolActivityList({
  group,
  showThinking,
}: {
  group: ToolGroup;
  showThinking: boolean;
}) {
  // A run with exactly ONE tool call opens its card straight away, so the diff
  // or output is one click from the line rather than two.
  const { calls } = summarizeToolGroup(group.items);
  return (
    <div className="mt-2 ml-1 pl-3 border-l border-border-subtle flex flex-col gap-2">
      {group.items.map((p) => (
        <AssistantPart
          key={p.id}
          part={p}
          showThinking={showThinking}
          defaultExpanded={calls === 1 && p.type === "tool"}
        />
      ))}
    </div>
  );
});

/** Chevron that turns a quarter-turn when its disclosure is open. */
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      size={12}
      aria-hidden="true"
      className={`shrink-0 text-text-quiet transition-transform ${open ? "rotate-90" : ""}`}
    />
  );
}

export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  showThinking,
  entering = false,
}: {
  group: ToolGroup;
  showThinking: boolean;
  // True when the owning message arrived while the user was watching, so the
  // line pops in like every other part of a live message (see AssistantPart).
  entering?: boolean;
}) {
  // Shared with the working line, so a run opened there stays open here.
  const [expanded, toggle] = useGroupExpanded(group.id);
  const summary = summarizeToolGroup(group.items);
  const tone = groupTone(summary);
  return (
    // Same always-present motion wrapper AssistantPart uses: the element type
    // never swaps, so the pop plays once at mount and never replays.
    <motion.div
      data-motion={entering ? "part" : undefined}
      {...(entering ? MESSAGE_IN_ENTER : MESSAGE_IN_IDLE)}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title={expanded ? "Hide tool calls" : "Show tool calls"}
        className="manta-tool-group inline-flex items-center gap-2 max-w-full text-left text-label text-text-muted hover:text-text transition-colors"
      >
        <StatusDot tone={tone} />
        <span className="truncate">{summary.label}</span>
        {summary.failed > 0 && (
          <span className="text-danger whitespace-nowrap">· {summary.failed} failed</span>
        )}
        <DisclosureChevron open={expanded} />
      </button>
      <CardMount show={expanded} k={group.id}>
        <ToolActivityList group={group} showThinking={showThinking} />
      </CardMount>
    </motion.div>
  );
});
