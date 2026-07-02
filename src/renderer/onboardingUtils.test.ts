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
  it("has four ordered numbered steps 1..4", () => {
    expect([...ONBOARDING_STEPS]).toEqual([1, 2, 3, 4]);
    expect(FIRST_STEP).toBe(1);
    expect(LAST_STEP).toBe(4);
  });

  it("labels every numbered step", () => {
    for (const s of ONBOARDING_STEPS) {
      expect(typeof STEP_LABELS[s]).toBe("string");
      expect(STEP_LABELS[s].length).toBeGreaterThan(0);
    }
    expect(STEP_LABELS[1]).toBe("Connect");
    expect(STEP_LABELS[4]).toBe("Project");
  });
});

describe("canGoBack", () => {
  it("is false on step 1 and on success", () => {
    expect(canGoBack(1)).toBe(false);
    expect(canGoBack("success")).toBe(false);
  });
  it("is true on steps 2, 3, 4", () => {
    expect(canGoBack(2)).toBe(true);
    expect(canGoBack(3)).toBe(true);
    expect(canGoBack(4)).toBe(true);
  });
});

describe("nextPosition", () => {
  it("advances numbered steps", () => {
    expect(nextPosition(1)).toBe(2);
    expect(nextPosition(2)).toBe(3);
    expect(nextPosition(3)).toBe(4);
  });
  it("step 4 → success", () => {
    expect(nextPosition(4)).toBe("success");
  });
  it("success is terminal", () => {
    expect(nextPosition("success")).toBe("success");
  });
});

describe("prevPosition", () => {
  it("goes back one numbered step", () => {
    expect(prevPosition(2)).toBe(1);
    expect(prevPosition(3)).toBe(2);
    expect(prevPosition(4)).toBe(3);
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

  it("paired but no default model → step 2 (providers)", () => {
    expect(resolveInitialStep({ boxToken: HEX32 })).toBe(2);
    expect(resolveInitialStep({ boxToken: HEX32, projects: [] })).toBe(2);
  });

  it("a defaultModel with no modelID does not count as chosen", () => {
    expect(
      resolveInitialStep({
        boxToken: HEX32,
        defaultModel: { providerID: "anthropic", modelID: "" },
      }),
    ).toBe(2);
  });

  it("paired + model but no projects → step 4 (first project)", () => {
    expect(
      resolveInitialStep({
        boxToken: HEX32,
        defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    ).toBe(4);
  });

  it("paired + model + a project → still step 4 (never auto-jumps to success)", () => {
    expect(
      resolveInitialStep({
        boxToken: HEX32,
        defaultModel: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        projects: [{ tmuxSession: "demo", defaultCwd: "~/projects/demo" }],
      }),
    ).toBe(4);
  });
});
