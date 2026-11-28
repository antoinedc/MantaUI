// @vitest-environment jsdom
//
// The profile's Research tab (proposal A): every library entry the agent relies on as a hairline row — topic, sources, age,
// fresh / stale / thin — each expandable to its sources, the library's own one-liner and the stale / thin counts in the pane
// beside it, and the refresh control (which lives here too).

import { describe, expect, it } from "vitest";
import type { AgentInfo, AgentProfile, AgentResearchEntry } from "../../shared/types";
import { installMockApi, mount, type Harness, type MockApi } from "../testHarness";
import { AgentResearch } from "./AgentResearch";
import { buttonIn, clickEl, useHarnessLifecycle } from "./agentsTestFixtures";

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({ slug: "seo", name: "SEO", description: "d", isolation: "none", model: null, color: null, builtIn: false, role: "specialist", useWhen: null, notFor: null, notice: null, ...over });
const entry = (over: Partial<AgentResearchEntry> = {}): AgentResearchEntry => ({ id: "r1", topic: "Technical SEO for AI search", sourceCount: 5, ageDays: 3, status: "fresh", thin: false, ...over });

const SOURCES = [
  { label: "developers.google.com", url: "https://developers.google.com/search/docs/ai" },
  { label: "OpenAI", url: "https://openai.com/search" },
  { label: "No link publisher", url: null },
];

const profile = (research: AgentResearchEntry[], over: Partial<AgentProfile> = {}): AgentProfile => ({
  info: info(),
  seats: [],
  lastChangedAt: null,
  builtBy: "architect",
  refresh: { enabled: true, routineId: "rt1" },
  research,
  ...over,
});

describe("AgentResearch", () => {
  let h: Harness | null = null;
  let api: MockApi;
  const { onChanged, take } = useHarnessLifecycle();

  async function open(p: AgentProfile, overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi(overrides));
    h = take(mount(<AgentResearch profile={p} onChanged={onChanged} />));
    await h.flush();
  }
  const rows = () => [...h!.container.querySelectorAll<HTMLElement>('[data-testid="research-entry"]')];
  const pane = () => h!.container.querySelector<HTMLElement>('[data-testid="profile-pane"]')!;
  const btn = (scope: ParentNode, text: string) => buttonIn(scope, text, true);
  const click = (el: Element | null | undefined) => clickEl(h!, el);

  it("one column: the entries under a plain title, the tab's own note under them (no side pane)", async () => {
    await open(profile([entry()]));
    const main = h!.container.querySelector('[data-testid="profile-main"]')!;
    expect(main.querySelector("h3")!.textContent).toBe("Research it relies on");
    expect(main.querySelector("h3")!.className).not.toContain("uppercase");
    expect(pane().tagName).toBe("ASIDE");
    expect(pane().className).not.toContain("bg-bg-elev");
    expect(main.contains(pane())).toBe(false);
    expect(main.compareDocumentPosition(pane()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a row: topic, 'N sources · N days old', fresh / stale, and thin in the warn tone", async () => {
    await open(profile([entry(), entry({ id: "r2", topic: "AI crawler access rules", status: "stale", ageDays: 41, sourceCount: 4 }), entry({ id: "r3", topic: "llms.txt adoption", thin: true, sourceCount: 2, ageDays: 6 })]));
    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain("Technical SEO for AI search");
    expect(rows()[0].textContent).toContain("5 sources · 3 days old");
    expect(rows()[0].textContent).toContain("fresh");
    expect(rows()[1].textContent).toContain("41 days old");
    expect(rows()[1].textContent).toContain("stale");
    const thin = [...rows()[2].querySelectorAll("span")].find((e) => e.textContent === "thin")!;
    expect(thin.className).toContain("bg-warn-bg");
    expect(thin.className).not.toContain("border");
  });

  it("an entry with sources opens to them: each a link to the page, the first row open at the start", async () => {
    await open(profile([entry({ sources: SOURCES }), entry({ id: "r2", topic: "Second", sources: SOURCES.slice(0, 1) })]));
    const [first, second] = rows().map((r) => r.querySelector<HTMLDetailsElement>("details")!);
    expect(first.open).toBe(true);
    expect(second.open).toBe(false);
    const links = [...first.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["developers.google.com", "OpenAI"]);
    expect(links[0].getAttribute("href")).toBe("https://developers.google.com/search/docs/ai");
    expect(first.textContent).toContain("No link publisher"); // a source with no safe link is named, not linked
    expect(first.querySelectorAll("a")).toHaveLength(2);
  });

  it("a source link opens through the app and says so when it can't", async () => {
    await open(profile([entry({ sources: SOURCES })]), { openExternal: () => Promise.resolve() });
    await click(rows()[0].querySelector("a"));
    expect(api.calls.openExternal).toEqual([["https://developers.google.com/search/docs/ai"]]);
    h!.unmount();
    await open(profile([entry({ sources: SOURCES })]), { openExternal: () => Promise.reject(new Error("no browser")) });
    await click(rows()[0].querySelector("a"));
    expect(rows()[0].querySelector('[role="alert"]')?.textContent).toContain("Couldn't open the link");
  });

  it("private sources are counted, never listed; 'also used by' names the other agents", async () => {
    await open(profile([entry({ sources: SOURCES.slice(0, 1), privateSources: 2, usedBy: ["Conversion", "Security"] })]));
    const body = rows()[0].textContent ?? "";
    expect(body).toContain("2 private sources aren't listed");
    expect(body).toContain("Also used by Conversion, Security");
    h!.unmount();
    await open(profile([entry({ sources: SOURCES.slice(0, 1), privateSources: 1 })]));
    expect(rows()[0].textContent).toContain("1 private source isn't listed");
  });

  it("an entry the box sent no sources for is a plain row with its counts: nothing to expand", async () => {
    await open(profile([entry()]));
    expect(rows()[0].querySelector("details")).toBeNull();
    expect(rows()[0].textContent).toContain("5 sources");
  });

  it("a missing entry says it is no longer in the library, with no freshness claim", async () => {
    await open(profile([entry({ status: "missing", sourceCount: null, ageDays: null })]));
    expect(rows()[0].textContent).toContain("no longer in the library");
    expect(rows()[0].textContent).not.toContain("fresh");
  });

  it("with nothing yet, says so — the pane is still there", async () => {
    await open(profile([]));
    expect(h!.container.querySelector('[data-testid="research-empty"]')?.textContent).toContain("Nothing yet");
    expect(pane()).toBeTruthy();
  });

  it("the pane: one line on what the library is, and how many entries are stale and thin", async () => {
    await open(profile([entry(), entry({ id: "r2", status: "stale" }), entry({ id: "r3", thin: true }), entry({ id: "r4", status: "stale", thin: true })]));
    const about = pane().querySelector('[data-testid="research-about"]')!;
    expect(about.textContent).toContain("shared by every agent");
    expect(about.textContent).toContain("thin means fewer than 3 independent sources");
    const health = [...pane().querySelectorAll('[data-testid="research-health"] dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(health).toEqual([["Stale", "2"], ["Thin", "2"]]);
    expect(pane().textContent).not.toContain("Next refresh"); // the box doesn't say when
  });

  it("a missing entry gets its own count only when there is one", async () => {
    await open(profile([entry({ status: "missing", sourceCount: null, ageDays: null })]));
    expect([...pane().querySelectorAll('[data-testid="research-health"] dt')].map((d) => d.textContent)).toEqual(["Stale", "Thin", "Missing"]);
  });

  it("the refresh control lives here: Monthly by default, Off after the toggle; no help text on this tab", async () => {
    await open(profile([entry()]), { agentsRefreshSet: () => Promise.resolve({ enabled: false, routineId: "rt1" }) });
    const group = pane().querySelector<HTMLElement>('[role="group"][aria-label="Refresh with new research"]')!;
    expect(btn(group, "Monthly")?.getAttribute("aria-pressed")).toBe("true");
    expect(pane().textContent).not.toContain("Once a month");
    await click(btn(group, "Off"));
    expect(api.calls.agentsRefreshSet).toEqual([[{ slug: "seo", enabled: false }]]);
    expect(btn(group, "Off")?.getAttribute("aria-pressed")).toBe("true");
    expect(onChanged).toHaveBeenCalled();
  });

  it("the lead and the Architect have no refresh control", async () => {
    await open(profile([entry()], { info: info({ role: "architect" }) }));
    expect(pane().querySelector('[role="group"]')).toBeNull();
  });
});
