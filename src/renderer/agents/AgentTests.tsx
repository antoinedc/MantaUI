// ===== The profile's Tests tab (Architect v2 §3.4) =====
//
// The trial runs the Architect made of this agent's drafts, newest first: one hairline row per trial (when, how many cases, the
// verdict of the proposal that used it), opening (a native disclosure) to its cases — what each was expected to do, how it ended,
// the Architect's verdict and quote, and its transcript. The pane says plainly what a trial may and may not do.

import { ChevronRight, FlaskConical } from "lucide-react";
import type { AgentChange, AgentTrial } from "../../shared/types";
import { Pill } from "../Pill";
import { TrialCaseList } from "../TrialParts";
import { trialCountLine, trialDate, trialRows, trialVerdictOf, verdictsFor } from "../agentTrial";
import { BlockTitle } from "./AgentsParts";
import { Pane, PaneGroup, TwoColumn } from "./ProfileLayout";

export const TRIAL_SAFETY_NOTE = "Runs on this box with the agent's permissions, minus secrets, publishing and sending.";

function TrialRow({ trial, records, defaultOpen }: { trial: AgentTrial; records: ReadonlyArray<AgentChange> | null; defaultOpen: boolean }) {
  const verdict = trialVerdictOf(trial, records);
  const running = trial.cases.some((c) => c.state === "queued" || c.state === "running");
  return (
    <li data-testid="trial-row" className="border-b border-border-subtle">
      <details open={defaultOpen} className="group">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-text-faint transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          <FlaskConical size={16} aria-hidden="true" className="shrink-0 text-text-faint" />
          <span className="min-w-0 flex-1 text-body text-text">{trialDate(trial.createdAt)}</span>
          <span className="flex shrink-0 items-center gap-3 whitespace-nowrap text-meta text-text-faint">
            <span>{trialCountLine(trial.cases)}</span>
            {running ? (
              <Pill tone="neutral">running</Pill>
            ) : verdict ? (
              <Pill tone={verdict === "passed" ? "ok" : "danger"}>
                <span data-testid="trial-row-verdict">{verdict}</span>
              </Pill>
            ) : null}
          </span>
        </summary>
        <div className="mb-3 ml-8 text-meta">
          <TrialCaseList trialId={trial.id} rows={trialRows(trial.cases, verdictsFor(trial.id, records))} canRead />
        </div>
      </details>
    </li>
  );
}

export function AgentTests({ trials, records }: { trials: ReadonlyArray<AgentTrial>; records: ReadonlyArray<AgentChange> | null }) {
  const sorted = [...trials].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <TwoColumn
      main={
        <section data-testid="tests-main">
          <BlockTitle>Trial runs</BlockTitle>
          <ul className="m-0 list-none border-t border-border-subtle p-0" data-testid="tests-trials">
            {sorted.map((t, i) => (
              <TrialRow key={t.id} trial={t} records={records} defaultOpen={i === 0} />
            ))}
          </ul>
        </section>
      }
      pane={
        <Pane label="Tests">
          <PaneGroup title="About tests" testId="tests-about">
            <p className="m-0 text-label text-text">
              Before proposing a change, the Architect runs the draft on sample tasks and judges what it did. {TRIAL_SAFETY_NOTE}
            </p>
          </PaneGroup>
        </Pane>
      }
    />
  );
}
