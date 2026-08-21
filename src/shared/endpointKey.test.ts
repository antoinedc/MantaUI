import { describe, it, expect } from "vitest";
import { endpointKey } from "./endpointKey.mjs";

describe("endpointKey — the single identity definition", () => {
  it("renders providerID/modelID for the RPC (deliver) shape", () => {
    expect(endpointKey({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  it("renders providerID/id for the router catalogue shape", () => {
    expect(endpointKey({ providerID: "anthropic", id: "claude-sonnet-4-6" })).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  it("the two shapes resolve to the SAME identity — one convention, not two", () => {
    expect(endpointKey({ providerID: "anthropic", modelID: "claude-opus-4-7" })).toBe(
      endpointKey({ providerID: "anthropic", id: "claude-opus-4-7" }),
    );
  });

  it("distinguishes different models of the same provider", () => {
    expect(endpointKey({ providerID: "anthropic", modelID: "a" })).not.toBe(
      endpointKey({ providerID: "anthropic", modelID: "z" }),
    );
  });

  it("returns '' for null / undefined / missing provider / missing model", () => {
    expect(endpointKey(null)).toBe("");
    expect(endpointKey(undefined)).toBe("");
    expect(endpointKey({})).toBe("");
    expect(endpointKey({ providerID: "anthropic" })).toBe("");
    expect(endpointKey({ modelID: "x" })).toBe("");
  });

  it("an empty key is never an identity — it never equals a real key", () => {
    expect(endpointKey({ providerID: "anthropic" })).not.toBe(
      endpointKey({ providerID: "anthropic", modelID: "x" }),
    );
    expect(endpointKey({ modelID: "x" })).not.toBe(
      endpointKey({ providerID: "p", modelID: "x" }),
    );
  });

  it("every missing-identity endpoint collapses to the same empty key — so comparison SITES must guard, not the key", () => {
    // Two endpoints with no identity BOTH produce "" — that is exactly why a
    // comparison must never pair two empty keys as "the same endpoint". The
    // key returns "" for all of these; the guard lives at the comparison site
    // (routingBoundary's incumbentIndex early-returns -1 on an empty incumbent).
    expect(endpointKey({})).toBe("");
    expect(endpointKey({ providerID: "p" })).toBe("");
    expect(endpointKey({ modelID: "x" })).toBe("");
  });
});
