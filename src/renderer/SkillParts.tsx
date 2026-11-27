// ===== Architect v2 Stage 2 — the skills a change card shows =====
//
// Shared by the change card (`AgentChangeView`) and the profile's Skills section (spec 2026-11-27-architect-v2.md §4). Drawn from the
// record alone: per skill what is done to it (new / replaces / removes), its files, where it came from with the licence and the install
// count, and the COPIED scripts flagged (a copied script is text no one at Manta wrote; an agent with a shell could run it). What the
// Architect searched for first is one native <details>. Every link opens through the app and says so when it can't (a plain anchor would
// be swallowed by the window handler); an address that isn't https is shown as text, never as a link.

import { useState } from "react";
import type { AgentChange } from "../shared/types";
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

/** Under the diff of a change that touches skills: each skill with its files and origin, and the search that came first. */
export function SkillsDiffBlock({ change }: { change: AgentChange }) {
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
                {s.paths.map((p) =>
                  s.scripts.includes(p) ? (
                    <li key={p} className="flex flex-wrap items-center gap-2" data-testid="agent-change-skill-script">
                      <span>{p}</span>
                      <Pill tone="warn">Copied script</Pill>
                    </li>
                  ) : (
                    <li key={p}>{p}</li>
                  ),
                )}
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
