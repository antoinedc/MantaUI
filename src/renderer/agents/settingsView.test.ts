// Pure logic of the profile's Settings tab (docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §5).

import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../shared/types";
import { editableFields, fieldValue, isUnchanged, lockedNote, learningLine, modelOptions, refreshDayLine, toWire, SETTINGS_MAX } from "./settingsView";

const info = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  slug: "dev",
  name: "Dev",
  description: "Writes code.",
  isolation: "worktree",
  model: null,
  color: null,
  builtIn: true,
  role: "specialist",
  useWhen: "Code changes.",
  notFor: null,
  notice: null,
  ...over,
});

describe("which fields a profile lets the user edit", () => {
  it("a specialist: all six; the Architect: only its model; Manta: none", () => {
    expect(editableFields(info())).toEqual(["name", "description", "useWhen", "notFor", "model", "isolation"]);
    expect(editableFields(info({ role: "architect" }))).toEqual(["model"]);
    expect(editableFields(info({ role: "lead" }))).toEqual([]);
  });
  it("the locked note names the agent and says the change waits for the user's click", () => {
    expect(lockedNote("Architect")).toMatch(/Architect is built into Manta/);
    expect(lockedNote("Architect")).toMatch(/always wait for your click/);
  });
});

describe("what a field shows and what it sends", () => {
  it("shows the saved value; an empty routing line or Auto is the empty string", () => {
    const a = info({ model: "openai/gpt-6-sol", notFor: null });
    expect(fieldValue(a, "name")).toBe("Dev");
    expect(fieldValue(a, "notFor")).toBe("");
    expect(fieldValue(a, "model")).toBe("openai/gpt-6-sol");
    expect(fieldValue(info(), "model")).toBe("");
    expect(fieldValue(a, "isolation")).toBe("worktree");
  });
  it("is unchanged when the trimmed text equals the saved value (nothing is sent)", () => {
    expect(isUnchanged(info(), "name", "  Dev ")).toBe(true);
    expect(isUnchanged(info(), "name", "Developer")).toBe(false);
    expect(isUnchanged(info(), "notFor", "")).toBe(true);
    expect(isUnchanged(info(), "useWhen", "Code changes.")).toBe(true);
  });
  it("sends trimmed text; an empty routing line and Auto go as null", () => {
    expect(toWire("name", "  Developer ")).toBe("Developer");
    expect(toWire("useWhen", "   ")).toBeNull();
    expect(toWire("notFor", "")).toBeNull();
    expect(toWire("model", "")).toBeNull();
    expect(toWire("model", "openai/gpt-6-sol")).toBe("openai/gpt-6-sol");
    expect(toWire("isolation", "none")).toBe("none");
  });
  it("the limits are the box's", () => {
    expect(SETTINGS_MAX).toEqual({ name: 40, description: 200, useWhen: 200, notFor: 200 });
  });
});

describe("modelOptions", () => {
  it("Auto first, then the approved models, and the current one even when it is no longer approved", () => {
    expect(modelOptions(["b/two", "a/one"], "")).toEqual([{ value: "", label: "Auto" }, { value: "a/one", label: "a/one" }, { value: "b/two", label: "b/two" }]);
    expect(modelOptions(["a/one"], "z/gone").map((o) => o.value)).toEqual(["", "a/one", "z/gone"]);
    expect(modelOptions([], "").map((o) => o.value)).toEqual([""]);
  });
});

describe("read-only lines", () => {
  it("the refresh day: monthly on the Nth, next run after today", () => {
    const now = Date.UTC(2026, 10, 28, 12); // 28 Nov
    expect(refreshDayLine(12, now)).toBe("Runs monthly, on the 12th. Next: 12 Dec");
    expect(refreshDayLine(28, now)).toBe("Runs monthly, on the 28th. Next: 28 Dec");
    expect(refreshDayLine(1, now)).toBe("Runs monthly, on the 1st. Next: 1 Dec");
    expect(refreshDayLine(22, Date.UTC(2026, 10, 3, 12))).toBe("Runs monthly, on the 22nd. Next: 22 Nov");
    expect(refreshDayLine(null, now)).toBe("");
  });
  it("the team-wide learning setting in words", () => {
    expect(learningLine("tell")).toBe("Team setting: learns from your corrections and tells you");
    expect(learningLine("auto")).toBe("Team setting: learns from your corrections");
    expect(learningLine("ask")).toBe("Team setting: asks you before keeping a rule");
    expect(learningLine("never")).toBe("Team setting: doesn't learn from your corrections");
    expect(learningLine(null)).toBe("Team setting: see Settings");
  });
});
