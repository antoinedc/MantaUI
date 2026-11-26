// The one rendering of research-library entries (agent screens spec §2.5): topic, "N sources · 3 days old", and a fresh /
// stale pill plus a "thin" pill (warn tone, like stale: both are cautions). Used by the task side panel and by the agent profile's Research tab.

import { BookOpen } from "lucide-react";
import type { AgentResearchEntry } from "../shared/types";
import { Pill } from "./Pill";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "5 sources · 3 days old" — either half is left out when the box doesn't know it. */
export function researchMeta(e: Pick<AgentResearchEntry, "sourceCount" | "ageDays">): string {
  const parts: string[] = [];
  if (e.sourceCount != null) parts.push(plural(e.sourceCount, "source", "sources"));
  if (e.ageDays != null) parts.push(e.ageDays <= 0 ? "today" : `${plural(e.ageDays, "day", "days")} old`);
  return parts.join(" · ");
}

export function ResearchRows({
  entries,
  emptyText = "None yet",
  limit,
}: {
  entries: ReadonlyArray<AgentResearchEntry>;
  emptyText?: string;
  limit?: number;
}) {
  const shown = limit != null ? entries.slice(0, limit) : entries;
  if (shown.length === 0) {
    return (
      <p className="m-0 text-label text-text-faint" data-testid="research-empty">
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="manta-agents-research m-0 flex list-none flex-col p-0" data-testid="research-rows">
      {shown.map((e) => (
        <li
          key={e.id}
          data-testid="research-row"
          data-status={e.status}
          className="flex items-center gap-2 border-b border-border-subtle py-2 text-label"
        >
          <BookOpen size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
          <span className="min-w-0 truncate text-text" title={e.topic}>
            {e.topic}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-meta text-text-faint">
            {e.status === "missing" ? (
              <span>no longer in the library</span>
            ) : (
              <>
                {researchMeta(e) && <span>{researchMeta(e)}</span>}
                <Pill tone={e.status === "stale" ? "warn" : "ok"}>{e.status}</Pill>
                {e.thin && <Pill tone="warn">thin</Pill>}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
