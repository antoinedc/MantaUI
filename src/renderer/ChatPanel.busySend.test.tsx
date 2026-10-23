// @vitest-environment jsdom
//
// OpenCode V2 cleanup spec §2: a message sent while the agent is working goes
// INTO the running turn (steer) and is listed in the "⏳ queued" card from the
// box's inbox; pop-last and × cancel it through opencode:inbox-cancel. Every
// branch of every action must report visibly (AGENTS.md "never stub a control").

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { useStore } from "./store";
import { resetRetiredInboxEpochs } from "./inboxState";
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

const item = (id: string, text: string, attachmentCount = 0) => ({
  id,
  text,
  delivery: "steer" as const,
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
  async function key(k: string) {
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    });
    await h!.flush();
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
      const send = h!.container.querySelector('button[aria-label="Queue message while running"]') as HTMLButtonElement;
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
      const x = h!.container.querySelector('[data-testid="inbox-row"] button') as HTMLButtonElement;
      await act(async () => x.click());
      await h!.flush();
      expect(api.calls.opencodeInboxCancel).toEqual([[{ sessionId: SID, id: "m1" }]]);
      expect(sendError()).toBe("");
      expect(textarea().value).toBe("");
    });

    it("× on an item that was already delivered says so", async () => {
      await open({ opencodeInboxCancel: () => Promise.resolve({ outcome: "delivered" }) });
      await pushInbox([item("m1", "first")]);
      await act(async () => (h!.container.querySelector('[data-testid="inbox-row"] button') as HTMLButtonElement).click());
      await h!.flush();
      expect(useStore.getState().systemNotice).toBe("Already sent to the agent");
    });

    it("× failing shows the error", async () => {
      await open({ opencodeInboxCancel: () => Promise.reject(new Error("offline")) });
      await pushInbox([item("m1", "first")]);
      await act(async () => (h!.container.querySelector('[data-testid="inbox-row"] button') as HTMLButtonElement).click());
      await h!.flush();
      expect(sendError()).toContain("offline");
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
