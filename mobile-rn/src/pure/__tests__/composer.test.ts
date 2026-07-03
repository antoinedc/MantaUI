// composer.test.ts — pure send-gate: empty/whitespace blocked, running-state
// gate, trim normalization.

import { describe, expect, it } from "vitest";

import { canSubmitPrompt, preparePrompt } from "../composer";

describe("canSubmitPrompt", () => {
  it("allows a non-empty draft when idle", () => {
    expect(canSubmitPrompt("hello", false)).toBe(true);
  });

  it("blocks an empty draft", () => {
    expect(canSubmitPrompt("", false)).toBe(false);
  });

  it("blocks an all-whitespace draft (spaces, tabs, newlines)", () => {
    expect(canSubmitPrompt("   ", false)).toBe(false);
    expect(canSubmitPrompt("\t\n  \n", false)).toBe(false);
  });

  it("blocks while a turn is running, even with a non-empty draft", () => {
    expect(canSubmitPrompt("hello", true)).toBe(false);
  });

  it("blocks an empty draft while running too", () => {
    expect(canSubmitPrompt("", true)).toBe(false);
  });
});

describe("preparePrompt", () => {
  it("trims surrounding whitespace", () => {
    expect(preparePrompt("  hi there \n")).toBe("hi there");
  });

  it("returns null for empty / whitespace-only drafts", () => {
    expect(preparePrompt("")).toBeNull();
    expect(preparePrompt("   \t\n ")).toBeNull();
  });

  it("preserves interior whitespace and newlines", () => {
    expect(preparePrompt("  line one\nline two  ")).toBe("line one\nline two");
  });
});
