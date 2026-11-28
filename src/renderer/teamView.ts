// ===== The sidebar's Team section and the agent conversation — pure logic (docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §6, §7) =====

import type { AgentInfo } from "../shared/types";

/** One row per valid agent except the Architect (it has no conversation): the lead first, the box's order otherwise. */
export function teamAgents(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo[] {
  const rows = (agents ?? []).filter((a) => !a.error && a.role !== "architect");
  const lead = rows.find((a) => a.role === "lead");
  return lead ? [lead, ...rows.filter((a) => a !== lead)] : rows;
}

type WindowLike = { index: number; opencodeSessionId?: string | null };

/** The window carrying an agent's stored conversation. The window's NAME is never trusted: Settings can rename the agent. */
export function windowOfAgent<W extends WindowLike>(windows: ReadonlyArray<W> | undefined, sessionId: string | null | undefined): W | null {
  if (!sessionId) return null;
  return windows?.find((w) => w.opencodeSessionId === sessionId) ?? null;
}

/** Changes when a window of the agents' tmux session appears, goes or is re-stamped — the cue to read the stored conversations again. */
export const teamWindowsKey = (windows: ReadonlyArray<WindowLike> | undefined): string => (windows ?? []).map((w) => `${w.index}:${w.opencodeSessionId ?? ""}`).join(",");

/** Which agent a session is the conversation of, from the stored chats (slug → session id); null when it is nobody's. */
export function agentOfSession(
  sessionId: string | null | undefined,
  chats: Readonly<Record<string, string>> | null | undefined,
  agents: ReadonlyArray<AgentInfo> | null | undefined,
): { slug: string; name: string } | null {
  if (!sessionId || !chats || !agents) return null;
  const slug = Object.keys(chats).find((s) => chats[s] === sessionId);
  const found = slug ? agents.find((a) => a.slug === slug) : undefined;
  return found ? { slug: found.slug, name: found.name || found.slug } : null;
}
