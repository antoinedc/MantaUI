// Pure logic for "@agent" mentions in a project chat (Agents Phase 1, spec §8).
// No React: unit-tested in agentDispatch.test.ts.

import type { AgentInfo } from "../shared/types";
import { resolveAgentMentions, type AgentMention } from "./chatShared";

/** The tmux session that holds every agent's direct chat window (never listed as a workspace). */
export const AGENTS_TMUX_SESSION = "manta-agents";

/** The OpenCode agent key a package agent is compiled to (server side). Used to hide them from the opencode-agent list. */
export const PACKAGE_AGENT_PREFIX = "agent-";

export const ONE_AGENT_ERROR = "Mention one agent per message for now";

/** An agent a message can be dispatched to: its package parsed, and not the lead (Manta already leads every chat). */
export function usableAgents(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo[] {
  return (agents ?? []).filter((a) => !a.error && a.role !== "lead");
}

/** The valid lead (Agents Phase 2): a parsed package whose role is "lead". Null when the box has none. */
export function leadAgent(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo | null {
  return (agents ?? []).find((a) => a.role === "lead" && !a.error) ?? null;
}

/** The lead's display name for "<Lead> asked: …" lines; "Manta" until the list loads or when the box has no lead. */
export function leadDisplayName(agents: ReadonlyArray<AgentInfo> | null | undefined): string {
  const lead = leadAgent(agents);
  return lead?.name || lead?.slug || "Manta";
}

/** The agents a routine can run as (Agents Phase 2): valid specialists. */
export function routineAgents(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo[] {
  return (agents ?? []).filter((a) => !a.error && a.role === "specialist");
}

export type AgentDispatchPick = null | { slug: string } | { error: string };

/**
 * Does this message go to a package agent? `null` = no (the normal send path).
 * Mentions are resolved against the text actually being sent, so a token the
 * user deleted after picking it never dispatches. More than one distinct
 * package agent is refused (Phase 1: one agent per message).
 */
export function pickAgentDispatch(
  text: string,
  mentions: ReadonlyArray<AgentMention>,
  agents: ReadonlyArray<AgentInfo> | null | undefined,
): AgentDispatchPick {
  const slugs = new Set(usableAgents(agents).map((a) => a.slug));
  if (slugs.size === 0) return null;
  const hit = new Set<string>();
  for (const m of resolveAgentMentions(text, mentions as AgentMention[])) {
    if (slugs.has(m.name)) hit.add(m.name);
  }
  // A hand-typed "@slug" (not picked from the popup) counts too.
  for (const m of text.matchAll(/(?:^|\s)@([a-z][a-z0-9-]{0,30})(?![a-z0-9-])/g)) {
    if (slugs.has(m[1])) hit.add(m[1]);
  }
  if (hit.size === 0) return null;
  if (hit.size > 1) return { error: ONE_AGENT_ERROR };
  return { slug: [...hit][0] };
}

/** The display name for an `agent-<slug>` OpenCode agent id (a result card's `agent`), else null when it is not a package agent. */
export function packageAgentDisplayName(
  opencodeAgent: string | undefined,
  agents: ReadonlyArray<AgentInfo> | null | undefined,
): string | null {
  if (!opencodeAgent || !opencodeAgent.startsWith(PACKAGE_AGENT_PREFIX)) return null;
  const slug = opencodeAgent.slice(PACKAGE_AGENT_PREFIX.length);
  return (agents ?? []).find((a) => a.slug === slug)?.name ?? slug;
}

/** Initial letter + colour for an agent row (the agent's own colour, else a neutral). */
export function agentInitial(a: Pick<AgentInfo, "name" | "slug">): string {
  return (a.name || a.slug).trim().charAt(0).toUpperCase() || "?";
}

/** The partial "@name" being typed just before the caret (e.g. "se" for "ask @se|"), or null. */
export function agentMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const m = /(?:^|\s)@([a-z0-9-]{0,31})$/i.exec(text.slice(0, caret));
  if (!m) return null;
  return { query: m[1].toLowerCase(), start: caret - m[1].length - 1 };
}

/** Agents whose slug or name starts with `query`, in list order. */
export function matchAgents(agents: ReadonlyArray<AgentInfo> | null | undefined, query: string): AgentInfo[] {
  return usableAgents(agents).filter((a) => a.slug.startsWith(query) || a.name.toLowerCase().startsWith(query));
}

/** `text` with the "@query" at `start..caret` replaced by "@slug ", and the new caret. */
export function insertAgentMention(text: string, start: number, caret: number, slug: string): { text: string; caret: number } {
  const ins = `@${slug} `;
  const rest = text.slice(caret).replace(/^\s+/, "");
  return { text: text.slice(0, start) + ins + rest, caret: start + ins.length };
}
