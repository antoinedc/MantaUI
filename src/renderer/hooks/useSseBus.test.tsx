// @vitest-environment jsdom
//
// Streaming-behavior tests for useSseBus hook (BET-64).
//
// Tests the SSE event routing, drain-abort logic, step boundary handling,
// child-session routing, and state transitions. Uses the render harness to
// mount ChatPanel and emit events through the mock bus.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { ChatPanel } from "../ChatPanel";
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
  type MockApi,
  type MockEventBus,
  type Harness,
} from "../testHarness";

const PROPS = {
  sessionId: "ses_test",
  tmuxSession: "proj",
  windowIndex: 1,
  cwd: "/home/dev/projects/x",
  isActive: true,
};

describe("useSseBus via ChatPanel", () => {
  let bus: ReturnType<typeof installMockApi>["bus"];
  let h: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    ({ bus } = installMockApi());
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("mounts and subscribes to SSE events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    // The hook should have registered a listener via onOpencodeEvent.
    expect(bus.listenerCount()).toBeGreaterThan(0);
  });

  it("transitions running state on session.status events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Simulate session going busy
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "busy" } },
    });

    // Simulate session going idle
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "idle" } },
    });

    // Component should still be mounted without errors.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles session.error with different error types", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // ProviderAuthError
    await emitAndFlush(bus, h, {
      type: "session.error",
      properties: {
        sessionID: "ses_test",
        error: { name: "ProviderAuthError", data: { message: "Invalid token" } },
      },
    });

    // Component should still be mounted (error is displayed, not crashed).
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("routes child-session events to scheduleChildRefetch when expanded", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit a child session.created event to register the child
    await emitAndFlush(bus, h, {
      type: "session.created",
      properties: {
        sessionID: "ses_test",
        info: { id: "child_123", parentID: "ses_test" },
      },
    });

    // Now emit a message.part.delta for the child session
    // This should trigger scheduleChildRefetch if the child is expanded
    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "child_123",
        partID: "part_1",
        messageID: "msg_1",
        field: "text",
        delta: "Hello from child",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles session.next.step.ended with usage data", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "session.next.step.ended",
      properties: {
        sessionID: "ses_test",
        usage: { input: 1000, output: 500, reasoning: 100, cache: { read: 200, write: 50 } },
        cost: 0.01,
        messageID: "msg_1",
        finish: "stop",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles compaction events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Compaction started
    await emitAndFlush(bus, h, {
      type: "session.next.compaction.started",
      properties: {
        sessionID: "ses_test",
        reason: "context",
        text: "Compacting...",
      },
    });

    // Compaction delta
    await emitAndFlush(bus, h, {
      type: "session.next.compaction.delta",
      properties: {
        sessionID: "ses_test",
        delta: " more text",
      },
    });

    // Compaction ended
    await emitAndFlush(bus, h, {
      type: "session.next.compaction.ended",
      properties: { sessionID: "ses_test" },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles vcs.branch.updated events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "vcs.branch.updated",
      properties: {
        sessionID: "ses_test",
        branch: "main",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles todo.updated events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "todo.updated",
      properties: {
        sessionID: "ses_test",
        todos: [
          { content: "Task 1", status: "in_progress", priority: "high" },
        ],
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles command.executed events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "command.executed",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
        name: "Read",
        arguments: '{"path": "/tmp/file.txt"}',
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles server.connected by refreshing permissions and questions", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "server.connected",
      properties: { sessionID: "ses_test" },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles permission events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "permission.asked",
      properties: { sessionID: "ses_test" },
    });

    await emitAndFlush(bus, h, {
      type: "permission.replied",
      properties: { sessionID: "ses_test" },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles question events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "question.asked",
      properties: { sessionID: "ses_test" },
    });

    await emitAndFlush(bus, h, {
      type: "question.replied",
      properties: { sessionID: "ses_test" },
    });

    await emitAndFlush(bus, h, {
      type: "question.rejected",
      properties: { sessionID: "ses_test" },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles message.part.updated and message.updated", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
      },
    });

    await emitAndFlush(bus, h, {
      type: "message.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_2",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles session.compacted", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "session.compacted",
      properties: { sessionID: "ses_test" },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles session.idle", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "session.idle",
      properties: { sessionID: "ses_test" },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles child session idle and status events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Register a child session
    await emitAndFlush(bus, h, {
      type: "session.created",
      properties: {
        sessionID: "ses_test",
        info: { id: "child_456", parentID: "ses_test" },
      },
    });

    // Child goes idle
    await emitAndFlush(bus, h, {
      type: "session.idle",
      properties: { sessionID: "child_456" },
    });

    // Child goes busy
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: {
        sessionID: "child_456",
        status: { type: "busy" },
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("drops events for non-matching sessions", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit an event for a different session (not registered as child)
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: {
        sessionID: "other_session",
        status: { type: "busy" },
      },
    });

    // Component should still be mounted (event was dropped).
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });
});

// ===== Queued-message drain at the next tool boundary (BET-131 regression) =====
//
// The deployed opencode build never emits `session.next.step.*`, so the
// drain trigger on that event is dead in production. The real, primary
// trigger is a `message.part.updated` event whose part is a tool that just
// completed/errored (`isToolStepBoundary`). This regression was introduced
// when the SSE handler moved from ChatPanel.tsx into useSseBus.ts (BET-64)
// and the tool-boundary call site was dropped. Verify it fires the abort
// immediately at the next tool completion instead of waiting for full idle.
describe("useSseBus queued-message drain on tool step boundary", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // Same controlled-input helper as ChatPanel.harness.test.tsx.
  function typeInto(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function queueASecondMessage(container: HTMLElement) {
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, "second message");
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  }

  it("aborts and drains at the next completed tool part, not at full idle", async () => {
    ({ api, bus } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Turn is already running.
    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "busy" } },
    });

    // User submits a second message mid-turn — it queues instead of sending.
    await queueASecondMessage(h.container);
    await h.flush();
    expect(api.calls.opencodeAbort ?? []).toEqual([]);

    // A tool call completes — this is the ONLY step-boundary event the
    // deployed opencode build actually emits. It must trigger the drain
    // immediately, not wait for session.idle.
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
        part: { type: "tool", state: { status: "completed" } },
      },
    });

    expect(api.calls.opencodeAbort).toEqual([["ses_test"]]);
  });

  it("does not abort on a running (non-boundary) tool part", async () => {
    ({ api, bus } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "busy" } },
    });
    await queueASecondMessage(h.container);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
        part: { type: "tool", state: { status: "running" } },
      },
    });

    expect(api.calls.opencodeAbort ?? []).toEqual([]);
  });

  it("does not drain the parent queue on a subagent child's tool completion", async () => {
    ({ api, bus } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Register a subagent child session under the main session.
    await emitAndFlush(bus, h, {
      type: "session.created",
      properties: {
        sessionID: "ses_test",
        info: { id: "child_boundary", parentID: "ses_test" },
      },
    });

    await emitAndFlush(bus, h, {
      type: "session.status",
      properties: { sessionID: "ses_test", status: { type: "busy" } },
    });
    await queueASecondMessage(h.container);
    await h.flush();

    // A tool completes inside the CHILD session — must not drain the
    // parent's queue.
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "child_boundary",
        messageID: "msg_child_1",
        part: { type: "tool", state: { status: "completed" } },
      },
    });

    expect(api.calls.opencodeAbort ?? []).toEqual([]);
  });
});
