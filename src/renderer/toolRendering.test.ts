import { describe, it, expect } from "vitest";
import { bulletStyle } from "./ToolCall";
import type { OpencodePart } from "../shared/types";

// Build a tool part with a given lifecycle status.
function toolPart(status?: string): OpencodePart {
  return { type: "tool", tool: "bash", state: status ? { status } : {} } as unknown as OpencodePart;
}

describe("bulletStyle", () => {
  it("grey, no pulse for non-tool parts", () => {
    const text = { type: "text", text: "hi" } as unknown as OpencodePart;
    expect(bulletStyle(text)).toEqual({ color: "#5C6578", pulse: false });
  });

  it("green, no pulse for a completed tool", () => {
    expect(bulletStyle(toolPart("completed"))).toEqual({ color: "#22C79A", pulse: false });
  });

  it("red, no pulse for an errored tool", () => {
    expect(bulletStyle(toolPart("error"))).toEqual({ color: "#F0505F", pulse: false });
  });

  it("grey + pulse for running / pending / unknown-active tools", () => {
    expect(bulletStyle(toolPart("running"))).toEqual({ color: "#5C6578", pulse: true });
    expect(bulletStyle(toolPart("pending"))).toEqual({ color: "#5C6578", pulse: true });
    expect(bulletStyle(toolPart(undefined))).toEqual({ color: "#5C6578", pulse: true });
  });
});
