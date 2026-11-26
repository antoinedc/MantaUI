// @vitest-environment jsdom
//
// The profile's Seats (agent screens spec §2.2, §5.1): one row per seat with its brief, notes and current task; Edit brief,
// Remove (confirmed), Add a seat; the memory map of the selected seat. The lead and the Architect work in every project.

import { describe, expect, it } from "vitest";
import { act } from "react";
import type { AgentFleet, AgentProfile, AgentSeat } from "../../shared/types";
import { installMockApi, mount, type Harness, type MockApi } from "../testHarness";
import { AgentSeats, MemoryMap } from "./AgentSeats";
import { useHarnessLifecycle, buttonIn, clickEl } from "./agentsTestFixtures";

const seat = (project: string, name: string, over: Partial<AgentSeat> = {}): AgentSeat => ({
  project,
  projectName: name,
  brief: `Brief for ${name}\nsecond line`,
  addedAt: 1,
  addedBy: "user",
  notes: 23,
  memory: [
    { label: "SEO know-how", access: "read", note: "changed only by the Architect" },
    { label: `${name} memory`, access: "read-write", note: `shared with other agents in ${name}` },
    { label: "Other projects", access: "none", note: "other seats' memory: only if they share" },
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
  const { onChanged, take } = useHarnessLifecycle();

  async function open(p: AgentProfile = profile(), overrides: Record<string, unknown> = {}, props: { fleet?: AgentFleet | null; projects?: typeof PROJECTS | null } = {}) {
    ({ api } = installMockApi(overrides));
    h = take(mount(<AgentSeats profile={p} projects={props.projects === undefined ? PROJECTS : props.projects} fleet={props.fleet === undefined ? fleetFor() : props.fleet} onChanged={onChanged} />));
    await h.flush();
  }
  const rows = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="seat-row"]')];
  const btn = (scope: ParentNode, text: string) => buttonIn(scope, text, true);
  const click = (el: Element | null | undefined) => clickEl(h!, el);
  async function type(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
    await act(async () => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  }

  it("two columns: the seats under a plain title, the tinted pane beside them", async () => {
    await open();
    const main = h!.container.querySelector('[data-testid="profile-main"]')!;
    expect(main.querySelector("h3")!.textContent).toBe("Seats");
    expect(main.querySelector("h3")!.className).not.toContain("uppercase");
    const pane = h!.container.querySelector('[data-testid="profile-pane"]')!;
    expect(pane.tagName).toBe("ASIDE");
    expect(main.contains(pane)).toBe(false);
    expect(main.querySelector('[data-testid="seat-add"]')).toBeNull(); // adding lives in the pane
    expect(pane.querySelector('[data-testid="seat-add"]')).toBeTruthy();
  });

  it("the pane says what a seat is (once), and offers Add a seat", async () => {
    await open();
    const pane = h!.container.querySelector('[data-testid="profile-pane"]')!;
    expect(pane.textContent).toContain("What a seat is");
    expect(pane.textContent).toContain("A seat lets the agent work in one project");
    expect(pane.textContent).toContain("Add a seat");
  });

  it("a row per seat: project, its whole brief, notes, the current task, and its own access map", async () => {
    await open();
    expect(rows()).toHaveLength(2);
    const t = rows()[0].textContent ?? "";
    expect(t).toContain("Manta");
    expect(t).toContain("Brief for Manta");
    expect(t).toContain("second line");
    expect(t).toContain("23 notes");
    expect(t).toContain("Pricing audit");
    expect(t).toContain("Working · 4/7");
    expect(rows()[1].textContent).toContain("No brief yet");
    expect(rows()[1].textContent).toContain("—");
  });

  it("each seat shows its own access: a tag per memory, in that seat's words", async () => {
    await open();
    const access = (i: number) => [...rows()[i].querySelectorAll('[data-testid="memory-row"]')].map((r) => [r.firstElementChild?.textContent, r.querySelector("[data-access]")?.textContent]);
    expect(access(0)).toEqual([["SEO know-how", "read"], ["Manta memory", "read + write"], ["Other projects", "no access"]]);
    expect(access(1)).toEqual([["SEO know-how", "read"], ["Ronda memory", "read + write"], ["Other projects", "no access"]]);
    expect(rows()[0].querySelector("button[aria-pressed]")).toBeNull(); // nothing to select: every seat shows its own
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
    expect(h!.container.querySelector('[data-testid="profile-pane"]')?.textContent).toContain("What a seat is"); // the pane stays
  });

  it("Edit brief: a textarea, Save sends it and reads again; Cancel leaves it alone", async () => {
    await open(profile(), { agentsSeatSet: () => Promise.resolve(seat("manta-aaaaaaaaaa", "Manta")) });
    await click(btn(rows()[0], "Edit brief"));
    const ta = rows()[0].querySelector("textarea")!;
    expect(ta.value).toBe("Brief for Manta\nsecond line");
    expect(ta.maxLength).toBe(4000);
    expect(rows()[0].textContent).toContain("27 / 4000");
    await type(ta, "New brief");
    expect(rows()[0].textContent).toContain("9 / 4000");
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
    const trigger = btn(rows()[0], "Remove seat")!;
    expect(trigger.className).toContain("underline"); // a quiet link, not a button-shaped box
    await click(trigger);
    expect(btn(rows()[0], "Edit brief")).toBeUndefined(); // the row is asking
    await click(btn(rows()[0], "Cancel"));
    expect(api.calls.agentsSeatRemove ?? []).toHaveLength(0);
    await click(btn(rows()[0], "Remove seat"));
    await click(btn(rows()[0], "Remove seat")); // the confirmation
    expect(api.calls.agentsSeatRemove).toEqual([[{ slug: "seo", project: "manta-aaaaaaaaaa" }]]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refused removal says why", async () => {
    await open(profile(), { agentsSeatRemove: () => Promise.reject(new Error("Couldn't move the seat file")) });
    await click(btn(rows()[0], "Remove seat"));
    await click(btn(rows()[0], "Remove seat"));
    expect(rows()[0].querySelector('[role="alert"]')?.textContent).toBe("Couldn't move the seat file");
  });

  it("Add a seat: a list of the projects without one; Add sends the choice", async () => {
    await open(profile(), { agentsSeatAdd: () => Promise.resolve(seat("capo-cccccccccc", "Capo")) });
    const select = h!.container.querySelector<HTMLSelectElement>('[data-testid="seat-add"] select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose a project…", "Capo"]);
    expect(btn(h!.container, "Add")?.disabled).toBe(true);
    expect(select.getAttribute("aria-label") ?? "").toContain("project");
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
});

describe("MemoryMap", () => {
  const view = (access: "read" | "read-write" | "none") =>
    seat("manta-aaaaaaaaaa", "Manta", { memory: [{ label: "Research library", access, note: "shared by all agents" }] });
  const tag = (h: Harness) => h.container.querySelector('[data-testid="memory-row"] [data-access]')!;

  it("renders nothing for no seat or no memory", () => {
    for (const s of [null, seat("p", "P", { memory: [] })]) {
      const h = mount(<MemoryMap seat={s} />);
      expect(h.container.querySelector('[data-testid="memory-map"]')).toBeNull();
      h.unmount();
    }
  });

  it("is rows, not cards: the name and one tag (read / read + write / no access); nothing in a box", () => {
    for (const variant of ["pane", "inline"] as const) {
      for (const [access, text] of [["read", "read"], ["read-write", "read + write"], ["none", "no access"]] as const) {
        const h = mount(<MemoryMap seat={view(access)} variant={variant} />);
        const row = h.container.querySelector('[data-testid="memory-row"]')!;
        expect(row.textContent).toContain("Research library");
        expect(tag(h).textContent).toBe(text);
        expect(tag(h).getAttribute("data-access")).toBe(access);
        expect(row.className).not.toMatch(/(^|\s)border(\s|$)/);
        expect(h.container.querySelector(".grid-cols-2")).toBeNull();
        h.unmount();
      }
    }
  });

  it("the row's note is its tooltip, not more text in the row", () => {
    const h = mount(<MemoryMap seat={view("read")} variant="inline" />);
    expect(h.container.querySelector('[data-testid="memory-row"]')?.getAttribute("title")).toBe("shared by all agents");
    expect(h.container.querySelector('[data-testid="memory-row"]')?.textContent).not.toContain("shared by all agents");
    h.unmount();
  });

  it("the pane's version has its own quiet title naming the seat", () => {
    const h = mount(<MemoryMap seat={view("read")} variant="pane" />);
    expect(h.container.querySelector("h3")?.textContent).toBe("Access · in the Manta seat");
    h.unmount();
  });
});
