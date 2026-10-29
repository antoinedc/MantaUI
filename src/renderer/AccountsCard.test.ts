// @vitest-environment jsdom
//
// ===== AccountsCard pure row logic (BET-1250) =====
//
// The merged Accounts list's row logic is extracted as pure functions
// (describeAccountState, describeMissing, helpText, usagePace) so the state
// column and the Auto-eligibility phrase mapping are testable without a DOM.
// The one gate the router waits on (autoEligibility) is exercised directly so
// "what the UI says is missing" equals "what blocks Auto" by construction.

import { describe, it, expect } from "vitest";
import { autoEligibility, MISSING } from "../shared/autoEligibility.mjs";
import {
  describeMissing,
  endpointEligibility,
  helpText,
  type AccountRowModel,
} from "./AccountsCard";

const subscription = (over: Partial<AccountRowModel> = {}): AccountRowModel => ({
  id: "anthropic",
  className: "Supported",
  kind: "subscription",
  name: "Claude",
  plan: "Max 20x",
  connected: true,
  eligibilityMissing: [],
  ...over,
});


describe("describeMissing", () => {
  it("maps machine keys to the human phrase set autoEligibility reports", () => {
    // Drive the missing set from the gate itself so UI and router can't drift.
    const input = {
      model: {},
      identity: { known: false },
      quality: { known: false },
      providerClass: "custom" as const,
    };
    const missing = autoEligibility(input).missing; // [identity, price, caching, quality]
    const phrase = describeMissing(missing);
    expect(missing.sort()).toEqual(
      [MISSING.IDENTITY, MISSING.PRICE, MISSING.CACHING, MISSING.QUALITY].sort(),
    );
    expect(phrase).toBe("which model, what it costs, whether it caches, and how it compares");
  });

  it("joins two gaps with a final 'and'", () => {
    expect(describeMissing([MISSING.IDENTITY, MISSING.CACHING])).toBe(
      "which model, and whether it caches",
    );
  });

  it("single gap has no comma", () => {
    expect(describeMissing([MISSING.PRICE])).toBe("what it costs");
  });

  it("empty/unknown keys → null", () => {
    expect(describeMissing([])).toBeNull();
    expect(describeMissing(["nope"])).toBeNull();
  });
});

describe("helpText", () => {
  it("supported row: class · kind · plan", () => {
    expect(helpText(subscription())).toBe("Supported · subscription · Max 20x");
  });

  it("custom row with gaps names them in the help line", () => {
    const row: AccountRowModel = {
      id: "x",
      className: "Custom",
      kind: "declared",
      name: "X",
      connected: true,
      eligibilityMissing: autoEligibility({
        model: {},
        identity: { known: false },
        quality: { known: false },
        providerClass: "custom",
      }).missing,
    };
    expect(helpText(row)).toContain("Custom · Auto needs: which model, what it costs, whether it caches, and how it compares");
  });
});

describe("endpointEligibility (multi-model union — reviewer Question)", () => {
  const ep = (models: string[]) => ({
    id: "voska",
    name: "VoskaAI",
    baseURL: "https://api.voska.org/v1",
    hasApiKey: true,
    enabledModels: models,
  });

  it("unions gaps across ALL enabled models so a declared model can't mask an unresolved one", () => {
    // alpha is fully declared; beta is opaque + undeclared.
    const declared = {
      "voska/alpha": { catalogId: "alpha-model", price: { input: 0.02, output: 0.08 }, caches: false },
    };
    const { missing } = endpointEligibility(ep(["alpha", "beta"]), declared, null);
    // beta's gaps must still surface — the endpoint is NOT fully described.
    expect(missing).toEqual(
      expect.arrayContaining([MISSING.IDENTITY, MISSING.PRICE, MISSING.CACHING, MISSING.QUALITY]),
    );
  });

  it("an endpoint whose every model is declared is fully described", () => {
    const declared = {
      "voska/alpha": { catalogId: "a", price: { input: 1, output: 2 }, caches: false },
      "voska/beta": { catalogId: "b", price: { input: 1, output: 2 }, caches: false },
    };
    const { missing } = endpointEligibility(ep(["alpha", "beta"]), declared, null);
    expect(missing).toEqual([]);
  });

  it("an endpoint with no enabled models still reports the gaps it needs", () => {
    const { missing } = endpointEligibility(ep([]), {}, null);
    expect(missing).toEqual(expect.arrayContaining([MISSING.IDENTITY]));
  });

  it("an endpoint that reports a price + caching lists only the identity gap, not 'what it costs' (9d)", () => {
    // The endpoint "told us" its price (free) and caching (none) — the row must
    // NOT say "Auto needs: what it costs". This is the case the empty-model
    // eligibility bug (BET-1273 9d) got wrong: it always reported PRICE/CACHING/
    // QUALITY missing because it judged `{}` instead of the resolved endpoint.
    const declared = {
      "voska/m1": { price: "free" as const, caches: false as const },
    };
    const { missing } = endpointEligibility(ep(["m1"]), declared, null);
    expect(missing).toEqual([MISSING.IDENTITY]);
    expect(missing).not.toContain(MISSING.PRICE);
    expect(missing).not.toContain(MISSING.CACHING);
    expect(missing).not.toContain(MISSING.QUALITY);
  });

  it("a custom endpoint with a declared price does not say 'Auto needs: what it costs'", () => {
    const declared = {
      "voska/m1": { price: { input: 0.02, output: 0.08 }, caches: false },
    };
    const { missing } = endpointEligibility(ep(["m1"]), declared, null);
    expect(missing).not.toContain(MISSING.PRICE);
    const row: AccountRowModel = {
      id: "voska",
      className: "Custom",
      kind: "declared",
      name: "VoskaAI",
      connected: true,
      eligibilityMissing: missing,
    };
    expect(helpText(row)).not.toContain("what it costs");
  });
});



