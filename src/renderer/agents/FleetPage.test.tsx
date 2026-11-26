// @vitest-environment jsdom
//
// The Fleet page (agent screens spec §2.1, contract §States): Needs you, the recap, the agents × projects grid, the header
// pills — and its loading / error / empty / older-box states.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentFleet, AgentInfo, NeedsYou, UsageSnapshot } from "../../shared/types";
import { resetPackageAgentsForTest } from "../packageAgents";
import { useStore } from "../store";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import type { AgentsRead } from "./useAgentsRead";
import { FleetPage } from "./FleetPage";

const NOW = 1_800_000_000_000;

const agent = (slug: string, name: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug,
  name,
  description: `${name} agent`,
  isolation: "none",
  model: null,
  color: "#336699",
  builtIn: false,
  role: "specialist",
  useWhen: null,
  notFor: null,
  notice: null,
  ...over,
});
const AGENTS = [agent("dev", "Dev"), agent("seo", "SEO")];

const fleet = (over: Partial<AgentFleet> = {}): AgentFleet => ({
  asOf: NOW,
  projects: [
    { slug: "manta", name: "Manta" },
    { slug: "ronda", name: "Ronda" },
  ],
  rows: [
    {
      slug: "dev",
      name: "Dev",
      color: "#336699",
      seats: ["manta"],
      cells: { manta: { jobId: "job1", title: "Explorer: 0-byte file crash", at: NOW, state: "working", detail: "4/7 · 1 question" }, ronda: null },
      tasksThisWeek: 14,
    },
    {
      slug: "seo",
      name: "SEO",
      color: null,
      seats: ["manta", "ronda"],
      cells: {
        manta: { jobId: "", title: "Idle", at: 0, state: "idle", detail: "last task 3d ago" },
        ronda: { jobId: "job2", title: "Weekly audit", at: NOW, state: "failed", detail: "Gmail token" },
      },
      tasksThisWeek: 7,
    },
  ],
  week: { tasks: 41 },
  recap: { since: NOW - 18 * 3_600_000, lines: ["Manta handed 9 requests to agents", "SEO finished 1 task in Ronda"] },
  ...over,
});

const needsData = (over: Partial<NeedsYou> = {}): NeedsYou => ({ questions: [], changes: [], reviews: [], count: 0, ...over });
const needsRead = (over: Partial<AgentsRead<NeedsYou>> = {}): AgentsRead<NeedsYou> => ({
  data: needsData(),
  error: null,
  unsupported: false,
  loading: false,
  reload: () => Promise.resolve(),
  ...over,
});

describe("FleetPage", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let hint: (() => void) | null = null;
  const onOpenProfile = vi.fn();

  beforeEach(() => {
    resetStore({ usage: [], jobs: {}, drafts: [] });
    resetPackageAgentsForTest();
    onOpenProfile.mockClear();
    hint = null;
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  async function open(props: { needs?: AgentsRead<NeedsYou>; focus?: "needs" } = {}, overrides: Record<string, unknown> = {}, strict = false) {
    ({ api } = installMockApi({
      agentsList: () => Promise.resolve(AGENTS),
      agentsFleet: () => Promise.resolve(fleet()),
      agentsFleetSeen: () => Promise.resolve({ ok: true }),
      agentsProjects: () => Promise.resolve([{ slug: "manta", name: "Manta" }]),
      onAgentFleet: (cb: () => void) => {
        hint = cb;
        return () => {
          hint = null;
        };
      },
      ...overrides,
    }));
    h = mount(<FleetPage needs={props.needs ?? needsRead()} focus={props.focus} onOpenProfile={onOpenProfile} />, { strictMode: strict });
    await h.flush();
    await h.flush();
  }
  const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
  const text = () => h!.container.textContent ?? "";
  async function click(el: Element | null | undefined) {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }

  it("shows a skeleton only after 150 ms of waiting, then the page", async () => {
    let resolve!: (f: AgentFleet) => void;
    await open({}, { agentsFleet: () => new Promise<AgentFleet>((r) => (resolve = r)) });
    expect(q('[data-testid="fleet-skeleton"]')).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(q('[data-testid="fleet-skeleton"]')).toBeTruthy();
    await act(async () => {
      resolve(fleet());
    });
    await h!.flush();
    expect(q('[data-testid="fleet-skeleton"]')).toBeNull();
    expect(q('[data-testid="fleet-grid"]')).toBeTruthy();
  });

  it("a first read that fails is a sentence with Try again, which reads again", async () => {
    let calls = 0;
    await open({}, { agentsFleet: () => (++calls === 1 ? Promise.reject(new Error("The box is busy")) : Promise.resolve(fleet())) });
    expect(q('[data-testid="fleet-error"]')?.textContent).toContain("The box is busy");
    const retry = [...h!.container.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    await click(retry);
    expect(q('[data-testid="fleet-error"]')).toBeNull();
    expect(q('[data-testid="fleet-grid"]')).toBeTruthy();
  });

  it("an older box (unknown channel) is told to update, not shown an error", async () => {
    await open({}, { agentsFleet: () => Promise.reject(new Error("unknown rpc channel: agents:fleet")) });
    expect(q('[data-testid="fleet-unsupported"]')?.textContent).toContain("Update the box to see the fleet");
    expect(q('[data-testid="fleet-error"]')).toBeNull();
  });

  it("no agents: says so and offers New agent, which opens a chat draft with Manta", async () => {
    await open({}, { agentsFleet: () => Promise.resolve(fleet({ rows: [], projects: [] })) });
    expect(q('[data-testid="fleet-no-agents"]')?.textContent).toContain("No agents yet");
    resetStore({ projects: [{ tmuxSession: "manta", defaultCwd: "/work/manta", windows: [] } as never], activeProjectName: "manta" });
    await click([...h!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New agent"));
    const s = useStore.getState();
    expect(s.drafts.at(-1)?.input).toBe("Create an agent that ");
  });

  it("shows the header pills (tasks this week, plan usage from the plan windows) and never a dollar amount", async () => {
    const usage: UsageSnapshot = { provider: "claude", providerIDs: ["anthropic"], fetchedAt: 1, windows: [{ kind: "session", label: "5h", pct: 12 }, { kind: "weekly", label: "7d", pct: 38 }] } as UsageSnapshot;
    resetStore({ usage: [usage] });
    await open();
    expect(text()).toContain("All projects");
    expect(text()).toContain("This week: 41 tasks · plan usage 38%");
    expect(text()).not.toMatch(/\$/);
  });

  it("leaves out the plan usage when it is unknown", async () => {
    await open();
    expect(text()).toContain("This week: 41 tasks");
    expect(text()).not.toContain("plan usage");
  });

  it("Needs you comes first with its count, then the recap, then the grid", async () => {
    await open({ needs: needsRead({ data: needsData({ count: 3 }) }) });
    const order = [...h!.container.querySelectorAll('[data-testid="fleet-needs"], [data-testid="fleet-recap"], [data-testid="fleet-grid"]')].map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["fleet-needs", "fleet-recap", "fleet-grid"]);
    expect(q('[data-testid="fleet-needs"] [data-testid="needs-count"]')?.textContent).toBe("3");
  });

  it("an empty Needs you says Nothing needs you.", async () => {
    await open();
    expect(q('[data-testid="fleet-needs"]')?.textContent).toContain("Nothing needs you.");
    expect(q('[data-testid="needs-count"]')).toBeNull();
  });

  it("Needs you has its own states: loading, error with Try again, older box", async () => {
    await open({ needs: needsRead({ data: null, loading: true }) });
    expect(q('[data-testid="fleet-needs"]')?.textContent).toContain("Loading");
    h!.unmount();
    const reload = vi.fn(() => Promise.resolve());
    await open({ needs: needsRead({ data: null, error: "No answer", reload }) });
    expect(q('[data-testid="fleet-needs"]')?.textContent).toContain("No answer");
    await click([...q('[data-testid="fleet-needs"]')!.querySelectorAll("button")].find((b) => b.textContent === "Try again"));
    expect(reload).toHaveBeenCalled();
    h!.unmount();
    await open({ needs: needsRead({ data: null, unsupported: true }) });
    expect(q('[data-testid="fleet-needs"]')?.textContent).toContain("Update the box");
  });

  it("the recap: 'Since …' and the server's own lines; nothing when there are none", async () => {
    await open();
    expect(q('[data-testid="fleet-recap"]')?.textContent).toContain("Since");
    expect(q('[data-testid="fleet-recap"]')?.textContent).toContain("Manta handed 9 requests to agents");
    expect(q('[data-testid="fleet-recap"]')?.textContent).toContain("SEO finished 1 task in Ronda");
    h!.unmount();
    await open({}, { agentsFleet: () => Promise.resolve(fleet({ recap: { since: null, lines: [] } })) });
    expect(q('[data-testid="fleet-recap"]')).toBeNull();
  });

  it("the grid is a table: a column per project, a row per agent, '—' for no seat, tasks this week last", async () => {
    await open();
    const table = q('[data-testid="fleet-grid"] table')!;
    expect([...table.querySelectorAll("thead th")].map((t) => t.textContent)).toEqual(["Agent", "Manta", "Ronda", "Tasks this week"]);
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('th[scope="row"]')?.textContent).toContain("Dev");
    const cells = [...rows[0].querySelectorAll("td")];
    expect(cells[0].textContent).toContain("Explorer: 0-byte file crash");
    expect(cells[0].textContent).toContain("Working · 4/7 · 1 question");
    expect(cells[1].textContent).toBe("—");
    expect(cells[2].textContent).toBe("14");
    const seo = [...rows[1].querySelectorAll("td")];
    expect(seo[0].textContent).toContain("last task 3d ago");
    expect(seo[1].textContent).toContain("Failed · Gmail token");
    // the region is named and keyboard-scrollable (responsive-table guide)
    const region = q('[data-testid="fleet-grid"] [role="region"]')!;
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("a cell with a task opens its session; an idle cell and a dash are not buttons", async () => {
    await open({}, { delegateOpenSession: () => Promise.resolve({ ok: true, tmuxSession: "manta", windowIndex: 2 }) });
    const buttons = [...h!.container.querySelectorAll<HTMLButtonElement>('[data-testid="fleet-grid"] td button')];
    expect(buttons.map((b) => b.textContent)).toEqual([expect.stringContaining("Explorer: 0-byte"), expect.stringContaining("Weekly audit")]);
    await click(buttons[0]);
    expect(api.calls.delegateOpenSession).toEqual([[{ jobId: "job1" }]]);
  });

  it("a refused open says why on the page", async () => {
    await open({}, { delegateOpenSession: () => Promise.resolve({ ok: false, error: "That task has no window any more" }) });
    await click(q('[data-testid="fleet-grid"] td button'));
    expect(q('[data-testid="fleet-open-error"]')?.textContent).toContain("That task has no window any more");
    expect(q('[data-testid="fleet-open-error"]')?.getAttribute("role")).toBe("alert");
  });

  it("an agent's name opens its profile", async () => {
    await open();
    await click([...h!.container.querySelectorAll('[data-testid="fleet-grid"] th[scope="row"] button')][1]);
    expect(onOpenProfile).toHaveBeenCalledWith("seo");
  });

  it("refetches once, a second after a burst of hints (subscribed before the first read)", async () => {
    let reads = 0;
    await open({}, { agentsFleet: () => (reads++, Promise.resolve(fleet())) });
    expect(reads).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => {
      hint?.();
      hint?.();
      hint?.();
    });
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(reads).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(reads).toBe(2);
  });

  it("records the visit when the page is left, once it has shown the fleet", async () => {
    await open();
    expect(api.calls.agentsFleetSeen ?? []).toHaveLength(0);
    h!.unmount();
    h = null;
    expect(api.calls.agentsFleetSeen).toHaveLength(1);
  });

  it("does not record a visit that never showed anything (StrictMode's simulated unmount, an early leave)", async () => {
    await open({}, { agentsFleet: () => new Promise(() => {}) }, true);
    h!.unmount();
    h = null;
    expect(api.calls.agentsFleetSeen ?? []).toHaveLength(0);
  });

  it("Needs you row: scrolls the first section into view", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await open({ focus: "needs" });
    expect(scroll).toHaveBeenCalled();
  });
});
