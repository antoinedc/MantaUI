// @vitest-environment jsdom
//
// The agent-change card (Agents Phase 4, spec §4): states and buttons, every press awaited with the outcome shown,
// the diff view, the no-record state, and a running call that gets its record from a bus hint without a reload.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { AgentChange, AgentChangeEvent, OpencodePart } from "../shared/types";
import { AgentChangeCard } from "./AgentChangeCard";
import { ToolCall } from "./ToolCall";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";

const CREATE_MD =
  "---\nname: Reviewer\ndescription: Reviews pull requests\nisolation: none\nuse_when: a PR needs a look\nnot_for: writing code\n---\nYou review pull requests.\nNever edit files.\n";

const change = (over: Partial<AgentChange> = {}): AgentChange => ({
  id: "ach_0123456789abcdef",
  kind: "create",
  slug: null,
  agentName: "Reviewer",
  sessionID: "ses_1",
  messageID: "msg_1",
  callID: "call_1",
  state: "pending",
  needsClick: true,
  reason: "ask",
  before: null,
  after: CREATE_MD,
  createdAt: 1,
  decidedAt: null,
  error: null,
  ...over,
});

const part = (status = "completed", output?: string): OpencodePart =>
  ({
    id: "p1",
    type: "tool",
    tool: "agent_change",
    callID: "call_1",
    messageID: "msg_1",
    sessionID: "ses_1",
    state: { status, input: { action: "create", draft: {} }, ...(output !== undefined ? { output } : {}) },
  }) as unknown as OpencodePart;

const buttons = (h: Harness) => Array.from(h.container.querySelectorAll("button"));
const byText = (h: Harness, text: string) =>
  buttons(h).find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
const q = (h: Harness, id: string) => h.container.querySelector(`[data-testid="${id}"]`);
const chip = (h: Harness) => q(h, "agent-change-chip")?.textContent;

async function press(h: Harness, el: HTMLElement | undefined | null) {
  expect(el, "expected the control to exist").toBeTruthy();
  await act(async () => {
    el!.click();
  });
  await h.flush();
}

describe("AgentChangeCard", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let hint: ((p: AgentChangeEvent) => void) | null;
  let offCount: number;
  let current: AgentChange | null;

  const open = (over: Record<string, unknown> = {}, p: OpencodePart = part()) => {
    ({ api } = installMockApi({
      agentsChangeFor: () => Promise.resolve(current),
      onAgentChange: (cb: (p: AgentChangeEvent) => void) => {
        hint = cb;
        return () => {
          offCount++;
          hint = null;
        };
      },
      ...over,
    }));
    h = mount(<AgentChangeCard part={p} />);
  };

  beforeEach(() => {
    resetStore();
    hint = null;
    offCount = 0;
    current = change();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("looks the record up by the call's tuple and shows the new agent", async () => {
    open();
    await h!.flush();
    expect(api.calls.agentsChangeFor).toEqual([[{ sessionID: "ses_1", messageID: "msg_1", callID: "call_1" }]]);
    expect(h!.text()).toContain("New agent: Reviewer");
    expect(chip(h!)).toBe("Waiting for you");
    expect(h!.text()).toContain("Reviews pull requests");
    expect(h!.text()).toContain("Use when: a PR needs a look");
    expect(h!.text()).toContain("Not for: writing code");
    expect(q(h!, "agent-change-facts")?.textContent).toBe("Read-only · Model: Auto");
    const details = q(h!, "agent-change-instructions") as HTMLDetailsElement;
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Never edit files.");
    expect(byText(h!, "Create")).toBeTruthy();
    expect(byText(h!, "Discard")).toBeTruthy();
    expect(byText(h!, "Undo")).toBeUndefined();
  });

  it("says a worktree agent edits code on its own branch, and names a pinned model", async () => {
    current = change({
      after: "---\nname: Dev\ndescription: Builds\nisolation: worktree\nmodel: anthropic/claude-x\n---\nGo.\n",
    });
    open();
    await h!.flush();
    expect(q(h!, "agent-change-facts")?.textContent).toBe("Edits code (own branch) · Model: anthropic/claude-x");
  });

  it("shows the reason line for a change that raises power", async () => {
    current = change({ kind: "update", agentName: "Manta", before: CREATE_MD, after: CREATE_MD.replace("review", "triage"), reason: "lead" });
    open();
    await h!.flush();
    expect(q(h!, "agent-change-reason")?.textContent).toBe("This changes Manta's own instructions");
    expect(byText(h!, "Apply")).toBeTruthy();
  });

  it("an Ask-level proposal gives no reason line", async () => {
    open();
    await h!.flush();
    expect(q(h!, "agent-change-reason")).toBeNull();
  });

  it("Create awaits the box, disables both buttons meanwhile, and shows the new chip and a line", async () => {
    let finish!: (c: AgentChange) => void;
    open({ agentsChangeApply: () => new Promise<AgentChange>((r) => (finish = r)) });
    await h!.flush();
    await act(async () => {
      byText(h!, "Create")!.click();
    });
    expect(api.calls.agentsChangeApply).toEqual([["ach_0123456789abcdef"]]);
    expect(byText(h!, "Creating…")).toBeTruthy();
    expect(byText(h!, "Creating…")!.disabled).toBe(true);
    expect(byText(h!, "Discard")!.disabled).toBe(true);
    await act(async () => {
      finish(change({ state: "applied", slug: "reviewer", decidedAt: 2 }));
    });
    await h!.flush();
    expect(chip(h!)).toBe("Created");
    expect(q(h!, "agent-change-notice")?.textContent).toContain("Created.");
    expect(q(h!, "agent-change-notice")?.getAttribute("role")).toBe("status");
    expect(h!.text()).toContain("@reviewer");
    expect(byText(h!, "Undo")).toBeTruthy();
    expect(byText(h!, "Create")).toBeUndefined();
  });

  it("Discard calls the discard channel and ends with a Discarded chip and no buttons", async () => {
    open({ agentsChangeDiscard: () => Promise.resolve(change({ state: "discarded", decidedAt: 2 })) });
    await h!.flush();
    await press(h!, byText(h!, "Discard"));
    expect(api.calls.agentsChangeDiscard).toEqual([["ach_0123456789abcdef"]]);
    expect(chip(h!)).toBe("Discarded");
    expect(buttons(h!)).toHaveLength(0);
  });

  it("Undo on an applied change calls the undo channel", async () => {
    current = change({ state: "applied", slug: "reviewer", needsClick: false, reason: null });
    open({ agentsChangeUndo: () => Promise.resolve(change({ state: "undone", slug: "reviewer" })) });
    await h!.flush();
    expect(chip(h!)).toBe("Created");
    expect(buttons(h!).map((b) => b.textContent)).toEqual(["Undo"]);
    await press(h!, byText(h!, "Undo"));
    expect(api.calls.agentsChangeUndo).toEqual([["ach_0123456789abcdef"]]);
    expect(chip(h!)).toBe("Undone");
    expect(buttons(h!)).toHaveLength(0);
  });

  it("shows the box's sentence when it refuses a press, keeps the state and re-enables the buttons", async () => {
    open({ agentsChangeApply: () => Promise.reject(new Error("Changing agents is turned off in your autonomy settings")) });
    await h!.flush();
    await press(h!, byText(h!, "Create"));
    const alert = q(h!, "agent-change-notice");
    expect(alert?.textContent).toBe("Changing agents is turned off in your autonomy settings");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(chip(h!)).toBe("Waiting for you");
    expect(byText(h!, "Create")!.disabled).toBe(false);
    expect(byText(h!, "Discard")!.disabled).toBe(false);
  });

  it("a press that lands in conflict shows the box's sentence instead of a success line", async () => {
    current = change({ kind: "update", before: CREATE_MD, after: CREATE_MD.replace("review", "triage") });
    open({
      agentsChangeApply: () =>
        Promise.resolve(change({ kind: "update", state: "conflict", before: CREATE_MD, error: "Dev changed since this was proposed; ask Manta again" })),
    });
    await h!.flush();
    await press(h!, byText(h!, "Apply"));
    expect(chip(h!)).toBe("Not applied");
    expect(q(h!, "agent-change-error")?.textContent).toBe("Dev changed since this was proposed; ask Manta again");
    expect(q(h!, "agent-change-notice")).toBeNull();
    expect(buttons(h!)).toHaveLength(0);
  });

  it("a failed record says it was written, not activated, and Retry is the apply channel", async () => {
    current = change({ state: "failed", slug: "reviewer", error: "Reviewer was written but couldn't be activated: reload failed" });
    open({ agentsChangeApply: () => Promise.resolve(change({ state: "applied", slug: "reviewer" })) });
    await h!.flush();
    expect(chip(h!)).toBe("Written, not activated");
    expect(q(h!, "agent-change-error")?.textContent).toContain("couldn't be activated");
    expect(buttons(h!).map((b) => b.textContent)).toEqual(["Retry"]);
    await press(h!, byText(h!, "Retry"));
    expect(api.calls.agentsChangeApply).toEqual([["ach_0123456789abcdef"]]);
    expect(chip(h!)).toBe("Created");
    expect(q(h!, "agent-change-error")).toBeNull();
  });

  it("terminal states carry no buttons", async () => {
    for (const state of ["discarded", "undone", "expired", "conflict"] as const) {
      current = change({ state, error: state === "conflict" ? "It changed." : null });
      open();
      await h!.flush();
      expect(buttons(h!), state).toHaveLength(0);
      h!.unmount();
    }
    h = null;
  });

  it("an expired proposal says so even when the box sent no sentence", async () => {
    current = change({ state: "expired" });
    open();
    await h!.flush();
    expect(chip(h!)).toBe("Expired");
    expect(h!.text()).toContain("expired");
  });

  describe("update view", () => {
    const lines = (n: number, edit: Record<number, string> = {}) =>
      Array.from({ length: n }, (_, i) => edit[i + 1] ?? `rule ${i + 1}`).join("\n") + "\n";
    const md = (body: string) => `---\nname: Dev\ndescription: Builds\nisolation: worktree\n---\n${body}`;

    it("draws a line diff of before → after", async () => {
      current = change({ kind: "update", agentName: "Dev", slug: "dev", before: md("Be careful.\nShip it.\n"), after: md("Be careful.\nShip it twice.\n") });
      open();
      await h!.flush();
      expect(h!.text()).toContain("Change to Dev");
      const del = Array.from(h!.container.querySelectorAll('[data-diff="del"]')).map((e) => e.textContent);
      const add = Array.from(h!.container.querySelectorAll('[data-diff="add"]')).map((e) => e.textContent);
      expect(del).toEqual(["−Ship it."]);
      expect(add).toEqual(["+Ship it twice."]);
      expect(q(h!, "agent-change-diff-more")).toBeNull();
      expect(byText(h!, "Apply")).toBeTruthy();
    });

    it("folds a diff longer than 30 rows behind a native details", async () => {
      const edits: Record<number, string> = {};
      for (let i = 1; i <= 40; i += 3) edits[i] = `changed ${i}`;
      current = change({ kind: "update", agentName: "Dev", slug: "dev", before: md(lines(40)), after: md(lines(40, edits)) });
      open();
      await h!.flush();
      const more = q(h!, "agent-change-diff-more") as HTMLDetailsElement;
      expect(more.tagName).toBe("DETAILS");
      expect(more.open).toBe(false);
      expect(more.querySelector("summary")?.textContent).toMatch(/^Show \d+ more lines?$/);
      const shown = h!.container.querySelectorAll('[data-testid="agent-change-diff"] > div > [data-diff]');
      expect(shown).toHaveLength(30);
    });

    it("says so when the file's bytes show no visible change", async () => {
      current = change({ kind: "update", agentName: "Dev", slug: "dev", before: md("Same.\n"), after: md("Same.\n") });
      open();
      await h!.flush();
      expect(q(h!, "agent-change-nodiff")).toBeTruthy();
    });
  });

  describe("no record", () => {
    it("settled with no record: 'no longer available' and no buttons", async () => {
      current = null;
      open();
      await h!.flush();
      expect(q(h!, "agent-change-gone")?.textContent).toBe("This change is no longer available");
      expect(buttons(h!)).toHaveLength(0);
    });

    it("shows the tool's refusal when the part carries one", async () => {
      current = null;
      open({}, part("completed", "Not changed: Only the lead can create or change agents"));
      await h!.flush();
      expect(q(h!, "agent-change-gone")?.textContent).toBe("Not changed: Only the lead can create or change agents");
    });

    it("a failed tool call with no record says the tool failed", async () => {
      current = null;
      open({}, part("error"));
      await h!.flush();
      expect(q(h!, "agent-change-gone")?.textContent).toBe("The agent change tool failed.");
    });

    it("a read that fails is reported with a way to retry it, not hidden", async () => {
      let fail = true;
      open({ agentsChangeFor: () => (fail ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(current)) });
      await h!.flush();
      expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load this change: HTTP 500");
      fail = false;
      await press(h!, byText(h!, "Try again"));
      expect(chip(h!)).toBe("Waiting for you");
    });

    it("a part with no call tuple has nothing to look up", async () => {
      const bare = { id: "p9", type: "tool", tool: "agent_change", state: { status: "completed" } } as unknown as OpencodePart;
      open({}, bare);
      await h!.flush();
      expect(api.calls.agentsChangeFor).toBeUndefined();
      expect(q(h!, "agent-change-gone")).toBeTruthy();
    });
  });

  describe("running → event → card, without a reload", () => {
    it("shows 'Preparing the change…' while the part runs and does not read yet", async () => {
      current = null;
      open({}, part("running"));
      await h!.flush();
      expect(q(h!, "agent-change-preparing")?.textContent).toBe("Preparing the change…");
      expect(api.calls.agentsChangeFor).toBeUndefined();
      expect(hint, "subscribed before any read").toBeTruthy();
    });

    it("a hint for its session reads the record and the buttons appear while the part is still running", async () => {
      current = null;
      open({}, part("running"));
      await h!.flush();
      current = change();
      await act(async () => hint!({ id: "ach_0123456789abcdef", sessionID: "ses_1", slug: null }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      expect(chip(h!)).toBe("Waiting for you");
      expect(byText(h!, "Create")).toBeTruthy();
    });

    it("ignores a hint for another session", async () => {
      current = null;
      open({}, part("running"));
      await h!.flush();
      await act(async () => hint!({ id: "ach_other", sessionID: "ses_other", slug: null }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toBeUndefined();
    });

    it("once it holds a record, ignores hints that name another record", async () => {
      open();
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      await act(async () => hint!({ id: "ach_other", sessionID: "ses_1", slug: null }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      current = change({ state: "applied", slug: "reviewer" });
      await act(async () => hint!({ id: "ach_0123456789abcdef", sessionID: "ses_1", slug: "reviewer" }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(2);
      expect(chip(h!)).toBe("Created");
    });

    it("reads when the part settles", async () => {
      current = null;
      open({}, part("running"));
      await h!.flush();
      current = change();
      h!.rerender(<AgentChangeCard part={part("completed", "Proposed.")} />);
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      expect(chip(h!)).toBe("Waiting for you");
    });

    it("re-reads after a reconnect (the stream resync frame)", async () => {
      const { bus } = installMockApi({
        agentsChangeFor: () => Promise.resolve(current),
        onAgentChange: () => () => {},
      });
      h = mount(<AgentChangeCard part={part()} />);
      await h.flush();
      current = change({ state: "discarded" });
      await act(async () => bus.emitStream({ sub: "resync", sessionId: "", payload: {} }));
      await h.flush();
      expect(chip(h)).toBe("Discarded");
    });

    it("never rolls back to an older read", async () => {
      // the first read is slow and old; a hint-driven read answers first with newer state
      const resolvers: Array<(c: AgentChange | null) => void> = [];
      open({ agentsChangeFor: () => new Promise<AgentChange | null>((r) => resolvers.push(r)) });
      await h!.flush();
      await act(async () => hint!({ id: "ach_0123456789abcdef", sessionID: "ses_1", slug: null }));
      expect(resolvers).toHaveLength(2);
      await act(async () => resolvers[1](change({ state: "applied", slug: "reviewer" })));
      await act(async () => resolvers[0](change({ state: "pending" })));
      await h!.flush();
      expect(chip(h!)).toBe("Created");
    });

    it("unsubscribes when it unmounts", async () => {
      open();
      await h!.flush();
      h!.unmount();
      h = null;
      expect(offCount).toBe(1);
    });
  });

  it("ToolCall draws this part as the card, not a generic tool card", async () => {
    installMockApi({ agentsChangeFor: () => Promise.resolve(change()), onAgentChange: () => () => {} });
    h = mount(<ToolCall part={part()} verbose={false} />);
    await h.flush();
    expect(q(h, "agent-change-card")).toBeTruthy();
    expect(h.text()).not.toContain("AgentChange");
  });
});
