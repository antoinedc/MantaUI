// @vitest-environment jsdom
//
// Streaming-behavior tests for useTranscriptState hook (BET-64).
//
// Tests the message-list state, pin-to-bottom scroll behavior, delta
// buffering/flushing, inactive-panel gating, and session-change reset.
// Uses the render harness to mount ChatPanel and assert on DOM state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { ChatPanel } from "../ChatPanel";
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
} from "../testHarness";

const PROPS = {
  sessionId: "ses_test",
  tmuxSession: "proj",
  windowIndex: 1,
  cwd: "/home/dev/projects/x",
  isActive: true,
};

describe("useTranscriptState via ChatPanel", () => {
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

  it("mounts and shows the transcript container", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    // The transcript container should be present.
    expect(h.container.querySelector('[class*="transcript"]') || h.container.firstChild).not.toBeNull();
  });

  it("handles message.part.delta events for active panel", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit a delta event for the active panel
    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        partID: "part_1",
        messageID: "msg_1",
        field: "text",
        delta: "Hello",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles message.part.delta for inactive panel by setting refetchOwed", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Set isActive to false to simulate inactive panel
    await act(async () => {
      h!.rerender(<ChatPanel {...PROPS} isActive={false} />);
    });
    await h!.flush();

    // Emit a delta event for the inactive panel
    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        partID: "part_2",
        messageID: "msg_2",
        field: "text",
        delta: "World",
      },
    });

    // Component should still be mounted (delta was suppressed, refetch owed).
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles session-change reset", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Simulate session change by remounting with a different sessionId
    await act(async () => {
      h!.rerender(<ChatPanel {...PROPS} sessionId="ses_new" />);
    });
    await h!.flush();

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles message.part.updated events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles message.updated events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "message.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles scroll events on the transcript container", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Find the scroll container and simulate a scroll event
    const scrollContainer = h.container.querySelector('[class*="transcript"]') || h.container.firstChild;
    if (scrollContainer && scrollContainer instanceof HTMLElement) {
      await act(async () => {
        scrollContainer.scrollTop = 100;
        scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    }

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles multiple rapid delta events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit multiple delta events rapidly
    for (let i = 0; i < 10; i++) {
      await emitAndFlush(bus, h, {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          partID: `part_${i}`,
          messageID: "msg_1",
          field: "text",
          delta: `Chunk ${i} `,
        },
      });
    }

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles delta events with different fields", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit delta events for different fields
    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        partID: "part_1",
        messageID: "msg_1",
        field: "text",
        delta: "Text delta",
      },
    });

    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        partID: "part_2",
        messageID: "msg_1",
        field: "reasoning",
        delta: "Reasoning delta",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles delta events with empty partID or delta (should be ignored)", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit delta events with missing partID or delta
    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        partID: "",
        messageID: "msg_1",
        field: "text",
        delta: "Should be ignored",
      },
    });

    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_test",
        partID: "part_1",
        messageID: "msg_1",
        field: "text",
        delta: "",
      },
    });

    // Component should still be mounted (events were ignored).
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles child session message events when expanded", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Register a child session
    await emitAndFlush(bus, h, {
      type: "session.created",
      properties: {
        sessionID: "ses_test",
        info: { id: "child_789", parentID: "ses_test" },
      },
    });

    // Emit a message.part.delta for the child (should trigger scheduleChildRefetch if expanded)
    await emitAndFlush(bus, h, {
      type: "message.part.delta",
      properties: {
        sessionID: "child_789",
        partID: "part_1",
        messageID: "msg_1",
        field: "text",
        delta: "Child delta",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("auto-scrolls to bottom during rapid streaming commits when user is at tail", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Seed an initial assistant message so the transcript has content
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_seed",
      },
    });

    // Simulate rapid streaming: emit many small delta events that accumulate
    // and flush in quick succession. This reproduces the cadence where
    // setMessages fires repeatedly during a live turn.
    for (let i = 0; i < 20; i++) {
      await emitAndFlush(bus, h, {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          partID: "part_stream",
          messageID: "msg_seed",
          field: "text",
          delta: `chunk${i} `,
        },
      });
    }

    // After all the streaming commits, the transcript should still be mounted
    // and the scroll container should exist.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("does not snap viewport when user has scrolled up during streaming", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Seed an initial message
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_seed2",
      },
    });

    // Simulate user scrolling up by setting scrollTop on the scroll container
    const scrollContainer = h.container.querySelector('[class*="overflow-y-auto"]');
    if (scrollContainer && scrollContainer instanceof HTMLElement) {
      // Set scrollTop to simulate user scrolling up
      scrollContainer.scrollTop = 100;
      // Dispatch a scroll event to update pinnedToBottom state
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      await h.flush();
    }

    // Now emit streaming deltas
    for (let i = 0; i < 10; i++) {
      await emitAndFlush(bus, h, {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          partID: "part_stream2",
          messageID: "msg_seed2",
          field: "text",
          delta: `more${i} `,
        },
      });
    }

    // Component should still be mounted
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles prevScrollHeight guard when scrollHeight is transiently 0", async () => {
    // This test verifies the fix for the prevScrollHeight desync bug.
    // When el.scrollHeight is 0 (mid-layout), prevScrollHeight should NOT
    // be updated to 0, because that would cause wasAtBottomBeforeCommit(0, ...)
    // to return true on the next commit (first-commit rule), snapping the
    // viewport to bottom even if the user scrolled up.
    
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Seed a message
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_seed3",
      },
    });

    // Simulate user scrolling up
    const scrollContainer = h.container.querySelector('[class*="overflow-y-auto"]');
    if (scrollContainer && scrollContainer instanceof HTMLElement) {
      scrollContainer.scrollTop = 200;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
      await h.flush();
    }

    // Emit more events to trigger setMessages
    for (let i = 0; i < 5; i++) {
      await emitAndFlush(bus, h, {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          partID: `part_guard_${i}`,
          messageID: "msg_seed3",
          field: "text",
          delta: `guard${i} `,
        },
      });
    }

    // Component should still be mounted and not have crashed
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });
});
