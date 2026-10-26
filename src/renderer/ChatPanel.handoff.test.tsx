// @vitest-environment jsdom
//
// Auto-handoff inside the real <ChatPanel> (spec 2026-10-26-auto-handoff.md):
// the pinned card, `/handoff`, the mode control, the §6.4 pane switch, composer
// + prefs carry-over, draft consumption, the successor chrome and Previous
// sessions. Each test drives the mocked box (rpc channels + the `handoff` bus)
// and asserts on the rendered DOM / the rpc calls — no component internals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { HandoffEventPayload, HandoffRecord, HandoffSessionInfo } from "../shared/api";
import { ChatPanel } from "./ChatPanel";
import { readPlanSaved, writePlanSaved } from "./chatShared";
import { writeCarry } from "./handoffCarry";
import { resetHandoffStore } from "./handoffStore";
import { useStore } from "./store";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";

const SID = "ses_old";
const PROPS = { sessionId: SID, tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true, projectName: "proj", winName: "chat-1", mode: "chat" as const };

const rec = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  id: "hof_a",
  fromSessionId: SID,
  kind: "suggest",
  trigger: "user",
  state: "ready",
  text: "## Goal\nship it",
  createdAt: 10,
  updatedAt: 10,
  ...over,
});

const EMPTY: HandoffSessionInfo = { records: [], links: null, continuation: null };

/** A handoff bus the test can write to. */
function makeBus() {
  const subs = new Set<(p: HandoffEventPayload) => void>();
  return {
    on: (cb: (p: HandoffEventPayload) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    count: () => subs.size,
    async emit(ev: HandoffEventPayload) {
      await act(async () => {
        for (const cb of Array.from(subs)) cb(ev);
      });
    },
  };
}

const assistantMsg = (id: string, input: number) => ({
  info: { id, sessionID: SID, role: "assistant", time: { created: 1, completed: 2 }, tokens: { input, output: 10, cache: { read: 0, write: 0 } } },
  parts: [{ id: `${id}-t`, messageID: id, type: "text", text: "hello" }],
});

describe("ChatPanel — auto-handoff", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let bus: ReturnType<typeof makeBus>;
  let refresh: ReturnType<typeof vi.fn>;
  const lists: Record<string, HandoffSessionInfo> = {};

  beforeEach(() => {
    localStorage.clear();
    resetHandoffStore();
    for (const k of Object.keys(lists)) delete lists[k];
    bus = makeBus();
    // `refresh` is what moves the pane: it re-reads the window list, where the box
    // has restamped the window to the successor by the time the commit is announced.
    refresh = vi.fn(async () => {
      useStore.setState({
        projects: [{ tmuxSession: "proj", defaultCwd: "/x", windows: [{ index: 1, name: "chat-1", opencodeSessionId: "ses_new" }] }] as never,
      });
    });
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(overrides: Record<string, unknown> = {}, props: Partial<typeof PROPS> = {}) {
    ({ api } = installMockApi({
      onHandoff: bus.on,
      handoffList: ({ sessionId }: { sessionId: string }) => Promise.resolve(lists[sessionId] ?? EMPTY),
      configUpdate: (patch: Record<string, unknown>) => Promise.resolve({ ...patch }),
      ...overrides,
    }));
    resetStore({ refresh, projects: [{ tmuxSession: "proj", defaultCwd: "/x", windows: [{ index: 1, name: "chat-1", opencodeSessionId: SID }] }] } as never);
    h = mount(<ChatPanel {...PROPS} {...props} />);
    await h.flush();
    await h.flush();
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
  async function enter() {
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await h!.flush();
  }
  const sendErrorText = () =>
    [...h!.container.querySelectorAll("span.flex-1")].map((e) => e.textContent ?? "").find((t) => t.startsWith("⚠ ")) ?? "";
  const byText = (text: string, root: ParentNode = document.body) =>
    [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  async function click(el: Element | undefined | null) {
    expect(el, "expected the control").toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  describe("pinned card", () => {
    it("pins a ready server-path record above the composer, and its actions call the box", async () => {
      lists[SID] = { records: [rec()], links: null, continuation: null };
      await open({
        handoffStart: () => Promise.resolve({ handoff: rec({ state: "committed", how: "clear", successorId: "ses_new", updatedAt: 11 }) }),
      });
      const card = h!.container.querySelector('[data-testid="handoff-card"]');
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain("ship it");
      // above the composer in document order
      expect(card!.compareDocumentPosition(textarea()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await click(byText("Clear & start", h!.container));
      expect(api.calls.handoffStart).toEqual([[{ id: "hof_a", how: "clear", disposition: "send" }]]);
    });

    it("does not pin agent-path records (they are the tool part) or started ones", async () => {
      lists[SID] = { records: [rec({ trigger: "agent" })], links: null, continuation: null };
      await open();
      expect(h!.container.querySelector('[data-testid="handoff-card"]')).toBeNull();
    });

    it("follows the record when the box announces it started", async () => {
      lists[SID] = { records: [rec()], links: null, continuation: null };
      await open();
      expect(h!.container.querySelector('[data-testid="handoff-badge"]')?.textContent).toBe("ready");
      lists[SID] = { records: [rec({ state: "starting", updatedAt: 11 })], links: null, continuation: null };
      await bus.emit({ id: "hof_a", fromSessionId: SID, state: "starting" });
      await h!.flush();
      expect(h!.container.querySelector('[data-testid="handoff-badge"]')?.textContent).toBe("starting");
      expect(byText("Clear & start", h!.container)!.disabled).toBe(true);
    });
  });

  describe("inline card (agent path)", () => {
    const toolMsg = {
      info: { id: "m_h", sessionID: SID, role: "assistant", time: { created: 1, completed: 2 } },
      parts: [
        { id: "p_bash", messageID: "m_h", type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a" } },
        {
          id: "p_hand",
          messageID: "m_h",
          type: "tool",
          tool: "handoff",
          state: { status: "completed", input: { action: "suggest", body: "x" }, output: "Handoff prompt ready below.\n<!-- manta-handoff:hof_inl -->" },
        },
      ],
    };

    it("renders the `handoff` tool part as the card — standing alone, not folded into a tool group", async () => {
      await open({
        opencodeMessages: () => Promise.resolve([toolMsg]),
        handoffGet: () => Promise.resolve({ handoff: rec({ id: "hof_inl", trigger: "agent" }) }),
      });
      const card = h!.container.querySelector('[data-testid="handoff-card"]');
      expect(card).not.toBeNull();
      expect(api.calls.handoffGet).toEqual([[{ id: "hof_inl" }]]);
      expect(h!.text()).not.toContain("manta-handoff");
      // the preceding bash call is still an ordinary tool row; the card is not inside any collapsed group
      expect(card!.closest("[aria-expanded='false']")).toBeNull();
    });
  });

  describe("/handoff", () => {
    it("is intercepted: creates a ready card via handoff:create and sends nothing to the model", async () => {
      await open();
      await type("/handoff focus on the auth bug");
      await enter();
      expect(api.calls.handoffCreate).toEqual([[{ sessionId: SID, trigger: "user", action: "suggest", goal: "focus on the auth bug" }]]);
      expect(api.calls.opencodePrompt).toBeUndefined();
      expect(textarea().value).toBe("");
      // no optimistic user row for a local command
      expect(h!.text()).not.toContain("focus on the auth bug");
    });

    it("works without a goal", async () => {
      await open();
      await type("/handoff");
      await enter();
      expect(api.calls.handoffCreate).toEqual([[{ sessionId: SID, trigger: "user", action: "suggest" }]]);
    });

    it("reports a failure", async () => {
      await open({ handoffCreate: () => Promise.reject(new Error("busy")) });
      await type("/handoff");
      await enter();
      expect(sendErrorText()).toMatch(/Couldn't hand off: .*busy/);
    });

    it("is offered in the slash palette", async () => {
      await open();
      await type("/hand");
      expect(document.body.textContent).toContain("Write a handoff prompt");
    });
  });

  describe("Hand off button (context popover)", () => {
    it("creates a ready card with trigger button", async () => {
      await open({ opencodeMessages: () => Promise.resolve([assistantMsg("m1", 5000)]) });
      await click(h!.container.querySelector(".manta-ctx-pill"));
      await click(byText("Hand off"));
      expect(api.calls.handoffCreate).toEqual([[{ sessionId: SID, trigger: "button", action: "suggest" }]]);
    });

    it("a refusal is reported in the panel", async () => {
      await open({ opencodeMessages: () => Promise.resolve([assistantMsg("m1", 5000)]), handoffCreate: () => Promise.reject(new Error("busy")) });
      await click(h!.container.querySelector(".manta-ctx-pill"));
      await click(byText("Hand off"));
      expect(sendErrorText()).toMatch(/Couldn't hand off/);
    });
  });

  describe("mode control", () => {
    it("sits beside the trust toggle and cycles + persists", async () => {
      await open();
      const btn = () => h!.container.querySelector('[data-testid="handoff-mode"]') as HTMLButtonElement;
      expect(btn()).not.toBeNull();
      expect(btn().textContent).toContain("Handoff: auto");
      await click(btn());
      expect(btn().textContent).toContain("Handoff: suggest");
      expect(api.calls.configUpdate).toEqual([[{ handoffMode: "suggest" }]]);
    });

    it("reports a save that fails", async () => {
      await open({ configUpdate: () => Promise.reject(new Error("nope")) });
      await click(h!.container.querySelector('[data-testid="handoff-mode"]') as HTMLElement);
      expect(h!.container.querySelector('[data-testid="handoff-mode"]')!.textContent).toContain("Handoff: auto");
      expect(h!.text()).toContain("Couldn't save handoff mode: nope");
    });
  });

  describe("§6.4 pane switch on a committed replacement", () => {
    const commit: HandoffEventPayload = { id: "hof_r", fromSessionId: SID, successorId: "ses_new", state: "committed", how: "clear" };

    it("switches a pane that shows the predecessor", async () => {
      await open();
      await bus.emit(commit);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("does not switch a pane showing some other session", async () => {
      await open({}, { sessionId: "ses_other" });
      await bus.emit(commit);
      expect(refresh).not.toHaveBeenCalled();
    });

    it("never switches for a branch (only the initiating client does)", async () => {
      await open();
      await bus.emit({ ...commit, how: "new-session" });
      expect(refresh).not.toHaveBeenCalled();
    });

    it("waits for the commit", async () => {
      await open();
      await bus.emit({ ...commit, state: "starting" });
      expect(refresh).not.toHaveBeenCalled();
    });

    it("acts once however many times the commit is announced", async () => {
      await open();
      await bus.emit(commit);
      await bus.emit(commit);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("also switches on load when the box says this session was replaced", async () => {
      lists[SID] = { records: [], links: { replacedBy: "ses_new" }, continuation: null };
      await open();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("copies Auto/model prefs and the plan toggle, and carries unsent text to the successor", async () => {
      writePlanSaved(SID, true);
      await open();
      await type("half-typed thought");
      await bus.emit({ ...commit, id: "hof_carry" });
      expect(readPlanSaved("ses_new")).toBe(true);
      expect(localStorage.getItem("manta:handoff:carry:ses_new")).toContain("half-typed thought");
    });

    it("says so and carries nothing when the switch fails", async () => {
      refresh.mockRejectedValueOnce(new Error("offline"));
      await open();
      await type("keep this");
      await bus.emit({ ...commit, id: "hof_fail" });
      expect(sendErrorText()).toContain("the switch failed");
      expect(localStorage.getItem("manta:handoff:carry:ses_new")).toBeNull();
      expect(textarea().value).toBe("keep this");
    });
  });

  describe("successor chrome", () => {
    const creating = rec({ id: "hof_c", fromSessionId: "ses_prev", successorId: SID, state: "committed", how: "clear", createdAt: 5, updatedAt: 5 });
    const sessions = (id: string) =>
      id === SID ? Promise.resolve([]) : Promise.resolve([assistantMsg("pm1", 182_000)].map((m) => ({ ...m, info: { ...m.info, sessionID: "ses_prev" } })));

    it("shows 'Carried-over context' while a preamble is unconsumed and drops it once consumed", async () => {
      lists[SID] = { records: [creating], links: { replaces: "ses_prev" }, continuation: { preamble: "## Goal\nold work" } };
      await open({ opencodeMessages: sessions });
      const block = h!.container.querySelector('[data-testid="handoff-carried"]');
      expect(block?.textContent).toContain("Carried-over context — sent with the next message.");
      expect(block?.textContent).not.toContain("old work");
      await click(block!.querySelector("button"));
      expect(h!.container.querySelector('[data-testid="handoff-carried"]')!.textContent).toContain("old work");
      lists[SID] = { records: [creating], links: { replaces: "ses_prev" }, continuation: {} };
      await bus.emit({ id: "hof_c", fromSessionId: "ses_prev", successorId: SID, state: "committed", how: "clear" });
      await h!.flush();
      expect(h!.container.querySelector('[data-testid="handoff-carried"]')).toBeNull();
    });

    it("shows 'Continued from <title> — handed off at 182k tokens · View previous'", async () => {
      lists[SID] = { records: [creating], links: { replaces: "ses_prev" }, continuation: null };
      await open({
        opencodeMessages: sessions,
        opencodeListSessions: () => Promise.resolve([{ id: "ses_prev", title: "Fix login" }]),
      });
      const n = h!.container.querySelector('[data-testid="handoff-continuation"]');
      expect(n?.textContent).toContain("Continued from “Fix login” — handed off at 182k tokens");
      expect(n?.textContent).toContain("View previous");
    });

    it("lists Previous sessions in the menu; opening one is read-only with a Back to current bar", async () => {
      lists[SID] = { records: [creating], links: { replaces: "ses_prev" }, continuation: null };
      await open({
        opencodeMessages: sessions,
        opencodeListSessions: () => Promise.resolve([{ id: "ses_prev", title: "Fix login" }]),
      });
      await click(h!.container.querySelector('button[aria-label="Session actions"]'));
      expect(document.body.textContent).toContain("Previous sessions");
      await click(byText("Fix login"));
      const bar = h!.container.querySelector('[data-testid="handoff-previous-bar"]');
      expect(bar?.textContent).toContain("Viewing a previous session — Fix login (read-only)");
      expect(h!.container.querySelector("textarea")).toBeNull(); // no way to send
      await click(byText("Back to current", h!.container));
      expect(h!.container.querySelector('[data-testid="handoff-previous-bar"]')).toBeNull();
      expect(h!.container.querySelector("textarea")).not.toBeNull();
    });

    it("opening a deleted previous session says it was deleted", async () => {
      lists[SID] = { records: [creating], links: { replaces: "ses_prev" }, continuation: null };
      await open({
        opencodeMessages: (id: string) => (id === SID ? Promise.resolve([]) : Promise.reject(new Error("404"))),
        opencodeListSessions: () => Promise.resolve([]),
      });
      await click(h!.container.querySelector('[data-testid="handoff-continuation"] button'));
      expect(h!.container.querySelector('[data-testid="handoff-deleted"]')?.textContent).toBe("This session was deleted.");
      expect(h!.container.querySelector('[data-testid="handoff-previous-bar"]')?.textContent).toContain("This session was deleted.");
      await click(byText("Back to current", h!.container));
      expect(h!.container.querySelector("textarea")).not.toBeNull();
    });

    it("no previous sessions → no menu group", async () => {
      await open();
      await click(h!.container.querySelector('button[aria-label="Session actions"]'));
      expect(document.body.textContent).not.toContain("Previous sessions");
    });
  });

  describe("composer carry-over + draft consumption into the successor", () => {
    const editRec = rec({ id: "hof_d", fromSessionId: "ses_prev", successorId: SID, state: "committed", how: "clear", disposition: "draft", createdAt: 5, updatedAt: 5 });

    it("loads the carried composer text", async () => {
      writeCarry(SID, { text: "typed before the switch", attachments: [] });
      await open();
      expect(textarea().value).toBe("typed before the switch");
      expect(localStorage.getItem(`manta:handoff:carry:${SID}`)).toBeNull();
    });

    it("persists the draft locally BEFORE telling the box, then loads it above carried text", async () => {
      lists[SID] = { records: [editRec], links: { replaces: "ses_prev" }, continuation: { draft: "EDITED HANDOFF", draftRevision: 1 } };
      writeCarry(SID, { text: "my unsent note", attachments: [] });
      let localCopyWhenConsumed: string | null = null;
      await open({
        handoffDraftConsumed: () => {
          localCopyWhenConsumed = localStorage.getItem(`manta:handoff:carry:${SID}`);
          return Promise.resolve();
        },
      });
      expect(api.calls.handoffDraftConsumed).toEqual([[{ id: "hof_d", draftRevision: 1 }]]);
      expect(localCopyWhenConsumed).toContain("EDITED HANDOFF");
      expect(textarea().value).toBe("EDITED HANDOFF\n\nmy unsent note");
    });

    it("loads a revision once, however often the session is refetched", async () => {
      lists[SID] = { records: [editRec], links: { replaces: "ses_prev" }, continuation: { draft: "EDITED", draftRevision: 1 } };
      await open();
      await bus.emit({ id: "hof_d", fromSessionId: "ses_prev", successorId: SID, state: "committed", how: "clear", disposition: "draft" });
      await h!.flush();
      expect(api.calls.handoffDraftConsumed).toHaveLength(1);
      expect(textarea().value).toBe("EDITED");
    });

    it("skips a draft the box already reports as consumed", async () => {
      lists[SID] = { records: [editRec], links: { replaces: "ses_prev" }, continuation: { draft: "EDITED", draftRevision: 1, draftConsumed: true } };
      await open();
      expect(api.calls.handoffDraftConsumed).toBeUndefined();
      expect(textarea().value).toBe("");
    });

    it("still loads the draft if the box can't be told, and says so", async () => {
      lists[SID] = { records: [editRec], links: { replaces: "ses_prev" }, continuation: { draft: "EDITED", draftRevision: 2 } };
      await open({ handoffDraftConsumed: () => Promise.reject(new Error("offline")) });
      expect(textarea().value).toBe("EDITED");
      expect(sendErrorText()).toMatch(/couldn't mark it as used/);
    });
  });
});
