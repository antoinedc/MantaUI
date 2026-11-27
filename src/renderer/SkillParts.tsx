// ===== Architect v2 Stage 2 — the skills a change card shows =====
//
// Shared by the change card (`AgentChangeView`) and the profile's Skills section (spec 2026-11-27-architect-v2.md §4). Drawn from the
// record alone: per skill what is done to it (new / replaces / removes), its files, where it came from with the licence and the install
// count, and the COPIED scripts flagged (a copied script is text no one at Manta wrote; an agent with a shell could run it). What the
// Architect searched for first is one native <details>. Every link opens through the app and says so when it can't (a plain anchor would
// be swallowed by the window handler); an address that isn't https is shown as text, never as a link.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentChange } from "../shared/types";
import { diffRows } from "./agentChange";
import { Button } from "./Button";
import { DiffLine } from "./DiffLine";
import { Pill } from "./Pill";
import { candidateVerdictLabel, hasSkillChanges, httpsUrl, provenanceLine, registryLine, skillOpLabel, skillSearchLine } from "./agentSkills";

const H4 = "m-0 text-meta font-semibold uppercase tracking-wider text-text-faint";

/** An address that opens through the app; when it can't open, the sentence says so under it. Not https → plain text. */
export function OriginLink({ url, errorTestId }: { url: string; errorTestId: string }) {
  const [error, setError] = useState<string | null>(null);
  const safe = httpsUrl(url);
  if (!safe) return <span className="break-all text-text-faint">{url}</span>;
  return (
    <>
      <a
        href={safe}
        rel="noopener noreferrer"
        className="text-accent-tx hover:underline break-all"
        onClick={(e) => {
          e.preventDefault();
          setError(null);
          Promise.resolve(window.api.openExternal(safe)).catch(() => setError("Couldn't open the link. Copy the address shown."));
        }}
      >
        {safe}
      </a>
      {error && (
        <div role="alert" className="text-danger break-words" data-testid={errorTestId}>
          {error}
        </div>
      )}
    </>
  );
}

type FileState =
  | { status: "idle" | "loading" }
  | { status: "ready"; before: string | null; after: string | null; truncated: boolean }
  | { status: "error"; message: string };

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";

/** One changed file of a skill: a native <details>; opening it reads the file from the box (once) and shows its text, or a diff against what was there. */
function SkillFile({ changeId, skill, path, script, onOpened }: { changeId: string; skill: string; path: string; script: boolean; onOpened?: (key: string) => void }) {
  const full = `skills/${skill}/${path}`;
  const [state, setState] = useState<FileState>({ status: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const r = await window.api.agentsChangeFile({ id: changeId, path: full });
      if (!alive.current) return;
      if (!r || (r.before !== null && typeof r.before !== "string") || (r.after !== null && typeof r.after !== "string")) throw new Error("The box didn't answer. Try again in a moment.");
      setState({ status: "ready", before: r.before, after: r.after, truncated: r.truncated === true });
      onOpened?.(`${skill}/${path}`); // only a file that was really read counts as opened
    } catch (e) {
      if (alive.current) setState({ status: "error", message: errText(e) });
    }
  }, [changeId, full, onOpened, skill, path]);
  const rows = state.status === "ready" && state.before !== null && state.after !== null ? diffRows(state.before, state.after) : [];
  return (
    <details
      data-testid="agent-change-skill-file"
      data-path={full}
      data-script={script ? "true" : undefined}
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state.status === "idle") void load();
      }}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-text-muted">
        <span>{path}</span>
        {script && <Pill tone="warn">Script</Pill>}
      </summary>
      <div className="mt-1 flex flex-col gap-1 font-sans" data-testid="agent-change-skill-file-body">
        {state.status === "loading" && <span className="text-text-faint">Loading…</span>}
        {state.status === "error" && (
          <span className="flex flex-wrap items-center gap-2">
            <span role="alert" className="break-words text-danger" data-testid="agent-change-skill-file-error">
              Couldn't open {path}: {state.message}
            </span>
            <Button tone="default" onClick={() => void load()}>
              Try again
            </Button>
          </span>
        )}
        {state.status === "ready" && (
          <>
            {state.before === null && state.after !== null && <span className="text-text-faint">New file</span>}
            {state.after === null && state.before !== null && <span className="text-text-faint">Removed file</span>}
            {state.before !== null && state.after !== null && rows.length === 0 && <span className="text-text-faint">Unchanged</span>}
            {rows.length > 0 ? (
              <div className="overflow-x-auto rounded-md bg-fill">
                <div className="w-max min-w-full py-1 font-mono leading-snug">
                  {rows.map((r, i) => (
                    <DiffLine key={i} row={r} />
                  ))}
                </div>
              </div>
            ) : (
              (state.after ?? state.before) !== null &&
              state.before !== state.after && <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-fill px-3 py-2 font-mono text-text-muted">{state.after ?? state.before}</pre>
            )}
            {state.truncated && <span className="text-text-faint">Shown cut short: the file is longer than the box shows.</span>}
          </>
        )}
      </div>
    </details>
  );
}

/** Under the diff of a change that touches skills: each skill with its files and origin, and the search that came first. `onOpened`: a file was read. */
export function SkillsDiffBlock({ change, onOpened }: { change: AgentChange; onOpened?: (key: string) => void }) {
  if (!hasSkillChanges(change)) return null;
  const search = change.skillSearch;
  return (
    <section className="flex flex-col gap-2 rounded-md bg-bg px-3 py-2 break-words" data-testid="agent-change-skills" aria-label="Skills">
      <h4 className={H4}>Skills</h4>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {(change.skillsDiff ?? []).map((s) => (
          <li key={s.name} className="flex flex-col gap-1" data-testid="agent-change-skill" data-op={s.op}>
            <span className="flex flex-wrap items-baseline gap-2">
              <Pill tone={s.op === "remove" ? "warn" : s.op === "add" ? "accent" : "neutral"}>{skillOpLabel(s.op)}</Pill>
              <span className="font-medium text-text">{s.name}</span>
            </span>
            {s.op !== "remove" && (
              <>
                <span className="text-text-muted">{provenanceLine(s.provenance)}</span>
                {s.provenance && <OriginLink url={s.provenance.url} errorTestId="agent-change-skill-link-error" />}
              </>
            )}
            {s.paths.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-px p-0 font-mono text-text-muted" aria-label={`Files of ${s.name}`}>
                {s.paths.map((p) => (
                  <li key={p}>
                    <SkillFile changeId={change.id} skill={s.name} path={p} script={s.op !== "remove" && s.scripts.includes(p)} onOpened={onOpened} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {search && (
        <details data-testid="agent-change-skill-search">
          <summary className="cursor-pointer text-text-muted">{skillSearchLine(search)}</summary>
          <div className="mt-2 flex flex-col gap-2">
            <ul className="m-0 flex list-none flex-col gap-px p-0 text-text-muted" aria-label="Searches">
              {search.queries.map((q, i) => (
                <li key={i}>
                  <span className="text-text-faint">{q.source}: </span>
                  {q.query}
                </li>
              ))}
            </ul>
            {search.candidates.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Skills looked at">
                {search.candidates.map((c, i) => {
                  const meta = [registryLine({ installs: c.installs, stars: c.stars }), c.licence].filter(Boolean).join(" · ");
                  return (
                    <li key={i} className="flex flex-col gap-1" data-testid="agent-change-skill-candidate" data-verdict={c.verdict}>
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-text">{c.ref}</span>
                        <Pill tone={c.verdict === "rejected" ? "neutral" : "ok"}>{candidateVerdictLabel(c.verdict)}</Pill>
                        {meta && <span className="text-text-faint">{meta}</span>}
                      </span>
                      <span className="text-text-muted">{c.why}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
