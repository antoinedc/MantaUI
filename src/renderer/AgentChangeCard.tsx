// ===== Agents Phase 4 — the card for Manta's `agent_change` tool call =====
//
// Drawn by the app from the box's record (never from what the model said): the new agent, or a line diff of the
// change, with the buttons its state allows. Every press awaits the box and says what happened — a new chip, a short
// line, or the box's own sentence when it refuses (AGENTS.md "never stub a control").
//
// Phase 5A: the record-driven part is `AgentChangeView` (exported), so an Architect job's result card can draw the records
// its task proposed — the same buttons and behaviour, plus the Architect's summary, its evidence and the rules it
// considered, the held / applying states, and the source blocks of a change to the Architect itself.
//
// Freshness: the card subscribes to the `agentChange` bus kind BEFORE its first read, fetches the record by the call's
// tuple when the tool part settles, on every hint for it and after a reconnect. A read that lands after a newer one
// (or after the user's own press) never rolls the card back.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight } from "lucide-react";
import type { AgentChange, OpencodePart } from "../shared/types";
import { Button } from "./Button";
import { Card } from "./Card";
import { Pill } from "./Pill";
import {
  agentChangeActions,
  agentChangeButtonLabel,
  agentChangeChip,
  agentChangeKeyOf,
  agentChangeOutcome,
  agentChangeReason,
  agentChangeTitle,
  architectSourceBlocks,
  changeAuthor,
  changedLineCount,
  DIFF_COLLAPSE_ROWS,
  diffRows,
  evidenceLines,
  isArchitectChange,
  parseAgentMdView,
  verdictLabel,
  type AgentChangeAction,
  type DiffRow,
} from "./agentChange";

type Notice = { tone: "ok" | "error"; text: string; state: AgentChange["state"] };

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";

const MUTED = "text-meta text-text-faint px-1 py-1";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function CreateView({ change }: { change: AgentChange }) {
  const view = parseAgentMdView(change.after);
  if (!view) {
    return (
      <details data-testid="agent-change-raw">
        <summary className="cursor-pointer text-text-muted">The agent file</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words text-text-muted max-h-64 overflow-y-auto">{change.after}</pre>
      </details>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="agent-change-create">
      <div className="text-text break-words">{view.description}</div>
      {view.useWhen && (
        <div className="break-words">
          <span className="text-text-faint">Use when: </span>
          <span className="text-text-muted">{view.useWhen}</span>
        </div>
      )}
      {view.notFor && (
        <div className="break-words">
          <span className="text-text-faint">Not for: </span>
          <span className="text-text-muted">{view.notFor}</span>
        </div>
      )}
      <div className="text-text-muted" data-testid="agent-change-facts">
        {view.editsCode ? "Edits code (own branch)" : "Read-only"} · Model: {view.model ?? "Auto"}
      </div>
      <details data-testid="agent-change-instructions">
        <summary className="cursor-pointer text-text-muted">Instructions</summary>
        <div className="mt-2 whitespace-pre-wrap break-words text-text-muted max-h-64 overflow-y-auto">{view.body}</div>
      </details>
    </div>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  if (row.kind === "gap") {
    return (
      <div className="flex whitespace-pre text-text-faint" data-diff="gap">
        <span className="select-none shrink-0 w-3" aria-hidden="true" />
        <span className="flex-1">⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}</span>
      </div>
    );
  }
  const add = row.kind === "add";
  const del = row.kind === "del";
  return (
    <div className={`flex whitespace-pre${add ? " bg-[var(--diff-add)]" : del ? " bg-[var(--diff-del)]" : ""}`} data-diff={row.kind}>
      <span className={`select-none shrink-0 w-3 ${add ? "text-ok" : del ? "text-danger" : "text-text-faint"}`} aria-hidden="true">
        {add ? "+" : del ? "−" : " "}
      </span>
      <span className="flex-1 text-text">{row.text || " "}</span>
    </div>
  );
}

function UpdateView({ change }: { change: AgentChange }) {
  const rows = diffRows(change.before ?? "", change.after);
  if (rows.length === 0) {
    return (
      <div className="text-text-faint" data-testid="agent-change-nodiff">
        No visible change to the agent's file.
      </div>
    );
  }
  const shown = rows.slice(0, DIFF_COLLAPSE_ROWS);
  const rest = rows.slice(DIFF_COLLAPSE_ROWS);
  return (
    <div className="rounded-md bg-bg overflow-x-auto" data-testid="agent-change-diff">
      <div className="leading-snug w-max min-w-full py-1">
        {shown.map((r, i) => (
          <DiffLine key={i} row={r} />
        ))}
        {rest.length > 0 && (
          <details data-testid="agent-change-diff-more">
            <summary className="cursor-pointer text-text-muted px-3 py-1">
              Show {rest.length} more line{rest.length === 1 ? "" : "s"}
            </summary>
            {rest.map((r, i) => (
              <DiffLine key={i} row={r} />
            ))}
          </details>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2.5 h-2.5 shrink-0 rounded-full border-2 border-accent/35 border-t-accent-tx animate-spin motion-reduce:animate-none"
    />
  );
}

/** An evidence link: opens through the app (a plain anchor would be swallowed by the window handler), and says so when it can't. */
function EvidenceLink({ url, onError }: { url: string; onError: (message: string) => void }) {
  return (
    <a
      href={url}
      rel="noopener noreferrer"
      className="text-accent-tx hover:underline break-all"
      onClick={(e) => {
        e.preventDefault();
        Promise.resolve(window.api.openExternal(url)).catch(() => onError("Couldn't open the link. The address is shown above to copy."));
      }}
    >
      {url}
    </a>
  );
}

function EvidenceSection({ change }: { change: AgentChange }) {
  const lines = evidenceLines(change.evidence);
  const [linkError, setLinkError] = useState<string | null>(null);
  if (lines.length === 0) return null;
  return (
    <details data-testid="agent-change-evidence">
      <summary className="cursor-pointer text-text-muted">Evidence ({lines.length})</summary>
      <ul className="m-0 mt-2 list-none p-0 flex flex-col gap-2">
        {lines.map((e, i) => (
          <li key={i} className="flex flex-col gap-1 break-words" data-testid="agent-change-evidence-item">
            <span className="text-text">{e.claim}</span>
            {e.isPrivate ? (
              <span className="text-text-faint">Private source</span>
            ) : (
              <>
                {e.quote && <blockquote className="m-0 border-l-2 border-border pl-2 text-text-muted">{e.quote}</blockquote>}
                {e.url && <EvidenceLink url={e.url} onError={setLinkError} />}
              </>
            )}
          </li>
        ))}
      </ul>
      {linkError && (
        <div role="alert" className="mt-1 text-danger break-words" data-testid="agent-change-link-error">
          {linkError}
        </div>
      )}
    </details>
  );
}

function AdmissionSection({ change }: { change: AgentChange }) {
  const rules = change.admission ?? [];
  if (rules.length === 0) return null;
  return (
    <details data-testid="agent-change-admission">
      <summary className="cursor-pointer text-text-muted">Rules considered ({rules.length})</summary>
      <ul className="m-0 mt-2 list-none p-0 flex flex-col gap-2">
        {rules.map((r, i) => (
          <li key={i} className="flex flex-col gap-1 break-words" data-testid="agent-change-admission-item" data-verdict={r.verdict}>
            <span className="flex items-baseline gap-2 min-w-0">
              <Pill tone={r.verdict === "excluded" ? "neutral" : r.verdict === "general" ? "ok" : "accent"}>{verdictLabel(r.verdict)}</Pill>
              <span className="text-text">{r.rule}</span>
            </span>
            <span className="text-text-muted">{r.why}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Under the diff of a change to the Architect: what each added, changed or removed extra source does, and what it can reach. */
function SourceBlocks({ change }: { change: AgentChange }) {
  const blocks = isArchitectChange(change) ? architectSourceBlocks(change.before, change.after) : [];
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="agent-change-sources">
      {blocks.map((b) => (
        <div key={b.id} className="rounded-md bg-bg px-3 py-2 flex flex-col gap-1 break-words" data-testid="agent-change-source" data-change={b.change}>
          <div className="text-text font-medium">
            {b.change === "added" ? "New source" : b.change === "changed" ? "Changed source" : "Removed source"}: {b.name}
          </div>
          <code className="font-mono text-text-muted whitespace-pre-wrap break-all">{b.runs}</code>
          {b.change !== "removed" && <div className="text-text-muted">{b.line}</div>}
          {b.secrets.length > 0 && <div className="text-text-muted">Uses the secret{b.secrets.length === 1 ? "" : "s"}: {b.secrets.join(", ")}</div>}
          {b.note && <div className="text-text-faint">{b.note}</div>}
          {b.warning && (
            <div className="text-warn" data-testid="agent-change-source-warning">
              {b.warning}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/** The fold's label when the card is collapsed: "Show the change · 2 lines · based on 3 sources". */
function foldLabel(change: AgentChange): string {
  if (change.kind === "create") return "Show the new agent";
  const lines = changedLineCount(change);
  const sources = change.evidence?.length ?? 0;
  return ["Show the change", ...(lines > 0 ? [plural(lines, "line")] : []), ...(sources > 0 ? [`based on ${plural(sources, "source")}`] : [])].join(" · ");
}

/**
 * The card for one change record, drawn from the record alone. Its buttons call the box and await the answer; the new
 * record goes to `onChange` (the owner of the record replaces it), and the line saying what happened shows here.
 *
 * `collapsed` (the profile's pending card): ONE summary line — the chip, who and what, and the same buttons — with the change
 * itself (evidence, rules, the diff or the new agent) folded under "Show the change". What the user must read to decide or to
 * understand a press (the reason a click is needed, a refusal, the outcome) stays outside the fold. The buttons exist once, in
 * the order of the line (the primary one last, at the line's end).
 */
export function AgentChangeView({ change, onChange, collapsed = false }: { change: AgentChange; onChange: (next: AgentChange) => void; collapsed?: boolean }) {
  const [busy, setBusy] = useState<AgentChangeAction | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const press = async (action: AgentChangeAction) => {
    if (busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const next =
        action === "apply"
          ? await window.api.agentsChangeApply(change.id)
          : action === "discard"
            ? await window.api.agentsChangeDiscard(change.id)
            : await window.api.agentsChangeUndo(change.id);
      if (!alive.current) return;
      if (!next) throw new Error("The box didn't answer. Check the card again in a moment.");
      onChange(next);
      const outcome = agentChangeOutcome(action, next);
      // The new chip says it; add the short line only when it ended where the press aimed (a refusal says why instead).
      setNotice(next.state === outcome.state ? { tone: "ok", text: outcome.text, state: next.state } : null);
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: errText(e), state: change.state });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const chip = agentChangeChip(change);
  const reason = agentChangeReason(change);
  const actions = agentChangeActions(change.state);
  const anyBusy = busy !== null;
  const needsAttention = change.state === "failed" || change.state === "conflict";
  const sentence =
    change.state === "expired" && !change.error ? "This proposal expired. Ask Manta again if you still want it." : change.error;

  const buttons =
    actions.length === 0
      ? null
      : actions.map((action) => (
          <Button
            key={action}
            tone={action === "apply" && change.state === "pending" ? "primary" : "default"}
            loading={busy === action}
            disabled={anyBusy}
            onClick={() => void press(action)}
          >
            {agentChangeButtonLabel(action, change, busy === action)}
          </Button>
        ));

  // what the user reads to decide, and what says how a press ended
  const lead = (
    <>
      {reason && (
        <div className="text-warn" data-testid="agent-change-reason">
          {reason}
        </div>
      )}
      {change.state === "held" && (
        <div className="text-text-muted" data-testid="agent-change-held">
          The Architect is still working
        </div>
      )}
      {change.state === "applying" && (
        <div className="flex items-center gap-2 text-text-muted" data-testid="agent-change-applying">
          <Spinner />
          <span>Applying…</span>
        </div>
      )}
    </>
  );
  const detail = (
    <>
      <EvidenceSection change={change} />
      <AdmissionSection change={change} />
      {change.kind === "create" ? <CreateView change={change} /> : <UpdateView change={change} />}
      <SourceBlocks change={change} />
    </>
  );
  const outcome = (
    <>
      {sentence && change.state !== "applied" && (
        <div className="text-warn break-words" role={needsAttention ? "alert" : undefined} data-testid="agent-change-error">
          {sentence}
        </div>
      )}
      {notice && notice.state === change.state && (
        <div
          className={`break-words ${notice.tone === "ok" ? "text-ok" : "text-danger"}`}
          role={notice.tone === "error" ? "alert" : "status"}
          data-testid="agent-change-notice"
        >
          {notice.text}
        </div>
      )}
    </>
  );
  const chipPill = (
    <Pill tone={chip.tone}>
      <span data-testid="agent-change-chip">{chip.label}</span>
    </Pill>
  );

  if (collapsed) {
    return (
      <div className="text-meta" data-testid="agent-change-card" data-state={change.state}>
        <Card
          elevated={change.state === "pending"}
          warn={needsAttention}
          header={
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
              {chipPill}
              <div className="min-w-0 flex-1 basis-64 break-words text-body text-text" data-testid="agent-change-summary-line">
                <span className="font-semibold">{changeAuthor(change)}</span> · {change.summary || agentChangeTitle(change)}
              </div>
              {buttons && <div className="flex shrink-0 items-center gap-2">{[...buttons].reverse()}</div>}
            </div>
          }
        >
          <div className="flex flex-col gap-2">
            {lead}
            {outcome}
            <details data-testid="agent-change-fold" className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-meta font-medium text-text-faint hover:text-text [&::-webkit-details-marker]:hidden">
                <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                {foldLabel(change)}
              </summary>
              <div className="mt-2 flex flex-col gap-2">{detail}</div>
            </details>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="text-meta" data-testid="agent-change-card" data-state={change.state}>
      <Card
        elevated={change.state === "pending"}
        warn={needsAttention}
        header={
          <>
            <span
              className="inline-flex items-center justify-center w-[30px] h-[30px] rounded-md shrink-0 bg-accent-bg text-accent"
              aria-hidden="true"
            >
              <Bot size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-text font-medium mb-px break-words">{agentChangeTitle(change)}</div>
              {change.slug && <div className="text-text-faint mb-px">@{change.slug}</div>}
            </div>
            {chipPill}
          </>
        }
        actions={buttons ?? undefined}
      >
        <div className="flex flex-col gap-2">
          {change.summary && (
            <p className="m-0 text-text break-words" data-testid="agent-change-summary">
              {change.summary}
            </p>
          )}
          {lead}
          {detail}
          {outcome}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tool part
// ---------------------------------------------------------------------------

export const AgentChangeCard = memo(function AgentChangeCard({ part }: { part: OpencodePart }) {
  const p = part as Record<string, unknown>;
  const key = agentChangeKeyOf(p);
  const sessionID = key?.sessionID ?? null;
  const messageID = key?.messageID ?? null;
  const callID = key?.callID ?? null;
  const toolState = (p.state ?? {}) as { status?: string; output?: unknown };
  const status = String(toolState.status ?? "");
  const settled = status === "completed" || status === "error";

  const [record, setRecord] = useState<AgentChange | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const recordRef = useRef<AgentChange | null>(null);
  recordRef.current = record;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Reads and presses take a ticket; a read older than the newest applied one is dropped, a press result always lands.
  const tickets = useRef({ issued: 0, applied: 0 });
  const take = (record: AgentChange, ticket: number, force: boolean) => {
    if (!alive.current) return;
    if (!force && ticket < tickets.current.applied) return;
    tickets.current.applied = Math.max(tickets.current.applied, ticket);
    recordRef.current = record;
    setRecord(record);
  };

  const fetchRecord = useCallback(async () => {
    if (!sessionID || !messageID || !callID) return;
    const ticket = ++tickets.current.issued;
    try {
      const found = await window.api.agentsChangeFor({ sessionID, messageID, callID });
      if (!alive.current) return;
      if (found) take(found, ticket, false);
      setLoadError(null);
    } catch (e) {
      if (alive.current && !recordRef.current) setLoadError(errText(e));
    } finally {
      if (alive.current) setLoaded(true);
    }
    // `take` only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionID, messageID, callID]);

  // Subscribe first (declared first, so it runs before the settle fetch below), then read.
  useEffect(() => {
    if (!sessionID) return;
    const offs: Array<() => void> = [];
    const keep = (off: unknown) => {
      if (typeof off === "function") offs.push(off as () => void);
    };
    keep(
      window.api.onAgentChange?.((ev) => {
        if (ev.sessionID !== sessionID) return;
        const have = recordRef.current;
        if (have && ev.id !== have.id) return;
        void fetchRecord();
      }),
    );
    // After a reconnect the socket may have dropped events.
    keep(
      window.api.onStreamEvent?.((ev) => {
        if (ev.sub === "resync") void fetchRecord();
      }),
    );
    return () => offs.forEach((off) => off());
  }, [sessionID, fetchRecord]);

  useEffect(() => {
    if (!settled) return;
    setLoaded(false);
    void fetchRecord();
  }, [settled, fetchRecord]);

  // a press result always lands (it is the newest word on the record), whatever read is still in flight
  if (record) return <AgentChangeView change={record} onChange={(next) => take(next, ++tickets.current.issued, true)} />;

  if (!settled) {
    return (
      <div className={MUTED} data-testid="agent-change-preparing">
        Preparing the change…
      </div>
    );
  }
  if (key && !loaded && !loadError) {
    return (
      <div className={MUTED} data-testid="agent-change-loading">
        Loading the change…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="text-meta px-1 py-1 flex items-center gap-2 flex-wrap" data-testid="agent-change-load-error">
        <span className="text-danger break-words" role="alert">
          Couldn't load this change: {loadError}
        </span>
        <Button
          tone="default"
          onClick={() => {
            setLoadError(null);
            setLoaded(false);
            void fetchRecord();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  // Settled and the box has no record: the tool refused (its sentence is the part's output), failed, or the record was pruned.
  const output = typeof toolState.output === "string" ? toolState.output.trim() : "";
  const refusal = /^Not changed\b/i.test(output) ? output : null;
  return (
    <div className={MUTED} data-testid="agent-change-gone">
      {refusal ?? (status === "error" ? "The agent change tool failed." : "This change is no longer available")}
    </div>
  );
});
