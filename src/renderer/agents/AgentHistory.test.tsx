// @vitest-environment jsdom
//
// The profile's History (agent screens spec §5.2): the change records of one agent, undone ones marked, Details expanding a
// row into the existing change card (the only Undo), Restore before this where it would change something.

import { describe, expect, it } from "vitest";
import { act } from "react";
import type { AgentChange } from "../../shared/types";
import { installMockApi, mount, type Harness, type MockApi } from "../testHarness";
import { AgentHistory, HistoryPane } from "./AgentHistory";
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

  it("a row: when, who, the summary, and the outcome with its reason", async () => {
    await open(LIST);
    expect(rows()).toHaveLength(3);
    const t = rows()[0].textContent ?? "";
    expect(t).toContain("Manta · for you");
    expect(t).toContain("Dropped two crawler rules.");
    const status = rows()[0].querySelector('[data-testid="history-status"]')!;
    expect(status.textContent).toContain("Live");
    expect(status.textContent).toContain("you approved it");
    expect(rows()[0].querySelector('[data-testid="history-when"]')?.textContent).toMatch(/\d/);
    expect(rows()[1].textContent).toContain("Architect");
    expect(rows()[1].querySelector('[data-testid="history-status"]')?.textContent).toContain("applied automatically");
  });

  it("the summary is body text in full ink; the who and when are quieter", async () => {
    await open(LIST);
    expect(rows()[0].querySelector('[data-testid="history-summary"]')!.className).toContain("text-text");
    expect(rows()[0].querySelector('[data-testid="history-summary"]')!.className).toContain("text-body");
    expect(rows()[0].querySelector('[data-testid="history-when"]')!.className).toContain("text-text-faint");
  });

  it("an undone change is listed, marked Undone, with who undid it", async () => {
    await open([rec({ id: "u", state: "undone", decidedBy: "click" }), ...LIST.slice(1)]);
    const status = rows()[0].querySelector('[data-testid="history-status"]')!;
    expect(status.textContent).toContain("Undone");
    expect(status.textContent).toContain("by you");
    expect(rows()[0].getAttribute("data-state")).toBe("undone");
  });

  it("Details is a native disclosure: the existing change card appears when a row is opened, and goes when it is closed", async () => {
    await open(LIST);
    const details = rows()[1].querySelector<HTMLDetailsElement>("details")!;
    expect(details).toBeTruthy();
    expect(details.querySelector("summary")?.textContent).toContain("Details");
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeNull();
    await click(details.querySelector("summary"));
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeTruthy();
    await click(details.querySelector("summary"));
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeNull();
  });

  it("exactly one Undo: on the newest live change; older live rows' cards have none", async () => {
    await open(LIST);
    for (const r of rows().slice(0, 2)) await click(r.querySelector("summary"));
    const undos = [...h!.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Undo");
    expect(undos).toHaveLength(1);
    expect(rows()[0].contains(undos[0])).toBe(true); // c3 is the newest applied
    expect(rows()[1].querySelector('[data-testid="agent-change-card"]')).toBeTruthy(); // the card is there, just without a button
  });

  it("a pending change has no Details here: its card is above the tabs (no second Apply / Discard)", async () => {
    await open([rec({ id: "p", state: "pending", decidedAt: null, decidedBy: null }), ...LIST]);
    expect(rows()[0].textContent).toContain("Waiting for your click");
    expect(rows()[0].querySelector("details")).toBeNull();
    expect(rows()[0].textContent).toContain("card above");
    expect(btn(rows()[0], "Apply")).toBeUndefined();
    // and the live Undo is still the newest live row's
    await click(rows()[1].querySelector("summary"));
    expect([...h!.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Undo")).toHaveLength(1);
  });

  it("'Restore the version before this' is a quiet link inside the opened row, only where it would change something", async () => {
    await open(LIST);
    const restoreLink = (i: number) => [...rows()[i].querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore the version before this");
    expect(restoreLink(0)).toBeUndefined(); // closed rows hold no controls
    await click(rows()[0].querySelector("summary"));
    expect(restoreLink(0)).toBeTruthy();
    expect(restoreLink(0)!.className).toContain("underline");
    await click(rows()[1].querySelector("summary"));
    expect(restoreLink(1)).toBeTruthy();
    // a create has nothing before it
    await click(rows()[2].querySelector("summary"));
    expect(restoreLink(2)).toBeUndefined();
  });

  it("Restore asks the box, says 'Restoring…' while it runs, then the new record's row is at the top, opened", async () => {
    let finish!: (r: AgentChange) => void;
    const restored = rec({ id: "r1", before: "V3", after: "V2", origin: { kind: "restore", fromChangeId: "c3" }, decidedBy: "click", summary: null, createdAt: NOW, decidedAt: NOW });
    await open(LIST, {}, { agentsChangeRestore: () => new Promise<AgentChange>((r) => (finish = r)) });
    await click(rows()[0].querySelector("summary"));
    await click(btn(rows()[0], "Restore the version before this"));
    expect(api.calls.agentsChangeRestore).toEqual([[{ id: "c3" }]]);
    expect(btn(rows()[0], "Restoring…")?.disabled).toBe(true);
    await act(async () => {
      finish(restored);
    });
    await h!.flush();
    expect(rows()).toHaveLength(4);
    expect(rows()[0].getAttribute("data-id")).toBe("r1");
    expect(rows()[0].textContent).toContain("You");
    expect(rows()[0].querySelector<HTMLDetailsElement>("details")!.open).toBe(true);
    expect(rows()[0].querySelector('[data-testid="agent-change-card"]')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(restored);
  });

  it("a refused Restore says why, in the row", async () => {
    await open(LIST, {}, { agentsChangeRestore: () => Promise.reject(new Error("Already at that version")) });
    await click(rows()[1].querySelector("summary"));
    await click(btn(rows()[1], "Restore the version before this"));
    expect(rows()[1].querySelector('[role="alert"]')?.textContent).toBe("Already at that version");
    expect(rows()).toHaveLength(3);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a record whose card is shown above the tabs has no second card here", async () => {
    await open(LIST, { cardsAbove: new Set(["c3"]) });
    expect(rows()[0].querySelector("details")).toBeNull();
    expect(rows()[0].textContent).toContain("card above");
    expect(rows()[1].querySelector("details")).toBeTruthy();
  });

  it("rows past the first few are rendered lazily (content-visibility), the ones in view are not", async () => {
    const many = Array.from({ length: 6 }, (_, i) => rec({ id: `m${i}`, createdAt: NOW - i * DAY, decidedAt: NOW - i * DAY }));
    await open(many);
    expect(rows()[0].className).not.toContain("content-visibility");
    expect(rows()[5].className).toContain("content-visibility");
    expect(rows()[5].className).toContain("contain-intrinsic-size");
  });

  describe("the pane", () => {
    it("counts live, waiting and undone changes, and says in one place how changes land", async () => {
      ({ api } = installMockApi({}));
      h = take(mount(<HistoryPane records={[...LIST, rec({ id: "p", state: "pending" }), rec({ id: "u", state: "undone" }), rec({ id: "d", state: "discarded" })]} />));
      const kv = [...h.container.querySelectorAll('[data-testid="history-summary-counts"] dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
      expect(kv).toEqual([["Live", "3"], ["Waiting", "1"], ["Undone", "1"]]);
      const how = h.container.querySelector('[data-testid="history-how"]')!;
      expect(how.textContent).toContain("your setting decides");
      expect(how.textContent).toContain("restored to the version before it");
    });

    it("before the history has loaded there are no counts to show — the line on how changes land still is", async () => {
      ({ api } = installMockApi({}));
      h = take(mount(<HistoryPane records={null} />));
      expect(h.container.querySelector('[data-testid="history-summary-counts"]')).toBeNull();
      expect(h.container.querySelector('[data-testid="history-how"]')).toBeTruthy();
    });
  });
});
