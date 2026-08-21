import { describe, it, expect } from "vitest";
import { BOUNDARY, crossesBoundary, shouldSwitch, boundaryPhrase } from "./routingBoundary.mjs";
import { endpointKey } from "./endpointKey.mjs";
// @ts-expect-error — server module has no .d.mts; toDeliverModel is the RPC
// boundary normaliser whose OUTPUT shape is exactly what the renderer hands
// shouldSwitch on both sides (the bug this file pins).
import { toDeliverModel } from "../server/delegate.mjs";

/**
 * A routed endpoint in the shape PRODUCTION actually produces across the RPC
 * boundary: `{providerID, modelID}` (see toDeliverModel). NOT the router's
 * catalogue shape — building fixtures by hand in the router shape is how this
 * file's 26 cases all passed against a function production never calls.
 */
function ep(providerID: string, id: string): { providerID: string; modelID: string } {
  const out = toDeliverModel({ providerID, id });
  if (!out) throw new Error("toDeliverModel returned null for a well-formed endpoint");
  return out;
}

// An incumbent endpoint in the model shape crossesBoundary now reads for its
// declared modalities (via acceptsModality) — { capabilities.input } like an
// OpencodeModel — NOT a pre-computed array. Unknown input ([]) = allow.
function incumbentModel(input: string[]): object {
  return { capabilities: { input } };
}

const followUp = {
  hasRoutedModel: true,
  agent: "general",
  previousAgent: "general",
  contextTokens: 1000,
  incumbentContextLimit: 40000,
  requiredModalities: ["text"],
  incumbentModel: incumbentModel(["text", "image"]),
  incumbentHealthy: true,
  justCompacted: false,
  userRequested: false,
};

describe("crossesBoundary — each boundary in isolation", () => {
  it("FIRST_TURN when there is no routed model yet", () => {
    expect(crossesBoundary({ ...followUp, hasRoutedModel: false })).toMatchObject({
      crossed: true,
      boundary: BOUNDARY.FIRST_TURN,
    });
  });

  it("AGENT when the agent changed (plan -> build)", () => {
    expect(
      crossesBoundary({ ...followUp, agent: "build", previousAgent: "plan" }),
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.AGENT });
  });

  it("CONSTRAINT when context outgrew the incumbent's limit", () => {
    expect(
      crossesBoundary({ ...followUp, contextTokens: 41000, incumbentContextLimit: 40000 }),
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.CONSTRAINT });
  });

  it("CONSTRAINT when a required modality is missing", () => {
    expect(
      crossesBoundary({
        ...followUp,
        requiredModalities: ["image", "pdf"],
        incumbentModel: incumbentModel(["text", "image"]),
      }),
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.CONSTRAINT });
  });

  it("CONSTRAINT when the incumbent provider is unhealthy", () => {
    expect(crossesBoundary({ ...followUp, incumbentHealthy: false })).toMatchObject({
      crossed: true,
      boundary: BOUNDARY.CONSTRAINT,
    });
  });

  it("COMPACTED when the cache is gone anyway", () => {
    expect(crossesBoundary({ ...followUp, justCompacted: true })).toMatchObject({
      crossed: true,
      boundary: BOUNDARY.COMPACTED,
    });
  });

  it("USER when the user re-picked Auto", () => {
    expect(crossesBoundary({ ...followUp, userRequested: true })).toMatchObject({
      crossed: true,
      boundary: BOUNDARY.USER,
    });
  });
});

describe("crossesBoundary — no boundary", () => {
  it("returns crossed:false for an ordinary follow-up turn", () => {
    expect(crossesBoundary(followUp)).toMatchObject({ crossed: false, boundary: null });
  });

  it("drifting numbers alone never cross a boundary (context growing under the limit)", () => {
    expect(
      crossesBoundary({ ...followUp, contextTokens: 25000 }),
    ).toMatchObject({ crossed: false, boundary: null });
    expect(
      crossesBoundary({
        ...followUp,
        contextTokens: 1,
        incumbentContextLimit: 1,
      }),
    ).toMatchObject({ crossed: false, boundary: null });
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
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.FIRST_TURN });
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
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.AGENT });
  });
});

describe("crossesBoundary — capability/health facts (BET-1248 reviewer Block)", () => {
  it("a context-outgrown incumbent is reported NOT stillCapable", () => {
    expect(
      crossesBoundary({ ...followUp, contextTokens: 41000, incumbentContextLimit: 40000 }),
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.CONSTRAINT, stillCapable: false, stillHealthy: true });
  });

  it("a missing modality is reported NOT stillCapable", () => {
    expect(
      crossesBoundary({
        ...followUp,
        requiredModalities: ["image", "pdf"],
        incumbentModel: incumbentModel(["text", "image"]),
      }),
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.CONSTRAINT, stillCapable: false, stillHealthy: true });
  });

  it("BET-1267 3e: an incumbent with NO declared modalities never forces a re-route on an attachment turn", () => {
    // [] = "no information", never "supports nothing" — a model with an
    // unknown capability set must NOT be treated as missing the modality, so
    // an image turn does not trigger a CONSTRAINT re-route (it used to, on
    // every attachment turn, because [] read as absent).
    expect(
      crossesBoundary({
        ...followUp,
        requiredModalities: ["image"],
        incumbentModel: incumbentModel([]),
      }),
    ).toMatchObject({ crossed: false, boundary: null, stillCapable: true, stillHealthy: true });
  });

  it("an unhealthy incumbent is reported NOT stillHealthy", () => {
    expect(
      crossesBoundary({ ...followUp, incumbentHealthy: false }),
    ).toMatchObject({ crossed: true, boundary: BOUNDARY.CONSTRAINT, stillCapable: true, stillHealthy: false });
  });

  it("non-constraint boundaries keep the incumbent capable + healthy", () => {
    const res = crossesBoundary({ ...followUp, justCompacted: true });
    expect(res.crossed).toBe(true);
    expect(res.boundary).toBe(BOUNDARY.COMPACTED);
    expect(res.stillCapable).toBe(true);
    expect(res.stillHealthy).toBe(true);
  });

  it("no boundary → crossed:false and the incumbent still fits", () => {
    const res = crossesBoundary(followUp);
    expect(res).toMatchObject({ crossed: false, boundary: null, stillCapable: true, stillHealthy: true });
  });

  it("wire: a context-outgrown incumbent STILL SWITCHES while in the top-N (the Block)", () => {
    // crossesBoundary reports the incapability...
    const { crossed, boundary, stillCapable, stillHealthy } = crossesBoundary({
      ...followUp,
      contextTokens: 41000,
      incumbentContextLimit: 40000,
    });
    expect(crossed).toBe(true);
    expect(boundary).toBe(BOUNDARY.CONSTRAINT);
    // ...and shouldSwitch honours it OVER the contention window: the incumbent
    // is ranked #1, yet incapable → the turn switches to a capable alternative.
    expect(
      shouldSwitch({
        incumbent: ep("anthropic", "a"),
        ranked: [ep("anthropic", "a"), ep("openai", "b")],
        incumbentStillEligible: true,
        incumbentStillCapable: stillCapable,
        incumbentHealthy: stillHealthy,
      }),
    ).toEqual({ switch: true, why: "incumbent-incapable" });
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

  it("THE BUG: a different model of the SAME provider as the incumbent switches", () => {
    // Both sides arrive in the RPC deliver shape {providerID, modelID}. Before
    // the shared endpointKey, each collapsed to "anthropic/" (its `.id` was
    // undefined), the incumbent "matched" the first same-provider candidate,
    // and this returned incumbent-retained — routing never switched. The shared
    // key sees anthropic/a !== anthropic/z, so the incumbent fell out → switch.
    const incumbent = ep("anthropic", "a");
    const differentModelSameProvider = ep("anthropic", "z");
    expect(
      shouldSwitch({
        incumbent,
        ranked: [differentModelSameProvider],
        incumbentStillEligible: true,
        incumbentStillCapable: true,
        incumbentHealthy: true,
      }),
    ).toEqual({ switch: true, why: "incumbent-dropped-out" });
  });

  it("an incumbent with no identity never matches another with no identity (empty-key guard)", () => {
    // An endpoint that lost its model id has key "" — "no identity". Two such
    // keys must never be treated as the same endpoint. Build both from the real
    // producer, then strip the model id (toDeliverModel refuses to emit them).
    const noModel = { ...ep("anthropic", "a") } as { providerID: string; modelID?: string };
    delete noModel.modelID;
    const otherNoModel = { ...ep("openai", "b") } as { providerID: string; modelID?: string };
    delete otherNoModel.modelID;
    expect(endpointKey(noModel)).toBe("");
    expect(endpointKey(otherNoModel)).toBe("");
    // incumbentIndex treats an empty incumbent key as absent → NOT the same
    // endpoint, so the empty-ranked neighbour does not retain the incumbent.
    expect(
      shouldSwitch({
        incumbent: noModel,
        ranked: [otherNoModel],
        incumbentStillEligible: true,
        incumbentStillCapable: true,
        incumbentHealthy: true,
      }),
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
