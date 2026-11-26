// ===== The Fleet page (agent screens spec §2.1) =====
//
// Built for reviewing, not watching: what needs the user first (answered in place), then a recap since the last visit, then
// the agents × projects grid with this week's task counts. Needs you comes from the App (the sidebar badge reads the same
// read); the fleet itself is read here and kept fresh by the box's hints. No dollar budgets anywhere: the header carries the
// task count and the plan usage the composer's dial already shows.
//
// The grid is a native table (the `responsive-table` guide: header cells, a sticky row header, a named, keyboard-scrollable
// region). A cell with a task opens that task's session; an idle cell and a dash (no seat) are not buttons.

import { useEffect, useId, useRef } from "react";
import type { AgentFleet, NeedsYou } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { Button } from "../Button";
import { Pill } from "../Pill";
import { StatusDot } from "../StatusDot";
import { nowMs } from "../clock";
import { openNewAgentDraft } from "../newAgentDraft";
import { usePackageAgents } from "../packageAgents";
import { useStore } from "../store";
import { AgentsHeader, SectionTitle } from "./AgentsParts";
import { NeedsYouList } from "./NeedsYou";
import { cellView, hasFleetRows, planUsagePercent, recapLead, weekPill } from "./agentsView";
import { useAfter, useAgentsRead, type AgentsRead } from "./useAgentsRead";
import { useOpenTask } from "./useOpenTask";

/** A cell's width (`w-52`); the table scrolls sideways inside its region when the columns don't fit. */
export const FLEET_CELL_PX = 208;
const SKELETON_DELAY_MS = 150;

const TH = "text-left font-semibold text-text-faint px-2 py-2 border-b border-border sticky top-0 bg-bg z-[1] whitespace-nowrap";
const TD = "px-2 py-2 border-b border-border-subtle align-top";

function Skeleton() {
  return (
    <div className="manta-agents-skeleton flex flex-col gap-3" data-testid="fleet-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 rounded-md bg-fill" />
      ))}
    </div>
  );
}

function NeedsSection({
  needs,
  fleet,
  agents,
  sectionRef,
  headingRef,
}: {
  needs: AgentsRead<NeedsYou>;
  fleet: AgentFleet | null;
  agents: ReturnType<typeof usePackageAgents>["agents"];
  sectionRef: React.RefObject<HTMLElement>;
  headingRef: React.RefObject<HTMLHeadingElement>;
}) {
  const headingId = useId();
  return (
    <section ref={sectionRef} aria-labelledby={headingId} data-testid="fleet-needs" className="manta-agents-needs">
      <div className="mb-3 flex items-center gap-2">
        <h2 ref={headingRef} id={headingId} tabIndex={-1} className="m-0 text-label font-semibold text-text outline-none">
          Needs you
        </h2>
        {(needs.data?.count ?? 0) > 0 && (
          <span data-testid="needs-count">
            <Pill tone="warn">{needs.data?.count}</Pill>
          </span>
        )}
      </div>
      {needs.data ? (
        <NeedsYouList data={needs.data} agents={agents} projects={fleet?.projects ?? []} onChanged={() => void needs.reload()} />
      ) : needs.unsupported ? (
        <p className="m-0 text-label text-text-faint">Update the box to see what needs you.</p>
      ) : needs.error ? (
        <div className="flex flex-wrap items-center gap-2 text-label">
          <span role="alert" className="break-words text-danger">
            Couldn't load what needs you: {needs.error}
          </span>
          <Button tone="default" onClick={() => void needs.reload()}>
            Try again
          </Button>
        </div>
      ) : (
        <p className="m-0 text-label text-text-faint">Loading…</p>
      )}
    </section>
  );
}

function Grid({ fleet, onOpenProfile }: { fleet: AgentFleet; onOpenProfile: (slug: string) => void }) {
  const titleId = useId();
  const { open, busyId, error } = useOpenTask();
  return (
    <section data-testid="fleet-grid" className="manta-agents-grid" aria-labelledby={titleId}>
      <SectionTitle id={titleId} sub="· open a cell to see its task">
        Agents × projects
      </SectionTitle>
      {error && (
        <p role="alert" data-testid="fleet-open-error" className="m-0 mb-2 break-words text-meta text-danger">
          {error}
        </p>
      )}
      <div role="region" tabIndex={0} aria-labelledby={titleId} className="max-h-[min(500px,80vh)] max-w-full overflow-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <table className="w-full border-separate border-spacing-0 text-meta">
          <thead>
            <tr>
              <th className={`${TH} left-0 z-[2]`}>Agent</th>
              {fleet.projects.map((p) => (
                <th key={p.slug} className={TH}>
                  {p.name}
                </th>
              ))}
              <th className={`${TH} text-right`}>Tasks this week</th>
            </tr>
          </thead>
          <tbody>
            {fleet.rows.map((row) => (
              <tr key={row.slug} data-slug={row.slug}>
                <th scope="row" className={`${TD} sticky left-0 bg-bg text-left font-normal`}>
                  <button
                    type="button"
                    onClick={() => onOpenProfile(row.slug)}
                    title={`Open ${row.name}'s profile`}
                    className="flex items-center gap-2 rounded-sm text-left text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    <AgentBadge size="md" agent={{ name: row.name, slug: row.slug, color: row.color }} />
                    <span className="whitespace-nowrap font-medium">{row.name}</span>
                  </button>
                </th>
                {fleet.projects.map((p) => {
                  const view = cellView(row.cells[p.slug]);
                  if (view.kind === "none") {
                    return (
                      <td key={p.slug} className={TD}>
                        <div className="flex w-52 flex-col text-text-quiet">—</div>
                      </td>
                    );
                  }
                  const cell = row.cells[p.slug]!;
                  const body = (
                    <>
                      <span className="truncate text-text-muted" title={view.title}>
                        {view.title}
                      </span>
                      <span className="flex items-center gap-2 text-text-faint">
                        {view.tone !== "idle" && <StatusDot tone={view.tone} />}
                        <span className="truncate">{busyId === cell.jobId ? "Opening…" : view.line}</span>
                      </span>
                    </>
                  );
                  return (
                    <td key={p.slug} className={TD}>
                      {view.openable ? (
                        <button
                          type="button"
                          disabled={busyId != null}
                          onClick={() => void open(cell.jobId)}
                          title="Open this task's session"
                          className="manta-agents-cell flex w-52 flex-col gap-px rounded-sm text-left hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="manta-agents-cell flex w-52 flex-col gap-px">{body}</div>
                      )}
                    </td>
                  );
                })}
                <td className={`${TD} text-right tabular-nums text-text-muted`}>{row.tasksThisWeek}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function FleetPage({
  needs,
  focus,
  focusNonce,
  onOpenProfile,
}: {
  /** What needs the user — read by the App (the sidebar badge shows its count) and handed down. */
  needs: AgentsRead<NeedsYou>;
  /** "needs": the Needs you row opened this page — scroll its first section into view. */
  focus?: "needs";
  /** Changes on every press of that row, so pressing it again scrolls again. */
  focusNonce?: number;
  onOpenProfile: (slug: string) => void;
}) {
  const fleet = useAgentsRead<AgentFleet>(() => window.api.agentsFleet(), 0);
  const { agents } = usePackageAgents();
  const usage = useStore((s) => s.usage);
  const slow = useAfter(fleet.loading, SKELETON_DELAY_MS);
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The recap is "since the last visit": record the visit when the page is left — but only one that showed the fleet, so a
  // reload (or StrictMode's simulated unmount) doesn't eat the recap unseen.
  const shown = useRef(false);
  if (fleet.data) shown.current = true;
  useEffect(
    () => () => {
      if (!shown.current) return;
      Promise.resolve(window.api.agentsFleetSeen?.()).catch((e: unknown) => console.warn("[agents] couldn't record the fleet visit:", e));
    },
    [],
  );

  useEffect(() => {
    if (focus !== "needs") return;
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    headingRef.current?.focus({ preventScroll: true });
  }, [focus, focusNonce]);

  const data = fleet.data;
  const planPct = planUsagePercent(usage);

  return (
    <div className="manta-agents-pane manta-agents-fleet flex h-full w-full flex-col bg-bg" data-screen="agents-fleet">
      <AgentsHeader
        right={
          data && (
            <>
              <Pill tone="neutral" border>
                All projects
              </Pill>
              <Pill tone="neutral" border>
                {weekPill(data.week.tasks, planPct)}
              </Pill>
            </>
          )
        }
      >
        <h1 className="m-0 text-label font-medium text-text">Fleet</h1>
      </AgentsHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex flex-col gap-6 px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
          <NeedsSection needs={needs} fleet={data} agents={agents} sectionRef={sectionRef} headingRef={headingRef} />
          {fleet.loading ? (
            slow ? <Skeleton /> : null
          ) : fleet.unsupported ? (
            <p className="m-0 text-label text-text-faint" data-testid="fleet-unsupported">
              Update the box to see the fleet.
            </p>
          ) : fleet.error ? (
            <div className="flex flex-wrap items-center gap-2 text-label" data-testid="fleet-error">
              <span role="alert" className="break-words text-danger">
                Couldn't load the fleet: {fleet.error}
              </span>
              <Button tone="default" onClick={() => void fleet.reload()}>
                Try again
              </Button>
            </div>
          ) : data && !hasFleetRows(data) ? (
            <div className="flex flex-col items-start gap-2" data-testid="fleet-no-agents">
              <p className="m-0 text-label text-text-faint">No agents yet.</p>
              <Button tone="default" onClick={() => openNewAgentDraft()}>
                New agent
              </Button>
            </div>
          ) : data ? (
            <>
              {data.recap.lines.length > 0 && (
                <div className="manta-agents-recap rounded-md bg-fill px-3 py-2 text-label text-text-muted" data-testid="fleet-recap">
                  <b className="font-semibold text-text">{recapLead(data.recap.since, nowMs())}</b> {data.recap.lines.join(" · ")}
                </div>
              )}
              <Grid fleet={data} onOpenProfile={onOpenProfile} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
