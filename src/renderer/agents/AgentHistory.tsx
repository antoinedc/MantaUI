// ===== An agent's history (agent screens spec §5.2; proposal A) =====
//
// The change log of one agent, newest first, every state. A row says when, who, what, and what became of it with its reason
// ("Live · you approved it", "Undone · by you", "Waiting for your click"). A row is a native disclosure: opened, it holds the
// EXISTING change card for that record and, where it would change something, "Restore the version before this" as a quiet
// link. The page offers each button once: Apply / Discard live on the pending change above the tabs (its row points up, and a
// record whose card is shown above has no second one), and Undo is on the newest live change only — older live rows show their
// card without it. The new record a restore makes appears at the top, opened. Edits made by hand to the agent's file are not
// in the list, and the page says so. The pane beside the list counts the changes and says how changes land.

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentChange } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { AgentChangeView } from "../AgentChangeCard";
import { BlockTitle, QuietLink } from "./AgentsParts";
import { Pane, PaneFacts, PaneGroup } from "./ProfileLayout";
import { canRestore, currentSnapshot, dateLabel, errText, historyCounts, historyStatus, historySummary, historyWho, latestLiveId, type StatusTone } from "./agentsView";

/** Rows below the first few are drawn lazily (the `defer-rendering-heavy-content` guide); the ones in view never are. */
const EAGER_ROWS = 3;

const TONE: Record<StatusTone, string> = { ok: "text-ok", accent: "text-accent-tx", faint: "text-text-faint", warn: "text-warn" };
const ROW_GRID = "grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-x-3 py-3";

function RowHead({ r, above, who }: { r: AgentChange; above: boolean; who: string }) {
  const status = historyStatus(r);
  const name = who.split(" · ")[0];
  return (
    <>
      <span data-testid="history-when" className="whitespace-nowrap pt-px text-label text-text-faint">
        {dateLabel(r.decidedAt ?? r.createdAt)}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-label text-text-muted">
          <AgentBadge size="md" agent={{ name, slug: name.toLowerCase(), color: null }} />
          {who}
        </div>
        <div data-testid="history-summary" className="mt-1 break-words text-body text-text">
          {historySummary(r)}
        </div>
        <div data-testid="history-status" className="mt-1 flex flex-wrap items-center gap-x-3 text-meta">
          <span className={`inline-flex items-center gap-2 font-medium ${TONE[status.tone]}`}>
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            {status.label}
          </span>
          {status.why && <span className="text-text-faint">{status.why}</span>}
          {above && <span className="text-text-faint">see the card above</span>}
        </div>
      </div>
      {!above && (
        <span className="flex items-center gap-1 whitespace-nowrap pt-px text-meta text-text-faint">
          <ChevronRight size={12} aria-hidden="true" className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          Details
        </span>
      )}
    </>
  );
}

function Row({
  r,
  index,
  above,
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
  above: boolean;
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
  const who = historyWho(r);
  return (
    <li
      data-testid="history-row"
      data-id={r.id}
      data-state={r.state}
      className={"border-b border-border-subtle" + (index >= EAGER_ROWS ? " [content-visibility:auto] [contain-intrinsic-size:auto_64px]" : "")}
    >
      {above ? (
        <div className={ROW_GRID}>
          <RowHead r={r} above who={who} />
        </div>
      ) : (
        <details open={openAtStart} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
          <summary className={`${ROW_GRID} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
            <RowHead r={r} above={false} who={who} />
          </summary>
          {open && (
            <div className="mb-3 ml-[68px] flex flex-col gap-2">
              <AgentChangeView change={r} actions={r.state === "applied" ? (latestLive ? ["undo"] : []) : undefined} onChange={onSettled} />
              {restorable && (
                <div>
                  <QuietLink onClick={onRestore} disabled={restoring || restoreBlocked}>
                    {restoring ? "Restoring…" : "Restore the version before this"}
                  </QuietLink>
                </div>
              )}
            </div>
          )}
        </details>
      )}
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
  cardsAbove,
}: {
  records: ReadonlyArray<AgentChange>;
  /** A record changed (a card press, a restore): the owner reads the profile and history again. */
  onChanged?: (record: AgentChange) => void;
  /** Records whose card is shown elsewhere on the page; their rows say so instead of offering a second card. */
  cardsAbove?: ReadonlySet<string>;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, AgentChange>>(new Map());
  const [added, setAdded] = useState<ReadonlyArray<AgentChange>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const all = useMemo(() => {
    const ids = new Set(records.map((r) => r.id));
    return [...added.filter((a) => !ids.has(a.id)), ...records].map((r) => overrides.get(r.id) ?? r);
  }, [records, added, overrides]);
  const current = useMemo(() => currentSnapshot(all), [all]);
  const latestLive = useMemo(() => latestLiveId(all), [all]);

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
    <section className="manta-agents-history">
      <BlockTitle>Changes, newest first</BlockTitle>
      {all.length === 0 ? (
        <p className="m-0 text-label text-text-faint">No changes yet.</p>
      ) : (
        <ol className="m-0 list-none border-t border-border-subtle p-0" data-testid="history-list">
          {all.map((r, i) => (
            <Row
              key={r.id}
              r={r}
              index={i}
              above={r.state === "pending" || (cardsAbove?.has(r.id) ?? false)}
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
      <p className="m-0 mt-2 text-meta text-text-faint">Changes made through Manta or the Architect. Edits made by hand to the agent's file aren't listed.</p>
    </section>
  );
}

/** The pane beside the log: how many changes are live, waiting and undone (once the log is read), and how changes land. */
export function HistoryPane({ records }: { records: ReadonlyArray<AgentChange> | null }) {
  const counts = records ? historyCounts(records) : null;
  return (
    <Pane label="History">
      {counts && (
        <PaneGroup title="Summary" testId="history-summary-counts">
          <PaneFacts rows={[["Live", String(counts.live)], ["Waiting", String(counts.waiting)], ["Undone", String(counts.undone)]]} />
        </PaneGroup>
      )}
      <PaneGroup title="How changes land" testId="history-how">
        <p className="m-0 text-label text-text">
          The Architect proposes; your setting decides whether a change waits for your click or goes live and tells you. Any live change can be undone, or the agent restored to the version before it.
        </p>
      </PaneGroup>
    </Pane>
  );
}
