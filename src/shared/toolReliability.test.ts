import { describe, it, expect } from "vitest";
import {
  classifyToolCall,
  aggregateReliability,
  shouldDerank,
  MIN_SAMPLE_REQUESTS,
} from "./toolReliability.mjs";
import type { ToolCall, ToolDef } from "./toolReliability.mjs";

// A tool with a compileable schema: `path` required-string, `count` integer,
// `mode` enum.
const readDef: ToolDef = {
  name: "read",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      count: { type: "integer" },
      mode: { type: "string", enum: ["auto", "manual"] },
    },
    required: ["path"],
  },
};

function asStr(c: ToolCall): ToolCall {
  return {
    ...c,
    arguments:
      typeof c.arguments === "object" && c.arguments !== null
        ? JSON.stringify(c.arguments)
        : c.arguments,
  };
}

describe("classifyToolCall", () => {
  const tools: Record<string, ToolDef> = { read: readDef };

  it("classifies a valid call as valid", () => {
    expect(classifyToolCall({ name: "read", arguments: { path: "/x", count: 2 } }, tools)).toBe("valid");
  });

  it("detects each of the three error classes", () => {
    // invalid-json: a string that does not parse.
    expect(classifyToolCall({ name: "read", arguments: "{not json" }, tools)).toBe("invalid-json");
    // invalid-json: arguments missing entirely.
    expect(classifyToolCall({ name: "read" }, tools)).toBe("invalid-json");
    // unknown-name: not in the request's tool list.
    expect(classifyToolCall({ name: "nope", arguments: {} }, tools)).toBe("unknown-name");
    // schema-mismatch: required key absent, but otherwise well-formed JSON.
    expect(classifyToolCall({ name: "read", arguments: { count: 2 } }, tools)).toBe("schema-mismatch");
    // schema-mismatch: declared type violated.
    expect(classifyToolCall({ name: "read", arguments: { path: 123 } }, tools)).toBe("schema-mismatch");
    // schema-mismatch: enum value out of range.
    expect(classifyToolCall({ name: "read", arguments: { path: "/x", mode: "turbo" } }, tools)).toBe(
      "schema-mismatch",
    );
  });

  it("invalid-json is detected from a stored (object) argument shape too", () => {
    expect(classifyToolCall({ name: "read", arguments: undefined }, tools)).toBe("invalid-json");
  });

  it("accepts a JSON-string argument value identically to an object", () => {
    const asString = asStr({ name: "read", arguments: { path: "/x", count: 3 } });
    expect(classifyToolCall(asString, tools)).toBe("valid");
  });

  it("a tool with no schema is always valid, even when its arguments are odd", () => {
    const bare: Record<string, ToolDef> = { bare: { name: "bare" } };
    expect(classifyToolCall({ name: "bare", arguments: {} }, bare)).toBe("valid");
    // Uncompileable schema (a string where an object is expected) → valid.
    const broken: Record<string, ToolDef> = { broken: { name: "broken", input_schema: "nope" as unknown } };
    expect(classifyToolCall({ name: "broken", arguments: {} }, broken)).toBe("valid");
  });

  it("with no tool list at all, unknown-name/schema checks are skipped (conservative)", () => {
    // No tools → nothing to be unknown against, nothing to violate → valid.
    expect(classifyToolCall({ name: "anything", arguments: {} }, null)).toBe("valid");
    expect(classifyToolCall({ name: "anything", arguments: {} }, {})).toBe("valid");
    // …but a genuinely unparseable argument is STILL invalid-json.
    expect(classifyToolCall({ name: "anything", arguments: "{bad" }, null)).toBe("invalid-json");
  });

  it("accepts a Map tool list and a missing name is unknown-name", () => {
    const map = new Map<string, ToolDef>([["read", readDef]]);
    expect(classifyToolCall({ name: "read", arguments: { path: "/x" } }, map)).toBe("valid");
    expect(classifyToolCall({ arguments: {} }, map)).toBe("unknown-name");
  });
});

describe("aggregateReliability", () => {
  const tools = [readDef];

  it("aggregates at request level: 5 calls / 1 bad = 1 errored request", () => {
    const request = {
      toolCalls: [
        { name: "read", arguments: { path: "/a" } },
        { name: "read", arguments: { path: "/b" } },
        { name: "read", arguments: { path: "/c" } },
        { name: "read", arguments: { path: "/d" } },
        { name: "read", arguments: { path: 42 } }, // schema-mismatch → bad
      ],
      tools,
    };
    expect(aggregateReliability([request])).toEqual({ requests: 1, errored: 1, rate: 1 });
  });

  it("counts a request only if it ended in tool calls", () => {
    const res = aggregateReliability([
      { toolCalls: [], tools },
      { toolCalls: [{ name: "read", arguments: { path: "/a" } }], tools },
      { toolCalls: [{ name: "read", arguments: { path: "/b" } }], tools },
    ]);
    // Two tool-ending requests, both clean → rate 0.
    expect(res).toEqual({ requests: 2, errored: 0, rate: 0 });
  });

  it("is safe on empty/null input", () => {
    expect(aggregateReliability([])).toEqual({ requests: 0, errored: 0, rate: 0 });
    expect(aggregateReliability(null)).toEqual({ requests: 0, errored: 0, rate: 0 });
  });

  it("skips unknown-name/schema checks when no tools are attached to a request", () => {
    const res = aggregateReliability([
      { toolCalls: [{ name: "anything", arguments: {} }] }, // no tools → valid
    ]);
    expect(res).toEqual({ requests: 1, errored: 0, rate: 0 });
  });
});

describe("shouldDerank", () => {
  const baseline = { rate: 0.1, n: 1000 };

  it("below the sample floor: never penalise, even at a 100% error rate", () => {
    const sample = { requests: MIN_SAMPLE_REQUESTS - 1, errored: MIN_SAMPLE_REQUESTS - 1, rate: 1 };
    expect(sample.requests).toBeLessThan(MIN_SAMPLE_REQUESTS);
    expect(shouldDerank(sample, baseline)).toEqual({
      penalise: false,
      reason: expect.stringContaining("floor"),
    });
  });

  it("at/above the floor, materially worse than baseline → penalise", () => {
    const sample = { requests: 50, errored: 10, rate: 0.2 };
    expect(shouldDerank(sample, baseline).penalise).toBe(true);
  });

  it("equal to baseline → do not penalise", () => {
    const sample = { requests: 50, errored: 5, rate: 0.1 };
    expect(sample.rate).toBe(baseline.rate);
    expect(shouldDerank(sample, baseline).penalise).toBe(false);
  });

  it("close to baseline (within a sigma) → do not penalise", () => {
    // threshold ≈ 0.1 + 1*sqrt(0.09/1000) ≈ 0.10949; 0.105 is inside.
    const sample = { requests: 60, errored: 6, rate: 0.1 };
    expect(shouldDerank(sample, { rate: 0.1, n: 5000 }).penalise).toBe(false);
  });

  it("no baseline → never penalise", () => {
    const sample = { requests: 50, errored: 25, rate: 0.5 };
    expect(shouldDerank(sample, undefined).penalise).toBe(false);
    expect(shouldDerank(sample, null).penalise).toBe(false);
  });

  it("a single-endpoint baseline (n<=1) is no baseline → never penalise", () => {
    const sample = { requests: 50, errored: 25, rate: 0.5 };
    expect(shouldDerank(sample, { rate: 0.1, n: 1 }).penalise).toBe(false);
  });

  it("penalise reasons are descriptive when they fire", () => {
    const sample = { requests: 50, errored: 25, rate: 0.5 };
    const res = shouldDerank(sample, { rate: 0.1, n: 1000 });
    expect(res.penalise).toBe(true);
    expect(res.reason).toContain("exceeds baseline");
  });
});
