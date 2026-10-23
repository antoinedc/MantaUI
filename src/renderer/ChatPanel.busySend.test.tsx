// @vitest-environment jsdom
//
// OpenCode V2 cleanup spec §2: a message sent while the agent is working goes
// INTO the running turn (steer) and is listed in the pending card from the
// box's inbox; pop-last and × cancel it through opencode:inbox-cancel. Every
// branch of every action must report visibly (AGENTS.md "never stub a control").
// v2-next Stage A: ⌥Enter = After this turn (delivery:"queue"); the card has
// Now / After this turn rows with Send now / Wait (N1) and the stopped footer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { useStore } from "./store";
import { BUSY_PLACEHOLDER, STOPPED_FOOTER_TEXT, busySendHint, resetRetiredInboxEpochs } from "./inboxState";
import { IS_MAC } from "./platform";
import {
  installMockApi,
  resetStore,
  mount,
  emitStreamAndFlush,
  type MockApi,
  type MockEventBus,
  type Harness,
} from "./testHarness";

const SID = "ses_test";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };

const item = (id: string, text: string, attachmentCount = 0, delivery: "steer" | "queue" = "steer") => ({
  id,
  text,
  delivery,
  createdAt: 1,
  attachmentCount,
});

describe("ChatPanel busy send + inbox", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;
  let rev = 0;

  beforeEach(() => resetRetiredInboxEpochs());
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(overrides: Record<string, unknown> = {}) {
    ({ api, bus } = installMockApi(overrides));
    resetStore();
    rev = 0;
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await emitStreamAndFlush(bus, h, { sub: "running", sessionId: SID, payload: { running: true } });
    return h;
  }
  const textarea = () => h!.container.querySelector("textarea") as HTMLTextAreaElement;
  async function type(value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea(), value);
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function key(k: string, init: KeyboardEventInit = {}) {
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    });
    await h!.flush();
  }
  // Dispatch a key and report whether the composer called preventDefault on it.
  async function keyPrevented(k: string, init: KeyboardEventInit = {}) {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    await act(async () => {
      textarea().dispatchEvent(ev);
    });
    await h!.flush();
    return ev.defaultPrevented;
  }
  const altEnter = { altKey: true };
  async function setRunning(running: boolean) {
    await emitStreamAndFlush(bus, h!, { sub: "running", sessionId: SID, payload: { running } });
  }
  async function pushInbox(items: ReturnType<typeof item>[]) {
    rev += 1;
    await emitStreamAndFlush(bus, h!, { sub: "inbox", sessionId: SID, payload: { epoch: "e1", rev, items } });
  }
  const sendError = () => {
    const el = [...h!.container.querySelectorAll("span.flex-1")].find((e) => (e.textContent ?? "").startsWith("⚠ "));
    return (el?.textContent ?? "").replace(/^⚠ /, "");
  };

  describe("send while running", () => {
    it("steers: opencodePrompt with delivery:steer, no model/agent, no optimistic row, running untouched, composer cleared", async () => {
      await open();
      await type("also check the tests");
      await key("Enter");
      const calls = api.calls.opencodePrompt ?? [];
      expect(calls).toHaveLength(1);
      const [sid, text, model, atts, mentions, agent, opts] = calls[0];
      expect([sid, text, model, agent]).toEqual([SID, "also check the tests", undefined, undefined]);
      expect(atts).toEqual([]);
      expect(mentions).toBeUndefined();
      expect(opts).toEqual({ delivery: "steer" });
      expect(textarea().value).toBe("");
      // no optimistic transcript row, and the turn is still running (Stop visible)
      expect(h!.text()).not.toContain("also check the tests");
      expect(h!.container.querySelector('button[aria-label="Stop the running turn"]')).not.toBeNull();
    });

    it("an opencode slash command goes as a steered command", async () => {
      await open({ opencodeCommands: () => Promise.resolve([{ name: "review", description: "" }]) });
      // the panel reads commands via the typeahead; prime it by typing "/"
      await type("/");
      await h!.flush();
      await type("/review HEAD~1");
      await key("Enter");
      expect(api.calls.opencodeRunCommand).toEqual([
        [{ sessionId: SID, command: "review", arguments: "HEAD~1", attachments: [], delivery: "steer" }],
      ]);
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
    });

    it("a local slash command is refused with a visible message: nothing sent, text kept", async () => {
      await open();
      await type("/clear");
      await key("Enter");
      expect(sendError()).toBe("Stop the agent or wait for it to finish before /clear");
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
      expect(api.calls.opencodeClearSession ?? []).toEqual([]);
      expect(textarea().value).toBe("/clear");
    });

    it("a failed send shows the error, keeps the draft, and leaves running alone", async () => {
      await open({ opencodePrompt: () => Promise.reject(new Error("box unreachable")) });
      await type("hello");
      await key("Enter");
      expect(sendError()).toContain("box unreachable");
      expect(textarea().value).toBe("hello");
      expect(h!.container.querySelector('button[aria-label="Stop the running turn"]')).not.toBeNull();
    });

    it("one in flight per panel: a second Enter is ignored and the button is disabled", async () => {
      let release!: () => void;
      await open({ opencodePrompt: () => new Promise<void>((res) => (release = res)) });
      await type("one");
      await key("Enter");
      await key("Enter");
      expect(api.calls.opencodePrompt).toHaveLength(1);
      const send = h!.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      await act(async () => release());
      await h!.flush();
      expect(textarea().value).toBe("");
    });

    it("newer text typed while the send is in flight is NOT cleared", async () => {
      let release!: () => void;
      await open({ opencodePrompt: () => new Promise<void>((res) => (release = res)) });
      await type("first draft");
      await key("Enter");
      await type("first draft and more");
      await act(async () => release());
      await h!.flush();
      expect(textarea().value).toBe("first draft and more");
      expect(api.calls.opencodePrompt).toHaveLength(1);
    });

    it("a pending question is rejected (awaited) BEFORE the message is sent", async () => {
      const order: string[] = [];
      await open({
        opencodeQuestionReject: () => {
          order.push("reject");
          return Promise.resolve();
        },
        opencodePrompt: () => {
          order.push("prompt");
          return Promise.resolve();
        },
      });
      await emitStreamAndFlush(bus, h!, {
        sub: "questions",
        sessionId: SID,
        payload: { questions: [{ id: "q1", sessionID: SID, requestId: "que_1", questions: [{ header: "H", question: "Which?", options: [{ label: "a" }] }] }] },
      });
      await type("go with a");
      await key("Enter");
      expect(order).toEqual(["reject", "prompt"]);
    });

    it("if the question can't be rejected NOTHING is sent, the draft is kept and the error shown", async () => {
      // Question cards only render over a non-empty transcript.
      await open({
        opencodeMessages: () =>
          Promise.resolve([
            {
              info: { id: "msg_a1", sessionID: SID, role: "assistant" as const, time: { created: 1, completed: 2 } },
              parts: [{ type: "text", id: "prt_a1", messageID: "msg_a1", text: "ok" }],
            },
          ]),
        opencodeQuestionReject: () => Promise.reject(new Error("denied")),
      });
      await emitStreamAndFlush(bus, h!, {
        sub: "questions",
        sessionId: SID,
        payload: { questions: [{ id: "q1", sessionID: SID, requestId: "que_1", questions: [{ header: "H", question: "Which?", options: [{ label: "a" }] }] }] },
      });
      await type("go with a");
      await key("Enter");
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
      expect(textarea().value).toBe("go with a");
      expect(sendError()).toContain("denied");
      expect(h!.text()).toContain("Which?");
    });
  });

  describe("⌥Enter = After this turn", () => {
    it("while running: the same busy send with delivery:queue; composer cleared; the key is consumed", async () => {
      await open();
      await type("then update the CHANGELOG");
      expect(await keyPrevented("Enter", altEnter)).toBe(true);
      const calls = api.calls.opencodePrompt ?? [];
      expect(calls).toHaveLength(1);
      const [sid, text, model, atts, mentions, agent, opts] = calls[0];
      expect([sid, text, model, agent]).toEqual([SID, "then update the CHANGELOG", undefined, undefined]);
      expect(atts).toEqual([]);
      expect(mentions).toBeUndefined();
      expect(opts).toEqual({ delivery: "queue" });
      expect(textarea().value).toBe("");
      expect(h!.container.querySelector('button[aria-label="Stop the running turn"]')).not.toBeNull();
    });

    it("an opencode slash command goes as a queued command", async () => {
      await open({ opencodeCommands: () => Promise.resolve([{ name: "review", description: "" }]) });
      await type("/");
      await h!.flush();
      await type("/review HEAD~1");
      await key("Enter", altEnter);
      expect(api.calls.opencodeRunCommand).toEqual([
        [{ sessionId: SID, command: "review", arguments: "HEAD~1", attachments: [], delivery: "queue" }],
      ]);
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
    });

    it("a local slash command is refused with the same visible message: nothing sent, text kept", async () => {
      await open();
      await type("/clear");
      await key("Enter", altEnter);
      expect(sendError()).toBe("Stop the agent or wait for it to finish before /clear");
      expect(api.calls.opencodePrompt ?? []).toEqual([]);
      expect(textarea().value).toBe("/clear");
    });

    it("one in flight per panel: a second ⌥Enter is ignored", async () => {
      let release!: () => void;
      await open({ opencodePrompt: () => new Promise<void>((res) => (release = res)) });
      await type("one");
      await key("Enter", altEnter);
      await key("Enter", altEnter);
      expect(api.calls.opencodePrompt).toHaveLength(1);
      await act(async () => release());
      await h!.flush();
    });

    it("newer text typed while the send is in flight is NOT cleared", async () => {
      let release!: () => void;
      await open({ opencodePrompt: () => new Promise<void>((res) => (release = res)) });
      await type("first draft");
      await key("Enter", altEnter);
      await type("first draft and more");
      await act(async () => release());
      await h!.flush();
      expect(textarea().value).toBe("first draft and more");
    });

    it("a failed send shows the error and keeps the draft", async () => {
      await open({ opencodePrompt: () => Promise.reject(new Error("box unreachable")) });
      await type("hello");
      await key("Enter", altEnter);
      expect(sendError()).toContain("box unreachable");
      expect(textarea().value).toBe("hello");
    });

    it("a pending question is rejected (awaited) BEFORE the message is sent", async () => {
      const order: string[] = [];
      await open({
        opencodeQuestionReject: () => {
          order.push("reject");
          return Promise.resolve();
        },
        opencodePrompt: () => {
          order.push("prompt");
          return Promise.resolve();
        },
      });
      await emitStreamAndFlush(bus, h!, {
        sub: "questions",
        sessionId: SID,
        payload: { questions: [{ id: "q1", sessionID: SID, requestId: "que_1", questions: [{ header: "H", question: "Which?", options: [{ label: "a" }] }] }] },
      });
      await type("go with a");
      await key("Enter", altEnter);
      expect(order).toEqual(["reject", "prompt"]);
    });

    it("when idle it is an ordinary send: the same call as Enter, no delivery", async () => {
      await open();
      await setRunning(false);
      await type("hello idle");
      expect(await keyPrevented("Enter", altEnter)).toBe(true);
      const viaAlt = api.calls.opencodePrompt ?? [];
      expect(viaAlt).toHaveLength(1);
      expect(viaAlt[0][1]).toBe("hello idle");
      expect((viaAlt[0][6] as { delivery?: string } | undefined)?.delivery).toBeUndefined();
      h!.unmount();
      h = null;

      await open();
      await setRunning(false);
      await type("hello idle");
      await key("Enter");
      const viaEnter = api.calls.opencodePrompt ?? [];
      expect(viaEnter).toHaveLength(1);
      expect(viaAlt[0]).toEqual(viaEnter[0]);
    });
  });

  describe("composer copy: hint, Send label, placeholder", () => {
    const hint = () => h!.container.querySelector('[data-testid="busy-send-hint"]');

    it("running: the two-key hint, a Send button (not Queue) and the neutral placeholder", async () => {
      await open();
      await type("x");
      expect(hint()?.textContent).toBe(busySendHint(IS_MAC));
      expect(hint()?.textContent).toContain("send now");
      expect(hint()?.textContent).toContain("after this turn");
      expect(textarea().placeholder).toBe(BUSY_PLACEHOLDER);
      expect(textarea().placeholder).toBe("Message the agent…");
      const send = h!.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      expect(send.title).toBe("Send now (Enter)");
      expect(h!.container.querySelector('button[aria-label="Queue message while running"]')).toBeNull();
    });

    it("idle: no hint, the resting placeholder, the plain Send title", async () => {
      await open();
      await setRunning(false);
      await type("x");
      expect(hint()).toBeNull();
      expect(textarea().placeholder).toBe("Reply, or describe the next task…");
      const send = h!.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      expect(send.title).toBe("Send (Enter)");
    });
  });

  describe("pending card", () => {
    it("lists the inbox items (from the frame) and drops them when the list empties", async () => {
      await open();
      await pushInbox([item("m1", "first"), item("m2", "second")]);
      const rows = [...h!.container.querySelectorAll('[data-testid="inbox-row"]')].map((r) => r.textContent);
      expect(rows[0]).toContain("first");
      expect(rows[1]).toContain("second");
      await pushInbox([]);
      expect(h!.container.querySelector('[data-testid="inbox-card"]')).toBeNull();
    });

    it("is seeded by opencode:inbox on open (survives a reload)", async () => {
      ({ api, bus } = installMockApi({
        opencodeInbox: () => Promise.resolve({ epoch: "e1", rev: 4, items: [item("m1", "from before the reload")] }),
      }));
      resetStore();
      h = mount(<ChatPanel {...PROPS} />);
      await h.flush();
      expect(h.text()).toContain("from before the reload");
    });

    it("× cancels that item; cancelled → no message, the frame removes the row", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "cancelled", item: item("m1", "first") }) });
      await pushInbox([item("m1", "first")]);
      const x = h!.container.querySelector('[data-testid="inbox-cancel"]') as HTMLButtonElement;
      await act(async () => x.click());
      await h!.flush();
      expect(api.calls.opencodeInboxCancel).toEqual([[{ sessionId: SID, id: "m1" }]]);
      expect(sendError()).toBe("");
      expect(textarea().value).toBe("");
    });

    it("× on an item that was already delivered says so", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "delivered" }) });
      await pushInbox([item("m1", "first")]);
      await act(async () => (h!.container.querySelector('[data-testid="inbox-cancel"]') as HTMLButtonElement).click());
      await h!.flush();
      expect(useStore.getState().systemNotice).toBe("Already sent to the agent");
    });

    it("× failing shows the error", async () => {
      await open({ opencodeInboxCancel: () => Promise.reject(new Error("offline")) });
      await pushInbox([item("m1", "first")]);
      await act(async () => (h!.container.querySelector('[data-testid="inbox-cancel"]') as HTMLButtonElement).click());
      await h!.flush();
      expect(sendError()).toContain("offline");
    });
  });

  describe("pending card (v2-next)", () => {
    const rowEls = () => [...h!.container.querySelectorAll('[data-testid="inbox-row"]')] as HTMLElement[];
    const header = () => h!.container.querySelector('[data-testid="inbox-header"]')?.textContent;
    const footer = () => h!.container.querySelector('[data-testid="inbox-footer"]');
    const click = async (el: Element | null) => {
      expect(el).not.toBeNull();
      await act(async () => (el as HTMLButtonElement).click());
      await h!.flush();
    };

    it("header counts messages with singular/plural", async () => {
      await open();
      await pushInbox([item("m1", "one")]);
      expect(header()).toBe("Pending · 1 message");
      await pushInbox([item("m1", "one"), item("m2", "two", 0, "queue")]);
      expect(header()).toBe("Pending · 2 messages");
    });

    it("rows: badge, text, note and the per-kind action; × on every row; oldest first", async () => {
      await open();
      await pushInbox([item("m1", "use staging", 0, "steer"), item("m2", "update CHANGELOG", 0, "queue")]);
      const [now, after] = rowEls();
      expect(now.querySelector('[data-testid="inbox-text"]')?.textContent).toBe("use staging");
      expect(now.querySelector('[data-testid="inbox-badge"]')?.textContent).toBe("Now");
      expect(now.querySelector('[data-testid="inbox-note"]')?.textContent).toBe("at next step");
      expect(now.querySelector('[data-testid="inbox-wait"]')?.textContent).toBe("Wait");
      expect(now.querySelector('[data-testid="inbox-send-now"]')).toBeNull();
      expect(after.querySelector('[data-testid="inbox-badge"]')?.textContent).toBe("After this turn");
      expect(after.querySelector('[data-testid="inbox-note"]')).toBeNull();
      expect(after.querySelector('[data-testid="inbox-send-now"]')?.textContent).toBe("Send now");
      expect(after.querySelector('[data-testid="inbox-wait"]')).toBeNull();
      for (const r of [now, after]) expect(r.querySelector('[data-testid="inbox-cancel"]')).not.toBeNull();
    });

    it("a Now row says 'runs next' once the agent is stopped", async () => {
      await open();
      await pushInbox([item("m1", "use staging")]);
      await setRunning(false);
      expect(rowEls()[0].querySelector('[data-testid="inbox-note"]')?.textContent).toBe("runs next");
    });

    it("stopped footer: only when not running AND an After item is present", async () => {
      await open();
      await pushInbox([item("m1", "later", 0, "queue")]);
      expect(footer()).toBeNull(); // running
      await setRunning(false);
      expect(footer()?.textContent).toBe(STOPPED_FOOTER_TEXT);
      await pushInbox([item("m2", "now only", 0, "steer")]);
      expect(footer()).toBeNull(); // only Now items
      await pushInbox([item("m2", "now only", 0, "steer"), item("m3", "later", 0, "queue")]);
      expect(footer()).not.toBeNull();
      await setRunning(true);
      expect(footer()).toBeNull();
    });

    it("Send now → N1 steer; changed needs nothing more (no banner, no toast)", async () => {
      await open({ opencodeInboxSetDelivery: () => Promise.resolve({ outcome: "changed" }) });
      await pushInbox([item("m1", "later", 0, "queue")]);
      await click(h!.container.querySelector('[data-testid="inbox-send-now"]'));
      expect(api.calls.opencodeInboxSetDelivery).toEqual([[{ sessionId: SID, id: "m1", delivery: "steer" }]]);
      expect(sendError()).toBe("");
      expect(useStore.getState().systemNotice).toBeNull();
      // the next inbox frame is what flips the badge
      await pushInbox([item("m1", "later", 0, "steer")]);
      expect(rowEls()[0].querySelector('[data-testid="inbox-badge"]')?.textContent).toBe("Now");
    });

    it("Wait → N1 queue", async () => {
      await open({ opencodeInboxSetDelivery: () => Promise.resolve({ outcome: "changed" }) });
      await pushInbox([item("m1", "now", 0, "steer")]);
      await click(h!.container.querySelector('[data-testid="inbox-wait"]'));
      expect(api.calls.opencodeInboxSetDelivery).toEqual([[{ sessionId: SID, id: "m1", delivery: "queue" }]]);
      expect(sendError()).toBe("");
    });

    it("delivered → the 'Already sent' toast", async () => {
      await open({ opencodeInboxSetDelivery: () => Promise.resolve({ outcome: "delivered" }) });
      await pushInbox([item("m1", "later", 0, "queue")]);
      await click(h!.container.querySelector('[data-testid="inbox-send-now"]'));
      expect(useStore.getState().systemNotice).toBe("Already sent to the agent");
      expect(sendError()).toBe("");
    });

    it("unknown → an error banner, never silent", async () => {
      await open({ opencodeInboxSetDelivery: () => Promise.resolve({ outcome: "unknown" }) });
      await pushInbox([item("m1", "now", 0, "steer")]);
      await click(h!.container.querySelector('[data-testid="inbox-wait"]'));
      expect(sendError()).toBe("Couldn't confirm the change — check the pending list");
    });

    it("a thrown error → an error banner with the message", async () => {
      await open({ opencodeInboxSetDelivery: () => Promise.reject(new Error("offline")) });
      await pushInbox([item("m1", "later", 0, "queue")]);
      await click(h!.container.querySelector('[data-testid="inbox-send-now"]'));
      expect(sendError()).toContain("offline");
    });

    it("one action in flight per row: the row's controls are disabled until the box answers", async () => {
      let release!: (v: unknown) => void;
      await open({ opencodeInboxSetDelivery: () => new Promise((res) => (release = res)) });
      await pushInbox([item("m1", "later", 0, "queue")]);
      const btn = () => h!.container.querySelector('[data-testid="inbox-send-now"]') as HTMLButtonElement;
      await click(btn());
      expect(btn().disabled).toBe(true);
      expect((h!.container.querySelector('[data-testid="inbox-cancel"]') as HTMLButtonElement).disabled).toBe(true);
      await click(btn());
      expect(api.calls.opencodeInboxSetDelivery).toHaveLength(1);
      await act(async () => release({ outcome: "changed" }));
      await h!.flush();
      expect(btn().disabled).toBe(false);
    });

    it("↑ edit last (header button) pops the newest and restores its text — same as the ↑ key", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "cancelled", item: item("m2", "second text") }) });
      await pushInbox([item("m1", "first"), item("m2", "second text")]);
      await click(h!.container.querySelector('[data-testid="inbox-edit-last"]'));
      expect(api.calls.opencodeInboxCancel).toEqual([[{ sessionId: SID, id: "m2" }]]);
      expect(textarea().value).toBe("second text");
    });

    it("× still reports a delivered item exactly as before", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "delivered" }) });
      await pushInbox([item("m1", "later", 0, "queue")]);
      await click(h!.container.querySelector('[data-testid="inbox-cancel"]'));
      expect(useStore.getState().systemNotice).toBe("Already sent to the agent");
    });
  });

  describe("pop-last (↑ on an empty composer)", () => {
    it("cancels the NEWEST pending item and restores its text", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "cancelled", item: item("m2", "second text") }) });
      await pushInbox([item("m1", "first"), item("m2", "second text")]);
      await key("ArrowUp");
      expect(api.calls.opencodeInboxCancel).toEqual([[{ sessionId: SID, id: "m2" }]]);
      expect(textarea().value).toBe("second text");
    });

    it("cancelled with attachments: text restored + the attachments note", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "cancelled", item: item("m1", "see image", 2) }) });
      await pushInbox([item("m1", "see image", 2)]);
      await key("ArrowUp");
      expect(textarea().value).toBe("see image");
      expect(useStore.getState().systemNotice).toBe("Attachments weren't restored — re-attach them");
    });

    it("delivered: 'Already sent to the agent', nothing restored", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "delivered" }) });
      await pushInbox([item("m1", "first")]);
      await key("ArrowUp");
      expect(useStore.getState().systemNotice).toBe("Already sent to the agent");
      expect(textarea().value).toBe("");
    });

    it("unknown: warns it may still be sent, restores NOTHING (it could be sent twice)", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "unknown" }) });
      await pushInbox([item("m1", "first")]);
      await key("ArrowUp");
      expect(sendError()).toBe("Couldn't confirm it was cancelled — it may still be sent");
      expect(textarea().value).toBe("");
    });

    it("a failing cancel reports the error and restores nothing", async () => {
      await open({ opencodeInboxCancel: () => Promise.reject(new Error("nope")) });
      await pushInbox([item("m1", "first")]);
      await key("ArrowUp");
      expect(sendError()).toContain("nope");
      expect(textarea().value).toBe("");
    });

    it("with nothing pending it falls through to prompt history (no swallowed keypress)", async () => {
      await open();
      await key("ArrowUp");
      expect(api.calls.opencodeInboxCancel ?? []).toEqual([]);
    });
  });

  describe("user Stop", () => {
    it("still shows the Aborted notice (no drain suppression exists any more)", async () => {
      await open();
      await emitStreamAndFlush(bus, h!, { sub: "aborted", sessionId: SID, payload: {} });
      expect(sendError()).toBe("Aborted");
    });
  });

  describe("command origin", () => {
    const msgs = (command?: { name: string; arguments: string }) => [
      {
        info: { id: "msg_u1", sessionID: SID, role: "user" as const, ...(command ? { command } : {}) },
        parts: [{ type: "text", id: "p1", messageID: "msg_u1", text: "EXPANDED TEMPLATE BODY" }],
      },
    ];

    it("shows the collapsed /name args bar from info.command", async () => {
      ({ api, bus } = installMockApi({ opencodeMessages: () => Promise.resolve(msgs({ name: "review", arguments: "HEAD~1" })) }));
      resetStore();
      h = mount(<ChatPanel {...PROPS} />);
      await h.flush();
      expect(h.text()).toContain("/review");
      expect(h.text()).toContain("HEAD~1");
      expect(h.text()).not.toContain("EXPANDED TEMPLATE BODY");
    });

    it("falls back to the live commandExecuted frame keyed by the user message id", async () => {
      ({ api, bus } = installMockApi({ opencodeMessages: () => Promise.resolve(msgs()) }));
      resetStore();
      h = mount(<ChatPanel {...PROPS} />);
      await h.flush();
      expect(h.text()).toContain("EXPANDED TEMPLATE BODY");
      await emitStreamAndFlush(bus, h, {
        sub: "commandExecuted",
        sessionId: SID,
        payload: { messageID: "msg_u1", name: "init", arguments: "" },
      });
      expect(h.text()).toContain("/init");
      expect(h.text()).not.toContain("EXPANDED TEMPLATE BODY");
    });

    it("an unattributed command message just shows its text", async () => {
      ({ api, bus } = installMockApi({ opencodeMessages: () => Promise.resolve(msgs()) }));
      resetStore();
      h = mount(<ChatPanel {...PROPS} />);
      await h.flush();
      expect(h.text()).toContain("EXPANDED TEMPLATE BODY");
    });
  });
});
