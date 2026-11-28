// @vitest-environment jsdom
//
// The profile's Overview (profile v5): the instructions as formatted text through the app's own Markdown renderer, and the Sections
// index beside them when there are 3 or more sections — it stays in view and marks the section being read (scroll-spy).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, resetStore, type Harness } from "../testHarness";
import { AgentOverview } from "./AgentOverview";
import { stripTitle } from "./agentsView";

const THREE = "You are Dev.\n\n## How you work\n\n- Start by reading the code.\n- **Always** write a test first.\n\n## Before you finish\n\nRun the checks.\n\n## Rules that are not negotiable\n\nNever merge.\n";
const TWO = "You are Dev.\n\n## How you work\n\nCarefully.\n\n## Gotchas\n\nNone.\n";

type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
let observers: Array<{ cb: Callback; targets: Element[] }> = [];
class FakeIO {
  entry: { cb: Callback; targets: Element[] };
  constructor(cb: Callback) {
    this.entry = { cb, targets: [] };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.push(el);
  }
  disconnect() {
    this.entry.targets = [];
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

describe("stripTitle", () => {
  it("drops a first line that is the agent's own name as a title — the page already has it", () => {
    expect(stripTitle("# Product Designer\n\nYou design.", "Product Designer")).toBe("You design.");
    expect(stripTitle("\n# product designer\nYou design.", "Product Designer")).toBe("You design.");
    expect(stripTitle("# Other title\n\nText", "Product Designer")).toBe("# Other title\n\nText");
    expect(stripTitle("Text\n# Product Designer\n", "Product Designer")).toBe("Text\n# Product Designer\n");
  });
});

describe("AgentOverview", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    resetStore();
    observers = [];
    vi.stubGlobal("IntersectionObserver", FakeIO);
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.unstubAllGlobals();
  });
  const open = async (instructions: string, name = "Dev") => {
    h = mount(<AgentOverview name={name} instructions={instructions} />);
    await h.flush();
  };
  const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...h!.container.querySelectorAll<HTMLElement>(sel)];

  it("renders the instructions as formatted text with the app's Markdown renderer, not as preformatted text", async () => {
    await open(THREE);
    const doc = q('[data-testid="profile-instructions"]')!;
    expect(doc.querySelector("pre")).toBeNull();
    expect(doc.querySelectorAll("h2")).toHaveLength(3);
    expect(doc.querySelectorAll("li")).toHaveLength(2);
    expect(doc.querySelector("strong")?.textContent).toBe("Always");
    expect(doc.textContent).not.toContain("##");
  });

  it("says so when the agent has no instructions", async () => {
    await open("   \n");
    expect(q('[data-testid="profile-instructions"]')).toBeNull();
    expect(h!.container.textContent).toContain("No instructions yet.");
  });

  it("shows the Sections index with 3 or more sections, each a link to a heading that has that id", async () => {
    await open(THREE);
    const nav = q('nav[aria-label="Sections of the instructions"]')!;
    expect(nav).toBeTruthy();
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["How you work", "Before you finish", "Rules that are not negotiable"]);
    for (const a of links) {
      const id = a.getAttribute("href")!.slice(1);
      expect(q(`h2[id="${id}"]`)).toBeTruthy();
    }
  });

  it("no Sections index with fewer than 3 sections", async () => {
    await open(TWO);
    expect(q('nav[aria-label="Sections of the instructions"]')).toBeNull();
  });

  it("clicking a section scrolls its heading into view, moves focus there and marks it as the current one", async () => {
    await open(THREE);
    const links = qa('nav[aria-label="Sections of the instructions"] a');
    await act(async () => links[1].click());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(links[1].getAttribute("aria-current")).toBe("true");
    expect(links[0].getAttribute("aria-current")).not.toBe("true");
    const id = links[1].getAttribute("href")!.slice(1);
    expect(document.activeElement?.id).toBe(id);
  });

  it("scroll-spy: the section whose heading reaches the top of the page becomes current; leaving it downward goes back to the one before", async () => {
    await open(THREE);
    const links = qa('nav[aria-label="Sections of the instructions"] a');
    expect(links[0].getAttribute("aria-current")).toBe("true"); // the first, before anything scrolled
    const heads = qa('[data-testid="profile-instructions"] h2');
    const spy = observers.find((o) => o.targets.length === 3)!;
    expect(spy).toBeTruthy();
    await act(async () => spy.cb([{ target: heads[2], isIntersecting: true, boundingClientRect: { top: 10 } as DOMRectReadOnly }]));
    expect(links[2].getAttribute("aria-current")).toBe("true");
    await act(async () => spy.cb([{ target: heads[2], isIntersecting: false, boundingClientRect: { top: 500 } as DOMRectReadOnly }]));
    expect(links[1].getAttribute("aria-current")).toBe("true");
  });

  it("the index is a sticky column that a narrow page drops (a container query, not the window's width)", async () => {
    await open(THREE);
    const nav = q('nav[aria-label="Sections of the instructions"]')!;
    expect(nav.className).toContain("sticky");
    expect(nav.className).toContain("hidden");
    expect(nav.className).toMatch(/@container\(min-width:/);
  });
});
