// ===== Architect v2 Stage 1 — the problem, the trial cases and a case's transcript =====
//
// Shared by the change card (`AgentChangeView`) and the profile's Tests tab (spec 2026-11-27-architect-v2.md §3.4). A case's
// transcript opens in a dialog (the shared Modal: focus trap, Escape, focus restored), read from the box a window at a time with
// "Load more" while the box says there is more. A Transcript button is only drawn for a case that ended in a trial the box still
// has; every press ends visibly (the text, or the box's sentence and Try again).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentChange, AgentProblem, AgentTrial } from "../shared/types";
import { Button } from "./Button";
import { Modal } from "./Modal";
import { Pill } from "./Pill";
import { caseEnded, caseStateLabel, expectLabel, trialRows, type TrialRow } from "./agentTrial";

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";

const H4 = "m-0 text-meta font-semibold uppercase tracking-wider text-text-faint";

/** The problem the proposal answers: the user's words, the shapes considered (the chosen one marked) and why. */
export function ProblemBlock({ problem }: { problem: AgentProblem }) {
  const shapes = Array.isArray(problem.shapes) ? problem.shapes : [];
  return (
    <section className="flex flex-col gap-2 rounded-md bg-bg px-3 py-2 break-words" data-testid="agent-change-problem" aria-label="The problem">
      <h4 className={H4}>The problem</h4>
      <blockquote className="m-0 border-l-2 border-border pl-2 text-text" data-testid="agent-change-problem-quote">
        {problem.userWords}
      </blockquote>
      {problem.statement && <p className="m-0 text-text-muted">{problem.statement}</p>}
      {shapes.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Ways to solve it">
          {shapes.map((s, i) => {
            const chosen = i === problem.chosen;
            return (
              <li key={i} className="flex flex-col gap-1" data-testid="agent-change-shape" data-chosen={chosen ? "true" : undefined}>
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className={chosen ? "font-medium text-text" : "text-text-muted"}>{s.shape}</span>
                  {chosen && <Pill tone="accent">Chosen</Pill>}
                </span>
                {s.wouldBuild && <span className="text-text-faint">{s.wouldBuild}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {problem.why && (
        <div>
          <span className="text-text-faint">Why: </span>
          <span className="text-text-muted">{problem.why}</span>
        </div>
      )}
    </section>
  );
}

/** One case's transcript in a dialog, a window at a time. Mounted only while open. */
export function TrialTranscriptDialog({ trialId, caseName, onClose }: { trialId: string; caseName: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await window.api.agentsTrialTranscript({ id: trialId, case: caseName, offset });
        if (!alive.current) return;
        if (!page || typeof page.text !== "string") throw new Error("The box didn't answer. Try again in a moment.");
        setText((t) => (offset === 0 ? page.text : t + page.text));
        setNext(typeof page.nextOffset === "number" ? page.nextOffset : null);
      } catch (e) {
        if (alive.current) setError(errText(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [trialId, caseName],
  );
  useEffect(() => {
    setText("");
    setNext(0);
    void load(0);
  }, [load]);

  const started = text.length > 0 || next !== 0;
  return (
    <Modal size="lg" tall padded={false} onDismiss={onClose} label={`Transcript · ${caseName}`}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h3 className="m-0 min-w-0 flex-1 truncate text-title font-semibold text-text">Transcript · {caseName}</h3>
        <Button tone="default" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-meta" data-testid="trial-transcript">
        {text ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-text-muted">{text}</pre>
        ) : !error && !started ? (
          <p className="m-0 text-text-faint">Loading…</p>
        ) : !error ? (
          <p className="m-0 text-text-faint">This case left no transcript.</p>
        ) : null}
        {error && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span role="alert" className="break-words text-danger" data-testid="trial-transcript-error">
              Couldn't load the transcript: {error}
            </span>
            <Button tone="default" loading={loading} onClick={() => void load(text ? (next ?? 0) : 0)}>
              Try again
            </Button>
          </div>
        )}
        {!error && text && next !== null && (
          <div className="mt-2">
            <Button tone="default" loading={loading} onClick={() => void load(next)}>
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The cases of a trial: name, what it was expected to do, how it ended, the verdict with its quote, and Transcript. */
export function TrialCaseList({ trialId, rows, canRead }: { trialId: string; rows: TrialRow[]; canRead: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-col gap-1 break-words" data-testid="trial-case" data-state={r.state ?? undefined}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text">{r.name}</span>
              {r.expect && <span className="text-text-faint">{expectLabel(r.expect)}</span>}
              {r.state && r.state !== "done" && <Pill tone={r.state === "running" || r.state === "queued" ? "neutral" : "warn"}>{caseStateLabel(r.state)}</Pill>}
              {r.verdict && (
                <Pill tone={r.verdict.pass ? "ok" : "danger"}>
                  <span data-testid="trial-case-verdict">{r.verdict.pass ? "Passed" : "Failed"}</span>
                </Pill>
              )}
              {canRead && caseEnded(r.state) && (
                <Button tone="ghost" onClick={() => setOpen(r.name)} title="Read what the agent did in this case">
                  Transcript
                </Button>
              )}
            </span>
            {r.verdict?.quote && <blockquote className="m-0 border-l-2 border-border pl-2 text-text-muted">{r.verdict.quote}</blockquote>}
            {r.verdict?.note && <span className="text-text-faint">{r.verdict.note}</span>}
          </li>
        ))}
      </ul>
      {open !== null && <TrialTranscriptDialog trialId={trialId} caseName={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The trial block of a change card: the verdicts from the record, joined to the trial's cases read from the box. */
export function TrialBlock({ change }: { change: AgentChange }) {
  const id = change.trial?.id ?? "";
  const [trial, setTrial] = useState<AgentTrial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const t = await window.api.agentsTrial({ id });
      if (!alive.current) return;
      if (!t || !Array.isArray(t.cases)) throw new Error("The box didn't answer. Try again in a moment.");
      setTrial(t);
    } catch (e) {
      if (alive.current) setError(errText(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    setTrial(null);
    void load();
  }, [load]);

  if (!change.trial) return null;
  const rows = trialRows(trial?.cases ?? null, change.trial.verdicts);
  return (
    <section className="flex flex-col gap-2 rounded-md bg-bg px-3 py-2" data-testid="agent-change-trial" aria-label="Trial run">
      <h4 className={H4}>Trial run</h4>
      <TrialCaseList trialId={id} rows={rows} canRead={trial !== null} />
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-words text-text-faint" data-testid="agent-change-trial-error">
            The trial's details couldn't be read: {error}
          </span>
          <Button tone="default" loading={loading} onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
