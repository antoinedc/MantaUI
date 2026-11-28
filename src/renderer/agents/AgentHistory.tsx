// ===== An agent's history (profile v5; agent screens spec §5.2) =====
//
// Only the changes that went live (applied), newest first, ONE compact line each: the date and what changed. A line is a native
// disclosure: opened, it says who made the change and how it landed, then holds the EXISTING change card (the test results and the
// change itself, and the page's one Undo — on the newest live change only) and "Restore the version before it" where it would change
// something. Pending changes are never listed here (their cards are in Needs you), nor are undone, refused or held ones. Edits made
// by hand to the agent's file are not in the list, and the page says so. The new record a restore makes lands at the top, opened.

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentChange } from "../../shared/types";
import { AgentChangeView } from "../AgentChangeCard";
import { QuietLink } from "./AgentsParts";
import { appliedHistory, canRestore, currentSnapshot, dateLabel, errText, historyHow, historySummary, latestLiveId } from "./agentsView";

/** Rows below the first few are drawn lazily (the `defer-rendering-heavy-content` guide); the ones in view never are. */
const EAGER_ROWS = 3;

function Row({
  r,
  index,
  latestLive,
  openAtStart,
  restorable,
  restoring,
  restoreBlocked,
  error,
  onRestore,
  onSettled,
}: {
  r: AgentChange;
  index: number;
  latestLive: boolean;
  openAtStart: boolean;
  restorable: boolean;
  restoring: boolean;
  restoreBlocked: boolean;
  error: string | undefined;
  onRestore: () => void;
  onSettled: (next: AgentChange) => void;
}) {
  const [open, setOpen] = useState(openAtStart);
  return (
    <li
      data-testid="history-row"
      data-id={r.id}
      data-state={r.state}
      className={"border-b border-border-subtle" + (index >= EAGER_ROWS ? " [content-visibility:auto] [contain-intrinsic-size:auto_36px]" : "")}
    >
      <details open={openAtStart} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
        <summary className="grid min-h-9 cursor-pointer list-none grid-cols-[56px_minmax(0,1fr)_14px] items-baseline gap-x-3 py-2 hover:[&_[data-testid=history-summary]]:text-text [&::-webkit-details-marker]:hidden">
          <span data-testid="history-when" className="whitespace-nowrap text-meta tabular-nums text-text-faint">
            {dateLabel(r.decidedAt ?? r.createdAt)}
          </span>
          <span data-testid="history-summary" className="min-w-0 break-words text-body text-text">
            {historySummary(r)}
          </span>
          <ChevronRight size={12} aria-hidden="true" className="self-center text-text-faint transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        </summary>
        {open && (
          <div className="mb-3 ml-[68px] flex flex-col gap-3">
            <p data-testid="history-how" className="m-0 text-meta text-text-faint">
              {historyHow(r)}
            </p>
            <AgentChangeView change={r} actions={latestLive ? ["undo"] : []} onChange={onSettled} />
            {restorable && (
              <div>
                <QuietLink onClick={onRestore} disabled={restoring || restoreBlocked}>
                  {restoring ? "Restoring…" : "Restore the version before it"}
                </QuietLink>
              </div>
            )}
          </div>
        )}
      </details>
      {error && (
        <div role="alert" className="mb-3 ml-[68px] break-words text-meta text-danger" data-testid="history-error">
          {error}
        </div>
      )}
    </li>
  );
}

export function AgentHistory({
  records,
  onChanged,
}: {
  /** The box's records of this agent, every state: only the applied ones are drawn. */
  records: ReadonlyArray<AgentChange>;
  /** A record changed (an Undo, a restore): the owner reads the profile and history again. */
  onChanged?: (record: AgentChange) => void;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, AgentChange>>(new Map());
  const [added, setAdded] = useState<ReadonlyArray<AgentChange>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  // everything the box said, with this page's own settled / restored records laid over it; the list shows what is live NOW
  const every = useMemo(() => {
    const ids = new Set(records.map((r) => r.id));
    return [...added.filter((a) => !ids.has(a.id)), ...records].map((r) => overrides.get(r.id) ?? r);
  }, [records, added, overrides]);
  const shown = useMemo(() => appliedHistory(every), [every]);
  const current = useMemo(() => currentSnapshot(every), [every]);
  const latestLive = useMemo(() => latestLiveId(every), [every]);

  const setError = (id: string, text: string | null) =>
    setErrors((m) => {
      const next = new Map(m);
      if (text) next.set(id, text);
      else next.delete(id);
      return next;
    });

  const restore = async (row: AgentChange) => {
    if (busy) return;
    setBusy(row.id);
    setError(row.id, null);
    try {
      const made = await window.api.agentsChangeRestore({ id: row.id });
      if (!made) throw new Error("The box didn't answer. Check the history again in a moment.");
      setAdded((a) => [made, ...a]);
      onChanged?.(made);
    } catch (e) {
      setError(row.id, errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="manta-agents-history" data-testid="history">
      {shown.length === 0 ? (
        <p className="m-0 text-label text-text-faint">No changes yet.</p>
      ) : (
        <ol className="m-0 list-none border-t border-border-subtle p-0" data-testid="history-list">
          {shown.map((r, i) => (
            <Row
              key={r.id}
              r={r}
              index={i}
              latestLive={r.id === latestLive}
              openAtStart={added.some((a) => a.id === r.id)}
              restorable={canRestore(r, current)}
              restoring={busy === r.id}
              restoreBlocked={busy != null}
              error={errors.get(r.id)}
              onRestore={() => void restore(r)}
              onSettled={(next) => {
                setOverrides((m) => new Map(m).set(next.id, next));
                onChanged?.(next);
              }}
            />
          ))}
        </ol>
      )}
      <p className="m-0 mt-3 max-w-[72ch] text-meta text-text-faint">
        Changes that went live, from Settings, Manta or the Architect. Changes waiting for your click are in Needs you. Edits made by hand to the agent's file aren't listed.
      </p>
    </section>
  );
}
