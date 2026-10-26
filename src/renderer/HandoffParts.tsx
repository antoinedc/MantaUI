// ===== Auto-handoff — UI pieces (spec 2026-10-26-auto-handoff.md §3, §9) =====
//
//   - HandoffCardView / HandoffToolCard / PinnedHandoffCard: the handoff card —
//     inline as the `handoff` tool part, pinned above the composer for
//     server-path records.
//   - CarriedContextBlock: "Carried-over context — sent with the next message."
//   - ContinuationNotice: "Continued from … · View previous".
//   - PreviousSessionBar: replaces the composer while a previous session is open.
//   - HandoffModeToggle: the "Handoff: auto|suggest|off" control by the trust row.
//
// All of it is presentational over handoff.ts (rules) and handoffActions.ts
// (effects). Every press awaits its effect and says what happened — success or
// failure — in the card (AGENTS.md "never stub a control").

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRightLeft, ChevronDown, ChevronRight } from "lucide-react";
import type { OpencodePart } from "../shared/types";
import type { HandoffHow, HandoffMode, HandoffRecord } from "../shared/api";
import { Button } from "./Button";
import { Card } from "./Card";
import { Pill } from "./Pill";
import { renderMarkdown } from "./MarkdownBody";
import { useStore } from "./store";
import { useHandoffRecord } from "./handoffStore";
import { copyHandoffText, openSessionWindow, retryHandoff, startHandoff } from "./handoffActions";
import {
  collapseHandoffText,
  describeContinuationNotice,
  describeHandoffError,
  describeHandoffMode,
  describeHandoffSource,
  handoffActionsEnabled,
  handoffBadge,
  handoffIdOfPart,
  nextHandoffMode,
  type ContinuationNotice as ContinuationNoticeData,
} from "./handoff";

type Notice = { tone: "ok" | "error"; text: string };
type Busy = "copy" | "clear" | "new-session" | "edit-clear" | "edit-new-session" | "retry" | "open" | null;

const NOTICE_CLS = { ok: "text-ok", error: "text-danger" } as const;

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export const HandoffCardView = memo(function HandoffCardView({ record }: { record: HandoffRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const badge = handoffBadge(record.state);
  const ready = handoffActionsEnabled(record);
  const failed = record.state === "failed";
  const started = record.state === "committed";
  const { shown, hidden } = collapseHandoffText(record.text);

  // Run one press: await it, then say what happened. `okText` is the success line
  // (omitted when the card itself changing state is the confirmation).
  const run = async (key: Exclude<Busy, null>, fn: () => Promise<void>, okText?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
      if (okText) setNotice({ tone: "ok", text: okText });
    } catch (e) {
      setNotice({ tone: "error", text: describeHandoffError(e) });
    } finally {
      setBusy(null);
    }
  };

  const start = (how: HandoffHow, disposition: "send" | "draft", key: Exclude<Busy, null>) => {
    setEditing(false);
    void run(key, () => startHandoff(record, how, disposition));
  };

  const anyBusy = busy !== null;
  const off = !ready || anyBusy;
  const offTitle = ready ? undefined : "Available once the handoff is ready";

  return (
    <div className="text-meta" data-testid="handoff-card" data-state={record.state}>
      <Card
        elevated
        danger={failed}
        header={
          <>
            <span
              className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-md shrink-0 bg-accent-bg text-accent"
              aria-hidden="true"
            >
              <ArrowRightLeft size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-text font-medium mb-px">Handoff prompt</div>
              <div className="text-text-faint mb-px">from {describeHandoffSource(record)}</div>
            </div>
            <Pill tone={badge.tone === "danger" ? "warn" : badge.tone}>
              <span data-testid="handoff-badge">{badge.label}</span>
            </Pill>
          </>
        }
        actions={
          record.state === "requested" || record.state === "generating" ? undefined : (
            <>
              {failed ? (
                <Button tone="default" loading={busy === "retry"} disabled={anyBusy} onClick={() => void run("retry", () => retryHandoff(record.id))}>
                  {busy === "retry" ? "Retrying…" : "Retry"}
                </Button>
              ) : (
                <>
                  <Button
                    tone="ghost"
                    disabled={!ready || anyBusy}
                    title={offTitle}
                    onClick={() => void run("copy", () => copyHandoffText(record.text), "Copied to the clipboard")}
                  >
                    {busy === "copy" ? "Copying…" : "Copy"}
                  </Button>
                  <Button
                    tone="primary"
                    disabled={off}
                    title={offTitle ?? "Replace this conversation with a fresh session that starts from this prompt"}
                    loading={busy === "clear"}
                    onClick={() => start("clear", "send", "clear")}
                  >
                    {busy === "clear" ? "Starting…" : "Clear & start"}
                  </Button>
                  <Button
                    tone="default"
                    disabled={off}
                    title={offTitle ?? "Open a new session that starts from this prompt; this one keeps going"}
                    loading={busy === "new-session"}
                    onClick={() => start("new-session", "send", "new-session")}
                  >
                    {busy === "new-session" ? "Starting…" : "Start in new session"}
                  </Button>
                  <button
                    type="button"
                    disabled={off}
                    title={offTitle ?? "Put the prompt in a new composer to edit before sending"}
                    aria-expanded={editing}
                    onClick={() => setEditing((v) => !v)}
                    className="ml-auto text-meta text-text-faint hover:text-text underline decoration-dotted disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                  >
                    Edit first
                  </button>
                </>
              )}
              {started && record.successorId && (
                <button
                  type="button"
                  disabled={anyBusy}
                  onClick={() => void run("open", () => openSessionWindow(record.successorId!))}
                  className="ml-auto text-meta text-accent hover:underline disabled:opacity-50"
                >
                  {busy === "open" ? "Opening…" : "Open session"}
                </button>
              )}
            </>
          )
        }
      >
        <>
          {record.text ? (
            <div className="text-text-muted break-words" data-testid="handoff-body">
              {renderMarkdown(expanded ? record.text : shown)}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-1 inline-flex items-center gap-1 text-text-faint hover:text-text"
                >
                  {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  {expanded ? "Show less" : `Show all (${hidden} more lines)`}
                </button>
              )}
            </div>
          ) : (
            <div className="text-text-faint">
              {record.state === "requested" || record.state === "generating" ? "Writing the handoff…" : "No text."}
            </div>
          )}
          {failed && record.reason && (
            <div className="mt-2 text-danger break-words" role="alert">
              {record.reason}
            </div>
          )}
          {editing && ready && (
            <div className="mt-3 flex items-center gap-2 flex-wrap" data-testid="handoff-edit-choice">
              <span className="text-text-faint">Edit in:</span>
              <Button tone="default" size="md" disabled={anyBusy} onClick={() => start("clear", "draft", "edit-clear")}>
                This window (clear)
              </Button>
              <Button tone="default" size="md" disabled={anyBusy} onClick={() => start("new-session", "draft", "edit-new-session")}>
                New session
              </Button>
              <button type="button" onClick={() => setEditing(false)} className="text-text-faint hover:text-text">
                Cancel
              </button>
            </div>
          )}
          {notice && (
            <div
              className={`mt-2 break-words ${NOTICE_CLS[notice.tone]}`}
              role={notice.tone === "error" ? "alert" : "status"}
              data-testid="handoff-notice"
            >
              {notice.text}
            </div>
          )}
        </>
      </Card>
    </div>
  );
});

/** The id's record, fetched live: loading / expired / failed-to-load states, then the card. */
const HandoffCardById = memo(function HandoffCardById({ id }: { id: string }) {
  const entry = useHandoffRecord(id);
  if (!entry || entry.status === "loading") {
    return <div className="text-meta text-text-faint px-1 py-1">Loading handoff…</div>;
  }
  if (entry.status === "expired") {
    return (
      <div className="text-meta text-text-faint px-1 py-1" data-testid="handoff-expired">
        This handoff has expired
      </div>
    );
  }
  if (!entry.record) {
    return (
      <div className="text-meta text-danger px-1 py-1" role="alert">
        Couldn't load this handoff{entry.error ? `: ${entry.error}` : ""}
      </div>
    );
  }
  return <HandoffCardView record={entry.record} />;
});

/**
 * The agent path: a `handoff` tool part in the transcript. The tool output is a
 * status line plus the marker; the card replaces the status line. Until the tool
 * has finished there is no marker, so the part shows as running.
 */
export const HandoffToolCard = memo(function HandoffToolCard({ part }: { part: OpencodePart }) {
  const id = handoffIdOfPart(part);
  const status = String(((part as Record<string, unknown>).state as { status?: string } | undefined)?.status ?? "");
  if (!id) {
    return (
      <div className="text-meta text-text-faint px-1 py-1" data-testid="handoff-pending">
        {status === "error" ? "The handoff tool failed." : "Preparing handoff…"}
      </div>
    );
  }
  return <HandoffCardById id={id} />;
});

/** The server path: a record pinned above the composer. */
export const PinnedHandoffCard = memo(function PinnedHandoffCard({ record }: { record: HandoffRecord }) {
  return (
    <div className="shrink-0 px-4 pt-2 pb-2">
      <HandoffCardView record={record} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Successor chrome
// ---------------------------------------------------------------------------

/** An armed handoff, held until the successor's first message goes out (§5.4). */
export const CarriedContextBlock = memo(function CarriedContextBlock({ preamble }: { preamble: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="shrink-0 px-4 pt-2 pb-2" data-testid="handoff-carried">
      <div className="rounded-lg border border-border bg-bg-soft px-3 py-2 text-meta">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-text-muted hover:text-text"
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          <span>Carried-over context — sent with the next message.</span>
        </button>
        {open && (
          <div className="mt-2 text-text-muted break-words max-h-[40vh] overflow-y-auto">{renderMarkdown(preamble)}</div>
        )}
      </div>
    </div>
  );
});

/** "Continued from <title> — handed off at 182k tokens · View previous". */
export const ContinuationNotice = memo(function ContinuationNotice({
  notice,
  onViewPrevious,
}: {
  notice: ContinuationNoticeData;
  onViewPrevious: () => void;
}) {
  return (
    <div
      className="shrink-0 mx-auto w-full px-4 pt-2 text-meta text-text-faint"
      style={{ maxWidth: "var(--measure)" }}
      data-testid="handoff-continuation"
    >
      {describeContinuationNotice(notice)} ·{" "}
      <button type="button" onClick={onViewPrevious} className="text-accent hover:underline">
        View previous
      </button>
    </div>
  );
});

/** Replaces the composer while a previous session is open: no send is possible. */
export const PreviousSessionBar = memo(function PreviousSessionBar({
  label,
  deleted,
  onBack,
}: {
  label: string;
  deleted: boolean;
  onBack: () => void;
}) {
  return (
    <div
      className="shrink-0 mx-auto w-full px-4 py-3 flex items-center gap-3 border-t border-border-subtle text-meta"
      style={{ maxWidth: "var(--measure)" }}
      data-testid="handoff-previous-bar"
    >
      <span className="min-w-0 flex-1 truncate text-text-muted" title={label}>
        {deleted ? "This session was deleted." : `Viewing a previous session — ${label} (read-only)`}
      </span>
      <Button tone="primary" onClick={onBack}>
        Back to current
      </Button>
    </div>
  );
});

/** The pane body for a previous session whose conversation is gone. */
export function DeletedSessionNotice({ children }: { children?: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center text-body text-text-faint" data-testid="handoff-deleted">
      {children ?? "This session was deleted."}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode control
// ---------------------------------------------------------------------------

/**
 * "Handoff: auto|suggest|off" beside the trust toggle. Click cycles and saves to
 * the box config; a save that fails restores the old value and says so here.
 */
export function HandoffModeToggle() {
  const mode = useStore((s) => s.handoffMode);
  const setHandoffMode = useStore((s) => s.setHandoffMode);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const cycle = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    clearTimeout(timer.current);
    const next: HandoffMode = nextHandoffMode(mode);
    try {
      await setHandoffMode(next);
    } catch (e) {
      setError(`Couldn't save handoff mode: ${String((e as Error)?.message ?? e)}`);
      timer.current = setTimeout(() => setError(null), 6000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void cycle()}
        disabled={saving}
        title={describeHandoffMode(mode)}
        data-testid="handoff-mode"
        className="inline-flex items-center gap-2 text-[11px] leading-none font-normal py-[6px] px-0 text-text-muted hover:text-text"
      >
        <ArrowRightLeft size={14} aria-hidden="true" />
        Handoff: {mode}
      </button>
      {error && (
        <span role="alert" className="text-[11px] leading-none text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
