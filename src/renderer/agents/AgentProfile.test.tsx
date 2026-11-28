// @vitest-environment jsdom
//
// The agent profile (profile v5): header with "Use it when / Not for" above the tabs, one Chat button, tabs Overview · Skills · Seats ·
// Learned · History · Research · Settings, no side column and no pending-change card, and its loading / error / invalid / lead /
// Architect states.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { AgentChange, AgentFleet, AgentInfo, AgentProfile as Profile } from "../../shared/types";
import { resetPackageAgentsForTest } from "../packageAgents";
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

const INSTRUCTIONS = "You are SEO.\n\n## How you work\n\n- Audit pages.\n- Never publish.\n\n## Before you finish\n\nSay what you found.\n\n## Gotchas\n\nNone.\n";

const rec = (over: Partial<AgentChange> = {}): AgentChange =>
  changeRecord({
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
  refresh: { enabled: true, routineId: "rt1", day: 12 },
  instructions: INSTRUCTIONS,
  research: [
    { id: "r1", topic: "Technical SEO for AI search", sourceCount: 5, ageDays: 3, status: "fresh", thin: false },
    { id: "r2", topic: "llms.txt adoption", sourceCount: 2, ageDays: 6, status: "fresh", thin: true },
  ],
  ...over,
});

const HISTORY = [rec({ id: "c2", before: "V1", after: "V2" }), rec({ id: "c1", kind: "create", before: null, after: "V1", createdAt: NOW - 9 * DAY, decidedAt: NOW - 9 * DAY, summary: "Created @seo." })];

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
      agentsApprovedModels: () => Promise.resolve([]),
      agentsAutonomyGet: () => Promise.resolve({ mode: "balanced", overrides: {}, effective: { learn_preference: "tell" } }),
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
    it("breadcrumbs, name, description", async () => {
      await open();
      const crumbs = q('[data-testid="agents-crumbs"]')!;
      expect(crumbs.textContent).toBe("AgentsSEO");
      await click(btn("Agents", crumbs));
      expect(onBack).toHaveBeenCalled();
      const head = q('[data-testid="profile-header"]')!;
      expect(head.querySelector("h1")?.textContent).toBe("SEO");
      expect(head.textContent).toContain("Technical SEO and visibility in AI search.");
    });

    it("the facts line is who it is and how it works: @slug, role, what it does to code, its model", async () => {
      await open();
      expect([...q('[data-testid="profile-facts"]')!.querySelectorAll("span")].map((x) => x.textContent)).toEqual(["@seo", "Specialist", "Read-only", "Auto"]);
    });

    it("'Use it when' and 'Not for' sit above the tabs, in the header's own block", async () => {
      await open();
      const block = q('[data-testid="profile-howto"]')!;
      expect(block.textContent).toContain("Use it when");
      expect(block.textContent).toContain("A page's ranking or markup is the question");
      expect(block.textContent).toContain("Not for");
      expect(block.textContent).toContain("Writing brand copy");
      expect(block.compareDocumentPosition(q('[role="tablist"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("an agent with neither line says where to write them", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ useWhen: null, notFor: null }) })) });
      expect(q('[data-testid="profile-howto"]')!.textContent).toContain("Nothing written yet. Add it in Settings.");
    });

    it("there is ONE button for the conversation, Chat — no 'Change via Manta', no 'Mention in a chat'", async () => {
      await open();
      const head = q('[data-testid="profile-header"]')!;
      expect([...head.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Chat"]);
      expect(h!.container.textContent).not.toMatch(/Change via Manta|Mention in a chat/);
    });

    it("Chat opens the agent's one conversation; a refusal says why on the page", async () => {
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

    it("the Architect has no Chat button: it says it works through Manta, and has no Seats tab", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ info: info({ slug: "architect", name: "Architect", role: "architect" }), seats: [] })) }, "architect");
      expect(btn("Chat")).toBeUndefined();
      expect(q('[data-testid="profile-header"]')!.textContent).toContain("Works through Manta: ask in any chat.");
      expect(qa('[role="tab"]').map((t) => t.textContent)).not.toContain("Seats");
      expect(qa('[role="tab"]').some((t) => (t.textContent ?? "").startsWith("Seats"))).toBe(false);
    });
  });

  describe("no side column and no pending card", () => {
    it("nothing pending is shown on the page, wherever the record sits; no side pane anywhere", async () => {
      const pending = rec({ id: "p1", state: "pending", decidedAt: null, decidedBy: null, needsClick: true, reason: "ask", summary: "Adds an llms.txt check." });
      await open({ agentsHistory: () => Promise.resolve([pending, ...HISTORY]) });
      expect(q('[data-testid="profile-pending"]')).toBeNull();
      expect(q('[data-testid="agent-change-card"]')).toBeNull();
      expect(h!.container.textContent).not.toContain("Adds an llms.txt check.");
      expect(panel("Overview").querySelector('[data-testid="profile-pane"]')).toBeNull(); // the other tabs keep their own note under the content, never beside it
      expect(q('[data-testid="profile-details"]')).toBeNull();
      expect(q('[data-testid="profile-grid"]')).toBeNull();
    });

    it("access shows in Seats only", async () => {
      await open();
      expect(panel("Overview").textContent).not.toMatch(/Manta memory|read \+ write/);
      expect(panel("Seats").textContent).toMatch(/Manta memory/);
    });
  });

  describe("tabs", () => {
    it("Overview · Skills · Seats · Learned · History · Research · Settings, with counts; Overview selected, the other panels hidden", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ learned: [], skills: [{ name: "audit", description: "d", files: 1, bytes: 10, provenance: null }] })) });
      expect(qa('[role="tab"]').map((t) => t.textContent)).toEqual(["Overview", "Skills 1", "Seats 2", "Learned", "History 2", "Research 2", "Settings"]);
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
      for (const n of ["Skills", "Seats", "Learned", "History", "Research", "Settings"]) expect(panel(n).hidden).toBe(true);
      expect(panel("Overview").hidden).toBe(false);
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
      expect(tab("Skills").getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tab("Skills"));
      await key(tab("Skills"), "End");
      expect(tab("Settings").getAttribute("aria-selected")).toBe("true");
      await key(tab("Settings"), "ArrowRight");
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
      await key(tab("Overview"), "ArrowLeft");
      expect(tab("Settings").getAttribute("aria-selected")).toBe("true");
      await key(tab("Settings"), "Home");
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    });

    it("another agent starts from its Overview", async () => {
      await open();
      await click(tab("History"));
      h!.unmount();
      await open();
      expect(tab("Overview").getAttribute("aria-selected")).toBe("true");
    });
  });

  describe("Overview", () => {
    it("the instructions, formatted, with the Sections index; nothing else (no research block, no details)", async () => {
      await open();
      const doc = q('[data-testid="profile-instructions"]')!;
      expect(doc.closest('[role="tabpanel"]')).toBe(panel("Overview"));
      expect(doc.querySelectorAll("h2")).toHaveLength(3);
      expect(doc.querySelector("pre")).toBeNull();
      expect(q('nav[aria-label="Sections of the instructions"]')).toBeTruthy();
      expect(panel("Overview").textContent).not.toMatch(/Research it relies on|Full instructions/);
    });
  });

  describe("Skills", () => {
    it("lists the agent's skills with name, description, files, where each came from, its licence and installs; an origin link opens through the app", async () => {
      const prov = { url: "https://github.com/acme/cro/blob/abc123/landing-audit/SKILL.md", sourceId: "src_1", repo: "acme/cro", ref: "abc123", licence: "MIT", taken: "whole" as const, registry: { installs: 12500, stars: 41100 } };
      await open({
        agentsProfile: () =>
          Promise.resolve(
            profile({
              skills: [
                { name: "landing-audit", description: "Audits a landing page.", files: 4, bytes: 1536, provenance: prov },
                { name: "own-notes", description: "", files: 1, bytes: 90, provenance: null },
              ],
            }),
          ),
        openExternal: () => Promise.reject(new Error("no browser")),
      });
      await click(tab("Skills"));
      const rows = [...panel("Skills").querySelectorAll<HTMLElement>('[data-testid="profile-skill"]')];
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain("landing-audit");
      expect(rows[0].textContent).toContain("Audits a landing page.");
      expect(rows[0].textContent).toContain("Copied from acme/cro · MIT · 12,500 installs · 41,100 stars");
      expect(rows[0].textContent).toContain("4 files · 1.5 KB");
      expect(rows[1].textContent).toContain("Written for this agent");
      const link = rows[0].querySelector("a") as HTMLAnchorElement;
      expect(link.href).toBe(prov.url);
      await click(link);
      expect(api.calls.openExternal).toEqual([[prov.url]]);
      expect(q('[data-testid="profile-skill-link-error"]')!.textContent).toMatch(/Couldn't open the link/);
    });

    it("no skills: an empty state that says what a skill is and where one will show", async () => {
      await open();
      await click(tab("Skills"));
      expect(q('[data-testid="skills-empty"]')!.textContent).toContain("No skills yet. When a proven skill fits SEO's job, the Architect proposes it; you'll find it in Needs you, then here.");
      expect(panel("Skills").textContent).toContain("A skill is a method file, checklist or script the agent reads only when its task needs it.");
    });
  });

  describe("other tabs", () => {
    it("Seats, Research, Learned and History are the agent's own, in their tab", async () => {
      await open({ agentsProfile: () => Promise.resolve(profile({ learned: [] })) });
      expect(panel("Seats").textContent).toContain("Manta");
      expect(panel("Research").textContent).toContain("Technical SEO for AI search");
      expect(panel("Learned").textContent).toContain("Nothing learned yet");
      expect(panel("History").textContent).toContain("Added rules for how AI search engines read pages.");
    });

    it("History lists only what went live: a pending change isn't there", async () => {
      const pending = rec({ id: "p1", state: "pending", decidedAt: null, needsClick: true, reason: "ask", summary: "Adds an llms.txt check." });
      await open({ agentsHistory: () => Promise.resolve([pending, ...HISTORY]) });
      expect(panel("History").textContent).not.toContain("Adds an llms.txt check.");
      expect(panel("History").querySelectorAll('[data-testid="history-row"]')).toHaveLength(2);
    });

    it("Settings: a field saves on blur and the page reads the agent again", async () => {
      await open({ agentsSettingsSet: () => Promise.resolve({ outcome: "saved", change: rec({ id: "ach_9", origin: { kind: "settings", field: "name" }, decidedBy: "click" }) }) });
      await click(tab("Settings"));
      const input = panel("Settings").querySelector<HTMLInputElement>('[data-testid="settings-field-name"] input')!;
      expect(input.value).toBe("SEO");
      const reads = (api.calls.agentsProfile ?? []).length;
      await act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "SEO Pro");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input.blur();
      });
      await h!.flush();
      expect(api.calls.agentsSettingsSet).toEqual([[{ slug: "seo", field: "name", value: "SEO Pro" }]]);
      expect((api.calls.agentsProfile ?? []).length).toBeGreaterThan(reads);
      expect((api.calls.agentsHistory ?? []).length).toBeGreaterThan(1);
    });
  });
});
