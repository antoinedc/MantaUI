// The offers stored for one chat ("this might deserve an agent"). The box's record is the truth: offers are READ on chat open, whenever the chat
// becomes the active one, on every events reconnect (the client-synthesised `resync` frame) and when the bus hints at a change — a missed event
// can never lose an offer. While an accepted offer's message is still going out the card refreshes every few seconds.
// Answers go through `agents:suggestion-act`; the card is acknowledged once it is on screen (`agents:suggestion-seen`).

import { useCallback, useEffect, useRef, useState } from "react";
import { anyPosting, localAfterAct, POSTING_POLL_MS, type LocalAct } from "../agentSuggestion";
import type { AgentSuggestion, AgentSuggestionAction } from "../../shared/types";

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "the box didn't answer";

export function useAgentSuggestions(sessionId: string, active: boolean, enabled = true) {
  const [offers, setOffers] = useState<AgentSuggestion[]>([]);
  const [local, setLocal] = useState<Record<string, LocalAct>>({});
  const seq = useRef(0);
  const seenSent = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    if (!enabled || !sessionId) return;
    const mine = ++seq.current;
    try {
      const res = await window.api.agentsSuggestions({ sessionId });
      if (!live.current || mine !== seq.current) return; // a newer read (or another chat) owns the answer
      setOffers(Array.isArray(res?.offers) ? res.offers : []);
    } catch {
      /* an older box ("unknown rpc channel") or a box that is down: keep what is shown; the next trigger reads again */
    }
  }, [sessionId, enabled]);

  // another chat: nothing of the last one stays
  useEffect(() => {
    seq.current++;
    setOffers([]);
    setLocal({});
    seenSent.current = new Set();
  }, [sessionId]);

  useEffect(() => {
    if (active) void refetch();
  }, [active, refetch]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const offBus = window.api.onAgentSuggestion((e) => {
      if (e?.sessionId === sessionId) void refetch();
    });
    const offStream = window.api.onStreamEvent((ev) => {
      if (ev.sub === "resync") void refetch();
    });
    return () => {
      if (typeof offBus === "function") offBus();
      if (typeof offStream === "function") offStream();
    };
  }, [sessionId, enabled, refetch]);

  const posting = anyPosting(offers);
  useEffect(() => {
    if (!posting || !active) return;
    const t = setInterval(() => void refetch(), POSTING_POLL_MS);
    return () => clearInterval(t);
  }, [posting, active, refetch]);

  const act = useCallback(
    async (id: string, action: AgentSuggestionAction) => {
      setLocal((m) => ({ ...m, [id]: { action, phase: "sending" } }));
      let next: LocalAct | null;
      try {
        next = localAfterAct(action, await window.api.agentsSuggestionAct({ id, action }));
      } catch (e) {
        next = { action, phase: "error", error: errText(e) };
      }
      // an accepted answer stays "sending" until the re-read shows it, so the buttons never flash back between the two
      if (next?.phase !== "error") await refetch();
      if (!live.current) return;
      setLocal((m) => {
        const { [id]: _gone, ...rest } = m;
        return next ? { ...rest, [id]: next } : rest;
      });
      if (next?.phase === "error") await refetch();
    },
    [refetch],
  );

  const markSeen = useCallback(
    (id: string) => {
      if (seenSent.current.has(id)) return;
      seenSent.current.add(id);
      window.api.agentsSuggestionSeen({ id, sessionId }).catch(() => seenSent.current.delete(id)); // acknowledgement, not a user action: the next time it is on screen it asks again
    },
    [sessionId],
  );

  return { offers, local, act, markSeen };
}
