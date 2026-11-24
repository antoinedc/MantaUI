// ===== Agents Phase 5A — the proposals an Architect task made, under its result card =====
//
// The box keeps one change record per proposal, tagged with the delegate job that made it. The result card of an Architect
// job lists them by that job id and keeps them fresh: it fetches on mount, refetches on an `agentChange` hint whose origin
// names this job, and after a reconnect (the stream's resync frame). A read that lands after a newer one never rolls the list
// back; a press on a record replaces just that record. Every record is the same card the lead's `agent_change` shows.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AgentChange } from "../shared/types";
import { AgentChangeView } from "./AgentChangeCard";
import { Button } from "./Button";

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";

export const ArchitectChanges = memo(function ArchitectChanges({ jobId }: { jobId: string }) {
  const [records, setRecords] = useState<AgentChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const tickets = useRef({ issued: 0, applied: 0 });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const ticket = ++tickets.current.issued;
    try {
      const list = await window.api.agentsChangesForJob(jobId);
      if (!alive.current || ticket < tickets.current.applied) return; // an older read never rolls a newer one back
      tickets.current.applied = ticket;
      setRecords(Array.isArray(list) ? list : []);
      setError(null);
    } catch (e) {
      if (alive.current) setError(errText(e));
    }
  }, [jobId]);

  // Subscribe first, then read, so a transition between the two is not missed.
  useEffect(() => {
    const offs: Array<() => void> = [];
    const keep = (off: unknown) => {
      if (typeof off === "function") offs.push(off as () => void);
    };
    keep(
      window.api.onAgentChange?.((ev) => {
        if (ev.origin?.kind === "job" && ev.origin.jobId === jobId) void load();
      }),
    );
    // After a reconnect the socket may have dropped events.
    keep(
      window.api.onStreamEvent?.((ev) => {
        if (ev.sub === "resync") void load();
      }),
    );
    void load();
    return () => offs.forEach((off) => off());
  }, [jobId, load]);

  const replace = useCallback((next: AgentChange) => {
    tickets.current.applied = ++tickets.current.issued; // the press result is the newest word
    setRecords((have) => (have ?? []).map((r) => (r.id === next.id ? next : r)));
  }, []);

  if (error && !records) {
    return (
      <div className="mt-2 text-meta flex items-center gap-2 flex-wrap" data-testid="agent-change-list-error">
        <span className="text-danger break-words" role="alert">
          Couldn't load the Architect's proposals: {error}
        </span>
        <Button
          tone="default"
          onClick={() => {
            setError(null);
            void load();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!records || records.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col" style={{ gap: "var(--block-gap)" }} data-testid="agent-change-list">
      {records.map((r) => (
        <AgentChangeView key={r.id} change={r} onChange={replace} />
      ))}
    </div>
  );
});
