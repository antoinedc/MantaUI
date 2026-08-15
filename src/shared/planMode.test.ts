import { describe, it, expect } from "vitest";
import { planModeFromToolPart } from "./planMode.mjs";

describe("planModeFromToolPart", () => {
  it("is true for a completed plan_enter", () => {
    expect(planModeFromToolPart({ type: "tool", tool: "plan_enter", state: { status: "completed" } })).toBe(true);
  });

  it("is false for a completed plan_exit", () => {
    expect(planModeFromToolPart({ type: "tool", tool: "plan_exit", state: { status: "completed" } })).toBe(false);
  });

  it("is null for an errored plan_exit (the regression: a rejected switch did not happen)", () => {
    expect(planModeFromToolPart({ type: "tool", tool: "plan_exit", state: { status: "error" } })).toBe(null);
  });

  it("is null for an errored plan_enter", () => {
    expect(planModeFromToolPart({ type: "tool", tool: "plan_enter", state: { status: "error" } })).toBe(null);
  });

  it("is null for a completed non-plan tool", () => {
    expect(planModeFromToolPart({ type: "tool", tool: "bash", state: { status: "completed" } })).toBe(null);
  });

  it("is null for a non-tool part", () => {
    expect(planModeFromToolPart({ type: "text", state: { status: "completed" } })).toBe(null);
  });

  it("is null for null / undefined", () => {
    expect(planModeFromToolPart(null)).toBe(null);
    expect(planModeFromToolPart(undefined)).toBe(null);
  });
});
