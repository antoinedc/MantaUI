// @vitest-environment jsdom
//
// The profile's History (agent screens spec §5.2): the change records of one agent, undone ones marked, Details expanding a
// row into the existing change card (the only Undo), Restore before this where it would change something.

import { describe, expect, it } from "vitest";
import { act } from "react";
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

// newest first, as the box answers
const LIST = [
  rec({ id: "c3", before: "V2", after: "V3", createdAt: NOW - 1 * DAY, decidedAt: NOW - 1 * DAY, summary: "Dropped two crawler rules.", origin: { kind: "chat" }, decidedBy: "click" }),
  rec({ id: "c2", before: "V1", after: "V2", createdAt: NOW - 2 * DAY, decidedAt: NOW - 2 * DAY }),
  rec({ id: "c1", kind: "create", before: null, after: "V1", createdAt: NOW - 5 * DAY, decidedAt: NOW - 5 * DAY, summary: "Created @seo." }),
];

describe("AgentHistory", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const { onChanged, take } = useHarnessLifecycle();

  async function open(records: AgentChange[], props: { cardsAbove?: ReadonlySet<string> } = {}, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi(overrides));
    h = take(mount(<AgentHistory records={records} onChanged={onChanged} {...props} />));
    await h.flush();
  }
  const rows = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="history-row"]')];
  const btn = (scope: ParentNode, text: string) => buttonIn(scope, text);
  const click = (el: Element | null | undefined) => clickEl(h!, el);

  it("says so when there are no changes, and always says what the list does not hold", async () => {
    await open([]);
    expect(h!.container.textContent).toContain("No changes yet.");
    expect(h!.container.textContent).toContain("Edits made by hand to the agent's file aren't listed");
  });

  it("a row: date, who, summary, outcome", async () => {
    await open(LIST);
    expect(rows()).toHaveLength(3);
    const t = rows()[0].textContent ?? "";
    expect(t).toContain("Manta · for you");
    expect(t).toContain("Dropped two crawler rules.");
    expect(t).toContain("Live (you approved it)");
    expect(rows()[1].textContent).toContain("Architect");
  });

  it("an undone change is listed, marked Undone, with who undid it", async () => {
    await open([rec({ id: "u", state: "undone", decidedBy: "click" }), ...LIST.slice(1)]);
    const t = rows()[0].textContent ?? "";
    expect(t).toContain("Undone by you");
    expect(rows()[0].getAttribute("data-state")).toBe("undone");
  });

  it("Details expands a row into the existing change card (its own Undo), Hide folds it back", async () => {
    await open(LIST);
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeNull();
    await click(btn(rows()[1], "Details"));
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeTruthy();
    expect(btn(rows()[1], "Hide")).toBeTruthy();
    // the card carries the one Undo; the row itself has no second one
    expect([...rows()[1].querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Undo")).toHaveLength(1);
    await click(btn(rows()[1], "Hide"));
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeNull();
  });

  it("a pending change has no Details here: its card is above the tabs (no duplicate Apply / Discard)", async () => {
    await open([rec({ id: "p", state: "pending", decidedAt: null, decidedBy: null }), ...LIST]);
    expect(rows()[0].textContent).toContain("Waiting for your click");
    expect(btn(rows()[0], "Details")).toBeUndefined();
    expect(btn(rows()[0], "Apply")).toBeUndefined();
  });

  it("Restore before this is offered only where it would change something", async () => {
    await open(LIST);
    // live version is V3 (the newest applied change's after): restoring before c3 (V2) and before c2 (V1) change it; a create has nothing before it
    expect(btn(rows()[0], "Restore before this")).toBeTruthy();
    expect(btn(rows()[1], "Restore before this")).toBeTruthy();
    expect(btn(rows()[2], "Restore before this")).toBeUndefined();
  });

  it("Restore asks the box, shows 'Restoring…' while it runs, then the new record's card at the top, expanded", async () => {
    let finish!: (r: AgentChange) => void;
    const restored = rec({ id: "r1", before: "V3", after: "V2", origin: { kind: "restore", fromChangeId: "c3" }, decidedBy: "click", summary: null, createdAt: NOW, decidedAt: NOW });
    await open(LIST, {}, { agentsChangeRestore: () => new Promise<AgentChange>((r) => (finish = r)) });
    await click(btn(rows()[0], "Restore before this"));
    expect(api.calls.agentsChangeRestore).toEqual([[{ id: "c3" }]]);
    expect(btn(rows()[0], "Restoring…")?.disabled).toBe(true);
    await act(async () => {
      finish(restored);
    });
    await h!.flush();
    expect(rows()).toHaveLength(4);
    expect(rows()[0].getAttribute("data-id")).toBe("r1");
    expect(rows()[0].textContent).toContain("You");
    expect(rows()[0].querySelector('[data-testid="agent-change-card"]')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(restored);
  });

  it("a refused Restore says why, under the row", async () => {
    await open(LIST, {}, { agentsChangeRestore: () => Promise.reject(new Error("Already at that version")) });
    await click(btn(rows()[1], "Restore before this"));
    expect(rows()[1].querySelector('[role="alert"]')?.textContent).toBe("Already at that version");
    expect(rows()).toHaveLength(3);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a record whose card is shown above the tabs has no second card here", async () => {
    await open(LIST, { cardsAbove: new Set(["c3"]) });
    expect(btn(rows()[0], "Details")).toBeUndefined();
    expect(rows()[0].textContent).toContain("card above");
    expect(btn(rows()[1], "Details")).toBeTruthy();
  });

  it("rows past the first few are rendered lazily (content-visibility), the ones in view are not", async () => {
    const many = Array.from({ length: 6 }, (_, i) => rec({ id: `m${i}`, createdAt: NOW - i * DAY, decidedAt: NOW - i * DAY }));
    await open(many);
    expect(rows()[0].className).not.toContain("content-visibility");
    expect(rows()[5].className).toContain("content-visibility");
    expect(rows()[5].className).toContain("contain-intrinsic-size");
  });
});
