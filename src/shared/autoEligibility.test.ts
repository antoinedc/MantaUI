import { describe, it, expect } from "vitest";
import { autoEligibility, MISSING } from "./autoEligibility.mjs";
import type { AutoEligibilityInput } from "./autoEligibility.mjs";

// A fully-described endpoint — every requirement is satisfied by either the
// catalogue/provider data or the user declaration.
function complete(over: Partial<AutoEligibilityInput> = {}): AutoEligibilityInput {
  return {
    providerClass: "custom",
    model: { providerID: "custom", id: "m1", cost: { input: 1, output: 3 } },
    identity: { known: false },
    quality: { known: true, score: 0.8 },
    declared: {
      catalogId: "some-catalog-model",
      price: { input: 1, output: 3 },
      caches: { read: true, write: true },
      tierOverride: "balanced",
    },
    ...over,
  };
}

describe("autoEligibility", () => {
  it("fully described custom endpoint is eligible with no penalty vs a supported one", () => {
    const custom = autoEligibility(complete({ providerClass: "custom" }));
    const supported = autoEligibility(complete({ providerClass: "supported" }));
    expect(custom.eligible).toBe(true);
    expect(custom.missing).toEqual([]);
    expect(supported.eligible).toBe(true);
    expect(supported.missing).toEqual([]);
    // Same data → same shape for both classes; class never changes the verdict.
    expect(supported).toEqual(custom);
  });

  it("nothing declared → missing identity, price and caching", () => {
    const res = autoEligibility({
      providerClass: "custom",
      model: { providerID: "custom", id: "m1" },
    });
    expect(res.eligible).toBe(false);
    expect(res.missing).toContain(MISSING.IDENTITY);
    expect(res.missing).toContain(MISSING.PRICE);
    expect(res.missing).toContain(MISSING.CACHING);
  });

  it("identity declared only → still ineligible, but identity no longer missing", () => {
    const res = autoEligibility({
      providerClass: "custom",
      model: { providerID: "custom", id: "m1" },
      declared: { catalogId: "catalog-alpha" },
    });
    expect(res.eligible).toBe(false);
    expect(res.missing).not.toContain(MISSING.IDENTITY);
    expect(res.missing).toContain(MISSING.PRICE);
    expect(res.missing).toContain(MISSING.CACHING);
  });

  it("price: 'free' satisfies PRICE; caches: false satisfies CACHING", () => {
    const res = autoEligibility({
      providerClass: "custom",
      model: { providerID: "custom", id: "m1" },
      identity: { known: true },
      quality: { known: true, score: 0.9 },
      declared: { price: "free", caches: false },
    });
    expect(res.eligible).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it("quality.known === false and no tierOverride → QUALITY missing", () => {
    const { tierOverride, ...declaredNoTier } = complete().declared!;
    const res = autoEligibility(
      complete({
        quality: { known: false, score: undefined },
        declared: declaredNoTier,
      }),
    );
    expect(res.eligible).toBe(false);
    expect(res.missing).toContain(MISSING.QUALITY);
  });

  it("quality.known === false, tierOverride present → QUALITY satisfied", () => {
    const res = autoEligibility(
      complete({
        quality: { known: false, score: undefined },
        declared: { tierOverride: "fast" },
      }),
    );
    expect(res.missing).not.toContain(MISSING.QUALITY);
  });

  it("declared identity (catalogId) satisfies IDENTITY even when identity.known is false", () => {
    const res = autoEligibility(
      complete({ identity: { known: false }, quality: { known: true, score: 0.8 } }),
    );
    expect(res.missing).not.toContain(MISSING.IDENTITY);
    expect(res.eligible).toBe(true);
  });

  it("provider cost figures satisfy PRICE and CACHING without declarations", () => {
    const res = autoEligibility(
      complete({
        model: {
          providerID: "anthropic",
          id: "claude-sonnet-4-6",
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
        declared: undefined,
      }),
    );
    expect(res.missing).not.toContain(MISSING.PRICE);
    expect(res.missing).not.toContain(MISSING.CACHING);
  });

  it("a supported provider with a gap reports it rather than being waved through", () => {
    // A supported provider that is missing its cost figures is a bug we own —
    // the gate must report it, not short-circuit on class.
    const res = autoEligibility({
      providerClass: "supported",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      identity: { known: true },
      quality: { known: true, score: 0.9 },
      declared: undefined,
    });
    expect(res.eligible).toBe(false);
    expect(res.missing).toContain(MISSING.PRICE);
    expect(res.missing).toContain(MISSING.CACHING);
  });
});
