// Tests for src/shared/constraintPin.mjs — the compaction constraint-pinning
// pure module (Optimizer P2.4, BET-1346). Vitest, mirrors optimizerPolicy.test.ts.
// Pure: no box, no model calls, no state dir.

import { describe, it, expect } from "vitest";
import {
  parseConstraints,
  renderConstraintBlock,
  buildCompactionPrompt,
  CONSTRAINT_EXTRACT_PROMPT,
  MAX_CONSTRAINTS,
  MAX_CONSTRAINT_CHARS,
} from "./constraintPin.mjs";

describe("parseConstraints", () => {
  it("returns [] for empty / garbage input", () => {
    expect(parseConstraints("")).toEqual([]);
    expect(parseConstraints(null)).toEqual([]);
    expect(parseConstraints(undefined)).toEqual([]);
    expect(parseConstraints(42)).toEqual([]);
    expect(parseConstraints("   \n\n   ")).toEqual([]);
  });

  it("splits on newlines and trims", () => {
    expect(parseConstraints("  always use tabs  \n  never touch deploy\n")).toEqual([
      "always use tabs",
      "never touch deploy",
    ]);
  });

  it("strips numbering and bullet prefixes", () => {
    expect(parseConstraints("- always use tabs\n* prefer ESM\n1. commit often\n2) no password in code\n• ok with that\n  + nested bullet")).toEqual([
      "always use tabs",
      "prefer ESM",
      "commit often",
      "no password in code",
      "ok with that",
      "nested bullet",
    ]);
  });

  it("drops lines that are pure numbering/bullet prefixes", () => {
    expect(parseConstraints("-\n1.\n2)\n*  \nreal instruction")).toEqual(["real instruction"]);
  });

  it("25 lines are capped to 20", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `instruction ${i + 1}`);
    const out = parseConstraints(lines.join("\n"));
    expect(out.length).toBe(MAX_CONSTRAINTS);
    expect(out[0]).toBe("instruction 1");
    expect(out[MAX_CONSTRAINTS - 1]).toBe(`instruction ${MAX_CONSTRAINTS}`);
  });

  it("a 500-char line is truncated to 300", () => {
    const long = "a".repeat(500);
    const out = parseConstraints(long);
    expect(out).toEqual(["a".repeat(MAX_CONSTRAINT_CHARS)]);
    expect(out[0].length).toBe(MAX_CONSTRAINT_CHARS);
  });

  it("de-duplicates case-insensitively", () => {
    expect(parseConstraints("use tabs\nUSE TABS\nUse Tabs\nother")).toEqual(["use tabs", "other"]);
  });

  it("never throws on bizarre input", () => {
    expect(() => parseConstraints("a\nb\nc")).not.toThrow();
  });
});

describe("renderConstraintBlock", () => {
  it("returns '' for an empty list", () => {
    expect(renderConstraintBlock([])).toBe("");
    expect(renderConstraintBlock(null)).toBe("");
    expect(renderConstraintBlock([""])).toBe("");
  });

  it("renders a fixed block with a '- ' bullet per constraint", () => {
    const block = renderConstraintBlock(["use tabs", "never touch deploy"]);
    expect(block).toBe(
      "\n\nStanding instructions from the user, preserved verbatim across compaction:\n- use tabs\n- never touch deploy",
    );
  });
});

describe("buildCompactionPrompt (the regression pin against 'replace')", () => {
  it("APPENDS — the base prompt is always a prefix of the result", () => {
    const base = "Summarize this conversation";
    const result = buildCompactionPrompt(base, ["use tabs"]);
    expect(result.startsWith(base)).toBe(true);
    expect(result).toBe(base + "\n\nStanding instructions from the user, preserved verbatim across compaction:\n- use tabs");
  });

  it("returns the base prompt unchanged when there are no constraints", () => {
    expect(buildCompactionPrompt("base", [])).toBe("base");
    expect(buildCompactionPrompt("base", null)).toBe("base");
  });
});

describe("CONSTRAINT_EXTRACT_PROMPT (the contract string)", () => {
  it("is the verbatim extraction prompt", () => {
    expect(CONSTRAINT_EXTRACT_PROMPT).toContain("standing instruction");
    expect(CONSTRAINT_EXTRACT_PROMPT).toContain("VERBATIM");
    expect(CONSTRAINT_EXTRACT_PROMPT).toContain("No commentary, no numbering, no invention");
  });
});
