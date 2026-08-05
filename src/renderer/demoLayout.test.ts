// demoLayout.test.ts — pins the demo-mode fixture-state selector.

import { describe, it, expect } from "vitest";
import { pickDemoState, DEMO_STATES, type DemoState } from "./demoLayout";

describe("pickDemoState — single URL selector for fixture states", () => {
  it("resolves each DEMO_STATES member by name", () => {
    for (const state of DEMO_STATES) {
      expect(pickDemoState(new URLSearchParams(`demo&state=${state}`))).toBe(state);
    }
  });

  it("defaults to the full fixture when state is absent", () => {
    expect(pickDemoState(new URLSearchParams(""))).toBe("full");
    expect(pickDemoState(new URLSearchParams("demo&desktop"))).toBe("full");
  });

  it("falls back to full when state is an unknown value (typo-safe)", () => {
    expect(pickDemoState(new URLSearchParams("demo&state=bogus"))).toBe("full");
    expect(pickDemoState(new URLSearchParams("demo&state=empty-ish"))).toBe("full");
    expect(pickDemoState(new URLSearchParams("demo&state="))).toBe("full");
  });
});

describe("pickDemoState — every member is a valid DemoState", () => {
  it("DEMO_STATES is exactly the set of DemoState values", () => {
    const states: readonly DemoState[] = DEMO_STATES;
    expect(states).toEqual([
      "full",
      "empty",
      "version-skew",
      "reconnecting",
      "incompatible",
      "update-failed",
      "server-update",
      "stream",
      "artifacts",
    ]);
  });
});
