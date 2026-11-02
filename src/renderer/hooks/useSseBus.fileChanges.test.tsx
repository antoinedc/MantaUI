// @vitest-environment jsdom
//
// File-change invalidation wiring in useSseBus: a file-changing tool reaching a
// terminal state (frame `toolBoundary`) in this session or one of its subagent
// sessions bumps the file generation path links / the Explorer watch; a stream
// resync bumps every session's.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChatPanel } from "../ChatPanel";
import { getFileGeneration } from "../explorer/fileChanges";
import {
  installMockApi,
  resetStore,
  mount,
  emitStreamAndFlush,
  type MockEventBus,
  type Harness,
} from "../testHarness";

const SES = "ses_fc_parent";
const CHILD = "ses_fc_child";
const PROPS = { sessionId: SES, tmuxSession: "proj", windowIndex: 1, cwd: "/home/dev/projects/x", isActive: true };

const boundary = (sessionId: string, tool: string, status = "completed") => ({
  sub: "toolBoundary" as const,
  sessionId,
  payload: { messageID: "m1", partID: "p1", callID: "c1", tool, status },
});

describe("useSseBus file-change invalidation", () => {
  let bus: MockEventBus;
  let h: Harness | null = null;

  beforeEach(async () => {
    ({ bus } = installMockApi());
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it.each(["edit", "write", "multiedit", "patch", "apply_patch", "bash", "shell"])(
    "bumps this session when %s finishes",
    async (tool) => {
      const before = getFileGeneration(SES);
      await emitStreamAndFlush(bus, h!, boundary(SES, tool));
      expect(getFileGeneration(SES)).toBe(before + 1);
    },
  );

  it("also bumps when the tool failed (it may have changed files before failing)", async () => {
    const before = getFileGeneration(SES);
    await emitStreamAndFlush(bus, h!, boundary(SES, "bash", "error"));
    expect(getFileGeneration(SES)).toBe(before + 1);
  });

  it("ignores tools that cannot change files", async () => {
    const before = getFileGeneration(SES);
    for (const tool of ["read", "grep", "glob", "list", "webfetch", "task"]) {
      await emitStreamAndFlush(bus, h!, boundary(SES, tool));
    }
    expect(getFileGeneration(SES)).toBe(before);
  });

  it("a subagent's file-changing tool bumps the child AND the parent", async () => {
    await emitStreamAndFlush(bus, h!, {
      sub: "childSession",
      sessionId: SES,
      payload: { childSessionId: CHILD, parentSessionId: SES },
    });
    const parentBefore = getFileGeneration(SES);
    const childBefore = getFileGeneration(CHILD);
    await emitStreamAndFlush(bus, h!, boundary(CHILD, "edit"));
    expect(getFileGeneration(SES)).toBe(parentBefore + 1);
    expect(getFileGeneration(CHILD)).toBe(childBefore + 1);
  });

  it("ignores unrelated sessions", async () => {
    const before = getFileGeneration(SES);
    const otherBefore = getFileGeneration("ses_fc_stranger");
    await emitStreamAndFlush(bus, h!, boundary("ses_fc_stranger", "edit"));
    expect(getFileGeneration(SES)).toBe(before);
    expect(getFileGeneration("ses_fc_stranger")).toBe(otherBefore);
  });

  it("a resync bumps every session", async () => {
    const before = getFileGeneration(SES);
    const otherBefore = getFileGeneration("ses_fc_stranger");
    await emitStreamAndFlush(bus, h!, { sub: "resync", sessionId: "", payload: {} });
    expect(getFileGeneration(SES)).toBeGreaterThan(before);
    expect(getFileGeneration("ses_fc_stranger")).toBeGreaterThan(otherBefore);
  });
});
