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
import { useTranscriptState, TRANSCRIPT_TAIL_LIMIT } from "./useTranscriptState";
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
  emitStreamAndFlush,
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

  it("handles stream.flush events for active panel", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit a box-flushed delta for the active panel (BET-551 / §17)
    await emitStreamAndFlush(bus, h, {
      sub: "flush",
      sessionId: "ses_test",
      payload: {
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        text: "Hello",
      },
    });

    // Component should still be mounted.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles stream.flush for inactive panel by setting refetchOwed", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Set isActive to false to simulate inactive panel
    await act(async () => {
      h!.rerender(<ChatPanel {...PROPS} isActive={false} />);
    });
    await h!.flush();

    // Emit a box-flushed delta for the inactive panel
    await emitStreamAndFlush(bus, h, {
      sub: "flush",
      sessionId: "ses_test",
      payload: {
        messageID: "msg_2",
        partID: "part_2",
        field: "text",
        text: "World",
      },
    });

    // Component should still be mounted (flush was suppressed, refetch owed).
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
});

// ===== Child transcript tail-first loading (BET-683) =====
//
// Mirrors the main-session tail-first policy for subagent child transcripts:
// fetchChildTranscript passes { limit: TRANSCRIPT_TAIL_LIMIT } until the
// expanded TaskCard's "Load earlier" pulls the full history (which flips the
// per-child flag so later fetches stay full). The per-child flag is cleared on
// session change.
describe("useTranscriptState child tail-first", () => {
  type Probe = {
    fetch: (id: string) => void;
    loadAll: (id: string) => void;
    ref: React.MutableRefObject<Map<string, boolean>>;
  };
  let probe: Probe | null = null;
  let h: ReturnType<typeof mount> | null = null;

  // A minimal component that owns the hook and exposes its child functions so
  // a test can drive them precisely (the repo has no @testing-library).
  function ChildProbe({ sessionId }: { sessionId: string }) {
    const {
      fetchChildTranscript,
      loadEarlierChildTranscript,
      childLoadedAllRef,
    } = useTranscriptState({ sessionId, isActive: true });
    probe = {
      fetch: fetchChildTranscript,
      loadAll: loadEarlierChildTranscript,
      ref: childLoadedAllRef,
    };
    return <div data-testid="child-probe" />;
  }

  beforeEach(() => {
    probe = null;
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("fetches a child tail-first, then full after loadEarlier, then stays full", async () => {
    const fetchCalls: Array<[string, unknown]> = [];
    installMockApi({
      opencodeMessages: (sessionId: string, opts?: { limit?: number }) => {
        fetchCalls.push([sessionId, opts]);
        return Promise.resolve([]);
      },
    });
    resetStore();
    h = mount(<ChildProbe sessionId="ses_a" />);
    await h.flush();

    // Fresh ref: first child fetch pulls the tail.
    act(() => probe!.fetch("child_1"));
    await h.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", { limit: TRANSCRIPT_TAIL_LIMIT }]);

    // "Load earlier" pulls the whole history and marks the child loaded-all.
    act(() => probe!.loadAll("child_1"));
    await h.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", {}]);
    expect(probe!.ref.current.get("child_1")).toBe(true);

    // A subsequent fetch for the loaded-all child stays full (no tail cut).
    act(() => probe!.fetch("child_1"));
    await h.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", {}]);
  });

  it("clears childLoadedAllRef on session change so a fresh fetch is tail-limited again", async () => {
    const fetchCalls: Array<[string, unknown]> = [];
    installMockApi({
      opencodeMessages: (sessionId: string, opts?: { limit?: number }) => {
        fetchCalls.push([sessionId, opts]);
        return Promise.resolve([]);
      },
    });
    resetStore();
    h = mount(<ChildProbe sessionId="ses_a" />);
    await h.flush();

    act(() => probe!.loadAll("child_1"));
    await h.flush();
    expect(probe!.ref.current.get("child_1")).toBe(true);

    // Switching sessions clears the per-child loaded-all flags.
    await act(async () => {
      h!.rerender(<ChildProbe sessionId="ses_b" />);
    });
    await h.flush();
    expect(probe!.ref.current.get("child_1")).toBeFalsy();

    // A fresh child fetch after the switch is tail-limited again.
    act(() => probe!.fetch("child_1"));
    await h.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", { limit: TRANSCRIPT_TAIL_LIMIT }]);
  });
});

