import { describe, it, expect } from "vitest";
// Single source of truth for the words the Accounts row and the needs-attention
// notification must agree on (BET-1270 6d). If these drift, a user reads one
// phrase in Settings and another in the push for the same provider.
import { PROVIDER_STATE_LABEL, providerStateLabel } from "./providerHealthLabel.mjs";

describe("providerStateLabel", () => {
  it("maps the three non-ok states to the words the Accounts row shows", () => {
    expect(providerStateLabel("out-of-credit")).toBe("Out of credit");
    expect(providerStateLabel("rate-limited")).toBe("Rate limited");
    expect(providerStateLabel("failing")).toBe("Not responding");
  });

  it("returns null for the ok/default state and unknown states", () => {
    expect(providerStateLabel("ok")).toBeNull();
    expect(providerStateLabel("nope")).toBeNull();
    expect(providerStateLabel(undefined as unknown as string)).toBeNull();
  });

  it("exposes the frozen table for direct reads", () => {
    expect(PROVIDER_STATE_LABEL["out-of-credit"]).toBe("Out of credit");
    expect(PROVIDER_STATE_LABEL["rate-limited"]).toBe("Rate limited");
    expect(PROVIDER_STATE_LABEL["failing"]).toBe("Not responding");
  });
});
