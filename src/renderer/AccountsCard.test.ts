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
import type { UsageWindow } from "../shared/types";
import {
  describeAccountState,
  describeMissing,
  endpointEligibility,
  helpText,
  usagePace,
  type AccountRowModel,
} from "./AccountsCard";

const subscription = (over: Partial<AccountRowModel> = {}): AccountRowModel => ({
  id: "anthropic",
  className: "Supported",
  kind: "subscription",
  name: "Claude",
  plan: "Max 20x",
  connected: true,
  reading: null,
  balance: null,
  health: "ok",
  eligibilityMissing: [],
  ...over,
});

describe("describeAccountState", () => {
  it("a supported subscription row shows its window percentage and pace", () => {
    const st = describeAccountState(
      subscription({ reading: { label: "5h window", pct: 41, pace: "under pace" } }),
    );
    expect(st.text).toContain("5h window");
    expect(st.text).toContain("41%");
    expect(st.text).toContain("under pace");
    // under-pace (41%) → ok tone.
    expect(st.tone).toBe("ok");
  });

  it("a reading near the cap turns the tone warn/danger", () => {
    expect(describeAccountState(subscription({ reading: { label: "5h", pct: 80, pace: "on pace" } })).tone).toBe("warn");
    expect(describeAccountState(subscription({ reading: { label: "5h", pct: 95, pace: "over pace" } })).tone).toBe("danger");
  });

  it("a supported credit row shows a balance", () => {
    const st = describeAccountState(subscription({ balance: 12.5, reading: null }));
    expect(st.text).toBe("$12.50 remaining");
    expect(st.tone).toBe("ok");
  });

  it("a low credit balance turns danger", () => {
    const st = describeAccountState(subscription({ balance: 1.2, reading: null }));
    expect(st.text).toBe("$1.20 remaining");
    expect(st.tone).toBe("danger");
  });

  it("custom row with no reader shows exactly 'No usage data' — no bar, no zero", () => {
    const row: AccountRowModel = {
      id: "voska",
      className: "Custom",
      kind: "declared",
      name: "VoskaAI",
      connected: true,
      reading: null,
      balance: null,
      health: "ok",
      eligibilityMissing: [],
    };
    const st = describeAccountState(row);
    expect(st.text).toBe("No usage data");
    expect(st.text).not.toMatch(/[0-9]%/);
    expect(st.text).not.toMatch(/0|bar/i);
    expect(st.tone).toBe("quiet");
  });

  it("credential absent shows 'Not connected'", () => {
    const st = describeAccountState(subscription({ connected: false }));
    expect(st.text).toBe("Not connected");
    expect(st.tone).toBe("quiet");
  });

  it("out-of-credit shows 'Out of credit' (danger)", () => {
    const st = describeAccountState(subscription({ health: "out-of-credit", balance: 0 }));
    expect(st.text).toBe("Out of credit");
    expect(st.tone).toBe("danger");
  });

  it("rate-limited shows the remaining cooldown (warn)", () => {
    const st = describeAccountState(subscription({ health: "rate-limited", retryInMinutes: 12 }));
    expect(st.text).toBe("Rate limited · retry in 12m");
    expect(st.tone).toBe("warn");
  });

  it("failing shows 'Not responding' (warn)", () => {
    const st = describeAccountState(subscription({ health: "failing" }));
    expect(st.text).toBe("Not responding");
    expect(st.tone).toBe("warn");
  });
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
      reading: null,
      balance: null,
      health: "ok",
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
      reading: null,
      balance: null,
      health: "unknown",
      eligibilityMissing: missing,
    };
    expect(helpText(row)).not.toContain("what it costs");
  });
});

describe("usagePace", () => {
  it("classifies under / on / over against elapsed window time", () => {
    const now = 500;
    // Window spans 0..1000ms, started at 0, resets at 1000 → at now=500 the
    // window is 50% elapsed, so pace is consumed% vs the 50% mark.
    const w = (pct: number): UsageWindow => ({ pct, startedAt: 0, resetsAt: 1000, label: "5h", kind: "session" });
    // 20% consumed at 50% elapsed → under pace.
    expect(usagePace(w(20), now)).toBe("under pace");
    // 50% consumed at 50% elapsed → on pace.
    expect(usagePace(w(50), now)).toBe("on pace");
    // 90% consumed at 50% elapsed → over pace.
    expect(usagePace(w(90), now)).toBe("over pace");
  });

  it("falls back to no pace when no timing is present (9e)", () => {
    expect(usagePace({ pct: 20 } as never, 0)).toBeNull();
    expect(usagePace({ pct: 85 } as never, 0)).toBeNull();
  });
});

describe("AccountsCard pace clause (9e)", () => {
  it("a reading with no timing renders the percentage with no pace clause", () => {
    const st = describeAccountState(
      subscription({ reading: { label: "Weekly", pct: 85, pace: null } }),
    );
    expect(st.text).toBe("Weekly 85%");
    expect(st.text).not.toContain("pace");
  });

  it("a reading with timing still renders the pace clause", () => {
    const st = describeAccountState(
      subscription({ reading: { label: "5h", pct: 41, pace: "under pace" } }),
    );
    expect(st.text).toBe("5h 41% · under pace");
  });
});

describe("health unknown is not healthy (9f)", () => {
  it("an unknown health entry renders the usage state, never 'ok'/'healthy'", () => {
    const withReading = describeAccountState(
      subscription({ health: "unknown", reading: { label: "5h", pct: 41, pace: "under pace" } }),
    );
    expect(withReading.text).toContain("5h 41%");
    expect(withReading.text).not.toMatch(/healthy|ok/i);

    const byBalance = describeAccountState(subscription({ health: "unknown", reading: null, balance: 12.5 }));
    expect(byBalance.text).toBe("$12.50 remaining");
  });

  it("an unknown health custom row with no data reads 'No usage data', not healthy", () => {
    const row: AccountRowModel = {
      id: "voska",
      className: "Custom",
      kind: "declared",
      name: "VoskaAI",
      connected: true,
      reading: null,
      balance: null,
      health: "unknown",
      eligibilityMissing: [],
    };
    const st = describeAccountState(row);
    expect(st.text).toBe("No usage data");
    expect(st.tone).toBe("quiet");
  });
});
