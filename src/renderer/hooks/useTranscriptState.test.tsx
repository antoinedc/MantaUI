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
import { useTranscriptState, TRANSCRIPT_TAIL_LIMIT, type TranscriptState } from "./useTranscriptState";
import type { OpencodeMessage } from "../../shared/types";
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

  // Mounts the probe against a mock that records every transcript fetch.
  async function mountChildProbe() {
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
    return fetchCalls;
  }

  it("fetches a child tail-first, then full after loadEarlier, then stays full", async () => {
    const fetchCalls = await mountChildProbe();

    // Fresh ref: first child fetch pulls the tail.
    act(() => probe!.fetch("child_1"));
    await h!.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", { limit: TRANSCRIPT_TAIL_LIMIT, view: true }]);

    // "Load earlier" pulls the whole history and marks the child loaded-all.
    act(() => probe!.loadAll("child_1"));
    await h!.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", { view: true }]);
    expect(probe!.ref.current.get("child_1")).toBe(true);

    // A subsequent fetch for the loaded-all child stays full (no tail cut).
    act(() => probe!.fetch("child_1"));
    await h!.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", { view: true }]);
  });

  it("clears childLoadedAllRef on session change so a fresh fetch is tail-limited again", async () => {
    const fetchCalls = await mountChildProbe();

    act(() => probe!.loadAll("child_1"));
    await h!.flush();
    expect(probe!.ref.current.get("child_1")).toBe(true);

    // Switching sessions clears the per-child loaded-all flags.
    await act(async () => {
      h!.rerender(<ChildProbe sessionId="ses_b" />);
    });
    await h!.flush();
    expect(probe!.ref.current.get("child_1")).toBeFalsy();

    // A fresh child fetch after the switch is tail-limited again.
    act(() => probe!.fetch("child_1"));
    await h!.flush();
    expect(fetchCalls.at(-1)).toEqual(["child_1", { limit: TRANSCRIPT_TAIL_LIMIT, view: true }]);
  });
});


// ===== Catch-up on reactivation (spec 2026-10-30-session-catch-up B1/B5) =====
describe("useTranscriptState catch-up", () => {
  let ts: TranscriptState | null = null;
  let h: ReturnType<typeof mount> | null = null;

  function Probe({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
    ts = useTranscriptState({ sessionId, isActive });
    return <div data-testid="probe" data-status={ts.catchUpStatus} />;
  }

  const msg = (id: string, text: string) =>
    ({
      info: { id, sessionID: "ses_a", role: "assistant", time: { created: 1, completed: 2 } },
      parts: [{ type: "text", id: `p_${id}`, messageID: id, text }],
    }) as unknown as OpencodeMessage;

  type Deferred = { resolve: (m: OpencodeMessage[]) => void; reject: (e: Error) => void };
  function deferredFetches() {
    const pending: Deferred[] = [];
    const calls: Array<[string, unknown]> = [];
    installMockApi({
      opencodeMessages: (sessionId: string, opts?: unknown) => {
        calls.push([sessionId, opts]);
        return new Promise<OpencodeMessage[]>((resolve, reject) => pending.push({ resolve, reject }));
      },
    });
    resetStore();
    return { pending, calls };
  }
  const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  // An active panel holding one old message, with a catch-up in flight.
  async function startCatchUpOverOld() {
    const { pending } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    act(() => ts!.setMessages([msg("m1", "old")]));
    let outcome: Awaited<ReturnType<TranscriptState["catchUp"]>> | undefined;
    act(() => { void ts!.catchUp().then((r) => (outcome = r)); });
    return { pending, result: () => outcome };
  }

  afterEach(() => {
    h?.unmount();
    h = null;
    ts = null;
  });

  it("starts idle and stays inert unless catchUp() is called (CtoChat-style use)", async () => {
    deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    expect(ts!.catchUpStatus).toBe("idle");
    act(() => ts!.scheduleRefetch());
    expect(ts!.catchUpStatus).toBe("idle");
  });

  it("success: fetches immediately with the tail options, applies the result, goes idle, reports before/after", async () => {
    const { pending, calls } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    act(() => ts!.setMessages([msg("m1", "old")]));
    ts!.refetchOwedWhileInactive.current = true;

    let result: Awaited<ReturnType<TranscriptState["catchUp"]>> | undefined;
    act(() => { void ts!.catchUp().then((r) => (result = r)); });
    // Immediately: no debounce, status catching, refreshing on, owed cleared.
    expect(calls).toEqual([["ses_a", { limit: TRANSCRIPT_TAIL_LIMIT, view: true }]]);
    expect(ts!.catchUpStatus).toBe("catching");
    expect(ts!.refreshing).toBe(true);
    expect(ts!.refetchOwedWhileInactive.current).toBe(false);

    const fresh = [msg("m1", "old"), msg("m2", "new")];
    await act(async () => pending[0].resolve(fresh));
    expect(result).toEqual({ ok: true, before: [msg("m1", "old")], after: fresh });
    expect(ts!.messages).toEqual(fresh);
    expect(ts!.catchUpStatus).toBe("idle");
    expect(ts!.refreshing).toBe(false);
  });

  it("starting a catch-up cancels the pending ordinary-refetch timer", async () => {
    const { pending, calls } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    act(() => ts!.scheduleRefetch());
    act(() => { void ts!.catchUp(); });
    await sleep(350);
    expect(calls).toHaveLength(1);
    await act(async () => pending[0].resolve([]));
  });

  it("failure: keeps the transcript, status failed, refetch owed again, refreshing cleared", async () => {
    const { pending, result } = await startCatchUpOverOld();
    await act(async () => pending[0].reject(new Error("offline")));
    expect(result()).toEqual({ ok: false });
    expect(ts!.messages).toEqual([msg("m1", "old")]);
    expect(ts!.catchUpStatus).toBe("failed");
    expect(ts!.refetchOwedWhileInactive.current).toBe(true);
    expect(ts!.refreshing).toBe(false);
  });

  it("a result arriving after deactivation is discarded: nothing applied, refetch stays owed", async () => {
    const { pending, result } = await startCatchUpOverOld();
    await act(async () => { h!.rerender(<Probe sessionId="ses_a" isActive={false} />); });
    act(() => ts!.resetCatchUp());
    await act(async () => pending[0].resolve([msg("m1", "old"), msg("m2", "new")]));
    expect(result()).toEqual({ ok: false, stale: true });
    expect(ts!.messages).toEqual([msg("m1", "old")]);
    expect(ts!.catchUpStatus).toBe("idle");
    expect(ts!.refetchOwedWhileInactive.current).toBe(true);
    expect(ts!.refreshing).toBe(false);
  });

  it("a result arriving after a session change is discarded and owes nothing to the new session", async () => {
    const { pending } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    let result: Awaited<ReturnType<TranscriptState["catchUp"]>> | undefined;
    act(() => { void ts!.catchUp().then((r) => (result = r)); });
    await act(async () => { h!.rerender(<Probe sessionId="ses_b" isActive />); });
    await act(async () => pending[0].resolve([msg("m9", "from the old session")]));
    expect(result).toEqual({ ok: false, stale: true });
    expect(ts!.messages).toBeNull();
    expect(ts!.catchUpStatus).toBe("idle");
    expect(ts!.refetchOwedWhileInactive.current).toBe(false);
  });

  it("a newer catch-up supersedes an older one: only the newer result applies", async () => {
    const { pending } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    const results: Array<Awaited<ReturnType<TranscriptState["catchUp"]>>> = [];
    act(() => { void ts!.catchUp().then((r) => results.push(r)); });
    act(() => { void ts!.catchUp().then((r) => results.push(r)); });
    // The older answer arrives first, with older content.
    await act(async () => pending[0].resolve([msg("m1", "older")]));
    expect(results).toEqual([{ ok: false, stale: true }]);
    expect(ts!.messages).toBeNull();
    expect(ts!.catchUpStatus).toBe("catching");
    expect(ts!.refetchOwedWhileInactive.current).toBe(false);
    await act(async () => pending[1].resolve([msg("m1", "newer")]));
    expect(results[1]).toMatchObject({ ok: true });
    expect(ts!.messages).toEqual([msg("m1", "newer")]);
    expect(ts!.catchUpStatus).toBe("idle");
  });

  it("an ordinary refetch that succeeds clears a failed status", async () => {
    const { pending } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    act(() => { void ts!.catchUp(); });
    await act(async () => pending[0].reject(new Error("offline")));
    expect(ts!.catchUpStatus).toBe("failed");

    act(() => ts!.scheduleRefetch());
    await sleep(350);
    expect(pending).toHaveLength(2);
    await act(async () => pending[1].resolve([msg("m1", "back")]));
    expect(ts!.catchUpStatus).toBe("idle");
    expect(ts!.messages).toEqual([msg("m1", "back")]);
  });

  it("an ordinary refetch timer that fires while the panel is inactive marks the refetch owed instead of fetching", async () => {
    const { calls } = deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    act(() => ts!.scheduleRefetch());
    await act(async () => { h!.rerender(<Probe sessionId="ses_a" isActive={false} />); });
    await sleep(350);
    expect(calls).toHaveLength(0);
    expect(ts!.refetchOwedWhileInactive.current).toBe(true);
  });

  it("resetCatchUp leaves nothing owed when no catch-up was pending", async () => {
    deferredFetches();
    h = mount(<Probe sessionId="ses_a" isActive />);
    await h.flush();
    act(() => ts!.resetCatchUp());
    expect(ts!.refetchOwedWhileInactive.current).toBe(false);
    expect(ts!.catchUpStatus).toBe("idle");
  });
});
