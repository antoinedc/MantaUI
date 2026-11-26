// @vitest-environment jsdom
//
// The @ picker's agent rows (agent screens spec §2.3), through the real composer: colour badge, name, one-line description,
// a "seated here" / "adds to <Project>" pill for specialists and none for the Architect, seated-here agents first, and the
// footer hint. The chat's project is resolved from its folder against the registry's projects.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { resetPackageAgentsForTest } from "./packageAgents";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";

const base = { isolation: "none" as const, model: null, builtIn: false, useWhen: null, notFor: null, notice: null };
const AGENTS = [
  { ...base, slug: "sales", name: "Sales", description: "Finds leads", color: null, role: "specialist", seats: [] },
  { ...base, slug: "seo", name: "SEO", description: "Audits pages for search engines", color: "#336699", role: "specialist", seats: ["site-aaaaaaaaaa"] },
  { ...base, slug: "architect", name: "Architect", description: "Builds agents", color: null, role: "architect", builtIn: true },
];
const PROJECTS = [
  { slug: "site-aaaaaaaaaa", name: "Site" },
  { slug: "api-bbbbbbbbbb", name: "API" },
];

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
});
const ta = () => h!.container.querySelector("textarea") as HTMLTextAreaElement;

async function openPicker(cwd: string, extra: Record<string, unknown> = {}) {
  installMockApi({
    agentsList: () => Promise.resolve(AGENTS),
    agentsProjects: () => Promise.resolve(PROJECTS),
    opencodeModels: () => Promise.resolve([{ id: "m", providerID: "p", name: "M", limit: { context: 1000, output: 100 } }]),
    ...extra,
  });
  resetPackageAgentsForTest();
  resetStore();
  h = mount(<ChatPanel sessionId="ses_test" tmuxSession="proj" windowIndex={1} cwd={cwd} isActive={true} />);
  await h.flush();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(ta(), "@");
    ta().selectionStart = 1;
    ta().selectionEnd = 1;
    ta().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  await h.flush();
  await h.flush();
}
const agentRows = () => [...h!.container.querySelectorAll('[data-testid="agent-pick-row"]')] as HTMLElement[];

describe("@ picker — agent rows", () => {
  it("lists seated-here agents first, then the rest by name, each with a badge and its description", async () => {
    await openPicker("/home/dev/projects/site");
    expect(agentRows().map((r) => r.getAttribute("data-slug"))).toEqual(["seo", "architect", "sales"]);
    const seo = agentRows()[0];
    expect(seo.textContent).toContain("@seo");
    expect(seo.textContent).toContain("Audits pages for search engines");
    expect(seo.querySelector('[data-testid="agent-badge"]')).not.toBeNull();
  });

  it("a seated specialist reads 'seated here'; an unseated one reads 'adds to <Project>'", async () => {
    await openPicker("/home/dev/projects/site");
    const pill = (slug: string) => agentRows().find((r) => r.getAttribute("data-slug") === slug)!.querySelector('[data-testid="agent-pick-pill"]')?.textContent;
    expect(pill("seo")).toBe("seated here");
    expect(pill("sales")).toBe("adds to Site");
  });

  it("the Architect has no pill but stays in the list", async () => {
    await openPicker("/home/dev/projects/site");
    const arch = agentRows().find((r) => r.getAttribute("data-slug") === "architect")!;
    expect(arch).toBeTruthy();
    expect(arch.querySelector('[data-testid="agent-pick-pill"]')).toBeNull();
  });

  it("shows no pill when the chat's folder is no known project, and still lists the agents", async () => {
    await openPicker("/home/dev/projects/elsewhere");
    expect(agentRows()).toHaveLength(3);
    expect(h!.container.querySelectorAll('[data-testid="agent-pick-pill"]')).toHaveLength(0);
  });

  it("an older box without the projects channel still works (no pills)", async () => {
    await openPicker("/home/dev/projects/site", { agentsProjects: () => Promise.reject(new Error("unknown rpc channel: agents:projects")) });
    expect(agentRows()).toHaveLength(3);
    expect(h!.container.querySelectorAll('[data-testid="agent-pick-pill"]')).toHaveLength(0);
  });

  it("the popup says seated agents come first", async () => {
    await openPicker("/home/dev/projects/site");
    expect(h!.text()).toContain("Seated in this project first · ⏎ mention");
  });

  it("clicking a row still completes the mention", async () => {
    await openPicker("/home/dev/projects/site");
    await act(async () => {
      agentRows()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(ta().value).toBe("@seo ");
  });
});
