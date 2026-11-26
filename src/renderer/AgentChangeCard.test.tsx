// @vitest-environment jsdom
//
// The agent-change card (Agents Phase 4, spec §4): states and buttons, every press awaited with the outcome shown,
// the diff view, the no-record state, and a running call that gets its record from a bus hint without a reload.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { AgentChange, AgentChangeEvent, OpencodePart } from "../shared/types";
import { AgentChangeCard, AgentChangeView } from "./AgentChangeCard";
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
  origin: { kind: "chat" },
  mode: null,
  releasedAt: 1,
  decidedBy: null,
  summary: null,
  evidence: [],
  admission: [],
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

  it("a failed record says it was not activated, and Retry is the apply channel", async () => {
    current = change({ state: "failed", slug: "reviewer", error: "Reviewer couldn't be activated, so nothing was kept: reload failed" });
    open({ agentsChangeApply: () => Promise.resolve(change({ state: "applied", slug: "reviewer" })) });
    await h!.flush();
    expect(chip(h!)).toBe("Not activated");
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
      await act(async () => hint!({ id: "ach_0123456789abcdef", sessionID: "ses_1", slug: null, origin: { kind: "chat" } }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      expect(chip(h!)).toBe("Waiting for you");
      expect(byText(h!, "Create")).toBeTruthy();
    });

    it("ignores a hint for another session", async () => {
      current = null;
      open({}, part("running"));
      await h!.flush();
      await act(async () => hint!({ id: "ach_other", sessionID: "ses_other", slug: null, origin: { kind: "chat" } }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toBeUndefined();
    });

    it("once it holds a record, ignores hints that name another record", async () => {
      open();
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      await act(async () => hint!({ id: "ach_other", sessionID: "ses_1", slug: null, origin: { kind: "chat" } }));
      await h!.flush();
      expect(api.calls.agentsChangeFor).toHaveLength(1);
      current = change({ state: "applied", slug: "reviewer" });
      await act(async () => hint!({ id: "ach_0123456789abcdef", sessionID: "ses_1", slug: "reviewer", origin: { kind: "chat" } }));
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
      await act(async () => hint!({ id: "ach_0123456789abcdef", sessionID: "ses_1", slug: null, origin: { kind: "chat" } }));
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

// ---------------------------------------------------------------------------
// Phase 5A: AgentChangeView, the record-driven card (summary, evidence, rules considered, held, applying, sources)
// ---------------------------------------------------------------------------

describe("AgentChangeView", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  beforeEach(() => resetStore());

  const proposal = (over: Partial<AgentChange> = {}): AgentChange =>
    change({
      kind: "update",
      slug: "dev",
      agentName: "Dev",
      before: "---\nname: Dev\ndescription: Builds\nisolation: worktree\n---\nBe careful.\n",
      after: "---\nname: Dev\ndescription: Builds\nisolation: worktree\n---\nBe careful.\nRun the tests.\n",
      origin: { kind: "job", jobId: "job1", rootJobId: "job1", attempt: 1 },
      mode: "build",
      summary: "Dev should always run the tests before finishing.",
      evidence: [
        { claim: "Short specific rules help", quote: "Short, specific rules beat long checklists", url: "https://example.com/study", private: false },
        { claim: "A founder agreed", quote: null, url: null, private: true },
      ],
      admission: [
        { rule: "Run the tests", verdict: "general", why: "Backed by the study" },
        { rule: "Write a haiku", verdict: "excluded", why: "Weak" },
      ],
      ...over,
    });
  const mountView = (c: AgentChange, extra: Record<string, unknown> = {}) => {
    const { api } = installMockApi(extra);
    const seen: AgentChange[] = [];
    h = mount(<AgentChangeView change={c} onChange={(n) => seen.push(n)} />);
    return { api, seen };
  };

  it("shows the Architect's summary first, then the diff", async () => {
    mountView(proposal());
    await h!.flush();
    const summary = q(h!, "agent-change-summary")!;
    expect(summary.textContent).toBe("Dev should always run the tests before finishing.");
    const card = q(h!, "agent-change-card")!;
    expect(card.textContent!.indexOf("Dev should always run")).toBeLessThan(card.textContent!.indexOf("Run the tests."));
  });

  it("evidence is a native details: the claim, then the quote and link — or 'Private source' with no quote and no link", async () => {
    mountView(proposal());
    await h!.flush();
    const ev = q(h!, "agent-change-evidence") as HTMLDetailsElement;
    expect(ev.tagName).toBe("DETAILS");
    expect(ev.open).toBe(false);
    expect(ev.querySelector("summary")!.textContent).toBe("Evidence (2)");
    const items = Array.from(ev.querySelectorAll('[data-testid="agent-change-evidence-item"]'));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Short specific rules help");
    expect(items[0].querySelector("blockquote")!.textContent).toBe("Short, specific rules beat long checklists");
    const link = items[0].querySelector("a") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/study");
    expect(items[1].textContent).toContain("A founder agreed");
    expect(items[1].textContent).toContain("Private source");
    expect(items[1].querySelector("blockquote")).toBeNull();
    expect(items[1].querySelector("a")).toBeNull();
  });

  it("an evidence link opens through the app and says so when it can't (a control always answers)", async () => {
    const { api } = mountView(proposal(), { openExternal: () => Promise.reject(new Error("no browser")) });
    await h!.flush();
    const link = q(h!, "agent-change-evidence")!.querySelector("a") as HTMLAnchorElement;
    await press(h!, link);
    expect(api.calls.openExternal).toEqual([["https://example.com/study"]]);
    expect(q(h!, "agent-change-link-error")!.textContent).toMatch(/Couldn't open the link/);
    expect(q(h!, "agent-change-link-error")!.getAttribute("role")).toBe("alert");
  });

  it("rules considered: a native details with a verdict chip and the why per rule", async () => {
    mountView(proposal());
    await h!.flush();
    const rules = q(h!, "agent-change-admission") as HTMLDetailsElement;
    expect(rules.tagName).toBe("DETAILS");
    expect(rules.querySelector("summary")!.textContent).toBe("Rules considered (2)");
    const rows = Array.from(rules.querySelectorAll('[data-testid="agent-change-admission-item"]'));
    expect(rows.map((r) => r.getAttribute("data-verdict"))).toEqual(["general", "excluded"]);
    expect(rows[0].textContent).toContain("General");
    expect(rows[0].textContent).toContain("Run the tests");
    expect(rows[1].textContent).toContain("Excluded");
    expect(rows[1].textContent).toContain("Weak");
  });

  it("a plain chat change has no summary, evidence or rules sections", async () => {
    mountView(change());
    await h!.flush();
    for (const id of ["agent-change-summary", "agent-change-evidence", "agent-change-admission"]) expect(q(h!, id)).toBeNull();
  });

  it("reason lines: the Architect itself, an unfinished task, a plan or a mention", async () => {
    for (const [reason, text] of [
      ["core", "This changes the Architect itself"],
      ["unfinished", "The task didn't finish — review before applying"],
      ["plan", "Proposed while planning or outside a hand-off — review before applying"],
    ] as const) {
      mountView(proposal({ reason, needsClick: true, state: "pending" }));
      await h!.flush();
      expect(q(h!, "agent-change-reason")!.textContent).toBe(text);
      h!.unmount();
    }
    h = null;
  });

  it("held: 'The Architect is still working', a chip, no buttons — and the evidence is already readable", async () => {
    mountView(proposal({ state: "held", needsClick: false, reason: null }));
    await h!.flush();
    expect(chip(h!)).toBe("Architect still working");
    expect(q(h!, "agent-change-held")!.textContent).toBe("The Architect is still working");
    expect(buttons(h!)).toHaveLength(0);
    expect(q(h!, "agent-change-evidence")).toBeTruthy();
  });

  it("applying: a spinner with a name and no buttons", async () => {
    mountView(proposal({ state: "applying", needsClick: false, reason: null }));
    await h!.flush();
    expect(chip(h!)).toBe("Applying…");
    const spin = q(h!, "agent-change-applying")!;
    expect(spin.textContent).toContain("Applying");
    expect(spin.querySelector("[aria-hidden='true']")).toBeTruthy();
    expect(buttons(h!)).toHaveLength(0);
  });

  it("its buttons behave as the tool-part card's: Apply awaits the box and hands the new record to onChange", async () => {
    const applied = proposal({ state: "applied", decidedBy: "click" });
    const { api, seen } = mountView(proposal({ state: "pending", needsClick: true, reason: "plan" }), { agentsChangeApply: () => Promise.resolve(applied) });
    await h!.flush();
    await press(h!, byText(h!, "Apply"));
    expect(api.calls.agentsChangeApply).toEqual([["ach_0123456789abcdef"]]);
    expect(seen).toEqual([applied]);
    expect(q(h!, "agent-change-notice")).toBeNull();
  });

  describe("an update of the Architect: one block per added or changed source", () => {
    const arch = (extra = "") => `---\nname: Architect\ndescription: Builds agents.\nrole: architect\nisolation: none\n${extra}---\nBody.\n`;
    const SRC = `sources:\n  - id: bookface\n    name: YC Bookface\n    description: Private forum.\n    command: [yc, search, "{query}", --type, posts]\n    env:\n      YC_TOKEN: "{secret:YC_TOKEN}"\n`;
    const archChange = (before: string, after: string): AgentChange =>
      change({ kind: "update", slug: "architect", agentName: "Architect", before, after, reason: "core", needsClick: true });

    it("shows the argv with {query} marked, the secret names and the private sentence", async () => {
      mountView(archChange(arch(), arch(SRC)));
      await h!.flush();
      const block = q(h!, "agent-change-source")!;
      expect(block.getAttribute("data-change")).toBe("added");
      expect(block.textContent).toContain("YC Bookface");
      expect(block.textContent).toContain("yc search {query} --type posts");
      expect(block.textContent).toContain("Runs yc search {query} --type posts on this box with your account's access");
      expect(block.textContent).toContain("YC_TOKEN");
      expect(block.textContent).toContain("Private: results go to the AI model and its local transcript");
      expect(q(h!, "agent-change-source-warning")).toBeNull();
      expect(byText(h!, "Apply")).toBeTruthy();
    });

    it("a private → public change carries the warning", async () => {
      mountView(archChange(arch(SRC), arch(SRC + "    private: false\n")));
      await h!.flush();
      expect(q(h!, "agent-change-source")!.getAttribute("data-change")).toBe("changed");
      expect(q(h!, "agent-change-source-warning")!.textContent).toBe("Private → Public: future evidence may show quotes and links");
    });

    it("a url source says which site it calls; a change that leaves the sources alone shows no block", async () => {
      const url = `sources:\n  - id: internal\n    name: Internal\n    description: Ours.\n    private: false\n    url: "https://search.example.com/api?q={query}"\n`;
      mountView(archChange(arch(), arch(url)));
      await h!.flush();
      expect(q(h!, "agent-change-source")!.textContent).toContain("Calls search.example.com");
      h!.unmount();
      mountView(archChange(arch(url), arch(url).replace("Builds agents.", "Builds agents well.")));
      await h!.flush();
      expect(q(h!, "agent-change-source")).toBeNull();
    });

    it("another agent's change never shows source blocks", async () => {
      mountView(change({ kind: "update", slug: "dev", agentName: "Dev", before: arch(), after: arch(SRC) }));
      await h!.flush();
      expect(q(h!, "agent-change-source")).toBeNull();
    });
  });
  describe("collapsed (the profile's pending card)", () => {
    let api: MockApi;
    const UPDATE_BEFORE = "---\nname: SEO\ndescription: d\nisolation: none\n---\nAudit one page.\nAsk before redirects.\n";
    const UPDATE_AFTER = "---\nname: SEO\ndescription: d\nisolation: none\n---\nAudit one page.\nCheck llms.txt.\n";
    const pending = (over: Partial<AgentChange> = {}) =>
      change({ kind: "update", slug: "seo", agentName: "SEO", before: UPDATE_BEFORE, after: UPDATE_AFTER, summary: "Adds an llms.txt check.", origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 }, ...over });
    const mountCollapsed = (c: AgentChange, onChange: (n: AgentChange) => void = () => undefined, over: Record<string, unknown> = {}) => {
      ({ api } = installMockApi(over));
      h = mount(<AgentChangeView change={c} onChange={onChange} collapsed />);
    };

    it("is one summary line — the chip, who, what, and the same two buttons — with the change folded", async () => {
      mountCollapsed(pending());
      await h!.flush();
      expect(chip(h!)).toBe("Waiting for you");
      const line = q(h!, "agent-change-summary-line")!;
      expect(line.textContent).toContain("Architect");
      expect(line.textContent).toContain("Adds an llms.txt check.");
      expect(buttons(h!).map((b) => b.textContent)).toEqual(["Discard", "Apply"]); // exactly one of each: no duplicated actions
      const fold = q(h!, "agent-change-fold") as HTMLDetailsElement;
      expect(fold.tagName).toBe("DETAILS");
      expect(fold.open).toBe(false);
      expect(fold.querySelector("summary")?.textContent).toBe("Show the change · 2 lines");
      expect(fold.querySelector('[data-testid="agent-change-diff"]')).toBeTruthy(); // the diff lives inside the fold
      expect(q(h!, "agent-change-summary")).toBeNull(); // the summary is in the line, not repeated above the fold
    });

    it("says who made the change: the Architect, Manta, or you", async () => {
      mountCollapsed(pending({ origin: { kind: "chat" } }));
      await h!.flush();
      expect(q(h!, "agent-change-summary-line")?.textContent).toContain("Manta");
      h!.unmount();
      mountCollapsed(pending({ origin: { kind: "restore", fromChangeId: "x" } }));
      await h!.flush();
      expect(q(h!, "agent-change-summary-line")?.textContent).toContain("You");
    });

    it("without a summary the line says what the change is", async () => {
      mountCollapsed(pending({ summary: null }));
      await h!.flush();
      expect(q(h!, "agent-change-summary-line")?.textContent).toContain("Change to SEO");
    });

    it("the fold names what the change is based on when it has evidence", async () => {
      mountCollapsed(
        pending({
          evidence: [
            { claim: "GPTBot honours robots.txt", quote: "q", url: "https://a.example", private: false },
            { claim: "llms.txt is read by Perplexity", quote: null, url: null, private: true },
          ],
        }),
      );
      await h!.flush();
      expect(q(h!, "agent-change-fold")?.querySelector("summary")?.textContent).toBe("Show the change · 2 lines · based on 2 sources");
      expect(q(h!, "agent-change-evidence")).toBeTruthy();
    });

    it("a new agent folds its description and instructions", async () => {
      mountCollapsed(change({ summary: "A reviewer." }));
      await h!.flush();
      const fold = q(h!, "agent-change-fold")!;
      expect(fold.querySelector("summary")?.textContent).toBe("Show the new agent");
      expect(fold.querySelector('[data-testid="agent-change-create"]')).toBeTruthy();
    });

    it("what the user must read stays outside the fold: the reason, a refusal, an outcome line", async () => {
      mountCollapsed(pending({ reason: "isolation", needsClick: true }), () => undefined, { agentsChangeApply: () => Promise.reject(new Error("Changing agents is turned off in your autonomy settings")) });
      await h!.flush();
      expect(q(h!, "agent-change-fold")!.contains(q(h!, "agent-change-reason"))).toBe(false);
      expect(q(h!, "agent-change-reason")?.textContent).toBe("This lets SEO edit code");
      await press(h!, byText(h!, "Apply"));
      expect(q(h!, "agent-change-notice")?.textContent).toBe("Changing agents is turned off in your autonomy settings");
      expect(q(h!, "agent-change-fold")!.contains(q(h!, "agent-change-notice"))).toBe(false);
    });

    it("Apply and Discard behave exactly as on the full card (one Undo after)", async () => {
      const applied = pending({ state: "applied", decidedAt: 2, decidedBy: "click" });
      const seen: AgentChange[] = [];
      mountCollapsed(pending(), (n) => seen.push(n), { agentsChangeApply: () => Promise.resolve(applied) });
      await h!.flush();
      await press(h!, byText(h!, "Apply"));
      expect(api.calls.agentsChangeApply).toEqual([["ach_0123456789abcdef"]]);
      expect(seen).toEqual([applied]);
      h!.unmount();
      mountCollapsed(applied);
      await h!.flush();
      expect(chip(h!)).toBe("Updated");
      expect(buttons(h!).map((b) => b.textContent)).toEqual(["Undo"]);
    });

    it("the default card is unchanged: no summary line, no fold", async () => {
      ({ api } = installMockApi({}));
      h = mount(<AgentChangeView change={pending()} onChange={() => undefined} />);
      await h.flush();
      expect(q(h, "agent-change-summary-line")).toBeNull();
      expect(q(h, "agent-change-fold")).toBeNull();
      expect(q(h, "agent-change-summary")?.textContent).toBe("Adds an llms.txt check.");
      expect(q(h, "agent-change-diff")).toBeTruthy();
    });
  });
  describe("actions filter (the history's rows)", () => {
    let api: MockApi;
    const applied = change({ kind: "update", state: "applied", needsClick: false, reason: null, slug: "seo", agentName: "SEO", before: "---\nname: SEO\ndescription: d\nisolation: none\n---\nA\n", after: "---\nname: SEO\ndescription: d\nisolation: none\n---\nB\n" });
    const show = async (c: AgentChange, actions?: ReadonlyArray<"apply" | "discard" | "undo">) => {
      ({ api } = installMockApi({}));
      h = mount(<AgentChangeView change={c} onChange={() => undefined} actions={actions} />);
      await h.flush();
    };

    it("offers only the buttons it is given (of those the state allows); the card itself is unchanged", async () => {
      await show(applied, []);
      expect(buttons(h!)).toHaveLength(0);
      expect(chip(h!)).toBe("Updated");
      expect(q(h!, "agent-change-diff")).toBeTruthy();
      h!.unmount();
      await show(applied, ["undo"]);
      expect(buttons(h!).map((b) => b.textContent)).toEqual(["Undo"]);
      h!.unmount();
      await show(change({ state: "pending" }), ["undo"]);
      expect(buttons(h!)).toHaveLength(0); // a filter never adds a button the state doesn't allow
    });

    it("without the prop every button the state allows is there, as before", async () => {
      await show(applied);
      expect(buttons(h!).map((b) => b.textContent)).toEqual(["Undo"]);
      expect(api.calls).toBeDefined();
    });
  });
});
