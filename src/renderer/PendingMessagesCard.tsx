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

/** A row: the box's pending item, or a message this panel is still sending (`sending`). */
export type PendingCardItem = OpencodeInboxItem & { sending?: boolean };
import {
  STOPPED_FOOTER_TEXT,
  inboxBadgeLabel,
  inboxRowNote,
  pendingHeaderText,
  showStoppedFooter,
} from "./inboxState";

const BADGE_BASE = "shrink-0 whitespace-nowrap rounded-full border px-2 text-micro tracking-normal font-semibold";
const BADGE_AFTER = "border-border bg-fill text-text-faint";
// Wait and × share one quiet bordered button style; Send now is the accented one.
const ROW_BUTTON =
  "shrink-0 inline-flex items-center justify-center rounded-sm border border-border bg-fill px-2 py-px text-text-muted hover:text-text hover:bg-fill-hover disabled:opacity-50";

export const PendingMessagesCard = memo(function PendingMessagesCard({
  items,
  running,
  busyIds,
  onSendNow,
  onWait,
  onCancel,
  onEditLast,
  actionsEnabled = true,
  gateNote = null,
}: {
  items: ReadonlyArray<PendingCardItem>;
  running: boolean;
  /** Rows with an action in flight (cancel or delivery change): all their controls are disabled. */
  busyIds: ReadonlySet<string>;
  onSendNow: (item: OpencodeInboxItem) => void;
  onWait: (item: OpencodeInboxItem) => void;
  onCancel: (item: OpencodeInboxItem) => void;
  onEditLast: () => void;
  /** False while the box can't be asked (or is too old to word the outcomes): ×, Send now, Wait and edit last are disabled. */
  actionsEnabled?: boolean;
  /** The footer line explaining why they are disabled ("Update your box to use this"); null while still checking. */
  gateNote?: string | null;
}) {
  const [lead, rest] = pendingHeaderText(items.length).split(" · ");
  const canEditLast = actionsEnabled && items.some((i) => !i.sending && !busyIds.has(i.id));
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
        {items.map((item, idx) => {
          const sending = item.sending === true;
          const busy = sending || busyIds.has(item.id) || !actionsEnabled;
          const note = sending ? "sending…" : inboxRowNote(item, running);
          const now = item.delivery === "steer";
          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 px-3 py-1${idx > 0 ? " border-t border-border-subtle" : ""}`}
              data-testid="inbox-row"
              data-delivery={item.delivery}
              data-sending={sending ? "true" : undefined}
            >
              {!now && (
                <span className={`${BADGE_BASE} ${BADGE_AFTER}`} data-testid="inbox-badge">
                  {inboxBadgeLabel(item)}
                </span>
              )}
              <span className="flex-1 min-w-0 truncate text-text" title={item.text} data-testid="inbox-text">
                {item.text}
              </span>
              {item.attachmentCount > 0 && (
                <span className="shrink-0 text-text-faint">
                  +{item.attachmentCount} attachment{item.attachmentCount === 1 ? "" : "s"}
                </span>
              )}
              {note && (
                <span className="shrink-0 whitespace-nowrap text-text-faint inline-flex items-center gap-1" data-testid="inbox-note">
                  {sending && (
                    <span
                      aria-hidden="true"
                      className="w-2.5 h-2.5 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {note}
                </span>
              )}
              {now ? (
                <button
                  type="button"
                  onClick={() => onWait(item)}
                  disabled={busy}
                  className={ROW_BUTTON}
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
                className={`${ROW_BUTTON} self-stretch`}
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
      {gateNote && (
        <div className="px-3 py-1 border-t border-border-subtle text-micro tracking-normal text-text-faint" data-testid="inbox-gate-note">
          {gateNote}
        </div>
      )}
      {showStoppedFooter(items, running) && (
        <div className="px-3 py-1 border-t border-border-subtle text-micro tracking-normal text-warn" data-testid="inbox-footer">
          {STOPPED_FOOTER_TEXT}
        </div>
      )}
    </div>
  );
});
