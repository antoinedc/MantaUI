// @vitest-environment jsdom
//
// Manta's "this might deserve an agent" offer in the chat (docs/superpowers/specs/2026-11-28-research-layer.md US4; design
// docs/screens/research/decisions.md §21–25): the card renders from the box's STORED offers (chat open, reconnect, bus hint), sits under the
// message that carried the third handoff, is acknowledged once it is actually on screen, and every answer reports both outcomes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { useStore } from "./store";
import { installMockApi, resetStore, mount, emitStreamAndFlush, type MockApi, type MockEventBus, type Harness } from "./testHarness";
import type { AgentSuggestion } from "../shared/types";

const REAL_ACTIONS = { activateWindow: useStore.getState().activateWindow, refresh: useStore.getState().refresh };
const SID = "ses_test";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };

const msg = (id: string, role: "user" | "assistant", text: string, created: number) => ({
  info: { id, sessionID: SID, role, time: { created, completed: role === "assistant" ? created + 1 : undefined } },
  parts: [{ id: `${id}_p`, messageID: id, type: "text", text }],
});
const MESSAGES = [msg("msg_u1", "user", "write the weekly release notes", 1), msg("msg_a1", "assistant", "ASSISTANT_ONE handed that to Dev", 2), msg("msg_u2", "user", "and another thing", 3), msg("msg_a2", "assistant", "ASSISTANT_TWO done", 4)];

const offer = (over: Partial<AgentSuggestion> = {}): AgentSuggestion => ({
  id: "o_1",
  anchorMessageId: "msg_a1",
  label: "weekly release notes",
  verdict: "agent",
  why: "It needs its own tone.",
  count: 3,
  state: "pending",
  seenAt: null,
  createdAt: "2026-11-28T10:00:00.000Z",
  ...over,
});

// A controllable IntersectionObserver: tests decide when (and how much of) a card is on screen.
type IO = { cb: IntersectionObserverCallback; els: Element[]; disconnected: boolean };
let observers: IO[] = [];
class FakeIO {
  rec: IO;
  constructor(cb: IntersectionObserverCallback) {
    this.rec = { cb, els: [], disconnected: false };
    observers.push(this.rec);
  }
  observe(el: Element) {
    this.rec.els.push(el);
  }
  unobserve() {}
  disconnect() {
    this.rec.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}
const reveal = async (h: Harness, ratio: number) => {
  await act(async () => {
    for (const o of observers) {
      if (o.disconnected) continue;
      o.cb(o.els.map((target) => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio }) as IntersectionObserverEntry), {} as IntersectionObserver);
    }
  });
  await h.flush();
};

describe("ChatPanel: the agent suggestion card", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;
  let stored: AgentSuggestion[] = [];
  let actImpl: (a: { id: string; action: string }) => Promise<unknown>;

  beforeEach(() => {
    observers = [];
    vi.stubGlobal("IntersectionObserver", FakeIO);
    stored = [offer()];
    actImpl = async () => ({ ok: true, sending: true });
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.unstubAllGlobals();
    useStore.setState({ ...REAL_ACTIONS });
  });

  async function open(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
    ({ api, bus } = installMockApi({
      opencodeMessages: () => Promise.resolve(MESSAGES),
      agentsSuggestions: () => Promise.resolve({ offers: stored }),
      agentsSuggestionSeen: () => Promise.resolve({ ok: true, seenAt: "2026-11-28T10:01:00.000Z" }),
      agentsSuggestionAct: (a: { id: string; action: string }) => actImpl(a),
      onAgentSuggestion: () => () => {},
      ...over,
    }));
    resetStore({} as never);
    h = mount(<ChatPanel {...PROPS} {...props} />);
    await h.flush();
    return h;
  }
  const q = <T extends Element = HTMLElement>(sel: string) => h!.container.querySelector<T>(sel);
  const card = () => q('[data-testid="agent-suggestion"]');
  const status = () => q('[data-testid="agent-suggestion-status"]');
  const click = async (sel: string) => {
    await act(async () => {
      q<HTMLButtonElement>(sel)!.click();
    });
    await h!.flush();
  };
  const calls = (name: string) => (api.calls[name] ?? []) as unknown[][];

  it("renders the stored offer under the message that carried the third handoff, with the spec's words and the four answers", async () => {
    await open();
    expect(card()).not.toBeNull();
    expect(h!.text()).toContain("You've asked for weekly release notes 3 times — want a dedicated agent?");
    expect(h!.text()).toContain("It needs its own tone.");
    expect(q('.manta-suggestion-agent')?.textContent).toBe("Make an agent");
    expect(q('.manta-suggestion-skill')?.textContent).toBe("Make a skill");
    expect(q('.manta-suggestion-later')?.textContent).toBe("Not now");
    expect(q('.manta-suggestion-never')?.textContent).toBe("Don't ask again for this");
    expect(q('.manta-suggestion-agent')?.className).toContain("bg-accent-solid"); // the verdict's button is primary
    // anchored: after ASSISTANT_ONE and before the next user message
    const order = h!.text();
    expect(order.indexOf("ASSISTANT_ONE")).toBeLessThan(order.indexOf("want a dedicated agent"));
    expect(order.indexOf("want a dedicated agent")).toBeLessThan(order.indexOf("and another thing"));
    expect(calls("agentsSuggestions")[0]).toEqual([{ sessionId: SID }]);
  });

  it("the verdict 'skill' words it as a skill and makes 'Make a skill' primary", async () => {
    stored = [offer({ verdict: "skill", count: 4 })];
    await open();
    expect(h!.text()).toContain("4 times — want a skill for it?");
    expect(q('.manta-suggestion-skill')?.className).toContain("bg-accent-solid");
    expect(q('.manta-suggestion-agent')?.className).not.toContain("bg-accent-solid");
  });

  it("an anchor that isn't a drawn message falls back to the last message", async () => {
    stored = [offer({ anchorMessageId: "msg_gone" })];
    await open();
    expect(h!.text().indexOf("ASSISTANT_TWO")).toBeLessThan(h!.text().indexOf("want a dedicated agent"));
  });

  it("no offers, no card; an older box ('unknown rpc channel') shows nothing and breaks nothing", async () => {
    stored = [];
    await open();
    expect(card()).toBeNull();
    h!.unmount();
    await open({ agentsSuggestions: () => Promise.reject(new Error("unknown rpc channel: agents:suggestions")) });
    expect(card()).toBeNull();
    expect(h!.text()).toContain("ASSISTANT_ONE");
  });

  it("reload: a fresh panel renders the same card from the stored offer (never a new one)", async () => {
    await open();
    h!.unmount();
    await open();
    expect(h!.container.querySelectorAll('[data-testid="agent-suggestion"]').length).toBe(1);
    expect(h!.text()).toContain("weekly release notes");
  });

  it("reconnect: a card whose event was dropped appears when the events socket reconnects (the resync frame re-reads)", async () => {
    stored = [];
    await open();
    expect(card()).toBeNull();
    stored = [offer()];
    await emitStreamAndFlush(bus, h!, { sub: "resync", sessionId: "", payload: {} });
    expect(card()).not.toBeNull();
  });

  it("the bus hint for THIS chat re-reads; one for another chat doesn't", async () => {
    let hint: (e: { sessionId: string; id: string }) => void = () => {};
    stored = [];
    await open({ onAgentSuggestion: (cb: typeof hint) => ((hint = cb), () => {}) });
    const reads = calls("agentsSuggestions").length;
    stored = [offer()];
    await act(async () => hint({ sessionId: "ses_other", id: "o_x" }));
    await h!.flush();
    expect(calls("agentsSuggestions").length).toBe(reads);
    expect(card()).toBeNull();
    await act(async () => hint({ sessionId: SID, id: "o_1" }));
    await h!.flush();
    expect(card()).not.toBeNull();
  });

  it("acknowledges once the card is at least half on screen — not when it is merely mounted — and only once", async () => {
    await open();
    expect(calls("agentsSuggestionSeen").length).toBe(0);
    await reveal(h!, 0.2);
    expect(calls("agentsSuggestionSeen").length).toBe(0);
    await reveal(h!, 0.6);
    expect(calls("agentsSuggestionSeen")).toEqual([[{ id: "o_1", sessionId: SID }]]);
    await reveal(h!, 1);
    expect(calls("agentsSuggestionSeen").length).toBe(1);
  });

  it("with no way to see what is on screen it never claims the card was seen", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await open();
    expect(card()).not.toBeNull();
    expect(calls("agentsSuggestionSeen").length).toBe(0);
  });

  it("Make an agent: shows the busy line at once, calls the box with the action, then the posted confirmation from the re-read", async () => {
    let release: (v: unknown) => void = () => {};
    actImpl = () => new Promise((r) => (release = r));
    await open();
    await click('.manta-suggestion-agent');
    expect(calls("agentsSuggestionAct")).toEqual([[{ id: "o_1", action: "agent" }]]);
    expect(status()?.textContent).toContain("You chose Make an agent. Sending your answer to Manta…");
    expect(q('.manta-suggestion-agent')).toBeNull();
    stored = [offer({ state: "answered", answer: "agent", accept: { state: "posted", messageId: "msg_9" } })];
    await act(async () => release({ ok: true, posted: "msg_9" }));
    await h!.flush();
    expect(status()?.textContent).toContain("You chose Make an agent. Sent to Manta as your message below.");
    expect(card()?.getAttribute("data-state")).toBe("answered");
  });

  it("Not now / Don't ask again: their resolved lines, nothing posted", async () => {
    actImpl = async () => ({ ok: true });
    await open();
    stored = [offer({ state: "answered", answer: "later" })];
    await click('.manta-suggestion-later');
    expect(status()?.textContent).toBe("Not now. Manta asks again after 3 more requests like this.");
    h!.unmount();
    stored = [offer()];
    await open();
    stored = [offer({ state: "answered", answer: "never" })];
    await click('.manta-suggestion-never');
    expect(status()?.textContent).toBe("Manta won't suggest an agent or a skill for weekly release notes again. You can still ask it for one.");
  });

  it("a refused answer says why in an alert and keeps the buttons; a thrown one does too", async () => {
    actImpl = async () => ({ ok: false, error: "That suggestion isn't available any more" });
    await open();
    await click('.manta-suggestion-agent');
    expect(status()?.getAttribute("role")).toBe("alert");
    expect(status()?.textContent).toContain("That suggestion isn't available any more");
    expect(q('.manta-suggestion-agent')).not.toBeNull();
    actImpl = async () => {
      throw new Error("Something went wrong on the box — try again.");
    };
    await click('.manta-suggestion-later');
    expect(status()?.textContent).toContain("Something went wrong on the box");
  });

  it("answered on another device: the second answer gets { already } and the card says so", async () => {
    actImpl = async () => ({ ok: true, already: "agent" });
    await open();
    stored = [offer({ state: "answered", answer: "agent", accept: { state: "posted", messageId: "m" } })];
    await click('.manta-suggestion-later');
    expect(status()?.textContent).toContain("Already answered on another device: Make an agent.");
  });

  it("sending → failed: the card says it couldn't be sent and Retry asks again with the same answer", async () => {
    stored = [offer({ state: "answered", answer: "agent", accept: { state: "failed", messageId: "m" } })];
    actImpl = async () => ({ ok: true, already: "agent", sending: true });
    await open();
    expect(status()?.getAttribute("role")).toBe("alert");
    expect(status()?.textContent).toContain("it couldn't be sent");
    await click('.manta-suggestion-retry');
    expect(calls("agentsSuggestionAct")).toEqual([[{ id: "o_1", action: "agent" }]]);
  });

  it("a card still posting refreshes itself until it is posted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stored = [offer({ state: "answered", answer: "agent", accept: { state: "posting", messageId: "m" } })];
      await open();
      expect(status()?.textContent).toContain("Sending your answer to Manta…");
      stored = [offer({ state: "answered", answer: "agent", accept: { state: "posted", messageId: "m" } })];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5500);
      });
      await h!.flush();
      expect(status()?.textContent).toContain("Sent to Manta as your message below.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no card and no read for a view-only session (a background job's window)", async () => {
    await open({ delegateJobForSession: () => Promise.resolve({ readOnly: true }) }, { readOnlyView: { kind: "job" } });
    expect(calls("agentsSuggestions").length).toBe(0);
  });
});
