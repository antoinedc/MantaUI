// @vitest-environment jsdom
//
// The profile's Seats (agent screens spec §2.2, §5.1): one row per seat with its brief, notes and current task; Edit brief,
// Remove (confirmed), Add a seat; the memory map of the selected seat. The lead and the Architect work in every project.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentFleet, AgentProfile, AgentSeat } from "../../shared/types";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import { AgentSeats, MemoryMap } from "./AgentSeats";

const seat = (project: string, name: string, over: Partial<AgentSeat> = {}): AgentSeat => ({
  project,
  projectName: name,
  brief: `Brief for ${name}\nsecond line`,
  addedAt: 1,
  addedBy: "user",
  notes: 23,
  memory: [
    { label: "SEO know-how", access: "read", note: "changed only by the Architect" },
    { label: "Manta memory", access: "read-write", note: "shared with other agents in Manta" },
    { label: "Ronda, Tenanture…", access: "none", note: "other seats' memory: only if they share" },
  ],
  ...over,
});

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  info: { slug: "seo", name: "SEO", description: "d", isolation: "none", model: null, color: null, builtIn: false, role: "specialist", useWhen: null, notFor: null, notice: null },
  seats: [seat("manta-aaaaaaaaaa", "Manta"), seat("ronda-bbbbbbbbbb", "Ronda", { brief: "", notes: null })],
  lastChangedAt: null,
  builtBy: "user",
  refresh: { enabled: true, routineId: null },
  research: [],
  ...over,
});

const PROJECTS = [
  { slug: "manta-aaaaaaaaaa", name: "Manta" },
  { slug: "ronda-bbbbbbbbbb", name: "Ronda" },
  { slug: "capo-cccccccccc", name: "Capo" },
];

const fleetFor = (): AgentFleet => ({
  asOf: 1,
  projects: [],
  rows: [{ slug: "seo", name: "SEO", color: null, seats: [], tasksThisWeek: 1, cells: { "manta-aaaaaaaaaa": { jobId: "job1", title: "Pricing audit", at: 1, state: "working", detail: "4/7" } } }],
  week: { tasks: 1 },
  recap: { since: null, lines: [] },
});

describe("AgentSeats", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onChanged = vi.fn();

  beforeEach(() => {
    resetStore();
    onChanged.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(p: AgentProfile = profile(), overrides: Record<string, unknown> = {}, props: { fleet?: AgentFleet | null; projects?: typeof PROJECTS | null } = {}) {
    ({ api } = installMockApi(overrides));
    h = mount(<AgentSeats profile={p} projects={props.projects === undefined ? PROJECTS : props.projects} fleet={props.fleet === undefined ? fleetFor() : props.fleet} onChanged={onChanged} />);
    await h.flush();
  }
  const rows = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="seat-row"]')];
  const btn = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  async function click(el: Element | null | undefined) {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }
  async function type(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
    await act(async () => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  }

  it("a row per seat: project, first line of the brief, notes, the current task", async () => {
    await open();
    expect(rows()).toHaveLength(2);
    const t = rows()[0].textContent ?? "";
    expect(t).toContain("Manta");
    expect(t).toContain("Brief for Manta");
    expect(t).not.toContain("second line");
    expect(t).toContain("23 notes");
    expect(t).toContain("Pricing audit");
    expect(t).toContain("Working · 4/7");
    expect(rows()[1].textContent).toContain("No brief yet");
    expect(rows()[1].textContent).toContain("—");
  });

  it("with no seat: says so, and still offers Add", async () => {
    await open(profile({ seats: [] }));
    expect(h!.container.textContent).toContain("No seats yet");
    expect(h!.container.querySelector('[data-testid="seat-add"]')).toBeTruthy();
  });

  it("the lead and the Architect work in every project: no rows, no actions", async () => {
    await open(profile({ info: { ...profile().info, role: "architect" }, seats: [] }));
    expect(h!.container.textContent).toContain("Works in every project");
    expect(h!.container.querySelector('[data-testid="seat-add"]')).toBeNull();
    expect(h!.container.querySelector('[data-testid="seat-row"]')).toBeNull();
  });

  it("Edit brief: a textarea, Save sends it and reads again; Cancel leaves it alone", async () => {
    await open(profile(), { agentsSeatSet: () => Promise.resolve(seat("manta-aaaaaaaaaa", "Manta")) });
    await click(btn(rows()[0], "Edit brief"));
    const ta = rows()[0].querySelector("textarea")!;
    expect(ta.value).toBe("Brief for Manta\nsecond line");
    expect(ta.maxLength).toBe(4000);
    await type(ta, "New brief");
    await click(btn(rows()[0], "Save"));
    expect(api.calls.agentsSeatSet).toEqual([[{ slug: "seo", project: "manta-aaaaaaaaaa", brief: "New brief" }]]);
    expect(onChanged).toHaveBeenCalled();
    expect(rows()[0].querySelector("textarea")).toBeNull();
    await click(btn(rows()[1], "Edit brief"));
    await click(btn(rows()[1], "Cancel"));
    expect(rows()[1].querySelector("textarea")).toBeNull();
    expect(api.calls.agentsSeatSet).toHaveLength(1);
  });

  it("a refused save keeps the editor open and says why", async () => {
    await open(profile(), { agentsSeatSet: () => Promise.reject(new Error("That brief is too long")) });
    await click(btn(rows()[0], "Edit brief"));
    await click(btn(rows()[0], "Save"));
    expect(rows()[0].querySelector("textarea")).toBeTruthy();
    expect(rows()[0].querySelector('[role="alert"]')?.textContent).toBe("That brief is too long");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("Remove asks first; confirming removes the seat, Cancel does nothing", async () => {
    await open(profile(), { agentsSeatRemove: () => Promise.resolve({ ok: true }) });
    await click(btn(rows()[0], "Remove"));
    await click(btn(rows()[0], "Cancel"));
    expect(api.calls.agentsSeatRemove ?? []).toHaveLength(0);
    await click(btn(rows()[0], "Remove"));
    await click(btn(rows()[0], "Remove seat"));
    expect(api.calls.agentsSeatRemove).toEqual([[{ slug: "seo", project: "manta-aaaaaaaaaa" }]]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refused removal says why", async () => {
    await open(profile(), { agentsSeatRemove: () => Promise.reject(new Error("Couldn't move the seat file")) });
    await click(btn(rows()[0], "Remove"));
    await click(btn(rows()[0], "Remove seat"));
    expect(rows()[0].querySelector('[role="alert"]')?.textContent).toBe("Couldn't move the seat file");
  });

  it("Add a seat: a list of the projects without one; Add sends the choice", async () => {
    await open(profile(), { agentsSeatAdd: () => Promise.resolve(seat("capo-cccccccccc", "Capo")) });
    const select = h!.container.querySelector<HTMLSelectElement>('[data-testid="seat-add"] select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose a project…", "Capo"]);
    expect(btn(h!.container, "Add")?.disabled).toBe(true);
    await type(select, "capo-cccccccccc");
    await click(btn(h!.container, "Add"));
    expect(api.calls.agentsSeatAdd).toEqual([[{ slug: "seo", project: "capo-cccccccccc" }]]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refused add says why; no projects left says so", async () => {
    await open(profile(), { agentsSeatAdd: () => Promise.reject(new Error("Unknown project")) });
    const select = h!.container.querySelector<HTMLSelectElement>('[data-testid="seat-add"] select')!;
    await type(select, "capo-cccccccccc");
    await click(btn(h!.container, "Add"));
    expect(h!.container.querySelector('[data-testid="seat-add"] [role="alert"]')?.textContent).toBe("Unknown project");
    h!.unmount();
    await open(profile(), {}, { projects: PROJECTS.slice(0, 2) });
    expect(h!.container.querySelector('[data-testid="seat-add"]')?.textContent).toContain("Every project has a seat");
    h!.unmount();
    await open(profile(), {}, { projects: null });
    expect(h!.container.querySelector('[data-testid="seat-add"]')?.textContent).toContain("Couldn't list the projects");
  });

  it("the memory map follows the selected seat (the first one by default)", async () => {
    await open();
    const map = () => h!.container.querySelector('[data-testid="memory-map"]')!;
    expect(map().textContent).toContain("Manta seat");
    expect(map().textContent).toContain("SEO know-how");
    expect(map().textContent).toContain("read-only");
    expect(map().textContent).toContain("read + write");
    expect(map().textContent).toContain("no access");
    await click(rows()[1].querySelector('button[aria-pressed]'));
    expect(map().textContent).toContain("Ronda seat");
  });
});

describe("MemoryMap", () => {
  it("renders nothing for no seat", () => {
    const h = mount(<MemoryMap seat={null} />);
    expect(h.container.querySelector('[data-testid="memory-map"]')).toBeNull();
    h.unmount();
  });
});
