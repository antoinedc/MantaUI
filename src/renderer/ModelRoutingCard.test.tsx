// @vitest-environment jsdom
//
// ModelRoutingCard — the Routing card in Settings → Models (BET-1222). Tiers
// must be read from the router module (never a literal), plan usage comes from
// the shared store (the same source the composer dial uses), and the card must
// stay visible — greyed — when routing is off.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ModelRoutingCard } from "./ModelRoutingCard";
import { useStore } from "./store";
import { AGENT_TIER } from "../shared/modelRouter.mjs";
import type { UsageSnapshot } from "../shared/types";

const SUB_LABELS = [
  "main conversation · switches at session start, never mid-task",
  "file search & codebase questions · fresh context",
  "multi-step research · fresh context",
  "reasoning-heavy, low token volume",
];

function snapshot(windows: UsageSnapshot["windows"], provider = "claude"): UsageSnapshot[] {
  return [
    {
      provider,
      providerIDs: ["anthropic"],
      planLabel: "Max 20x",
      windows,
      fetchedAt: Date.now(),
    },
  ];
}

describe("ModelRoutingCard", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    useStore.setState({ usage: [], modelRouting: { enabled: true, preset: "balanced" } });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function render() {
    h?.unmount();
    h = mount(<ModelRoutingCard />);
    return h;
  }

  it("renders the four agent rows in order with the exact sub-label copy", () => {
    const c = render();
    const text = c.text();
    for (const sub of SUB_LABELS) {
      expect(text).toContain(sub);
    }
    // Fixed display order: build, explore, general, plan.
    const indexes = ["build", "explore", "general", "plan"].map((agent) => text.indexOf(agent));
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });

  it("renders the warn-toned chip naming the provider when a window is at 89%", () => {
    useStore.setState({ usage: snapshot([{ kind: "session", label: "5h", pct: 89 }]) });
    const c = render();
    expect(c.text()).toContain("Claude 5h is nearly spent");
    // The warn chip carries the warn re-face; the neutral inset chip does not.
    expect(c.html()).toContain("border-warn bg-warn-bg");
  });

  it("renders the 'Routing is off' chip and keeps the card present when disabled", () => {
    useStore.setState({ modelRouting: { enabled: false, preset: "balanced" } });
    const c = render();
    expect(c.text()).toContain("Routing is off — you choose the model.");
    // Card still present (the whole point) — agent rows still render, greyed.
    expect(c.text()).toContain("build");
    expect(c.html()).toContain("opacity-60");
  });

  it("shows tiers matching AGENT_TIER imported from modelRouter.mjs", () => {
    useStore.setState({ modelRouting: { enabled: true, preset: "balanced" } });
    const c = render();
    const text = c.text();
    // Assert against the module import, never a literal — so the card and the
    // router cannot drift. For the balanced preset every effective tier equals
    // AGENT_TIER.balanced[agent] (all already at or above their floor).
    for (const agent of ["build", "explore", "general", "plan"] as const) {
      const tier = AGENT_TIER.balanced[agent];
      expect(text).toContain(`${tier} · auto`);
    }
  });
});
