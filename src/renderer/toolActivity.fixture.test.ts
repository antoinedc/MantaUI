// Parity fixture for the tool-activity wording and run grouping.
//
// `src/shared/fixtures/tool-activity-cases.json` is the contract between this
// module and the native iOS port (mobile/native/MantaUI/ToolActivity.swift). THIS
// test asserts the desktop output equals the fixture; ToolActivityTests.swift
// asserts the Swift output equals the same file. It generates nothing — if the
// wording here changes without the fixture, this suite goes red, and if the
// fixture changes without the Swift port, the iOS suite does.

import { describe, it, expect } from "vitest";
import fixture from "../shared/fixtures/tool-activity-cases.json";
import type { OpencodeMessage, OpencodePart } from "../shared/types";
import { describeActivity, layoutTranscript, summarizeToolGroup } from "./toolActivity";

type DescribeCase = {
  name: string;
  part: unknown;
  expect: {
    kind: string;
    status: string;
    running: string;
    done: string;
    failed: string;
    label: string;
    counted: boolean;
  };
};
type SummarizeCase = {
  name: string;
  parts: unknown[];
  expect: { label: string; calls: number; failed: number; running: boolean; live: string | null };
};
type LayoutCase = {
  name: string;
  running: boolean;
  showThinking: boolean;
  messages: unknown[];
  expect: { blocks: Record<string, string[]>; trailing: string | null };
};

const cases = fixture as unknown as {
  describe: DescribeCase[];
  summarize: SummarizeCase[];
  layout: LayoutCase[];
};

describe("tool-activity parity fixture", () => {
  it("is big enough to be a contract", () => {
    expect(cases.describe.length + cases.summarize.length).toBeGreaterThanOrEqual(25);
    expect(cases.layout.length).toBeGreaterThanOrEqual(6);
  });

  it("has unique case names", () => {
    for (const group of [cases.describe, cases.summarize, cases.layout]) {
      const names = group.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  describe("describeActivity", () => {
    for (const c of cases.describe) {
      it(c.name, () => {
        const a = describeActivity(c.part as OpencodePart);
        expect({
          kind: a.kind,
          status: a.status,
          running: a.running,
          done: a.done,
          failed: a.failed,
          label: a.label,
          counted: a.counted,
        }).toEqual(c.expect);
      });
    }
  });

  describe("summarizeToolGroup", () => {
    for (const c of cases.summarize) {
      it(c.name, () => {
        const s = summarizeToolGroup(c.parts as OpencodePart[]);
        expect({
          label: s.label,
          calls: s.calls,
          failed: s.failed,
          running: s.running,
          live: s.live ? s.live.running : null,
        }).toEqual(c.expect);
      });
    }
  });

  describe("layoutTranscript", () => {
    for (const c of cases.layout) {
      it(c.name, () => {
        const l = layoutTranscript(c.messages as OpencodeMessage[], {
          running: c.running,
          showThinking: c.showThinking,
        });
        const blocks: Record<string, string[]> = {};
        for (const [id, bs] of l.blocksByMessage) {
          blocks[id] = bs.map((b) =>
            b.kind === "tools" ? `tools:${b.group.items.map((i) => i.id).join(",")}` : `part:${b.part.id}`,
          );
        }
        expect({
          blocks,
          trailing: l.trailing ? l.trailing.items.map((i) => i.id).join(",") : null,
        }).toEqual(c.expect);
      });
    }
  });
});
