// @vitest-environment jsdom
//
// OpenCode V2 slice A2: useSseBus consumes ONLY interpreted `stream` frames.
// These tests drive the hook directly (a probe component with stubbed
// collaborators) so each row of the raw-event → frame mapping table in
// docs/superpowers/specs/2026-10-16-opencode-v2-slices-a2-b2.md is asserted at
// the seam: which collaborator is called, with what.
//
// Frames are delivered two ways, on purpose:
//   - `bus.emitStream(frame)`  pins a frame shape directly;
//   - `bus.emit(rawV1Event)`   replays a raw V1 opencode event through the REAL
//     box interpreter (testHarness), so the end-to-end mapping — including the
//     messageID-path trap and the step-finish → stepEnded derivation — is
//     exercised with no hand-written frame to drift from it.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, useRef } from "react";
import { useSseBus, type SseBus } from "./useSseBus";
import { installMockApi, resetStore, mount } from "../testHarness";
import type { StreamEnvelope } from "../../shared/types";

const SID = "ses_test";
const CHILD = "ses_child";

type Fn = Mock<(...args: unknown[]) => unknown>;
type Stubs = {
  setMessages: Fn;
  setRefreshing: Fn;
  scheduleRefetch: Fn;
  spliceMessage: Fn;
  scheduleChildRefetch: Fn;
  applyStreamFlush: Fn;
  submit: Fn;
  setPlanOn: Fn;
  childSessionIds: { current: Set<string> };
  expandedTasksRef: { current: Set<string> };
};

let bus!: SseBus;
let stubs!: Stubs;
let providerID: string | null = "anthropic";

function Probe() {
  const submitRef = useRef<(t?: string) => void>(() => {});
  submitRef.current = (t) => stubs.submit(t);
  bus = useSseBus({
    sessionId: SID,
    cwd: "/x",
    setMessages: stubs.setMessages as never,
    setRefreshing: stubs.setRefreshing as never,
    scheduleRefetch: stubs.scheduleRefetch as never,
    fetchOpts: () => ({}),
    spliceMessage: stubs.spliceMessage as never,
    scheduleChildRefetch: stubs.scheduleChildRefetch as never,
    childSessionIds: stubs.childSessionIds as never,
    childMessagesRef: { current: new Map() },
    expandedTasksRef: stubs.expandedTasksRef as never,
    childRefetchTimers: { current: new Map() },
    isActiveRef: { current: true },
    refetchOwedWhileInactive: { current: false },
    applyStreamFlush: stubs.applyStreamFlush as never,
    providerID,
    submit: (() => {}) as never,
    submitRef,
    setPlanOn: stubs.setPlanOn as never,
  });
  return null;
}

describe("useSseBus — interpreted frames (slice A2)", () => {
  let mockBus: ReturnType<typeof installMockApi>["bus"];
  let api: ReturnType<typeof installMockApi>["api"];
  let h: ReturnType<typeof mount> | null = null;

  const frame = (sub: string, payload: unknown, sessionId = SID): StreamEnvelope =>
    ({ sub, sessionId, payload }) as StreamEnvelope;
  const emit = async (ev: StreamEnvelope) => {
    act(() => mockBus.emitStream(ev));
    await h!.flush();
  };
  const emitRaw = async (ev: Parameters<typeof mockBus.emit>[0]) => {
    act(() => mockBus.emit(ev));
    await h!.flush();
  };

  async function mountProbe(overrides: Record<string, unknown> = {}) {
    ({ bus: mockBus, api } = installMockApi(overrides));
    resetStore();
    h = mount(<Probe />);
    await h.flush();
  }

  beforeEach(() => {
    providerID = "anthropic";
    stubs = {
      setMessages: vi.fn(),
      setRefreshing: vi.fn(),
      scheduleRefetch: vi.fn(),
      spliceMessage: vi.fn(),
      scheduleChildRefetch: vi.fn(),
      applyStreamFlush: vi.fn(() => 0),
      submit: vi.fn(),
      setPlanOn: vi.fn(),
      childSessionIds: { current: new Set() },
      expandedTasksRef: { current: new Set() },
    };
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  it("subscribes to frames only — never to raw opencode events", async () => {
    await mountProbe();
    expect(mockBus.streamListenerCount()).toBe(1);
    expect(mockBus.listenerCount()).toBe(0);
    h!.unmount();
    h = null;
    expect(mockBus.streamListenerCount()).toBe(0);
  });

  it("ignores frames for a session that is neither this one nor a known child", async () => {
    await mountProbe();
    await emit(frame("running", { running: true }, "ses_other"));
    await emit(frame("messageChanged", { messageID: "m" }, "ses_other"));
    expect(bus.running).toBe(false);
    expect(stubs.spliceMessage).not.toHaveBeenCalled();
    expect(stubs.scheduleChildRefetch).not.toHaveBeenCalled();
  });

  describe("messageChanged → targeted splice (keeps the per-message max-wait guard in spliceMessage)", () => {
    it("a frame splices exactly that message", async () => {
      await mountProbe();
      await emit(frame("messageChanged", { messageID: "msg_1" }));
      expect(stubs.spliceMessage).toHaveBeenCalledWith("msg_1");
    });

    it("a raw message.part.updated carrying the id ONLY on part.messageID still splices that message (the starvation trap)", async () => {
      await mountProbe();
      await emitRaw({
        type: "message.part.updated",
        properties: { sessionID: SID, part: { id: "prt_1", type: "text", messageID: "msg_part_path", sessionID: SID } },
      });
      expect(stubs.spliceMessage).toHaveBeenCalledWith("msg_part_path");
      expect(stubs.scheduleRefetch).not.toHaveBeenCalled(); // not the full-refetch fallback
    });

    it("message.updated (info.id), message.part.removed and message.removed all resolve their id", async () => {
      await mountProbe();
      await emitRaw({ type: "message.updated", properties: { sessionID: SID, info: { id: "msg_info", role: "user" } } });
      await emitRaw({ type: "message.part.removed", properties: { sessionID: SID, messageID: "msg_rm_part", partID: "p" } });
      await emitRaw({ type: "message.removed", properties: { sessionID: SID, messageID: "msg_rm" } });
      expect(stubs.spliceMessage.mock.calls.map((c) => c[0])).toEqual(["msg_info", "msg_rm_part", "msg_rm"]);
    });
  });

  describe("subagent child sessions", () => {
    it("childSession (published under the parent) admits the child's frames", async () => {
      await mountProbe();
      await emit(frame("childSession", { childSessionId: CHILD, parentSessionId: SID }));
      expect(stubs.childSessionIds.current.has(CHILD)).toBe(true);
    });

    it("raw session.created with info.parentID reaches the panel as a childSession frame", async () => {
      await mountProbe();
      await emitRaw({ type: "session.created", properties: { sessionID: CHILD, info: { id: CHILD, parentID: SID } } });
      expect(stubs.childSessionIds.current.has(CHILD)).toBe(true);
    });

    it("child messageChanged / flush refetch the child transcript ONLY while its card is expanded", async () => {
      await mountProbe();
      stubs.childSessionIds.current.add(CHILD);
      await emit(frame("messageChanged", { messageID: "c1" }, CHILD));
      await emit(frame("flush", { messageID: "c1", partID: "p1", field: "text", text: "hi" }, CHILD));
      expect(stubs.scheduleChildRefetch).not.toHaveBeenCalled();

      stubs.expandedTasksRef.current.add(CHILD);
      await emit(frame("messageChanged", { messageID: "c1" }, CHILD));
      await emit(frame("flush", { messageID: "c1", partID: "p1", field: "text", text: "hi" }, CHILD));
      expect(stubs.scheduleChildRefetch.mock.calls).toEqual([[CHILD], [CHILD]]);
      // a child's text is never spliced into / flushed onto the PARENT transcript
      expect(stubs.spliceMessage).not.toHaveBeenCalled();
      expect(stubs.applyStreamFlush).not.toHaveBeenCalled();
    });

    it("child running frames drive the live badge; going idle refetches the parent", async () => {
      await mountProbe();
      stubs.childSessionIds.current.add(CHILD);
      await emit(frame("running", { running: true, type: "busy" }, CHILD));
      expect(bus.liveChildStatus.get(CHILD)).toBe("running");
      expect(bus.running).toBe(false); // the child never flips the PARENT's running state
      expect(stubs.scheduleRefetch).not.toHaveBeenCalled();
      await emit(frame("running", { running: false, type: "idle" }, CHILD));
      expect(bus.liveChildStatus.get(CHILD)).toBe("idle");
      expect(stubs.scheduleRefetch).toHaveBeenCalledTimes(1);
    });

    it("a child's turnComplete (mid-turn flicker) does not move the badge", async () => {
      await mountProbe();
      stubs.childSessionIds.current.add(CHILD);
      await emit(frame("running", { running: true }, CHILD));
      await emit(frame("turnComplete", { complete: true, running: false }, CHILD));
      expect(bus.liveChildStatus.get(CHILD)).toBe("running");
    });
  });

  describe("retry banner", () => {
    it("retry frame shows it; null clears it", async () => {
      await mountProbe();
      await emit(frame("retry", { attempt: 2, message: "rate limited", next: 123, action: { title: "T", message: "M", label: "L", link: "https://x" } }));
      expect(bus.retryInfo).toEqual({
        attempt: 2,
        message: "rate limited",
        next: 123,
        action: { title: "T", message: "M", label: "L", link: "https://x" },
      });
      await emit(frame("retry", null));
      expect(bus.retryInfo).toBeNull();
    });

    it("raw session.status retry then busy: banner on, then off (via the box's retry null)", async () => {
      await mountProbe();
      await emitRaw({ type: "session.status", properties: { sessionID: SID, status: { type: "retry", attempt: 1, message: "overloaded", next: 5 } } });
      expect(bus.retryInfo?.message).toBe("overloaded");
      expect(bus.running).toBe(true); // retry is a live turn
      await emitRaw({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
      expect(bus.retryInfo).toBeNull();
    });
  });

  describe("sessionError", () => {
    it("typed message + stops the turn", async () => {
      await mountProbe();
      await emit(frame("running", { running: true }));
      await emit(frame("sessionError", { name: "ContextOverflowError", message: "too big" }));
      expect(bus.sendError).toBe("Context full — try /compact: too big");
      expect(bus.running).toBe(false);
      expect(bus.authReconnect).toBeNull();
    });

    it("a credential failure on the active provider becomes the reconnect banner", async () => {
      await mountProbe();
      await emit(frame("sessionError", { name: "ProviderAuthError", message: "x" }));
      expect(bus.sendError).toBe("Claude needs to be reconnected.");
      expect(bus.authReconnect).toBe("Claude");
    });

    it("keeps classifying against the raw provider message (rawMessage)", async () => {
      await mountProbe();
      await emit(frame("sessionError", { name: "ApiError", message: "Your session is no longer valid", rawMessage: 'Unauthorized: {"error":{"type":"authentication_error","message":"Your session is no longer valid"}}' }));
      expect(bus.authReconnect).toBe("Claude");
    });

    it("our own queued-drain abort is invisible: no banner, running false", async () => {
      await mountProbe();
      await emit(frame("running", { running: true }));
      bus.drainAbortRef.current = true;
      await emit(frame("sessionError", { name: "MessageAbortedError", message: "Aborted" }));
      expect(bus.sendError).toBeNull();
      expect(bus.running).toBe(false);
    });
  });

  describe("queued-prompt drain (abort at the next step boundary, submit on idle)", () => {
    async function withQueuedPrompt() {
      await mountProbe();
      await emit(frame("running", { running: true }));
      act(() => bus.setMessageQueue(["second"]));
      await h!.flush();
    }

    it("a toolBoundary frame aborts the in-flight turn once, even if several boundaries arrive before the abort lands", async () => {
      await withQueuedPrompt();
      await emit(frame("toolBoundary", { messageID: "m", partID: "p1", callID: "c1", tool: "bash", status: "completed" }));
      await emit(frame("toolBoundary", { messageID: "m", partID: "p2", callID: "c2", tool: "read", status: "error" }));
      expect(api.calls.opencodeAbort).toEqual([[SID]]);
      expect(bus.drainAbortRef.current).toBe(true);
    });

    it("a stepEnded frame is a step boundary too", async () => {
      await withQueuedPrompt();
      await emit(frame("stepEnded", { messageID: "m", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
      expect(api.calls.opencodeAbort).toEqual([[SID]]);
    });

    it("no queued prompt → no abort", async () => {
      await mountProbe();
      await emit(frame("running", { running: true }));
      await emit(frame("toolBoundary", { messageID: "m", partID: "p", callID: "c", tool: "bash", status: "completed" }));
      expect(api.calls.opencodeAbort ?? []).toEqual([]);
    });

    it("end to end: boundary → abort → V1 abort error (no frame) → idle → the queued prompt is submitted exactly once, drain re-armed", async () => {
      await withQueuedPrompt();
      await emitRaw({
        type: "message.part.updated",
        properties: { sessionID: SID, part: { id: "prt_t", type: "tool", messageID: "m", callID: "c", tool: "bash", state: { status: "completed" } } },
      });
      expect(api.calls.opencodeAbort).toEqual([[SID]]);
      // opencode's V1 abort: session.error(MessageAbortedError) → status idle → session.idle
      await emitRaw({ type: "session.error", properties: { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
      await emitRaw({ type: "session.status", properties: { sessionID: SID, status: { type: "idle" } } });
      await emitRaw({ type: "session.idle", properties: { sessionID: SID } });
      expect(bus.sendError).toBeNull();
      expect(bus.running).toBe(false);
      expect(stubs.submit).toHaveBeenCalledTimes(1);
      expect(stubs.submit).toHaveBeenCalledWith("second");
      expect(bus.messageQueue).toEqual([]);
      expect(bus.drainAbortRef.current).toBe(false);
    });
  });

  describe("stepEnded → live token snapshot", () => {
    it("sets stepTokens", async () => {
      await mountProbe();
      await emit(frame("stepEnded", { messageID: "m", tokens: { input: 3, output: 12, reasoning: 1, cache: { read: 70, write: 4 } }, cost: 0.5 }));
      expect(bus.stepTokens).toEqual({ input: 3, output: 12, reasoning: 1, cache: { read: 70, write: 4 }, cost: 0.5 });
    });

    it("an all-zero frame leaves the previous snapshot alone", async () => {
      await mountProbe();
      await emit(frame("stepEnded", { messageID: "m", tokens: { input: 3, output: 12, reasoning: 0, cache: { read: 0, write: 0 } } }));
      await emit(frame("stepEnded", { messageID: "m2", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
      expect(bus.stepTokens?.input).toBe(3);
    });

    it("the deployed V1 build's step-finish PART reaches the panel as a stepEnded snapshot", async () => {
      await mountProbe();
      await emitRaw({
        type: "message.part.updated",
        properties: {
          sessionID: SID,
          part: { id: "prt_sf", type: "step-finish", messageID: "msg_a", sessionID: SID, reason: "stop", cost: 0.25, tokens: { input: 5, output: 7, reasoning: 0, cache: { read: 69819, write: 177 } } },
        },
      });
      expect(bus.stepTokens).toEqual({ input: 5, output: 7, reasoning: 0, cache: { read: 69819, write: 177 }, cost: 0.25 });
    });
  });

  it("planMode frame mirrors opencode's local agent switch into the composer chip", async () => {
    await mountProbe();
    await emit(frame("planMode", { on: true }));
    await emit(frame("planMode", { on: false }));
    expect(stubs.setPlanOn.mock.calls).toEqual([[true], [false]]);
  });

  it("raw completed plan_enter / plan_exit tool parts reach the chip once each", async () => {
    await mountProbe();
    const part = (tool: string, id: string, status = "completed") => ({
      type: "message.part.updated",
      properties: { sessionID: SID, part: { id, type: "tool", messageID: "m", callID: `call_${id}`, tool, state: { status } } },
    });
    await emitRaw(part("plan_enter", "p1"));
    await emitRaw(part("plan_enter", "p1")); // re-emitted while streaming
    await emitRaw(part("plan_exit", "p2", "error")); // "Keep planning" rejects the exit: asserts nothing
    await emitRaw(part("plan_exit", "p3"));
    expect(stubs.setPlanOn.mock.calls).toEqual([[true], [false]]);
  });

  describe("compaction", () => {
    it("started → delta → ended shows the card, then clears it after 3s", async () => {
      await mountProbe();
      await emit(frame("compaction", { phase: "started", text: "Summ", reason: "overflow" }));
      expect(bus.compactionState).toEqual({ reason: "overflow", text: "Summ", phase: "running" });
      await emit(frame("compaction", { phase: "delta", text: "arising" }));
      expect(bus.compactionState?.text).toBe("Summarising");
      vi.useFakeTimers();
      act(() => mockBus.emitStream(frame("compaction", { phase: "ended" })));
      expect(bus.compactionState?.phase).toBe("done");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(bus.compactionState).toBeNull();
    });

    it("a started frame with no reason defaults to 'context'", async () => {
      await mountProbe();
      await emit(frame("compaction", { phase: "started" }));
      expect(bus.compactionState?.reason).toBe("context");
    });

    it("transcriptStale (session.compacted) clears the card and refetches the transcript", async () => {
      await mountProbe();
      await emit(frame("compaction", { phase: "started", text: "x" }));
      await emit(frame("transcriptStale", {}));
      expect(bus.compactionState).toBeNull();
      expect(stubs.scheduleRefetch).toHaveBeenCalledTimes(1);
    });
  });

  it("commandExecuted tags the message with its slash command", async () => {
    await mountProbe();
    await emit(frame("commandExecuted", { messageID: "msg_cmd", name: "init", arguments: "--fast" }));
    expect(bus.commandByMessageId.get("msg_cmd")).toEqual({ name: "init", arguments: "--fast" });
  });

  describe("running", () => {
    it("a running:true frame clears a stale 'Aborted' banner", async () => {
      await mountProbe();
      await emit(frame("sessionError", { name: "MessageAbortedError", message: "The operation was aborted" }));
      expect(bus.sendError).toContain("aborted");
      await emit(frame("running", { running: true, type: "busy" }));
      expect(bus.sendError).toBeNull();
    });

    it("…but never clears a non-abort error", async () => {
      await mountProbe();
      await emit(frame("sessionError", { name: "ApiError", message: "Invalid token" }));
      await emit(frame("running", { running: true }));
      expect(bus.sendError).toContain("Invalid token");
    });
  });

  describe("permissions frame is used directly (no refetch)", () => {
    const ask = { id: "perm_1", sessionID: SID, permission: "bash", patterns: ["ls"] };

    it("applies the list and clears it on the reply", async () => {
      await mountProbe();
      await emit(frame("permissions", { permissions: [ask] }));
      expect(bus.permissions).toEqual([ask]);
      await emit(frame("permissions", { permissions: [] }));
      expect(bus.permissions).toEqual([]);
      expect(api.calls.opencodePermissions ?? []).toHaveLength(0);
    });
  });

  it("resync (events socket reconnected) refetches the transcript, permissions and questions", async () => {
    await mountProbe({
      opencodePermissions: () => Promise.resolve([{ id: "perm_9", sessionID: SID, permission: "bash" }]),
      opencodeQuestions: () => Promise.resolve([]),
    });
    stubs.scheduleRefetch.mockClear();
    await emit(frame("resync", {}, ""));
    expect(stubs.scheduleRefetch).toHaveBeenCalledTimes(1);
    expect(api.calls.opencodePermissions?.at(-1)).toEqual([SID]);
    expect(api.calls.opencodeQuestions?.at(-1)).toEqual([SID]);
    expect(bus.permissions.map((p) => p.id)).toEqual(["perm_9"]);
  });

  it("raw server.connected becomes a resync frame (as httpApi synthesises it)", async () => {
    await mountProbe();
    stubs.scheduleRefetch.mockClear();
    await emitRaw({ type: "server.connected", properties: {} });
    expect(stubs.scheduleRefetch).toHaveBeenCalledTimes(1);
  });

  it("vcs.branch.updated has no frame: the branch stays on the 5s poll", async () => {
    await mountProbe();
    await emitRaw({ type: "vcs.branch.updated", properties: { branch: "feature/x" } });
    expect(bus.branch).toBeNull();
  });
});
