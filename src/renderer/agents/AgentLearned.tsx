// ===== The profile's Learned tab (Architect v2 §5.1) =====
//
// What this agent has learned from the user's own corrections: one hairline row per rule — the rule, when it was learned, and
// "inferred" where it goes beyond what the user said — grouped by where it applies (every project first, then each project).
// A row's evidence is a native disclosure: the user's own words, why Manta wrote the rule, and a way to open the task that
// taught it. Undo takes the rule back through the box (its words then can't produce it again) and says so; a refusal is a sentence.
// Rules past the 30 an agent keeps are listed apart, read-only: nothing on them can be pressed. Nothing here needs approving.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LearnedRule } from "../../shared/types";
import { Button } from "../Button";
import { BlockTitle, QuietLink } from "./AgentsParts";
import { Pane, PaneGroup, TwoColumn } from "./ProfileLayout";
import { dateLabel, errText } from "./agentsView";
import { useOpenTask } from "./useOpenTask";

const EVERY_PROJECT = "_all";

/** The rules by where they apply: every project first, then each project by its name. */
export function groupRules(rules: ReadonlyArray<LearnedRule>, nameOf: (slug: string) => string): Array<{ scope: string; title: string; rules: LearnedRule[] }> {
  const by = new Map<string, LearnedRule[]>();
  for (const r of [...rules].sort((a, b) => b.createdAt - a.createdAt)) by.set(r.scope, [...(by.get(r.scope) ?? []), r]);
  return [...by.entries()]
    .map(([scope, list]) => ({ scope, title: scope === EVERY_PROJECT ? "Every project" : nameOf(scope), rules: list }))
    .sort((a, b) => (a.scope === EVERY_PROJECT ? -1 : b.scope === EVERY_PROJECT ? 1 : a.title.localeCompare(b.title)));
}

function RuleMeta({ r }: { r: LearnedRule }) {
  return (
    <span className="text-meta text-text-faint">
      <span data-testid="learned-when">Learned {dateLabel(r.createdAt)}</span>
      {r.whyIsInferred && <span title="Manta went a little beyond your words to write this rule"> · inferred</span>}
    </span>
  );
}

function Evidence({ r, onOpenTask, opening }: { r: LearnedRule; onOpenTask: (jobId: string) => void; opening: boolean }) {
  return (
    <details className="group mt-1" data-testid="learned-evidence">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-meta font-medium text-text-faint hover:text-text [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        Evidence
      </summary>
      <div className="mt-1 flex flex-col gap-1 break-words text-meta">
        {r.quote && <blockquote className="m-0 border-l-2 border-border pl-3 text-text-muted">“{r.quote}”</blockquote>}
        {r.why && <div className="text-text-faint">{r.why}</div>}
        {r.sourceJobId && (
          <div>
            <QuietLink onClick={() => onOpenTask(r.sourceJobId as string)} disabled={opening}>
              {opening ? "Opening…" : "Open the task"}
            </QuietLink>
          </div>
        )}
      </div>
    </details>
  );
}

export function AgentLearned({
  slug,
  rules,
  projectName,
  onChanged,
}: {
  slug: string;
  rules: ReadonlyArray<LearnedRule>;
  /** A project's name from its registry slug (the slug itself when unknown). */
  projectName: (slug: string) => string;
  /** A rule was taken back: the owner reads the agent and its history again. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const task = useOpenTask();
  const live = rules.filter((r) => !r.archived);
  const archived = rules.filter((r) => r.archived);

  const undo = async (r: LearnedRule) => {
    if (busy) return;
    setBusy(r.id);
    setNotice(null);
    setError(null);
    try {
      const made = await window.api.agentsLearnedUndo({ slug, id: r.id });
      if (!made) throw new Error("The box didn't answer. Check the list again in a moment.");
      setNotice(`Removed “${r.rule}”. It won't be learned again from the same words.`);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <TwoColumn
      main={
        <section data-testid="learned-main">
          <BlockTitle>Learned from your corrections</BlockTitle>
          {live.length === 0 ? (
            <p className="m-0 text-label text-text-faint" data-testid="learned-empty">
              Nothing learned yet. When you correct this agent's work or say how you always want something done, Manta writes the rule down here, with your own words as the evidence.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groupRules(live, projectName).map((g) => (
                <section key={g.scope} data-testid="learned-group" aria-labelledby={`learned-${g.scope}`}>
                  <h4 id={`learned-${g.scope}`} data-testid="learned-group-title" className="m-0 mb-1 text-label font-medium text-text-muted">
                    {g.title}
                  </h4>
                  <ul className="m-0 list-none border-t border-border-subtle p-0">
                    {g.rules.map((r) => (
                      <li key={r.id} data-testid="learned-row" data-id={r.id} className="flex items-start gap-3 border-b border-border-subtle py-3">
                        <div className="min-w-0 flex-1">
                          <div data-testid="learned-rule" className="break-words text-body text-text">
                            {r.rule}
                          </div>
                          <RuleMeta r={r} />
                          <Evidence r={r} onOpenTask={(id) => void task.open(id)} opening={task.busyId === r.sourceJobId} />
                        </div>
                        <Button tone="default" loading={busy === r.id} disabled={busy !== null} onClick={() => void undo(r)} title="Take this rule back. The same words won't produce it again.">
                          {busy === r.id ? "Undoing…" : "Undo"}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          <div role="status" data-testid="learned-notice" className="mt-3 break-words text-meta text-ok empty:hidden">
            {notice}
          </div>
          {(error || task.error) && (
            <div role="alert" data-testid="learned-error" className="mt-3 break-words text-meta text-danger">
              {error ?? task.error}
            </div>
          )}
          {archived.length > 0 && (
            <details className="group mt-4 border-t border-border-subtle pt-3" data-testid="learned-archived">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-label font-medium text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
                Kept, no longer given to the agent · {archived.length}
              </summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {archived.map((r) => (
                  <li key={r.id} className="break-words text-label text-text-muted">
                    {r.rule}
                    <span className="block text-meta text-text-faint">
                      {r.scope === EVERY_PROJECT ? "Every project" : projectName(r.scope)} · learned {dateLabel(r.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      }
      pane={
        <Pane label="Learned">
          <PaneGroup title="How rules are learned" testId="learned-about">
            <p className="m-0 text-label text-text">
              When you clearly correct this agent, or say how you always want something done, Manta writes a rule down and gives it to the agent's later tasks in the same project, apart from its instructions. There is
              nothing to approve; Undo takes a rule back. What Manta does on its own is set in Settings → Agents, under "Learn a preference from your corrections".
            </p>
          </PaneGroup>
        </Pane>
      }
    />
  );
}
