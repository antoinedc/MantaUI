import { describe, it, expect } from "vitest";
import { BOUNDARY, crossesBoundary, shouldSwitch, boundaryPhrase } from "./routingBoundary.mjs";

// A routed endpoint with a distinct (providerID/id) identity, like the router's.
function ep(providerID: string, id: string) {
  return { providerID, id };
}

const followUp = {
  hasRoutedModel: true,
  agent: "general",
  previousAgent: "general",
  contextTokens: 1000,
  incumbentContextLimit: 40000,
  requiredModalities: ["text"],
  incumbentModalities: ["text", "image"],
  incumbentHealthy: true,
  justCompacted: false,
  userRequested: false,
};

describe("crossesBoundary — each boundary in isolation", () => {
  it("FIRST_TURN when there is no routed model yet", () => {
    expect(crossesBoundary({ ...followUp, hasRoutedModel: false })).toEqual({
      crossed: true,
      boundary: BOUNDARY.FIRST_TURN,
    });
  });

  it("AGENT when the agent changed (plan -> build)", () => {
    expect(
      crossesBoundary({ ...followUp, agent: "build", previousAgent: "plan" }),
    ).toEqual({ crossed: true, boundary: BOUNDARY.AGENT });
  });

  it("CONSTRAINT when context outgrew the incumbent's limit", () => {
    expect(
      crossesBoundary({ ...followUp, contextTokens: 41000, incumbentContextLimit: 40000 }),
    ).toEqual({ crossed: true, boundary: BOUNDARY.CONSTRAINT });
  });

  it("CONSTRAINT when a required modality is missing", () => {
    expect(
      crossesBoundary({
        ...followUp,
        requiredModalities: ["image", "pdf"],
        incumbentModalities: ["text", "image"],
      }),
    ).toEqual({ crossed: true, boundary: BOUNDARY.CONSTRAINT });
  });

  it("CONSTRAINT when the incumbent provider is unhealthy", () => {
    expect(crossesBoundary({ ...followUp, incumbentHealthy: false })).toEqual({
      crossed: true,
      boundary: BOUNDARY.CONSTRAINT,
    });
  });

  it("COMPACTED when the cache is gone anyway", () => {
    expect(crossesBoundary({ ...followUp, justCompacted: true })).toEqual({
      crossed: true,
      boundary: BOUNDARY.COMPACTED,
    });
  });

  it("USER when the user re-picked Auto", () => {
    expect(crossesBoundary({ ...followUp, userRequested: true })).toEqual({
      crossed: true,
      boundary: BOUNDARY.USER,
    });
  });
});

describe("crossesBoundary — no boundary", () => {
  it("returns crossed:false for an ordinary follow-up turn", () => {
    expect(crossesBoundary(followUp)).toEqual({ crossed: false, boundary: null });
  });

  it("drifting numbers alone never cross a boundary (context growing under the limit)", () => {
    expect(
      crossesBoundary({ ...followUp, contextTokens: 25000 }),
    ).toEqual({ crossed: false, boundary: null });
    expect(
      crossesBoundary({
        ...followUp,
        contextTokens: 1,
        incumbentContextLimit: 1,
      }),
    ).toEqual({ crossed: false, boundary: null });
  });

  it("precedence: FIRST_TURN beats every later boundary", () => {
    expect(
      crossesBoundary({
        ...followUp,
        hasRoutedModel: false,
        agent: "build",
        previousAgent: "plan",
        justCompacted: true,
        userRequested: true,
      }),
    ).toEqual({ crossed: true, boundary: BOUNDARY.FIRST_TURN });
  });

  it("precedence: AGENT beats CONSTRAINT/COMPACTED/USER", () => {
    expect(
      crossesBoundary({
        ...followUp,
        agent: "plan",
        previousAgent: "build",
        incumbentHealthy: false,
        justCompacted: true,
      }),
    ).toEqual({ crossed: true, boundary: BOUNDARY.AGENT });
  });
});

describe("shouldSwitch — hysteresis", () => {
  const base = {
    incumbent: ep("anthropic", "a"),
    ranked: [ep("anthropic", "a"), ep("openai", "b"), ep("deepseek", "c")],
    incumbentStillEligible: true,
    incumbentStillCapable: true,
    incumbentHealthy: true,
  };

  it("keeps the incumbent when a rival is marginally ahead but it is still in the top N", () => {
    // incumbent still #1 in ranked; nothing about anything else matters
    expect(shouldSwitch(base)).toEqual({ switch: false, why: "incumbent-retained" });
  });

  it("keeps the incumbent at position N (contention boundary), even when beaten", () => {
    // topN=3: positions 0,1,2 (i.e. 1st..3rd) keep the incumbent. Put it 3rd.
    expect(
      shouldSwitch({
        ...base,
        topN: 3,
        ranked: [ep("openai", "b"), ep("deepseek", "c"), ep("anthropic", "a")],
      }),
    ).toEqual({ switch: false, why: "incumbent-retained" });
  });

  it("switches when the incumbent is at position N+1 (outside the contention window)", () => {
    expect(
      shouldSwitch({
        ...base,
        topN: 3,
        ranked: [ep("openai", "b"), ep("deepseek", "c"), ep("groq", "d"), ep("anthropic", "a")],
      }),
    ).toEqual({ switch: true, why: "incumbent-dropped-out" });
  });

  it("switches when the incumbent is absent from ranked entirely", () => {
    expect(
      shouldSwitch({
        ...base,
        ranked: [ep("openai", "b"), ep("deepseek", "c"), ep("groq", "d")],
      }),
    ).toEqual({ switch: true, why: "incumbent-dropped-out" });
  });

  it("switches, incumbent-ineligible, when Auto can no longer describe it", () => {
    expect(shouldSwitch({ ...base, incumbentStillEligible: false })).toEqual({
      switch: true,
      why: "incumbent-ineligible",
    });
  });

  it("switches, incumbent-incapable, when it no longer fits the turn", () => {
    expect(shouldSwitch({ ...base, incumbentStillCapable: false })).toEqual({
      switch: true,
      why: "incumbent-incapable",
    });
  });

  it("switches, incumbent-unhealthy, when its provider went away", () => {
    expect(shouldSwitch({ ...base, incumbentHealthy: false })).toEqual({
      switch: true,
      why: "incumbent-unhealthy",
    });
  });

  it("topN defaults to 3", () => {
    const n4 = [ep("a", "1"), ep("a", "2"), ep("a", "3"), ep("a", "4")];
    // default topN=3: position 3 (4th, 0-based index 3) is outside → switch
    expect(
      shouldSwitch({ ...base, ranked: [...n4.slice(0, 3), ep("anthropic", "a")] }),
    ).toEqual({ switch: true, why: "incumbent-dropped-out" });
  });
});

describe("boundaryPhrase", () => {
  it("returns a phrase per boundary kind", () => {
    expect(boundaryPhrase(BOUNDARY.FIRST_TURN)).toBe("first turn");
    expect(boundaryPhrase(BOUNDARY.AGENT)).toBe("agent changed");
    expect(boundaryPhrase(BOUNDARY.CONSTRAINT)).toBe("context or capability");
    expect(boundaryPhrase(BOUNDARY.COMPACTED)).toBe("just compacted");
    expect(boundaryPhrase(BOUNDARY.USER)).toBe("Auto re-selected");
  });

  it("returns an empty string for an unknown / null boundary (never throws)", () => {
    expect(boundaryPhrase(null)).toBe("");
    expect(boundaryPhrase("nope")).toBe("");
  });
});
