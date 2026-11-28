// @vitest-environment jsdom
//
// The profile's History (profile v5): only changes that went live, one compact line each — date and what changed. A line opens
// (a native disclosure) to who made it and how it landed, the existing change card (the test results and the change itself, and the
// one Undo, on the newest live change), and "Restore the version before it" where it would change something.

import { describe, expect, it } from "vitest";
import type { AgentChange } from "../../shared/types";
import { installMockApi, mount, type Harness, type MockApi } from "../testHarness";
import { AgentHistory } from "./AgentHistory";
import { useHarnessLifecycle, buttonIn, changeRecord, clickEl } from "./agentsTestFixtures";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const rec = (over: Partial<AgentChange> = {}): AgentChange =>
  changeRecord({
    createdAt: NOW - 3 * DAY,
    decidedAt: NOW - 3 * DAY,
    releasedAt: NOW - 3 * DAY,
    summary: "Added rules for how AI search engines read pages.",
    ...over,
  });

// the box answers every state, newest first; the page shows the applied ones
const LIST = [
  rec({ id: "c3", before: "V2", after: "V3", createdAt: NOW - 1 * DAY, decidedAt: NOW - 1 * DAY, summary: "Dropped two crawler rules.", origin: { kind: "chat" }, decidedBy: "click" }),
  rec({ id: "c2", before: "V1", after: "V2", createdAt: NOW - 2 * DAY, decidedAt: NOW - 2 * DAY }),
  rec({ id: "c1", kind: "create", before: null, after: "V1", createdAt: NOW - 5 * DAY, decidedAt: NOW - 5 * DAY, summary: "Created @seo." }),
];

describe("AgentHistory", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const { onChanged, take } = useHarnessLifecycle();

  async function open(records: AgentChange[], overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi(overrides));
    h = take(mount(<AgentHistory records={records} onChanged={onChanged} />));
    await h.flush();
  }
  const rows = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="history-row"]')];
  const click = (el: Element | null | undefined) => clickEl(h!, el);
  const openRow = async (i: number) => click(rows()[i].querySelector("summary"));

  it("says so when nothing went live yet, and says what the list doesn't hold", async () => {
    await open([]);
    expect(h!.container.textContent).toContain("No changes yet.");
    expect(h!.container.textContent).toContain("Changes waiting for your click are in Needs you");
    expect(h!.container.textContent).toContain("Edits made by hand to the agent's file aren't listed");
  });

  it("lists only applied changes: pending, undone, refused, held and failed ones never appear", async () => {
    await open([
      rec({ id: "p", state: "pending", needsClick: true, reason: "ask", decidedAt: null, summary: "Waiting one." }),
      rec({ id: "u", state: "undone", summary: "Undone one." }),
      rec({ id: "d", state: "discarded", summary: "Discarded one." }),
      rec({ id: "h", state: "held", summary: "Held one." }),
      rec({ id: "f", state: "failed", summary: "Failed one." }),
      ...LIST,
    ]);
    expect(rows().map((r) => r.getAttribute("data-id"))).toEqual(["c3", "c2", "c1"]);
    expect(h!.container.textContent).not.toMatch(/Waiting one|Undone one|Discarded one|Held one|Failed one/);
    expect(h!.container.textContent).not.toContain("Waiting for your click");
  });

  it("a line is one line: the date and what changed — no chips, no who, no status", async () => {
    await open(LIST);
    const first = rows()[0];
    expect(first.querySelector('[data-testid="history-summary"]')?.textContent).toBe("Dropped two crawler rules.");
    expect(first.querySelector('[data-testid="history-when"]')?.textContent).toMatch(/\d/);
    expect(first.querySelector('[data-testid="history-status"]')).toBeNull();
    const closed = first.querySelector("summary")!.textContent ?? "";
    expect(closed).not.toMatch(/Live|you approved it|Tested|Manta · for you/);
  });

  it("opened, a line says who made it and how it landed, then holds the change card with its one Undo (newest live change only)", async () => {
    await open(LIST);
    await openRow(0);
    expect(rows()[0].querySelector('[data-testid="history-how"]')?.textContent).toBe("Manta · for you · you approved it");
    expect(buttonIn(rows()[0], "Undo")).toBeTruthy();
    await openRow(1);
    expect(rows()[1].querySelector('[data-testid="history-how"]')?.textContent).toBe("Architect · applied automatically");
    expect(buttonIn(rows()[1], "Undo")).toBeUndefined();
  });

  it("Undo on the newest change goes through the existing channel and the page is told", async () => {
    await open(LIST, { agentsChangeUndo: (id: string) => Promise.resolve({ ...LIST[0], id, state: "undone" }) });
    await openRow(0);
    await click(buttonIn(rows()[0], "Undo"));
    expect(api.calls.agentsChangeUndo?.[0]).toEqual(["c3"]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("a saved Settings field reads as made by the user in Settings", async () => {
    await open([rec({ id: "s", origin: { kind: "settings", field: "model" }, decidedBy: "click", summary: "Model: Auto → openai/gpt-6-sol.", createdAt: NOW, decidedAt: NOW }), ...LIST]);
    expect(rows()[0].querySelector('[data-testid="history-summary"]')?.textContent).toBe("Model: Auto → openai/gpt-6-sol.");
    await openRow(0);
    expect(rows()[0].querySelector('[data-testid="history-how"]')?.textContent).toBe("You · in Settings");
  });

  it("Restore the version before it is offered where it would change something — never on the creation line", async () => {
    await open(LIST);
    await openRow(0);
    expect(buttonIn(rows()[0], "Restore the version before it")).toBeTruthy();
    await openRow(2);
    expect(buttonIn(rows()[2], "Restore")).toBeUndefined();
  });

  it("Restore makes a new live record that lands at the top, opened; a refusal is a sentence on the line and nothing changes", async () => {
    const made = rec({ id: "r1", before: "V3", after: "V1", summary: "Restored an earlier version", origin: { kind: "restore", fromChangeId: "c2" }, decidedBy: "click", createdAt: NOW, decidedAt: NOW });
    await open(LIST, { agentsChangeRestore: () => Promise.resolve(made) });
    await openRow(1);
    await click(buttonIn(rows()[1], "Restore the version before it"));
    expect(api.calls.agentsChangeRestore?.[0]).toEqual([{ id: "c2" }]);
    expect(rows()[0].getAttribute("data-id")).toBe("r1");
    expect(onChanged).toHaveBeenCalledWith(made);
    h!.unmount();
    await open(LIST, { agentsChangeRestore: () => Promise.reject(new Error("Already at that version")) });
    await openRow(1);
    await click(buttonIn(rows()[1], "Restore the version before it"));
    expect(rows()[1].querySelector('[data-testid="history-error"]')?.textContent).toBe("Already at that version");
    expect(rows().map((r) => r.getAttribute("data-id"))).toEqual(["c3", "c2", "c1"]);
  });
});
