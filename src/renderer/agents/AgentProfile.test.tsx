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

const rec = (over: Partial<AgentChange> = {}): AgentChange => ({
  id: "c1",
  kind: "update",
  slug: "seo",
  agentName: "SEO",
  sessionID: "ses",
  messageID: "m",
  callID: "c",
  state: "applied",
  needsClick: false,
  reason: null,
  before: "V1",
  after: AGENT_MD,
  createdAt: NOW - 3 * DAY,
  decidedAt: NOW - 3 * DAY,
  error: null,
  origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 },
  mode: "build",
  releasedAt: NOW - 3 * DAY,
  decidedBy: "auto",
  summary: "Added rules for how AI search engines read pages.",
  evidence: [],
  admission: [],
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
  const btn = (text: string, scope: ParentNode = h!.container) => [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  async function click(el: Element | null | undefined) {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).click();
    });
    await h!.flush();
  }
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
      expect(head.textContent).toContain("built by Architect");
      expect(head.textContent).toContain("model: Auto");
      expect(head.textContent).toContain("read-only");
      expect(head.textContent).toContain("Technical SEO and visibility in AI search.");
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
      expect(d.projectName).toBe("manta");
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
    const pending = rec({ id: "p1", state: "pending", decidedAt: null, decidedBy: null, needsClick: true, reason: "ask", summary: "Adds an llms.txt check." });
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

    it("none when nothing is pending", async () => {
      await open();
      expect(q('[data-testid="profile-pending"]')).toBeNull();
    });
  });

  describe("tabs", () => {
    it("a tablist with counts; Overview selected, the other panels hidden; Tests is a disabled later tab", async () => {
      await open();
      const tabs = qa('[role="tab"]');
      expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Research · 5", "Seats · 2", "History · 2", "Tests — later"]);
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
      expect(tab("Research").getAttribute("aria-selected")).toBe("false");
      expect(panel("Overview").hidden).toBe(false);
      expect(panel("Research").hidden).toBe(true);
      expect(panel("Seats").hidden).toBe(true);
      expect(panel("History").hidden).toBe(true);
      const tests = tab("Tests") as HTMLButtonElement;
      expect(tests.disabled).toBe(true);
      expect(tests.title).toBe("Trial runs on sample tasks come later");
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
      for (const t of qa('[role="tab"]').slice(0, 4)) expect(t.getAttribute("aria-controls")).toBeNull();
      expect(qa('[role="tabpanel"]')).toHaveLength(4);
    });
  });

  describe("Overview", () => {
    it("the charter: what it is for, not for, edits code or read-only, model; the instructions folded", async () => {
      await open();
      const charter = q('[data-testid="profile-charter"]')!;
      expect(charter.textContent).toContain("Technical SEO and visibility in AI search.");
      expect(charter.textContent).toContain("A page's ranking or markup is the question");
      expect(charter.textContent).toContain("Writing brand copy");
      expect(charter.textContent).toContain("Read-only");
      const details = charter.querySelector("details")!;
      expect(details.textContent).toContain("Instructions");
      expect(details.textContent).toContain("Audit pages. Never publish.");
      expect(details.open).toBe(false);
    });

    it("research (first 4), history (first 3, read-only), seats, the first seat's memory map, Tests later", async () => {
      await open();
      const ov = panel("Overview");
      expect(ov.querySelectorAll('[data-testid="research-row"]')).toHaveLength(4);
      expect(ov.querySelectorAll('[data-testid="history-row"]')).toHaveLength(2);
      expect(ov.querySelectorAll('[data-testid="history-row"] button')).toHaveLength(0);
      expect(ov.textContent).toContain("Manta");
      expect(ov.querySelector('[data-testid="memory-map"]')?.textContent).toContain("Manta seat");
      expect(ov.textContent).toContain("Coming later");
    });

    it("'All research' and 'All history' and 'Manage seats' take you to the tab", async () => {
      await open();
      const ov = panel("Overview");
      await click(btn("All research (5)", ov));
      expect(tab("Research").getAttribute("aria-selected")).toBe("true");
      await click(tab("Overview"));
      await click(btn("All history (2)", ov));
      expect(tab("History").getAttribute("aria-selected")).toBe("true");
      await click(tab("Overview"));
      await click(btn("Manage seats", ov));
      expect(tab("Seats").getAttribute("aria-selected")).toBe("true");
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
    it("Research: every entry, with the library note", async () => {
      await open();
      const p = panel("Research");
      expect(p.querySelectorAll('[data-testid="research-row"]')).toHaveLength(5);
      expect(p.textContent).toContain("From the shared research library. Thin means fewer than 3 independent sources.");
      expect(p.textContent).toContain("no longer in the library");
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
      await click(btn("Remove", p));
      await click(btn("Remove seat", p));
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
      await click(btn("Restore before this", panel("History")));
      expect(api.calls.agentsChangeRestore).toEqual([[{ id: "c2" }]]);
      expect(api.calls.agentsProfile.length).toBeGreaterThan(before);
    });
  });
});
