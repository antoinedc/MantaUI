// The sidebar's Agents section (agent screens spec §1.1): the Needs you and Fleet rows, one row per agent on the box, and a
// New agent button.
//
//  - Needs you and Fleet open their own pages. Needs you carries ONE red number — the decisions waiting on the user — or, when only
//    optional questions are open, a small blue dot; Fleet carries the number of tasks in progress (a plain number, not an alert).
//  - Clicking an agent opens its PROFILE. Its direct chat is the profile's Chat button (a window in the hidden "manta-agents"
//    tmux session), so a row never opens a window itself.
//  - New agent opens a new-chat draft with Manta, "Create an agent that " typed, in the active project. Nothing is created
//    until the user sends it; the old name-and-description dialog is gone.
//
// Every control here does something visible: a page opens, a draft opens. An invalid agent's row still opens (its profile says
// what is wrong) and carries its error as the tooltip.

import { useId } from "react";
import { Inbox, LayoutGrid, Plus } from "lucide-react";
import type { AgentInfo } from "../shared/types";
import { Button } from "./Button";
import { agentInitial, leadAgent } from "./agentDispatch";
import type { AgentsView } from "./agents/agentsView";
import { openNewAgentDraft } from "./newAgentDraft";
import { usePackageAgents } from "./packageAgents";
import { ROW_SELECTED } from "./SessionRow";
import { Tag } from "./Tag";

const ROW_CLASS =
  "group relative z-[1] flex w-full items-center gap-2 rounded-md min-h-[var(--row-h)] px-[var(--row-px)] py-[var(--row-py)] text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1";

function AgentRow({ agent, selected, onOpen }: { agent: AgentInfo; selected: boolean; onOpen: () => void }) {
  const invalid = !!agent.error;
  const isLead = agent.role === "lead" && !invalid;
  const isArchitect = agent.role === "architect" && !invalid;
  const noticeId = useId();
  const showNotice = !!agent.notice;
  const title = invalid
    ? `${agent.name || agent.slug}: ${agent.error}`
    : isArchitect
      ? `${agent.description || agent.name} Ask Manta to build or improve an agent; the Architect does it as a task.`
      : agent.description || agent.name;
  return (
    <>
      <button
        type="button"
        data-rail-row=""
        data-testid="agent-row"
        data-slug={agent.slug}
        onClick={onOpen}
        aria-current={selected ? "page" : undefined}
        aria-describedby={showNotice ? noticeId : undefined}
        title={title}
        className={`${ROW_CLASS} ${selected ? ROW_SELECTED : "hover:bg-fill-hover"}${invalid ? " opacity-70" : ""}`}
      >
        <span
          aria-hidden="true"
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-sm bg-fill-hover text-micro font-semibold text-text"
          style={agent.color ? { backgroundColor: agent.color, color: "#fff" } : undefined}
        >
          {agentInitial(agent)}
        </span>
        <span className="flex-1 min-w-0 truncate text-label font-medium text-text">{agent.name || agent.slug}</span>
        {isLead && (
          <Tag size="sm" tone="accent" title="Leads every chat and hands work to the other agents">
            lead
          </Tag>
        )}
        {isArchitect && (
          <Tag size="sm" title="Works through tasks Manta hands it; ask Manta to build or improve an agent">
            via Manta
          </Tag>
        )}
        {invalid && <span className="shrink-0 text-micro text-danger">invalid</span>}
      </button>
      {showNotice && (
        <p id={noticeId} data-testid="agent-notice" className="m-0 px-[var(--row-px)] pb-1 text-micro text-text-faint">
          {agent.notice}
        </p>
      )}
    </>
  );
}

function NavRow({
  name,
  label,
  icon,
  selected,
  badge,
  dot,
  count,
  onClick,
}: {
  name: "needs" | "fleet";
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  /** The red number (decisions waiting on the user). */
  badge?: number;
  /** A small blue dot: only optional questions are open. */
  dot?: boolean;
  /** A plain number (tasks in progress). */
  count?: number;
  onClick: () => void;
}) {
  const waiting = badge ?? 0;
  const describe = waiting > 0 ? `${label}, ${waiting} ${waiting === 1 ? "decision" : "decisions"} waiting` : dot ? `${label}, an optional question is open` : count ? `${label}, ${count} in progress` : label;
  return (
    <button
      type="button"
      data-rail-row=""
      data-testid={`agents-nav-${name}`}
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      aria-label={describe}
      className={`${ROW_CLASS} ${selected ? ROW_SELECTED : "hover:bg-fill-hover"}`}
    >
      <span aria-hidden="true" className={`flex shrink-0 ${selected ? "text-accent-tx" : "text-text-faint"}`}>
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate text-label font-medium text-text">{label}</span>
      {waiting > 0 && (
        <span data-testid="agents-needs-badge" aria-hidden="true" className="rounded-full bg-danger px-1 text-[11px] font-semibold leading-5 text-white">
          {waiting}
        </span>
      )}
      {waiting === 0 && dot && <span data-testid="agents-needs-dot" aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
      {(count ?? 0) > 0 && (
        <span data-testid="agents-fleet-count" aria-hidden="true" className="text-meta tabular-nums text-text-faint">
          {count}
        </span>
      )}
    </button>
  );
}

export function AgentsSection({
  view,
  needs,
  fleetCount,
  onOpenView,
}: {
  /** The agent page showing now (selected-row state). */
  view: AgentsView;
  /** The Needs you row: decisions waiting on the user (the red number), or whether only optional questions are open (the blue dot). */
  needs: { decisions: number; questionDot: boolean };
  /** Tasks in progress, box-wide (the Fleet row's number). */
  fleetCount: number;
  onOpenView: (v: AgentsView) => void;
}) {
  const { agents } = usePackageAgents();

  // A box without the feature (or the demo transport) has no agents to show.
  if (!agents || agents.length === 0) return null;

  // The valid lead first, then the rest in the box's order (one row per package, no synthetic rows).
  const lead = leadAgent(agents);
  const ordered = lead ? [lead, ...agents.filter((a) => a !== lead)] : agents;
  const onNeeds = view?.page === "needs";
  const onFleet = view?.page === "fleet";

  return (
    <div className="px-1 pb-2" data-testid="agents-section">
      <div className="space-y-px">
        <NavRow
          name="needs"
          label="Needs you"
          icon={<Inbox size={14} />}
          selected={onNeeds}
          badge={needs.decisions}
          dot={needs.questionDot}
          onClick={() => onOpenView({ page: "needs" })}
        />
        <NavRow name="fleet" label="Fleet" icon={<LayoutGrid size={14} />} selected={onFleet} count={fleetCount} onClick={() => onOpenView({ page: "fleet" })} />
      </div>
      <div className="flex items-center justify-between px-1 pb-1 pt-3">
        <h3 className="m-0 text-micro font-semibold uppercase tracking-wider text-text-quiet">Agents</h3>
      </div>
      <div className="flex flex-col items-start gap-px px-[var(--row-px)] pb-1">
        <Button tone="default" onClick={() => openNewAgentDraft()} title="Opens a chat with Manta to describe it">
          <Plus size={12} aria-hidden="true" />
          New agent
        </Button>
        <span className="text-micro tracking-normal text-text-faint">opens a chat with Manta to describe it</span>
      </div>
      <div className="space-y-px">
        {ordered.map((a) => (
          <AgentRow key={a.slug} agent={a} selected={view?.page === "profile" && view.slug === a.slug} onOpen={() => onOpenView({ page: "profile", slug: a.slug })} />
        ))}
      </div>
    </div>
  );
}
