// ===== An agent's history (agent screens spec §5.2) =====
//
// The change records of one agent, newest first, every state: who made the change, what it was, what became of it. An undone
// change stays in the list, marked Undone. "Details" expands a row into the EXISTING change card for that record — its own
// Apply / Discard / Undo are the only ones (a record whose card already shows above the profile's tabs gets no second one).
// "Restore before this" asks the box to put the agent back to how it was before that change; the new record's card appears at
// the top, expanded. Edits made by hand to the agent's file are not in the list, and the page says so.

import { useMemo, useState } from "react";
import type { AgentChange } from "../../shared/types";
import { AgentChangeView } from "../AgentChangeCard";
import { Button } from "../Button";
import { canRestore, currentSnapshot, dateLabel, errText, historyOutcome, historySummary, historyWho } from "./agentsView";

/** Rows below the first few are drawn lazily (the `defer-rendering-heavy-content` guide); the ones in view never are. */
const EAGER_ROWS = 3;

export function AgentHistory({
  records,
  onChanged,
  preview,
  cardsAbove,
}: {
  records: ReadonlyArray<AgentChange>;
  /** A record changed (a card press, a restore): the owner reads the profile and history again. */
  onChanged?: (record: AgentChange) => void;
  /** Read-only first rows (the Overview): no actions, so no second copy of a card or a button. */
  preview?: number;
  /** Records whose card is shown elsewhere on the page; their rows say so instead of offering a second card. */
  cardsAbove?: ReadonlySet<string>;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, AgentChange>>(new Map());
  const [added, setAdded] = useState<ReadonlyArray<AgentChange>>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const all = useMemo(() => {
    const ids = new Set(records.map((r) => r.id));
    return [...added.filter((a) => !ids.has(a.id)), ...records].map((r) => overrides.get(r.id) ?? r);
  }, [records, added, overrides]);
  const current = useMemo(() => currentSnapshot(all), [all]);
  const shown = preview != null ? all.slice(0, preview) : all;

  const setError = (id: string, text: string | null) =>
    setErrors((m) => {
      const next = new Map(m);
      if (text) next.set(id, text);
      else next.delete(id);
      return next;
    });
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
      setOpen((s) => new Set(s).add(made.id));
      onChanged?.(made);
    } catch (e) {
      setError(row.id, errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (all.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-label text-text-faint">No changes yet.</p>
        <Note />
      </div>
    );
  }

  return (
    <div className="manta-agents-history flex flex-col">
      <ol className="m-0 flex list-none flex-col p-0" data-testid="history-list">
        {shown.map((r, i) => {
          const above = r.state === "pending" || (cardsAbove?.has(r.id) ?? false);
          const expanded = open.has(r.id);
          const err = errors.get(r.id);
          const when = dateLabel(r.decidedAt ?? r.createdAt);
          return (
            <li
              key={r.id}
              data-testid="history-row"
              data-id={r.id}
              data-state={r.state}
              className={
                "grid grid-cols-[52px_1fr_auto] gap-x-3 gap-y-2 border-b border-border-subtle py-2 text-label" +
                (i >= EAGER_ROWS ? " [content-visibility:auto] [contain-intrinsic-size:auto_64px]" : "")
              }
            >
              <span className="whitespace-nowrap pt-px text-meta text-text-faint">{when}</span>
              <div className="min-w-0">
                <span className="font-semibold text-text">{historyWho(r)}</span> <span className="text-text-muted">· {historySummary(r)}</span>
                <div className="text-meta text-text-faint">
                  {historyOutcome(r)}
                  {above && r.state !== "pending" ? " · see the card above" : above ? " · card above" : ""}
                </div>
                {err && (
                  <div role="alert" className="mt-1 break-words text-meta text-danger" data-testid="history-error">
                    {err}
                  </div>
                )}
              </div>
              {preview == null && (
                <div className="flex shrink-0 items-start gap-1">
                  {!above && (
                    <Button tone="ghost" ariaPressed={expanded} onClick={() => toggle(r.id)}>
                      {expanded ? "Hide" : "Details"}
                    </Button>
                  )}
                  {canRestore(r, current) && (
                    <Button tone="ghost" onClick={() => void restore(r)} loading={busy === r.id} disabled={busy != null && busy !== r.id}>
                      {busy === r.id ? "Restoring…" : "Restore before this"}
                    </Button>
                  )}
                </div>
              )}
              {preview == null && expanded && !above && (
                <div className="col-span-3">
                  <AgentChangeView
                    change={r}
                    onChange={(next) => {
                      setOverrides((m) => new Map(m).set(next.id, next));
                      onChanged?.(next);
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {preview == null && <Note />}
    </div>
  );
}

const Note = () => <p className="m-0 mt-2 text-meta text-text-faint">Changes made through Manta or the Architect. Edits made by hand to the agent's file aren't listed.</p>;
