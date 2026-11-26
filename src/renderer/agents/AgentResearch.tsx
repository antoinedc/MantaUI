// ===== The profile's Research tab (proposal A) =====
//
// Every library entry the agent relies on, as a hairline row: topic, "N sources · N days old", fresh / stale and thin (the warn
// tone). A row with something to show opens (a native disclosure) to the sources it rests on — each a link when the box gave a safe
// one — the private ones counted, and the other agents that rely on the same entry. A row the box sent no sources for (an older
// box) stays a plain row with its counts. The pane beside it says what the library is in one line, counts the stale and thin
// entries, and holds the refresh control.

import { useState } from "react";
import { BookOpen, ChevronRight } from "lucide-react";
import type { AgentProfile, AgentResearchEntry } from "../../shared/types";
import { Pill } from "../Pill";
import { researchMeta } from "../ResearchRows";
import { BlockTitle } from "./AgentsParts";
import { RefreshControl } from "./AgentRefresh";
import { Pane, PaneFacts, PaneGroup, TwoColumn } from "./ProfileLayout";
import { researchHealth } from "./agentsView";

const hasDetail = (e: AgentResearchEntry): boolean => (e.sources?.length ?? 0) > 0 || (e.privateSources ?? 0) > 0 || (e.usedBy?.length ?? 0) > 0;

/** A source link opens through the app (a plain anchor would be swallowed by the window handler) and says so when it can't. */
function SourceLink({ label, url, onError }: { label: string; url: string; onError: (message: string) => void }) {
  return (
    <a
      href={url}
      rel="noopener noreferrer"
      className="break-all text-accent-tx hover:underline"
      onClick={(e) => {
        e.preventDefault();
        Promise.resolve(window.api.openExternal(url)).catch(() => onError(`Couldn't open the link. The address: ${url}`));
      }}
    >
      {label}
    </a>
  );
}

function Summary({ entry }: { entry: AgentResearchEntry }) {
  return (
    <>
      <BookOpen size={16} aria-hidden="true" className="shrink-0 text-text-faint" />
      <span className="min-w-0 flex-1 text-body text-text">{entry.topic}</span>
      <span className="flex shrink-0 items-center gap-3 whitespace-nowrap text-meta text-text-faint">
        {entry.status === "missing" ? (
          <span>no longer in the library</span>
        ) : (
          <>
            {researchMeta(entry) && <span>{researchMeta(entry)}</span>}
            <span className="flex items-center gap-2">
              <Pill tone={entry.status === "stale" ? "warn" : "ok"}>{entry.status}</Pill>
              {entry.thin && <Pill tone="warn">thin</Pill>}
            </span>
          </>
        )}
      </span>
    </>
  );
}

function EntryRow({ entry, defaultOpen }: { entry: AgentResearchEntry; defaultOpen: boolean }) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const priv = entry.privateSources ?? 0;
  return (
    <li data-testid="research-entry" data-status={entry.status} className="border-b border-border-subtle">
      {hasDetail(entry) ? (
        <details open={defaultOpen} className="group">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-text-faint transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            <Summary entry={entry} />
          </summary>
          <div className="mb-3 ml-7 flex flex-col gap-2 text-meta">
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-text-muted">
              {(entry.sources ?? []).map((s) => (
                <li key={s.label}>{s.url ? <SourceLink label={s.label} url={s.url} onError={setLinkError} /> : <span>{s.label}</span>}</li>
              ))}
              {priv > 0 && <li className="text-text-faint">{priv === 1 ? "1 private source isn't listed" : `${priv} private sources aren't listed`}</li>}
            </ul>
            {(entry.usedBy?.length ?? 0) > 0 && <p className="m-0 text-text-faint">Also used by {entry.usedBy!.join(", ")}</p>}
            {linkError && (
              <div role="alert" className="break-words text-danger">
                {linkError}
              </div>
            )}
          </div>
        </details>
      ) : (
        <div className="flex min-h-10 items-center gap-3 py-2">
          <span className="w-3 shrink-0" aria-hidden="true" />
          <Summary entry={entry} />
        </div>
      )}
    </li>
  );
}

export function AgentResearch({ profile, onChanged }: { profile: AgentProfile; onChanged: () => void }) {
  const entries = profile.research;
  const health = researchHealth(entries);
  const refreshable = profile.info.role === "specialist";
  return (
    <TwoColumn
      main={
        <section data-testid="research-main">
          <BlockTitle>Research it relies on</BlockTitle>
          {entries.length === 0 ? (
            <p className="m-0 text-label text-text-faint" data-testid="research-empty">
              Nothing yet. The research this agent's changes rest on shows here.
            </p>
          ) : (
            <ul className="manta-agents-research m-0 list-none border-t border-border-subtle p-0" data-testid="research-entries">
              {entries.map((e, i) => (
                <EntryRow key={e.id} entry={e} defaultOpen={i === 0} />
              ))}
            </ul>
          )}
        </section>
      }
      pane={
        <Pane label="Research">
          <PaneGroup title="About the library" testId="research-about">
            <p className="m-0 text-label text-text">
              The research library is shared by every agent. Fresh means within its shelf life, stale past it, and thin means fewer than 3 independent sources.
            </p>
          </PaneGroup>
          <PaneGroup title="Health" testId="research-health">
            <PaneFacts rows={[["Stale", String(health.stale)], ["Thin", String(health.thin)], ...(health.missing > 0 ? [["Missing", String(health.missing)] as const] : [])]} />
          </PaneGroup>
          {refreshable && <RefreshControl profile={profile} onChanged={onChanged} note={false} />}
        </Pane>
      }
    />
  );
}
