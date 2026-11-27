// @vitest-environment jsdom
//
// The agent profile (agent screens spec §2.2, contract §States): header, pending change cards, tabs (Overview · Research ·
// Seats · History · Tests later), the refresh control, and its loading / error / invalid / lead / Architect states.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentChange, AgentFleet, AgentInfo, AgentProfile as Profile } from "../../shared/types";
import { resetPackageAgentsForTest } from "../packageAgents";
import { useStore } from "../store";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "../testHarness";
import { AgentProfile } from "./AgentProfile";
import { buttonIn, changeRecord, clickEl } from "./agentsTestFixtures";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug: "seo",
  name: "SEO",
  description: "Technical SEO and visibility in AI search.",
  isolation: "none",
  model: null,
  color: "#336699",
  builtIn: false,
  role: "specialist",
  useWhen: "A page's ranking or markup is the question",
  notFor: "Writing brand copy",
  notice: null,
  ...over,
});

const AGENT_MD = "---\nname: SEO\ndescription: Technical SEO and visibility in AI search.\nisolation: none\nuse_when: A page's ranking or markup is the question\n---\nAudit pages. Never publish.";

const rec = (over: Partial<AgentChange> = {}): AgentChange =>
  changeRecord({
    after: AGENT_MD,
    createdAt: NOW - 3 * DAY,
    decidedAt: NOW - 3 * DAY,
    releasedAt: NOW - 3 * DAY,
    summary: "Added rules for how AI search engines read pages.",
    ...over,
  });

const profile = (over: Partial<Profile> = {}): Profile => ({
  info: info(),
  seats: [
    { project: "manta-aaaaaaaaaa", projectName: "Manta", brief: "Audit the marketing site", addedAt: 1, addedBy: "user", notes: 23, memory: [{ label: "Manta memory", access: "read-write", note: "shared" }] },
    { project: "ronda-bbbbbbbbbb", projectName: "Ronda", brief: "", addedAt: 2, addedBy: "mention", notes: null, memory: [] },
  ],
  lastChangedAt: NOW - 3 * DAY,
  builtBy: "architect",
  refresh: { enabled: true, routineId: "rt1" },
  research: [
    { id: "r1", topic: "Technical SEO for AI search", sourceCount: 5, ageDays: 3, status: "fresh", thin: false },
    { id: "r2", topic: "llms.txt adoption", sourceCount: 2, ageDays: 6, status: "fresh", thin: true },
    { id: "r3", topic: "Structured data", sourceCount: 4, ageDays: 41, status: "stale", thin: false },
    { id: "r4", topic: "Old note", sourceCount: null, ageDays: null, status: "missing", thin: false },
    { id: "r5", topic: "Fifth", sourceCount: 3, ageDays: 1, status: "fresh", thin: false },
  ],
  ...over,
});

const HISTORY = [rec({ id: "c2", before: "V1", after: AGENT_MD }), rec({ id: "c1", kind: "create", before: null, after: "V1", createdAt: NOW - 9 * DAY, decidedAt: NOW - 9 * DAY, summary: "Created @seo." })];

const fleet = (): AgentFleet => ({ asOf: NOW, projects: [], rows: [], week: { tasks: 0 }, recap: { since: null, lines: [] } });

describe("AgentProfile", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const onBack = vi.fn();
  const onOpenWindow = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    resetStore({ jobs: {}, drafts: [], projects: [], activeProjectName: null });
    resetPackageAgentsForTest();
    onBack.mockClear();
    onOpenWindow.mockClear();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(overrides: Record<string, unknown> = {}, slug = "seo") {
    ({ api } = installMockApi({
      agentsProfile: () => Promise.resolve(profile()),
      agentsHistory: () => Promise.resolve(HISTORY),
      agentsFleet: () => Promise.resolve(fleet()),
      agentsProjects: () => Promise.resolve([{ slug: "manta-aaaaaaaaaa", name: "Manta" }, { slug: "ronda-bbbbbbbbbb", name: "Ronda" }, { slug: "capo-cccccccccc", name: "Capo" }]),
      agentsList: () => Promise.resolve([info()]),
      ...overrides,
    }));
    h = mount(<AgentProfile slug={slug} onBack={onBack} onOpenWindow={onOpenWindow} />);
    await h.flush();
    await h.flush();
  }
  const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...h!.container.querySelectorAll<HTMLElement>(sel)];
  const btn = (text: string, scope: ParentNode = h!.container) => buttonIn(scope, text, true);
  const click = (el: Element | null | undefined) => clickEl(h!, el);
  const tab = (name: string) => qa('[role="tab"]').find((t) => (t.textContent ?? "").startsWith(name))!;
  const panel = (name: string) => qa('[role="tabpanel"]').find((p) => p.getAttribute("aria-labelledby") === tab(name).id)!;

  describe("states", () => {
    it("loading, then the page", async () => {
      let resolve!: (p: Profile) => void;
      await open({ agentsProfile: () => new Promise<Profile>((r) => (resolve = r)) });
      expect(q('[data-testid="profile-header"]')).toBeNull();
      await act(async () => {
        resolve(profile());
      });
      await h!.flush();
      expect(q('[data-testid="profile-header"]')).toBeTruthy();
    });

    it("a first read that fails is a sentence with Try again and a way back", async () => {
      let n = 0;
      await open({ agentsProfile: () => (++n === 1 ? Promise.reject(new Error("No agent named @seo")) : Promise.resolve(profile())) });
      expect(q('[data-testid="profile-error"]')?.textContent).toContain("No agent named @seo");
      expect(q("nav")?.textContent).toContain("Agents");
      await click(btn("Try again"));
      expect(q('[data-testid="profile-error"]')).toBeNull();
      expect(q('[data-testid="profile-header"]')).toBeTruthy();
    });

    it("an older box is told to update", async () => {
      await open({ agentsProfile: () => Promise.reject(new Error("unknown rpc channel: agents:profile")) });
      expect(q('[data-testid="profile-unsupported"]')?.textContent).toContain("Update the box");
    });

    it("an invalid agent shows its error and no tabs", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ error: "agent.md has no description" }) })) });
      expect(q('[data-testid="profile-invalid"]')?.textContent).toContain("agent.md has no description");
      expect(q('[role="tablist"]')).toBeNull();
    });
  });

  describe("header", () => {
    it("breadcrumbs, name, facts, description", async () => {
      await open();
      const crumbs = q('[data-testid="agents-crumbs"]')!;
      expect(crumbs.textContent).toBe("AgentsSEO");
      expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe("SEO");
      await click(btn("Agents", crumbs));
      expect(onBack).toHaveBeenCalled();
      const head = q('[data-testid="profile-header"]')!;
      expect(head.textContent).toContain("SEO");
      expect(head.textContent).toContain("Technical SEO and visibility in AI search.");
      expect(head.querySelector("h1")!.className).toContain("text-display");
    });

    it("the facts line says who it is with separators — @slug, role, seats — and repeats nothing the page already says", async () => {
      await open();
      const facts = q('[data-testid="profile-facts"]')!;
      expect([...facts.querySelectorAll("span")].map((x) => x.textContent)).toEqual(["@seo", "Specialist", "2 seats"]);
      expect(facts.className).toContain("text-text-faint");
      expect(facts.textContent).not.toMatch(/model|read-only|built by|last changed/i);
    });

    it("the description is shown once on the whole page", async () => {
      await open();
      const text = h!.container.textContent ?? "";
      expect(text.split("Technical SEO and visibility in AI search.").length - 1).toBe(1);
      expect(text).not.toContain("Does:");
    });

    it("Change via Manta and Mention in a chat open chat drafts, prefilled", async () => {
      resetStore({ drafts: [], projects: [{ tmuxSession: "manta", defaultCwd: "/work/manta", windows: [] } as never], activeProjectName: "manta" });
      await open();
      await click(btn("Change via Manta"));
      expect(useStore.getState().drafts.at(-1)?.input).toBe("Change @seo: ");
      await click(btn("Mention in a chat"));
      expect(useStore.getState().drafts.at(-1)?.input).toBe("@seo ");
    });

    it("Mention in a chat opens in the first seat's project when the sidebar has it", async () => {
      resetStore({
        drafts: [],
        activeProjectName: "other",
        projects: [
          { tmuxSession: "other", defaultCwd: "/work/other", windows: [] } as never,
          { tmuxSession: "manta", defaultCwd: "/work/manta-aaaaaaaaaa-src/manta", windows: [] } as never,
        ],
      });
      await open();
      await click(btn("Mention in a chat"));
      const d = useStore.getState().drafts.at(-1)!;
      expect(d.input).toBe("@seo ");
      expect(d.mode).toEqual({ projectName: "manta" });
    });

    it("Chat opens the agent's direct chat window; a refusal says why on the page", async () => {
      await open({ agentsOpenChat: () => Promise.resolve({ tmuxSession: "manta-agents", windowIndex: 3 }) });
      await click(btn("Chat"));
      expect(api.calls.agentsOpenChat).toEqual([[{ slug: "seo" }]]);
      expect(onOpenWindow).toHaveBeenCalledWith("manta-agents", 3);
      h!.unmount();
      await open({ agentsOpenChat: () => Promise.reject(new Error("opencode is not running")) });
      await click(btn("Chat"));
      expect(q('[data-testid="profile-action-error"]')?.textContent).toContain("opencode is not running");
      expect(q('[data-testid="profile-action-error"]')?.getAttribute("role")).toBe("alert");
    });

    it("a window that fails to open is reported too", async () => {
      onOpenWindow.mockRejectedValueOnce(new Error("its chat window did not appear — try again"));
      await open({ agentsOpenChat: () => Promise.resolve({ tmuxSession: "manta-agents", windowIndex: 3 }) });
      await click(btn("Chat"));
      expect(q('[data-testid="profile-action-error"]')?.textContent).toContain("did not appear");
    });

    it("the Architect has no Chat button (it works through tasks)", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ slug: "architect", name: "Architect", role: "architect" }), seats: [] })) }, "architect");
      expect(btn("Chat")).toBeUndefined();
      expect(btn("Change via Manta")).toBeTruthy();
    });
  });

  describe("pending changes", () => {
    const pending = rec({ id: "p1", state: "pending", decidedAt: null, decidedBy: null, needsClick: true, reason: "ask", summary: "Adds an llms.txt check.", before: "---\nname: SEO\ndescription: d\nisolation: none\n---\nOld rule.\n", after: AGENT_MD });
    it("one card per pending record, above the tabs, with the card's own Apply", async () => {
      await open({ agentsHistory: () => Promise.resolve([pending, ...HISTORY]), agentsChangeApply: () => Promise.resolve({ ...pending, state: "applied", decidedAt: NOW, decidedBy: "click" }) });
      const cards = qa('[data-testid="profile-pending"] [data-testid="agent-change-card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0].compareDocumentPosition(q('[role="tablist"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await click(btn("Apply", cards[0]));
      expect(api.calls.agentsChangeApply).toEqual([["p1"]]);
      // it stays, in its new state; the history reads again
      expect(q('[data-testid="profile-pending"] [data-testid="agent-change-card"]')?.getAttribute("data-state")).toBe("applied");
      expect(api.calls.agentsHistory.length).toBeGreaterThanOrEqual(2);
    });

    it("is one summary line with Apply and Discard, the change folded under 'Show the change'", async () => {
      await open({ agentsHistory: () => Promise.resolve([pending, ...HISTORY]) });
      const card = q('[data-testid="profile-pending"] [data-testid="agent-change-card"]')!;
      expect(card.querySelector('[data-testid="agent-change-summary-line"]')?.textContent).toContain("Adds an llms.txt check.");
      const fold = card.querySelector<HTMLDetailsElement>('[data-testid="agent-change-fold"]')!;
      expect(fold.open).toBe(false);
      expect(fold.querySelector("summary")?.textContent).toMatch(/^Show the change · \d+ lines?/);
      expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Discard", "Apply"]);
    });

    it("none when nothing is pending", async () => {
      await open();
      expect(q('[data-testid="profile-pending"]')).toBeNull();
    });
  });

  describe("tabs", () => {
    it("a tablist with counts; Overview selected, the other panels hidden; there is no Tests tab until Tests exist", async () => {
      await open();
      const tabs = qa('[role="tab"]');
      expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Research · 5", "Seats · 2", "History · 2"]);
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
      expect(tab("Research").getAttribute("aria-selected")).toBe("false");
      expect(panel("Overview").hidden).toBe(false);
      expect(panel("Research").hidden).toBe(true);
      expect(panel("Seats").hidden).toBe(true);
      expect(panel("History").hidden).toBe(true);
      expect(qa('[role="tab"]').some((t) => /tests/i.test(t.textContent ?? ""))).toBe(false);
      expect(h!.container.textContent).not.toMatch(/Coming later|Tests — later/);
    });

    it("a click selects; only the selected tab is in the tab order", async () => {
      await open();
      await click(tab("Seats"));
      expect(tab("Seats").getAttribute("aria-selected")).toBe("true");
      expect(panel("Seats").hidden).toBe(false);
      expect(panel("Overview").hidden).toBe(true);
      expect(tab("Seats").tabIndex).toBe(0);
      expect(tab("Overview").tabIndex).toBe(-1);
    });

    it("arrows move and select (wrapping), Home and End jump; focus follows", async () => {
      await open();
      const key = async (el: HTMLElement, k: string) =>
        act(async () => {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
        });
      await key(tab("Overview"), "ArrowRight");
      expect(tab("Research").getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tab("Research"));
      await key(tab("Research"), "End");
      expect(tab("History").getAttribute("aria-selected")).toBe("true");
      await key(tab("History"), "ArrowRight");
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
      await key(tab("Overview"), "ArrowLeft");
      expect(tab("History").getAttribute("aria-selected")).toBe("true");
      await key(tab("History"), "Home");
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    });

    it("each panel is named by its tab (no aria-controls)", async () => {
      await open();
      for (const t of qa('[role="tab"]')) expect(t.getAttribute("aria-controls")).toBeNull();
      expect(qa('[role="tabpanel"]')).toHaveLength(4);
    });
  });

  describe("Overview", () => {
    const ov = () => panel("Overview");
    const pane = () => ov().querySelector<HTMLElement>('[data-testid="profile-pane"]')!;
    const group = (id: string) => pane().querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

    it("two columns: 'How to use it' and the research on the left, one details pane on the right", async () => {
      await open();
      const main = ov().querySelector<HTMLElement>('[data-testid="profile-main"]')!;
      expect(main).toBeTruthy();
      expect(pane().tagName).toBe("ASIDE");
      expect(pane().getAttribute("aria-label")).toBe("Details");
      expect(ov().contains(pane())).toBe(true);
      expect(main.contains(pane())).toBe(false);
      expect(pane().className).toContain("bg-bg-elev"); // one tinted region
      expect(pane().className).toContain("sticky");
      expect(ov().querySelector('[data-testid="profile-grid"]')!.className).toContain("18rem"); // the pane's column: ~288px
      expect(ov().querySelector('[data-testid="profile-howto"]')).toBeTruthy();
    });

    it("History is not on the Overview at all (it stays a tab); neither is a Tests box", async () => {
      await open();
      expect(ov().querySelector('[data-testid="history-row"]')).toBeNull();
      expect(ov().textContent).not.toMatch(/All history|Coming later/);
      expect(ov().textContent).not.toMatch(/\bHistory\b/);
      expect(panel("History").querySelectorAll('[data-testid="history-row"]')).toHaveLength(2);
    });

    it("'How to use it' is a definition list of the agent's real fields: use when, not for — nothing invented", async () => {
      await open();
      const dl = q('[data-testid="profile-howto"] dl')!;
      expect([...dl.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Use it when", "Not for"]);
      expect([...dl.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["A page's ranking or markup is the question", "Writing brand copy"]);
      expect(ov().textContent).not.toMatch(/Asks first|Measures|Does:/);
      expect(q('[data-testid="profile-howto"] h3')!.className).toContain("text-body");
      expect(q('[data-testid="profile-howto"] h3')!.className).toContain("font-semibold");
      expect(q('[data-testid="profile-howto"] h3')!.className).not.toContain("uppercase");
    });

    it("an agent with only one of the two shows only that row; with neither it says so instead of an empty list", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ notFor: null }) })) });
      expect([...q('[data-testid="profile-howto"] dl')!.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Use it when"]);
      h!.unmount();
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ useWhen: null, notFor: null }) })) });
      expect(q('[data-testid="profile-howto"] dl')).toBeNull();
      expect(q('[data-testid="profile-howto"]')!.textContent).toContain("Nothing written yet");
    });

    it("the full instructions are folded under the list, from the agent's own file", async () => {
      await open();
      const details = q('[data-testid="profile-howto"] details')!;
      expect(details.textContent).toContain("Full instructions");
      expect(details.textContent).toContain("Audit pages. Never publish.");
      expect((details as HTMLDetailsElement).open).toBe(false);
    });

    it("research it relies on: the first 4 rows as hairline rows, and 'All 5 →' goes to the tab", async () => {
      await open();
      expect(ov().querySelectorAll('[data-testid="research-row"]')).toHaveLength(4);
      await click(btn("All 5 →", ov()));
      expect(tab("Research").getAttribute("aria-selected")).toBe("true");
    });

    it("the pane's Details: model, works, built by, changed", async () => {
      await open();
      const rows = [...group("profile-details").querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
      expect(rows).toEqual([
        ["Model", "Auto"],
        ["Works", "Read-only"],
        ["Built by", "Architect"],
        ["Changed", expect.stringMatching(/\d/)],
      ]);
    });

    it("the pane's Seats: each seat with its notes, and Manage seats goes to the Seats tab", async () => {
      await open();
      const seats = group("profile-seats");
      expect(seats.textContent).toContain("Manta");
      expect(seats.textContent).toContain("23 notes");
      expect(seats.textContent).toContain("Ronda");
      await click(btn("Manage seats", seats));
      expect(tab("Seats").getAttribute("aria-selected")).toBe("true");
    });

    it("the pane's Access: the first seat's memory as rows with a tag each", async () => {
      await open();
      const access = group("profile-access");
      expect(access.textContent).toContain("Manta");
      const rows = [...access.querySelectorAll('[data-testid="memory-row"]')];
      expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Manta memory")]);
      expect(rows[0].querySelector("[data-access]")?.textContent).toBe("read + write");
    });

    it("the pane's Refresh: Monthly / Off (specialists only)", async () => {
      await open();
      expect(btn("Monthly", group("profile-refresh"))).toBeTruthy();
      expect(group("profile-refresh").textContent).toContain("Once a month"); // the Overview's keeps its note
      h!.unmount();
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ role: "lead" }), seats: [] })) });
      expect(q('[data-testid="profile-refresh"]')).toBeNull();
      expect(pane()).toBeTruthy();
    });

    it("below ~720px the pane stacks under the main column (a container query on the overview's own width)", async () => {
      await open();
      const grid = ov().querySelector('[data-testid="profile-grid"]')!;
      expect(grid.parentElement!.className).toContain("[container-type:inline-size]");
      expect(grid.className).toContain("@container(min-width:720px)");
    });

    it("the lead has no seats to list: it works in every project", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ role: "lead" }), seats: [] })) });
      expect(group("profile-seats").textContent).toContain("Works in every project");
      expect(group("profile-access")).toBeNull();
    });
  });

  describe("refresh", () => {
    it("is Monthly by default and Off after the toggle (and says so)", async () => {
      await open({ agentsRefreshSet: () => Promise.resolve({ enabled: false, routineId: "rt1" }) });
      const group = q('[role="group"][aria-label="Refresh with new research"]')!;
      expect(btn("Monthly", group)?.getAttribute("aria-pressed")).toBe("true");
      await click(btn("Off", group));
      expect(api.calls.agentsRefreshSet).toEqual([[{ slug: "seo", enabled: false }]]);
      expect(btn("Off", group)?.getAttribute("aria-pressed")).toBe("true");
      expect(btn("Monthly", group)?.getAttribute("aria-pressed")).toBe("false");
    });

    it("a refusal is a sentence and the setting stays where it was", async () => {
      await open({ agentsRefreshSet: () => Promise.reject(new Error("Couldn't read the refresh setting; try again")) });
      const group = q('[role="group"][aria-label="Refresh with new research"]')!;
      await click(btn("Off", group));
      expect(q('[data-testid="refresh-error"]')?.textContent).toBe("Couldn't read the refresh setting; try again");
      expect(btn("Monthly", group)?.getAttribute("aria-pressed")).toBe("true");
    });

    it("an agent already Off reads Off; the lead and the Architect have no refresh control", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ refresh: { enabled: false, routineId: "rt1" } })) });
      expect(btn("Off", q('[role="group"][aria-label="Refresh with new research"]')!)?.getAttribute("aria-pressed")).toBe("true");
      h!.unmount();
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ role: "lead" }), seats: [] })) });
      expect(q('[role="group"][aria-label="Refresh with new research"]')).toBeNull();
    });
  });

  describe("Research and Seats tabs", () => {
    it("Research: every entry as an expandable row, and the library's note once, in the pane", async () => {
      await open();
      const p = panel("Research");
      expect(p.querySelectorAll('[data-testid="research-entry"]')).toHaveLength(5);
      expect(p.querySelector('[data-testid="profile-pane"]')?.textContent).toContain("Thin means fewer than 3 independent sources".replace("Thin", "thin"));
      expect(p.textContent).toContain("no longer in the library");
      expect(panel("Overview").textContent).not.toContain("independent sources"); // the Overview doesn't repeat it
    });

    it("every tab is two columns: its content on the left, its own tinted pane on the right", async () => {
      await open();
      for (const name of ["Overview", "Research", "Seats", "History"]) {
        const p = panel(name);
        const side = p.querySelector('[data-testid="profile-pane"]');
        expect(side?.tagName, name).toBe("ASIDE");
        expect(p.querySelector('[data-testid="profile-main"]')?.contains(side), name).toBe(false);
        expect(side!.className, name).toContain("bg-bg-elev");
      }
      expect(panel("Research").textContent).toContain("Refresh with new research");
      expect(panel("Seats").textContent).toContain("What a seat is");
      expect(panel("History").textContent).toContain("How changes land");
    });

    it("the History pane counts the agent's changes: live, waiting, undone", async () => {
      await open();
      const counts = [...panel("History").querySelectorAll('[data-testid="history-summary-counts"] dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
      expect(counts).toEqual([["Live", "2"], ["Waiting", "0"], ["Undone", "0"]]);
    });

    it("one Apply / Discard on the page (the pending card) and, with a pending change, History's row for it points up", async () => {
      const pending = rec({ id: "p1", state: "pending", decidedAt: null, decidedBy: null, needsClick: true, reason: "ask", summary: "Adds an llms.txt check." });
      await open({ agentsHistory: () => Promise.resolve([pending, ...HISTORY]) });
      await click(tab("History"));
      const all = [...h!.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
      expect(all.filter((t) => t === "Apply")).toHaveLength(1);
      expect(all.filter((t) => t === "Discard")).toHaveLength(1);
      expect(panel("History").textContent).toContain("card above");
    });

    it("Seats: the rows and the actions (more in AgentSeats' own tests)", async () => {
      await open();
      const p = panel("Seats");
      expect(p.querySelectorAll('[data-testid="seat-row"]')).toHaveLength(2);
      expect(btn("Edit brief", p)).toBeTruthy();
    });

    it("a seat change reads the profile again", async () => {
      await open({ agentsSeatRemove: () => Promise.resolve({ ok: true }) });
      const before = api.calls.agentsProfile.length;
      const p = panel("Seats");
      await click(btn("Remove seat", p));
      await click(btn("Remove seat", p)); // the confirmation
      expect(api.calls.agentsProfile.length).toBe(before + 1);
    });
  });

  describe("History tab", () => {
    it("lists the records; a failed history read says so with Try again (the profile still shows)", async () => {
      await open();
      expect(panel("History").querySelectorAll('[data-testid="history-row"]')).toHaveLength(2);
      h!.unmount();
      let n = 0;
      await open({ agentsHistory: () => (++n === 1 ? Promise.reject(new Error("Couldn't read the change history")) : Promise.resolve(HISTORY)) });
      expect(panel("History").textContent).toContain("Couldn't read the change history");
      expect(q('[data-testid="profile-header"]')).toBeTruthy();
      await click(btn("Try again", panel("History")));
      expect(panel("History").querySelectorAll('[data-testid="history-row"]')).toHaveLength(2);
    });

    it("a restore reads the profile and history again", async () => {
      const restored = rec({ id: "r1", before: AGENT_MD, after: "V1", origin: { kind: "restore", fromChangeId: "c2" }, decidedBy: "click" });
      await open({ agentsChangeRestore: () => Promise.resolve(restored) });
      const before = api.calls.agentsProfile.length;
      await click(panel("History").querySelector('[data-id="c2"] summary'));
      await click(btn("Restore the version before this", panel("History")));
      expect(api.calls.agentsChangeRestore).toEqual([[{ id: "c2" }]]);
      expect(api.calls.agentsProfile.length).toBeGreaterThan(before);
    });
  });

  // Architect v2 §3.4: the Tests tab
  describe("Tests tab", () => {
    const kase = (name: string, over: Record<string, unknown> = {}) => ({ name, expect: "does" as const, state: "done" as const, finalAnswer: null, tools: [], filesChanged: 0, refused: [], wouldAsk: [], durationMs: 5, ...over });
    const trials = [
      { id: "tr_old", rootJobId: "job0", agentSlug: "seo", draftHash: "a", createdAt: NOW - 5 * DAY, cases: [kase("audit")] },
      { id: "tr_new", rootJobId: "job1", agentSlug: "seo", draftHash: "b", createdAt: NOW - DAY, cases: [kase("audit"), kase("publish", { expect: "declines" }), kase("slow", { state: "running" })] },
    ];
    const withTrials = () => ({
      agentsProfile: () => Promise.resolve(profile({ trials })),
      agentsHistory: () => Promise.resolve([rec({ id: "c3", trial: { id: "tr_old", verdicts: [{ case: "audit", pass: true, quote: "I checked the title tags first", note: "ok" }] } }), ...HISTORY]),
      agentsTrialTranscript: () => Promise.resolve({ text: "Assistant: I checked the title tags first", nextOffset: null }),
    });

    it("is shown last, with its count, only when the agent has trials", async () => {
      await open(withTrials());
      const names = qa('[role="tab"]').map((t) => t.textContent);
      expect(names.at(-1)).toBe("Tests · 2");
      expect(panel("Tests").hidden).toBe(true);
    });

    it("lists the trials newest first, the honest note beside them, the verdict of the proposal that used one, and each case's transcript", async () => {
      await open(withTrials());
      await click(tab("Tests"));
      const p = panel("Tests");
      expect(p.hidden).toBe(false);
      const rows = [...p.querySelectorAll<HTMLElement>('[data-testid="trial-row"]')];
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain("2 of 3 cases finished");
      expect(rows[0].textContent).toContain("running");
      expect((rows[0].querySelector("details") as HTMLDetailsElement).open).toBe(true);
      expect(rows[1].querySelector('[data-testid="trial-row-verdict"]')?.textContent).toBe("passed");
      expect(rows[1].textContent).toContain("I checked the title tags first");
      expect(p.querySelector('[data-testid="tests-about"]')?.textContent).toContain(
        "Runs in a private copy of the project, with no shell, no secrets, no publishing or sending, and file access limited to that copy.",
      );
      // a running case has no transcript yet; a finished one does
      const newCases = [...rows[0].querySelectorAll<HTMLElement>('[data-testid="trial-case"]')];
      expect(newCases.map((c) => [...c.querySelectorAll("button")].some((b) => b.textContent === "Transcript"))).toEqual([true, true, false]);
      expect(newCases[1].textContent).toContain("should decline");
      await click([...rows[1].querySelectorAll("button")].find((b) => b.textContent === "Transcript"));
      expect(api.calls.agentsTrialTranscript).toEqual([[{ id: "tr_old", case: "audit", offset: 0 }]]);
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Assistant: I checked the title tags first");
    });

    it("End from History reaches Tests", async () => {
      await open(withTrials());
      await click(tab("History"));
      await act(async () => {
        tab("History").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      });
      await h!.flush();
      expect(tab("Tests").getAttribute("aria-selected")).toBe("true");
    });
  });
});
