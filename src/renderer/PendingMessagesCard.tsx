// ===== Pending-messages card =====
//
// The pinned card listing the session's pending user messages (OpenCode V2
// v2-next spec, Stage A; visual source: docs/superpowers/specs/
// 2026-10-23-opencode-v2-next/pending-messages-mockup.html). Purely
// presentational: the rows come from the box's `inbox` snapshot (K3) and every
// action is a callback owned by ChatPanel, which reports each outcome.
//
//   - header `Pending · N message(s)` + `↑ edit last`;
//   - one row per item, oldest first: badge (Now = steer, After this turn =
//     queue), the text on one line, a quiet note + Wait on Now rows, a primary
//     Send now on After rows, × on every row. No drag handle, no reordering;
//   - the stopped footer when the agent is not running and an After item waits.

import { memo } from "react";
import { X } from "lucide-react";
import type { OpencodeInboxItem } from "../shared/types";
import {
  STOPPED_FOOTER_TEXT,
  inboxBadgeLabel,
  inboxRowNote,
  pendingHeaderText,
  showStoppedFooter,
} from "./inboxState";

const BADGE_BASE = "shrink-0 whitespace-nowrap rounded-full border px-2 text-micro tracking-normal font-semibold";
const BADGE_NOW = "border-accent/40 bg-accent-bg text-accent-tx";
const BADGE_AFTER = "border-border bg-fill text-text-faint";

export const PendingMessagesCard = memo(function PendingMessagesCard({
  items,
  running,
  busyIds,
  onSendNow,
  onWait,
  onCancel,
  onEditLast,
}: {
  items: ReadonlyArray<OpencodeInboxItem>;
  running: boolean;
  /** Rows with an action in flight (cancel or delivery change): all their controls are disabled. */
  busyIds: ReadonlySet<string>;
  onSendNow: (item: OpencodeInboxItem) => void;
  onWait: (item: OpencodeInboxItem) => void;
  onCancel: (item: OpencodeInboxItem) => void;
  onEditLast: () => void;
}) {
  const [lead, rest] = pendingHeaderText(items.length).split(" · ");
  const canEditLast = items.some((i) => !busyIds.has(i.id));
  return (
    <div
      className="rounded-lg border border-border bg-bg-soft overflow-hidden text-meta"
      data-testid="inbox-card"
    >
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border-subtle text-text-faint">
        <span data-testid="inbox-header">
          <span className="font-semibold text-text">{lead}</span>
          {" · "}
          {rest}
        </span>
        <button
          type="button"
          onClick={onEditLast}
          disabled={!canEditLast}
          className="ml-auto inline-flex items-center gap-1 text-text-faint hover:text-text disabled:opacity-50"
          title="Pull the newest pending message back into the composer to edit it"
          data-testid="inbox-edit-last"
        >
          <span className="font-mono">↑</span> edit last
        </button>
      </div>
      <div>
        {items.map((item) => {
          const busy = busyIds.has(item.id);
          const note = inboxRowNote(item, running);
          const now = item.delivery === "steer";
          return (
            <div
              key={item.id}
              className="flex items-center gap-2 px-3 py-1 border-b border-border-subtle last:border-b-0"
              data-testid="inbox-row"
              data-delivery={item.delivery}
            >
              <span className={`${BADGE_BASE} ${now ? BADGE_NOW : BADGE_AFTER}`} data-testid="inbox-badge">
                {inboxBadgeLabel(item)}
              </span>
              <span className="flex-1 min-w-0 truncate text-text" title={item.text} data-testid="inbox-text">
                {item.text}
              </span>
              {item.attachmentCount > 0 && (
                <span className="shrink-0 text-text-faint">
                  +{item.attachmentCount} attachment{item.attachmentCount === 1 ? "" : "s"}
                </span>
              )}
              {note && (
                <span className="shrink-0 whitespace-nowrap text-text-faint" data-testid="inbox-note">
                  {note}
                </span>
              )}
              {now ? (
                <button
                  type="button"
                  onClick={() => onWait(item)}
                  disabled={busy}
                  className="shrink-0 px-1 text-text-faint hover:text-text disabled:opacity-50"
                  title="Keep it for after this turn instead"
                  data-testid="inbox-wait"
                >
                  Wait
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onSendNow(item)}
                  disabled={busy}
                  className="shrink-0 rounded-sm border border-accent/45 bg-accent-bg px-2 py-px text-accent-tx hover:bg-fill-hover disabled:opacity-50"
                  title={running ? "Send it into the running turn now" : "Send it now — starts a turn"}
                  data-testid="inbox-send-now"
                >
                  Send now
                </button>
              )}
              <button
                type="button"
                onClick={() => onCancel(item)}
                disabled={busy}
                className="shrink-0 inline-flex items-center text-text-faint hover:text-text leading-none disabled:opacity-50"
                title="Cancel this message"
                aria-label="Cancel this message"
                data-testid="inbox-cancel"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {showStoppedFooter(items, running) && (
        <div className="px-3 py-1 border-t border-border-subtle text-micro tracking-normal text-warn" data-testid="inbox-footer">
          {STOPPED_FOOTER_TEXT}
        </div>
      )}
    </div>
  );
});
