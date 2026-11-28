import { describe, expect, it } from "vitest";
import { ACTION_LABEL, anyPosting, localAfterAct, viewOf } from "./agentSuggestion";
import type { AgentSuggestion } from "../shared/types";

const offer = (over: Partial<AgentSuggestion> = {}): AgentSuggestion => ({
  id: "o_1",
  anchorMessageId: "msg_1",
  label: "weekly release notes",
  verdict: "agent",
  why: "It needs its own tone.",
  count: 3,
  state: "pending",
  seenAt: null,
  createdAt: "2026-11-28T10:00:00.000Z",
  ...over,
});
const answered = (answer: AgentSuggestion["answer"], over: Partial<AgentSuggestion> = {}) => offer({ state: "answered", answer, ...over });

describe("the question and the answers", () => {
  it("names the kind in the spec's words and offers the four answers; the verdict picks the primary one", () => {
    const v = viewOf(offer());
    expect(v.question).toEqual({ before: "You've asked for ", label: "weekly release notes", after: " 3 times — want a dedicated agent?" });
    expect(v.showActions && !v.busy).toBe(true);
    expect(v.primary).toBe("agent");
    expect(v.why).toBe("It needs its own tone.");
    const skill = viewOf(offer({ verdict: "skill", count: 4 }));
    expect(skill.question.after).toBe(" 4 times — want a skill for it?");
    expect(skill.primary).toBe("skill");
  });

  it("the buttons are named as the design says", () => {
    expect(ACTION_LABEL).toEqual({ agent: "Make an agent", skill: "Make a skill", later: "Not now", never: "Don't ask again for this" });
  });
});

describe("states of the card (design: nine states)", () => {
  it("sending: buttons off, one busy line that names the choice", () => {
    const v = viewOf(offer(), { action: "agent", phase: "sending" });
    expect(v.showActions).toBe(false);
    expect(v.busy).toBe(true);
    expect(v.status).toMatchObject({ tone: "busy", text: "You chose Make an agent. Sending your answer to Manta…" });
    expect(viewOf(offer(), { action: "later", phase: "sending" }).status?.text).toBe("Saving your answer…");
  });

  it("accepted, still posting on the box (also after a crash): the same busy line", () => {
    const v = viewOf(answered("agent", { accept: { state: "posting", messageId: "msg_x" } }));
    expect(v.status).toMatchObject({ tone: "busy", text: "You chose Make an agent. Sending your answer to Manta…" });
    expect(v.showActions).toBe(false);
  });

  it("accepted and posted: the confirmation, for an agent and for a skill", () => {
    expect(viewOf(answered("agent", { accept: { state: "posted", messageId: "m" } })).status).toMatchObject({ tone: "ok", text: "You chose Make an agent. Sent to Manta as your message below." });
    expect(viewOf(answered("skill", { accept: { state: "posted", messageId: "m" } })).status?.text).toBe("You chose Make a skill. Sent to Manta as your message below.");
  });

  it("failed after 5 tries: an alert with Retry, and nothing was lost", () => {
    const v = viewOf(answered("agent", { accept: { state: "failed", messageId: "m" } }));
    expect(v.status).toMatchObject({ tone: "error", live: "alert", retry: true, text: "You chose Make an agent, but it couldn't be sent: the box didn't answer after 5 tries. Nothing was lost." });
  });

  it("Not now: asks again after 3 more; the second one is for good", () => {
    expect(viewOf(answered("later")).status?.text).toBe("Not now. Manta asks again after 3 more requests like this.");
    expect(viewOf(answered("later", { final: true })).status?.text).toBe("Not now. Manta won't suggest this again; ask it any time if you change your mind.");
  });

  it("Don't ask again: says what was promised, naming the kind", () => {
    expect(viewOf(answered("never")).status?.text).toBe("Manta won't suggest an agent or a skill for weekly release notes again. You can still ask it for one.");
  });

  it("answered on another device: this client's click gets that answer and says so", () => {
    const local = localAfterAct("later", { ok: true, already: "agent" });
    expect(local).toEqual({ action: "later", phase: "done", already: "agent" });
    expect(viewOf(answered("agent", { accept: { state: "posted", messageId: "m" } }), local).status).toMatchObject({ tone: "ok", text: "Already answered on another device: Make an agent." });
  });

  it("the other device's Not now / Don't ask again simply shows that resolved line here too", () => {
    expect(viewOf(answered("never"), { action: "agent", phase: "done", already: "never" }).status?.text).toMatch(/won't suggest an agent or a skill/);
  });

  it("a refused answer keeps the buttons and says why in an alert; an answered-but-failed Retry keeps its Retry", () => {
    const v = viewOf(offer(), { action: "agent", phase: "error", error: "Couldn't reach the box" });
    expect(v.showActions).toBe(true);
    expect(v.status).toMatchObject({ tone: "error", live: "alert" });
    expect(v.status?.text).toContain("Couldn't reach the box");
    const retry = viewOf(answered("agent", { accept: { state: "failed", messageId: "m" } }), { action: "agent", phase: "error", error: "offline" });
    expect(retry.status?.retry).toBe(true);
  });
});

describe("what a finished call means", () => {
  it("a first answer needs nothing local (the re-read shows it); a refusal is an error; a repeat is `already`", () => {
    expect(localAfterAct("agent", { ok: true, posted: "msg_1" })).toBeNull();
    expect(localAfterAct("agent", { ok: true, sending: true })).toBeNull();
    expect(localAfterAct("agent", { ok: false, error: "That suggestion isn't available any more" })).toEqual({ action: "agent", phase: "error", error: "That suggestion isn't available any more" });
  });

  it("anyPosting: only answered offers whose message hasn't been posted keep the client refreshing", () => {
    expect(anyPosting([offer(), answered("later")])).toBe(false);
    expect(anyPosting([answered("agent", { accept: { state: "posting", messageId: "m" } })])).toBe(true);
    expect(anyPosting([answered("agent", { accept: { state: "failed", messageId: "m" } })])).toBe(false);
  });
});
