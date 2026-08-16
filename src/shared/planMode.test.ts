import { describe, it, expect } from "vitest";
import { planModeFromToolPart, isPlanAgent, planSubdomain, planPageUrl } from "./planMode.mjs";

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

describe("isPlanAgent", () => {
  it("is true for 'plan'", () => {
    expect(isPlanAgent("plan")).toBe(true);
  });

  it("is true for 'manta-plan'", () => {
    expect(isPlanAgent("manta-plan")).toBe(true);
  });

  it("is false for other agent names", () => {
    expect(isPlanAgent("build")).toBe(false);
    expect(isPlanAgent("general")).toBe(false);
    expect(isPlanAgent("")).toBe(false);
  });

  it("is false for non-strings", () => {
    expect(isPlanAgent(undefined)).toBe(false);
    expect(isPlanAgent(null)).toBe(false);
    expect(isPlanAgent(123)).toBe(false);
    expect(isPlanAgent({})).toBe(false);
  });
});

describe("planSubdomain", () => {
  it("derives plan-<shortSessionId>, lowercased, alphanumerics only, truncated to 20 chars", () => {
    expect(planSubdomain("AbC-123")).toBe("plan-abc123");
    expect(planSubdomain("not-a-uuid-123456789012345678901234567890")).toBe(
      "plan-notauuid123456789012",
    );
  });

  it("is stable per session and differs across sessions", () => {
    const a = "sessA_someid1";
    const b = "sessB_someid2";
    expect(planSubdomain(a)).toBe(planSubdomain(a));
    expect(planSubdomain(a)).not.toBe(planSubdomain(b));
  });

  it("returns null for empty / unusable input", () => {
    expect(planSubdomain("")).toBe(null);
    expect(planSubdomain("   ")).toBe(null);
    expect(planSubdomain("!!!")).toBe(null);
    expect(planSubdomain(123)).toBe(null);
    expect(planSubdomain(null)).toBe(null);
    expect(planSubdomain(undefined)).toBe(null);
  });
});

describe("planPageUrl", () => {
  it("returns <base>/pages/plan-<shortSessionId>", () => {
    expect(planPageUrl("sess-abc", "https://box.example.com")).toBe(
      "https://box.example.com/pages/plan-sessabc",
    );
  });

  it("trims a trailing slash off the base", () => {
    expect(planPageUrl("sess", "https://box.example.com/")).toBe(
      "https://box.example.com/pages/plan-sess",
    );
    expect(planPageUrl("sess", "https://box.example.com///")).toBe(
      "https://box.example.com/pages/plan-sess",
    );
  });

  it("passes the host through unchanged for tailnet or other bases", () => {
    expect(planPageUrl("sess-1", "http://100.64.0.1:8787")).toBe(
      "http://100.64.0.1:8787/pages/plan-sess1",
    );
  });

  it("returns '' when the slug is unusable", () => {
    expect(planPageUrl("", "https://box.example.com")).toBe("");
    expect(planPageUrl("!!!", "https://box.example.com")).toBe("");
  });

  it("never throws on a bogus baseUrl", () => {
    expect(() => planPageUrl("sess", null)).not.toThrow();
    expect(() => planPageUrl("sess", undefined)).not.toThrow();
  });
});
