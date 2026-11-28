// Which session is which agent's conversation: the box's stored chats (`agents:chats`, slug → session id), read when a consumer
// mounts and again whenever its `key` changes (the sidebar passes the key of the agents' window set, so a conversation opened, closed
// or cleared is noticed). An older box has no such channel: that reads as "no conversations", never a crash.

import { useEffect, useState } from "react";
import { AGENTS_TMUX_SESSION } from "./agentDispatch";
import { usePackageAgents } from "./packageAgents";
import { agentOfSession } from "./teamView";

export function useAgentChats(key: string, enabled = true): Record<string, string> | null {
  const [chats, setChats] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const api = window.api as Partial<typeof window.api> | undefined;
    if (!api?.agentsChats) {
      setChats({});
      return;
    }
    let off = false;
    Promise.resolve()
      .then(() => window.api.agentsChats())
      .then((c) => {
        if (!off) setChats(c && typeof c === "object" ? c : {});
      })
      .catch(() => {
        if (!off) setChats((prev) => prev ?? {});
      });
    return () => {
      off = true;
    };
  }, [key, enabled]);
  return chats;
}

// Sessions already known to be an agent's conversation. A Clear makes a new session whose window re-mounts the chat panel before the
// stored chats are read again; remembering it keeps the agent's header and composer from flickering to a plain session's meanwhile.
const known = new Map<string, string>();

/** A Clear (or open) made `sessionId` the conversation of `slug`: the panel that mounts on it knows at once. */
export function rememberAgentSession(sessionId: string, slug: string): void {
  known.set(sessionId, slug);
}

/** Test seam. */
export function resetAgentSessionsForTest(): void {
  known.clear();
}

/** The agent whose conversation this session is — only for a window of the agents' tmux session; every other session is null. */
export function useAgentConversation(sessionId: string | null | undefined, tmuxSession: string | null | undefined): { slug: string; name: string } | null {
  const enabled = tmuxSession === AGENTS_TMUX_SESSION && !!sessionId;
  const { agents } = usePackageAgents();
  const chats = useAgentChats(sessionId ?? "", enabled);
  if (!enabled || !sessionId) return null;
  const fromBox = agentOfSession(sessionId, chats, agents);
  if (fromBox) {
    known.set(sessionId, fromBox.slug);
    return fromBox;
  }
  const slug = known.get(sessionId);
  const agent = slug ? agents?.find((a) => a.slug === slug) : undefined;
  return agent ? { slug: agent.slug, name: agent.name || agent.slug } : null;
}
