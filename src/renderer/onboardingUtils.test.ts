import { describe, it, expect } from "vitest";
import {
  ONBOARDING_STEPS,
  STEP_LABELS,
  FIRST_STEP,
  LAST_STEP,
  canGoBack,
  nextPosition,
  prevPosition,
  resolveInitialStep,
} from "./onboardingUtils";
import type { AppConfig } from "../shared/types";

const HEX32 = "0123456789abcdef0123456789abcdef";

describe("onboarding step model", () => {
  it("has two ordered numbered steps 1..2", () => {
    expect([...ONBOARDING_STEPS]).toEqual([1, 2]);
    expect(FIRST_STEP).toBe(1);
    expect(LAST_STEP).toBe(2);
  });

  it("labels every numbered step", () => {
    for (const s of ONBOARDING_STEPS) {
      expect(typeof STEP_LABELS[s]).toBe("string");
      expect(STEP_LABELS[s].length).toBeGreaterThan(0);
    }
    expect(STEP_LABELS[1]).toBe("Connect");
    expect(STEP_LABELS[2]).toBe("Connect a provider");
  });
});

describe("canGoBack", () => {
  it("is false on step 1 and on success", () => {
    expect(canGoBack(1)).toBe(false);
    expect(canGoBack("success")).toBe(false);
  });
  it("is true on step 2", () => {
    expect(canGoBack(2)).toBe(true);
  });
});

describe("nextPosition", () => {
  it("advances numbered steps", () => {
    expect(nextPosition(1)).toBe(2);
  });
  it("step 2 → success", () => {
    expect(nextPosition(2)).toBe("success");
  });
  it("success is terminal", () => {
    expect(nextPosition("success")).toBe("success");
  });
});

describe("prevPosition", () => {
  it("goes back one numbered step", () => {
    expect(prevPosition(2)).toBe(1);
  });
  it("clamps at step 1", () => {
    expect(prevPosition(1)).toBe(1);
  });
  it("is a no-op from success", () => {
    expect(prevPosition("success")).toBe("success");
  });
});

describe("resolveInitialStep", () => {
  it("fresh/empty/null config → step 1", () => {
    expect(resolveInitialStep(null)).toBe(1);
    expect(resolveInitialStep(undefined)).toBe(1);
    expect(resolveInitialStep({})).toBe(1);
    expect(resolveInitialStep({ projects: [] } as Partial<AppConfig>)).toBe(1);
  });

  it("malformed boxToken is treated as unpaired → step 1", () => {
    expect(resolveInitialStep({ boxToken: "" })).toBe(1);
    expect(resolveInitialStep({ boxToken: "nothex" })).toBe(1);
    expect(resolveInitialStep({ boxToken: HEX32.toUpperCase() })).toBe(1);
    expect(resolveInitialStep({ boxToken: HEX32.slice(0, 31) })).toBe(1);
  });

  it("paired → step 2 (provider, auto-skips if already connected)", () => {
    expect(resolveInitialStep({ boxToken: HEX32 })).toBe(2);
    expect(resolveInitialStep({ boxToken: HEX32, projects: [] })).toBe(2);
    expect(
      resolveInitialStep({
        boxToken: HEX32,
        defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    ).toBe(2);
  });
});
