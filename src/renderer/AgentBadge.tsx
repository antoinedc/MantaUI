// The agent's colour badge (agent screens contract: `.av`): the agent's initial on its own colour, else a neutral fill.
// The initial's ink is picked against that colour (`agentInk`): a fixed white can fall under 4.5:1 on a mid-light colour.
// One size per place it appears — the rail row (14), a panel / picker header (16), a page row (22), a profile header (44).

import { agentInitial } from "./agentDispatch";
import { agentInk } from "./agentInk";

export type AgentBadgeSize = "rail" | "sm" | "md" | "lg";

const SIZE: Record<AgentBadgeSize, string> = {
  rail: "h-[14px] w-[14px] rounded-sm",
  sm: "h-4 w-4 rounded-xs",
  md: "h-[22px] w-[22px] rounded-sm",
  lg: "h-11 w-11 rounded-md",
};

export function AgentBadge({
  agent,
  size = "md",
}: {
  agent: { name: string; slug: string; color: string | null };
  size?: AgentBadgeSize;
}) {
  const ink = agent.color ? agentInk(agent.color) : null;
  return (
    <span
      aria-hidden="true"
      data-testid="agent-badge"
      className={
        "flex shrink-0 items-center justify-center text-micro font-semibold tracking-normal " +
        SIZE[size] +
        (agent.color ? " text-on-accent" : " bg-fill-hover text-text")
      }
      style={agent.color ? { backgroundColor: agent.color, ...(ink ? { color: ink } : {}) } : undefined}
    >
      {agentInitial(agent)}
    </span>
  );
}
