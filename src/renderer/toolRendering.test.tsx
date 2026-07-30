// @vitest-environment jsdom
//
// Pure-rendering tests for tool part rendering. The `bulletStyle` cases live
// in the default (node) test env and run unchanged. The `TaskBody` cases
// below need jsdom because they mount a real React subtree via
// `./testHarness`.

import { describe, it, expect, afterEach } from "vitest";
import { bulletStyle } from "./ToolCall";
import { cssVar } from "./chatUtils";
import { ToolCall } from "./ToolCall";
import {
  installMockApi,
  mount,
  type Harness,
} from "./testHarness";
import type { OpencodePart } from "../shared/types";

// Build a tool part with a given lifecycle status.
function toolPart(status?: string): OpencodePart {
  return { type: "tool", tool: "bash", state: status ? { status } : {} } as unknown as OpencodePart;
}

// A minimal task tool part that extractSubagentInfo accepts (it requires
// state.metadata.sessionId to be present, otherwise it returns null and the
// TaskBody card doesn't render at all).
function taskPart(input: Record<string, unknown> = {}): OpencodePart {
  return {
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      input,
      metadata: { sessionId: "ses_child" },
      time: { start: 0, end: 18000 },
    },
  } as unknown as OpencodePart;
}

describe("bulletStyle", () => {
  it("grey, no pulse for non-tool parts", () => {
    const text = { type: "text", text: "hi" } as unknown as OpencodePart;
    expect(bulletStyle(text)).toEqual({ color: cssVar("--tx4"), pulse: false });
  });

  it("green, no pulse for a completed tool", () => {
    expect(bulletStyle(toolPart("completed"))).toEqual({ color: cssVar("--ok"), pulse: false });
  });

  it("red, no pulse for an errored tool", () => {
    expect(bulletStyle(toolPart("error"))).toEqual({ color: cssVar("--danger"), pulse: false });
  });

  it("grey + pulse for running / pending / unknown-active tools", () => {
    expect(bulletStyle(toolPart("running"))).toEqual({ color: cssVar("--tx4"), pulse: true });
    expect(bulletStyle(toolPart("pending"))).toEqual({ color: cssVar("--tx4"), pulse: true });
    expect(bulletStyle(toolPart(undefined))).toEqual({ color: cssVar("--tx4"), pulse: true });
  });
});

describe("TaskBody subagent row", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the agent name once, on the chevron line (no duplicate in meta row)", () => {
    // The harness installs a mock window.api so any module-level access from
    // ToolCall's transitive imports doesn't blow up.
    installMockApi();
    h = mount(
      <ToolCall
        part={taskPart({ description: "Find where skills are loaded", subagent_type: "explore" })}
        verbose={false}
      />,
    );
    const text = h.text();
    const matches = text.match(/explore/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("still renders the agent name when description is empty (row is unconditional)", () => {
    installMockApi();
    h = mount(
      <ToolCall
        part={taskPart({ subagent_type: "explore" })}
        verbose={false}
      />,
    );
    expect(h.text()).toContain("explore");
  });

  it("falls back to 'subagent' when subagent_type is absent (from extractSubagentInfo)", () => {
    installMockApi();
    h = mount(
      <ToolCall
        part={taskPart({ description: "Find where skills are loaded" })}
        verbose={false}
      />,
    );
    // The extractSubagentInfo fallback in chatUtils.ts is the literal
    // string "subagent"; the badge text is the only place that string can
    // appear when subagent_type is absent.
    expect(h.text()).toContain("subagent");
  });
});
