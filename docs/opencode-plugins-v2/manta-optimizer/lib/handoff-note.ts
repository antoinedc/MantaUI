// Agent awareness for auto-handoff: a one-line "you are at N of a B budget" note
// appended after the last message of a `context`-hook request.
// Spec: docs/superpowers/specs/2026-10-26-auto-handoff.md §4.4 (+ §15 generate marker).
//
// Gating (all must hold, else NO note): the session's policy is authoritative for
// THIS session (never the lastAny fallback), it carries a `handoff` block with
// mode ≠ off and measuredAt < 10 min old, the request is not a server `generate`
// call, and usage crossed 70% (once) or 90% (once) of the budget since it last
// sat below 50%. Threshold state lives in plugin memory per (sessionID, budget);
// a restart forgets it (at most one repeat). Fail open: any throw → no note.

import type { Policy } from "./mask.ts";

export const HANDOFF_GENERATE_MARKER = "<!-- manta-handoff-generate -->";
export const HANDOFF_MAX_AGE_MS = 10 * 60_000;
export const HANDOFF_FIRST_THRESHOLD = 0.7;
export const HANDOFF_SECOND_THRESHOLD = 0.9;
export const HANDOFF_RESET_BELOW = 0.5;
const MAX_TRACKED = 512;

export interface HandoffPolicy {
  contextTokens: number;
  budget: number;
  measuredAt: number;
  mode: "auto" | "suggest" | "off";
}

export interface HandoffNoteDeps {
  policies: { resolvePolicy(sessionID: string): { policy: Policy; authoritative: boolean } };
  now?: () => number;
}

function textOf(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("\n");
}

function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i]);
  }
  return "";
}

export function renderHandoffNote(contextTokens: number, budget: number): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return (
    `Context: ${k(contextTokens)} of a ${k(budget)} working budget. When you reach a natural ` +
    "stopping point and intend to keep working, call `handoff` with action `handoff`; " +
    "if you're done, just finish."
  );
}

export function createHandoffNote(deps: HandoffNoteDeps) {
  const now = deps.now ?? (() => Date.now());
  const state = new Map<string, { t70: boolean; t90: boolean }>();

  /** Append the note to `event.messages` when due. Returns whether it did. Never throws. */
  return function maybeAppendHandoffNote(event: any): boolean {
    try {
      const messages = event?.messages;
      const sessionID: string = typeof event?.sessionID === "string" ? event.sessionID : "";
      if (!sessionID || !Array.isArray(messages)) return false;
      if (lastUserText(messages).includes(HANDOFF_GENERATE_MARKER)) return false;

      const { policy, authoritative } = deps.policies.resolvePolicy(sessionID);
      if (!authoritative) return false;
      const h = (policy as Policy & { handoff?: HandoffPolicy | null }).handoff;
      if (!h || typeof h !== "object") return false;
      if (h.mode !== "auto" && h.mode !== "suggest") return false;
      const { contextTokens: used, budget, measuredAt } = h;
      if (![used, budget, measuredAt].every((n) => typeof n === "number" && Number.isFinite(n))) return false;
      if (budget <= 0 || used < 0) return false;
      if (now() - measuredAt >= HANDOFF_MAX_AGE_MS) return false;

      const key = `${sessionID}:${budget}`;
      const ratio = used / budget;
      const prev = state.get(key) ?? { t70: false, t90: false };
      if (ratio < HANDOFF_RESET_BELOW) {
        state.delete(key);
        return false;
      }
      const next = { ...prev };
      if (ratio >= HANDOFF_SECOND_THRESHOLD && !prev.t90) {
        next.t90 = true;
        next.t70 = true; // a first sighting at ≥90% must not also fire the 70% note later
      } else if (ratio >= HANDOFF_FIRST_THRESHOLD && !prev.t70) {
        next.t70 = true;
      } else {
        return false;
      }

      messages.push({ role: "user", content: [{ type: "text", text: renderHandoffNote(used, budget) }] });
      state.delete(key); // re-insert so the oldest-first eviction below is LRU
      state.set(key, next);
      while (state.size > MAX_TRACKED) {
        const oldest = state.keys().next().value;
        if (oldest === undefined) break;
        state.delete(oldest);
      }
      return true;
    } catch {
      return false;
    }
  };
}
