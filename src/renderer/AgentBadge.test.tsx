// @vitest-environment jsdom
//
// The agent's colour badge: initial on the agent's own colour, in whichever ink reads on it.

import { afterEach, describe, expect, it } from "vitest";
import { AgentBadge } from "./AgentBadge";
import { AGENT_INK_DARK, AGENT_INK_LIGHT } from "./agentInk";
import { mount, type Harness } from "./testHarness";

describe("AgentBadge", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });
  // jsdom writes a colour back in its rgb() form
  const norm = (c: string) => {
    const el = document.createElement("span");
    el.style.color = c;
    return el.style.color;
  };
  const badge = () => h!.container.querySelector<HTMLElement>('[data-testid="agent-badge"]')!;

  it("draws the initial in dark ink on a mid-light colour and in white on a deep one", () => {
    h = mount(<AgentBadge agent={{ name: "SEO", slug: "seo", color: "oklch(62% 0.14 160)" }} />);
    expect(badge().textContent).toBe("S");
    expect(badge().style.color).toBe(norm(AGENT_INK_DARK));
    h.unmount();
    h = mount(<AgentBadge agent={{ name: "Dev", slug: "dev", color: "#1f2a5a" }} />);
    expect(badge().style.color).toBe(norm(AGENT_INK_LIGHT));
  });

  it("the profile's large badge sets its initial at 15px (the mockup's), the small ones at 11px", () => {
    h = mount(<AgentBadge size="lg" agent={{ name: "SEO", slug: "seo", color: "#16a36b" }} />);
    expect(badge().className).toContain("text-prose");
    expect(badge().className).not.toContain("text-micro");
    h.unmount();
    h = mount(<AgentBadge size="md" agent={{ name: "SEO", slug: "seo", color: "#16a36b" }} />);
    expect(badge().className).toContain("text-micro");
  });

  it("without a colour, keeps the neutral fill and the theme's text", () => {
    h = mount(<AgentBadge agent={{ name: "Manta", slug: "manta", color: null }} />);
    expect(badge().className).toContain("bg-fill-hover");
    expect(badge().className).toContain("text-text");
    expect(badge().style.color).toBe("");
  });

  it("an unreadable colour keeps the theme's own ink", () => {
    h = mount(<AgentBadge agent={{ name: "X", slug: "x", color: "var(--nope)" }} />);
    expect(badge().className).toContain("text-on-accent");
    expect(badge().style.color).toBe("");
  });
});
