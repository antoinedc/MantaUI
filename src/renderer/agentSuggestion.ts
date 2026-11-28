// "This might deserve an agent" — what the card says in each state (design: docs/screens/research/profile-and-suggestion.html and decisions.md
// §21–25; contract: docs/superpowers/specs/2026-11-28-research-layer.md §6.6). Pure: the card and its tests read the same words.

import type { AgentSuggestion, AgentSuggestionAction, AgentSuggestionActResult } from "../shared/types";

export const ACTION_LABEL: Record<AgentSuggestionAction, string> = {
  agent: "Make an agent",
  skill: "Make a skill",
  later: "Not now",
  never: "Don't ask again for this",
};

/** The order a client keeps polling a not-yet-posted accept (the box retries on its own, this only refreshes the card). */
export const POSTING_POLL_MS = 5000;

/** A click in flight or refused, kept by the client only (the offer itself is the box's record). */
export type LocalAct = {
  action: AgentSuggestionAction;
  phase: "sending" | "error" | "done";
  error?: string;
  /** The box said someone else answered first: this was the answer. */
  already?: AgentSuggestionAction;
};

export type SuggestionView = {
  /** The question line: bold label inside. */
  question: { before: string; label: string; after: string };
  why: string;
  /** The four answers show (the offer is unanswered and nothing is in flight). */
  showActions: boolean;
  /** Buttons are disabled: a click is in flight. */
  busy: boolean;
  /** The button that follows the verdict is the primary one. */
  primary: "agent" | "skill";
  /** The one status line that replaces the buttons once answered, or after a refusal. */
  status: null | { tone: "busy" | "ok" | "error" | "neutral"; text: string; live: "status" | "alert"; retry: boolean };
};

const chose = (a: AgentSuggestionAction) => `You chose ${ACTION_LABEL[a]}`;

export function viewOf(o: AgentSuggestion, local: LocalAct | null = null): SuggestionView {
  const agent = o.verdict === "agent";
  const question = { before: "You've asked for ", label: o.label, after: ` ${o.count} times — want ${agent ? "a dedicated agent" : "a skill for it"}?` };
  const base = { question, why: o.why, primary: o.verdict } as const;

  if (o.state === "pending") {
    if (local?.phase === "sending") {
      const text = local.action === "agent" || local.action === "skill" ? `${chose(local.action)}. Sending your answer to Manta…` : "Saving your answer…";
      return { ...base, showActions: false, busy: true, status: { tone: "busy", text, live: "status", retry: false } };
    }
    if (local?.phase === "error") {
      return {
        ...base,
        showActions: true,
        busy: false,
        status: { tone: "error", text: `Couldn't send your answer: ${local.error || "the box didn't answer"}. Nothing was changed; try again.`, live: "alert", retry: false },
      };
    }
    return { ...base, showActions: true, busy: false, status: null };
  }

  const answer = o.answer ?? "later";
  if (local?.already && (answer === "agent" || answer === "skill")) {
    return { ...base, showActions: false, busy: false, status: { tone: "ok", text: `Already answered on another device: ${ACTION_LABEL[answer]}.`, live: "status", retry: false } };
  }
  if (answer === "agent" || answer === "skill") {
    if (local?.phase === "error") {
      return { ...base, showActions: false, busy: false, status: { tone: "error", text: `${chose(answer)}, but it couldn't be sent: ${local.error || "the box didn't answer"}. Nothing was lost.`, live: "alert", retry: true } };
    }
    if (local?.phase === "sending" || o.accept?.state === "posting" || !o.accept) {
      return { ...base, showActions: false, busy: false, status: { tone: "busy", text: `${chose(answer)}. Sending your answer to Manta…`, live: "status", retry: false } };
    }
    if (o.accept.state === "failed") {
      return { ...base, showActions: false, busy: false, status: { tone: "error", text: `${chose(answer)}, but it couldn't be sent: the box didn't answer after 5 tries. Nothing was lost.`, live: "alert", retry: true } };
    }
    return { ...base, showActions: false, busy: false, status: { tone: "ok", text: `${chose(answer)}. Sent to Manta as your message below.`, live: "status", retry: false } };
  }
  if (answer === "later") {
    const text = o.final ? "Not now. Manta won't suggest this again; ask it any time if you change your mind." : "Not now. Manta asks again after 3 more requests like this.";
    return { ...base, showActions: false, busy: false, status: { tone: "neutral", text, live: "status", retry: false } };
  }
  return { ...base, showActions: false, busy: false, status: { tone: "neutral", text: `Manta won't suggest an agent or a skill for ${o.label} again. You can still ask it for one.`, live: "status", retry: false } };
}

/** What a finished `agents:suggestion-act` call means for the card's own state. */
export function localAfterAct(action: AgentSuggestionAction, res: AgentSuggestionActResult): LocalAct | null {
  if (!res.ok) return { action, phase: "error", error: res.error };
  if (res.already) return { action, phase: "done", already: res.already };
  return null; // the re-read shows the answer
}

/** Whether any offer still waits for its message to reach the chat (so the client keeps refreshing). */
export const anyPosting = (offers: readonly AgentSuggestion[]): boolean => offers.some((o) => o.state === "answered" && o.accept?.state === "posting");
