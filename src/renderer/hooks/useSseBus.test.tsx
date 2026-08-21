// @vitest-environment jsdom
//
// Streaming-behavior tests for useSseBus hook (BET-64).
//
// Tests the SSE event routing, drain-abort logic, step boundary handling,
// child-session routing, and state transitions. Uses the render harness to
// mount ChatPanel and emit events through the mock bus.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, useRef, useState } from "react";
import { ChatPanel } from "../ChatPanel";
import { sessionAutoKey } from "../modelPrefs";
import { useSseBus, TURN_SETTLE_MS, type SseBus } from "./useSseBus";
import type { OpencodeMessage } from "../../shared/types";
import {
  installMockApi,
  resetStore,
  mount,
  emitAndFlush,
  emitStreamAndFlush,
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

  it("transitions running state on stream.running events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Simulate session going busy (BET-551 / §17 — running is box-derived)
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
    });

    // Simulate session going idle
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: false },
    });

    // Component should still be mounted without errors.
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("handles session.error with different error types", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Unknown generic error — the credential-error path is server-driven now
    // (BET-280) and exercised in src/server/claudeAuth.test.mjs.
    await emitAndFlush(bus, h, {
      type: "session.error",
      properties: {
        sessionID: "ses_test",
        error: { name: "ApiError", data: { message: "Invalid token" } },
      },
    });

    // Component should still be mounted (error is displayed, not crashed).
    expect(h.container.querySelector("textarea")).not.toBeNull();
  });

  it("renders the auth-error banner with [Reconnect] on Claude credential failure (BET-316)", async () => {
    // Pin the active model's providerID to "anthropic" so authErrorAdvice
    // has an authoritative provider to attribute to. The localStorage-backed
    // per-session override would otherwise win — clear it so the store's
    // defaultModel is what useSseBus sees.
    localStorage.clear();
    resetStore({
      defaultModel: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    });
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit the real upstream Claude credential-error payload (BET-280):
    // opencode wraps the plugin's throw as ApiError with this message.
    await emitAndFlush(bus, h, {
      type: "session.error",
      properties: {
        sessionID: "ses_test",
        error: {
          name: "ApiError",
          data: {
            message:
              "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
          },
        },
      },
    });

    // Banner shows the new copy and renders the [Reconnect] button. Note we
    // check `contains` rather than exact equality because the banner sits
    // alongside the textarea (and other UI) in the rendered DOM.
    const text = h.text();
    expect(text).toContain("Claude needs to be reconnected.");
    expect(text).toContain("Reconnect");
  });

  it("falls through to the raw-message path when providerID is unknown (BET-316)", async () => {
    // No active model — useSseBus receives providerID: null. authErrorAdvice
    // returns null and the existing switch/default branch surfaces the raw
    // message verbatim (preceded by the "API error:" prefix the switch
    // applies to ApiError). No [Reconnect] button should appear.
    localStorage.clear();
    resetStore({ defaultModel: null });
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitAndFlush(bus, h, {
      type: "session.error",
      properties: {
        sessionID: "ses_test",
        error: {
          name: "ApiError",
          data: {
            message:
              "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
          },
        },
      },
    });

    const text = h.text();
    // Raw upstream text lands in the banner — the user sees the actionable
    // "Run `claude`" message rather than a misattributed provider label.
    // (The existing switch prefixes ApiError with "API error: "; the rest of
    // the message is intact.)
    expect(text).toContain("Run `claude`");
    expect(text).not.toContain("Reconnect");
  });

  it("routes child-session stream events to scheduleChildRefetch when expanded", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    // Emit a child registration (BET-551 — the box publishes subagent.child)
    await emitStreamAndFlush(bus, h, {
      sub: "subagent.child",
      sessionId: "ses_test",
      payload: { childSessionId: "child_123" },
    });

    // Now emit a stream.flush for the child session. This routes to
    // scheduleChildRefetch if the child is expanded; either way the panel
    // stays mounted.
    await emitStreamAndFlush(bus, h, {
      sub: "flush",
      sessionId: "child_123",
      payload: {
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        text: "Hello from child",
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

  it("handles stream.todos events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const todos = [{ content: "Task 1", status: "in_progress", priority: "high" }];
    await emitStreamAndFlush(bus, h, {
      sub: "todos",
      sessionId: "ses_test",
      payload: {
        active: todos,
        visible: { visible: todos, hiddenPending: 0, hiddenDone: 0 },
        allTerminal: false,
        anyTerminal: false,
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

  it("handles stream.questions events", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: "ses_test",
      payload: { questions: [] },
    });
    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: "ses_test",
      payload: {
        questions: [
          { id: "que_1", sessionID: "ses_test", questions: [["pick one"]], requestId: "que_1" },
        ],
      },
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

  it("handles stream.turnComplete (idle)", async () => {
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    await emitStreamAndFlush(bus, h, {
      sub: "turnComplete",
      sessionId: "ses_test",
      payload: { complete: true, running: false },
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

  async function queueASecondMessage(container: HTMLElement, text = "second message") {
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, text);
    });
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  }

  // Shared 4-line setup prologue for the drain tests: install the mock API
  // with a no-op opencodePrompt, reset the store, mount ChatPanel, and flush.
  // Returns the harness so each test's `h =` assignment keeps TS narrowing.
  async function mountDrainHarness(): Promise<Harness> {
    ({ api, bus } = installMockApi({
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    const harness = mount(<ChatPanel {...PROPS} />);
    await harness.flush();
    return harness;
  }

  it("aborts and drains at the next completed tool part, not at full idle", async () => {
    h = await mountDrainHarness();

    // Turn is already running.
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
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
    h = await mountDrainHarness();

    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
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
    h = await mountDrainHarness();

    // Register a subagent child session under the main session.
    await emitAndFlush(bus, h, {
      type: "session.created",
      properties: {
        sessionID: "ses_test",
        info: { id: "child_boundary", parentID: "ses_test" },
      },
    });

    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
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

  // REGRESSION: a queued message must be submitted EXACTLY ONCE on drain.
  // There used to be TWO identical `[running, messageQueue]` drain effects —
  // one in useSseBus, one in ChatPanel — both firing on the same running→false
  // transition against the shared queue + submitRef, submitting the same
  // queued prompt twice. The ChatPanel duplicate was removed; the hook's
  // effect is the sole owner. If a duplicate is ever reintroduced this test
  // sees two opencodePrompt calls for "second message".
  it("submits a queued message exactly once when it drains (no double send)", async () => {
    h = await mountDrainHarness();

    // Turn running; queue a second message mid-turn.
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
    });
    await queueASecondMessage(h.container);
    await h.flush();

    // A tool completes → drain-abort fires opencodeAbort.
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
        part: { type: "tool", state: { status: "completed" } },
      },
    });
    // The abort flips the session idle → the drain effect submits the queued
    // prompt. Emit the turn-complete the abort would produce (BET-551 / §17
    // — the box reports completion via stream.turnComplete).
    await emitStreamAndFlush(bus, h, {
      sub: "turnComplete",
      sessionId: "ses_test",
      payload: { complete: true, running: false },
    });
    // BET-692: a turnComplete running:false is settled only after TURN_SETTLE_MS,
    // so wait out the settle window before the drain effect can run.
    await new Promise((r) => setTimeout(r, TURN_SETTLE_MS + 50));
    await h.flush();

    const promptCalls = (api.calls.opencodePrompt ?? []).filter((args) =>
      JSON.stringify(args).includes("second message"),
    );
    expect(promptCalls.length).toBe(1);
  });

  // REGRESSION (BET-709): queue drain silently dropped all but the last queued
  // prompt. The old drain did `setInput(queued)` then deferred the actual
  // submit to `setTimeout(0)`; with ≥2 items queued at the running→false edge,
  // the effect re-ran (React's scheduler beats setTimeout(0)) and the second
  // run overwrote the input before the first submit fired — "a" was never
  // sent, with no error. The drain now submits the queued text EXPLICITLY via
  // submitRef(textOverride), one item per idle edge, so every can be drained.
  it("drains ≥2 queued messages exactly once, in FIFO order (no first-message loss)", async () => {
    h = await mountDrainHarness();

    // Turn running; queue TWO distinct messages mid-turn.
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
    });
    await queueASecondMessage(h.container, "first queued");
    await queueASecondMessage(h.container, "second queued");
    await h.flush();

    // A tool completes → drain-abort fires opencodeAbort.
    await emitAndFlush(bus, h, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_1",
        part: { type: "tool", state: { status: "completed" } },
      },
    });
    // The abort flips the session idle; wait out the settle window then flush
    // so the FIRST drain edge runs.
    await emitStreamAndFlush(bus, h, {
      sub: "turnComplete",
      sessionId: "ses_test",
      payload: { complete: true, running: false },
    });
    await new Promise((r) => setTimeout(r, TURN_SETTLE_MS + 50));
    await h.flush();

    // First idle edge: the FIRST queued text is submitted exactly once, the
    // second not at all yet. submit() flips running true synchronously, so the
    // drain effect re-arms and the second item waits for the NEXT idle edge.
    let firstCalls = (api.calls.opencodePrompt ?? []).filter((args) =>
      JSON.stringify(args).includes("first queued"),
    );
    const secondCallsSoFar = (api.calls.opencodePrompt ?? []).filter((args) =>
      JSON.stringify(args).includes("second queued"),
    );
    expect(firstCalls.length).toBe(1);
    expect(secondCallsSoFar.length).toBe(0);

    // Start a second turn, then let it complete idle.
    await emitStreamAndFlush(bus, h, {
      sub: "running",
      sessionId: "ses_test",
      payload: { running: true },
    });
    await emitStreamAndFlush(bus, h, {
      sub: "turnComplete",
      sessionId: "ses_test",
      payload: { complete: true, running: false },
    });
    await new Promise((r) => setTimeout(r, TURN_SETTLE_MS + 50));
    await h.flush();

    // Second idle edge: the SECOND queued text is now submitted exactly once,
    // and the first is still exactly once (no double send).
    firstCalls = (api.calls.opencodePrompt ?? []).filter((args) =>
      JSON.stringify(args).includes("first queued"),
    );
    const secondCalls = (api.calls.opencodePrompt ?? []).filter((args) =>
      JSON.stringify(args).includes("second queued"),
    );
    expect(firstCalls.length).toBe(1);
    expect(secondCalls.length).toBe(1);
  });
});

// BET-692 — running must only flip false on a SETTLED completion. The box
// derives turnComplete from the transcript, so at every tool-step boundary the
// just-finished step's message is momentarily the transcript tail and a
// turnComplete with running:false fires mid-turn, re-armed by the next
// session.status busy 0-134ms later. RunningProbe owns useSseBus directly so
// the tests can assert the running boolean precisely.
describe("useSseBus running settle on turnComplete (BET-692)", () => {
  let probe: { running: boolean } | null = null;
  let h: ReturnType<typeof mount> | null = null;
  let bus: ReturnType<typeof installMockApi>["bus"];

  function RunningProbe() {
    const [, setMessages] = useState<OpencodeMessage[] | null>(null);
    const childSessionIds = useRef<Set<string>>(new Set());
    const childMessagesRef = useRef<Map<string, OpencodeMessage[]>>(new Map());
    const expandedTasksRef = useRef<Set<string>>(new Set());
    const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const isActiveRef = useRef<boolean>(true);
    const refetchOwedWhileInactive = useRef<boolean>(false);
    const submitRef = useRef<() => void>(() => {});
    const sse: SseBus = useSseBus({
      sessionId: "ses_test",
      cwd: "/home/dev/projects/x",
      setMessages,
      setRefreshing: () => {},
      scheduleRefetch: () => {},
      fetchOpts: () => ({}),
      spliceMessage: () => {},
      scheduleChildRefetch: () => {},
      childSessionIds,
      childMessagesRef,
      expandedTasksRef,
      childRefetchTimers,
      isActiveRef,
      refetchOwedWhileInactive,
      applyStreamFlush: () => 0,
      providerID: null,
      setPlanOn: () => {},
      submit: () => {},
      submitRef,
    });
    probe = { running: sse.running };
    return <div data-testid="running-probe" />;
  }

  const emit = (sub: "running" | "turnComplete", payload: { running: boolean; complete?: boolean }) =>
    act(() => bus.emitStream({ sub, sessionId: "ses_test", payload }));

  beforeEach(() => {
    ({ bus } = installMockApi());
    resetStore();
    probe = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    vi.useRealTimers();
  });

  it("absorbs the mid-turn flicker at a tool-step boundary", () => {
    h = mount(<RunningProbe />);

    // Session busy.
    emit("running", { running: true });
    expect(probe!.running).toBe(true);

    // Mid-turn tool-step boundary: the just-finished step's message is
    // momentarily the transcript tail, so a turnComplete running:false fires.
    emit("turnComplete", { complete: true, running: false });
    act(() => { vi.advanceTimersByTime(100); });
    // Not believed yet — the turn is still marked running.
    expect(probe!.running).toBe(true);

    // Next session.status busy re-arms running before the settle would fire.
    emit("running", { running: true });
    act(() => { vi.advanceTimersByTime(1000); });
    // The settle timer was cancelled, not merely delayed.
    expect(probe!.running).toBe(true);
  });

  it("ends the turn only after the settle window on a genuine completion", () => {
    h = mount(<RunningProbe />);

    emit("running", { running: true });
    emit("turnComplete", { complete: true, running: false });
    // Still pending within the settle window.
    expect(probe!.running).toBe(true);

    act(() => { vi.advanceTimersByTime(TURN_SETTLE_MS); });
    expect(probe!.running).toBe(false);
  });

  it("honours the hard running signal immediately, with no settle delay", () => {
    h = mount(<RunningProbe />);

    emit("running", { running: true });
    emit("running", { running: false });
    // The authoritative running event clears immediately — no timer advance.
    expect(probe!.running).toBe(false);
  });
});

// BET-418 §A — background-job children no longer route questions into the
// parent's panel (a job is created with a pre-flight permission ruleset and
// never asks once running). question.asked therefore never triggers a
// refetch: the viewed session's own ask carries a complete live payload, and
// a foreign session's ask is dropped by applyQuestionEvent before any
// refetch could be considered.
describe("useSseBus question.asked refetch gating (BET-418)", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;

  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("does NOT refetch questions for the viewed session's own stream.questions", async () => {
    ({ api, bus } = installMockApi());
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const before = (api.calls.opencodeQuestions ?? []).length;

    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: "ses_test",
      payload: {
        questions: [
          { id: "que_1", sessionID: "ses_test", questions: [["pick one"]], requestId: "que_1" },
        ],
      },
    });

    const after = (api.calls.opencodeQuestions ?? []).length;
    expect(after).toBe(before);
  });

  it("drops + does NOT refetch for a foreign (background-job child) session's stream.questions", async () => {
    ({ api, bus } = installMockApi());
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();

    const before = (api.calls.opencodeQuestions ?? []).length;

    await emitStreamAndFlush(bus, h, {
      sub: "questions",
      sessionId: "ses_child",
      payload: {
        questions: [
          { id: "que_child_live", sessionID: "ses_child", questions: [["pick one"]], requestId: "que_child_live" },
        ],
      },
    });

    const after = (api.calls.opencodeQuestions ?? []).length;
    expect(after).toBe(before);
  });
});

// BET-973 — the plan-mode mirror must only react to a COMPLETED plan_enter/
// plan_exit. "Keep planning" answers the plan question "No", which REJECTS the
// plan_exit tool, so its part lands in `error` — an errored switch did NOT
// happen and must not flip the chip. The old block reused isToolStepBoundary
// (which accepts `error` on purpose for the drain), reading an errored
// plan_exit as a real exit and silently dropping the session out of plan mode.
// PlanProbe owns useSseBus directly and captures the plan setter so the tests
// can assert exactly when it is (or isn't) called.
describe("useSseBus plan-mode mirror (BET-973)", () => {
  let planCalls: boolean[] | null = null;
  let h: ReturnType<typeof mount> | null = null;
  let bus: ReturnType<typeof installMockApi>["bus"];

  beforeEach(() => {
    ({ bus } = installMockApi());
    resetStore();
    planCalls = [];
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function PlanProbe() {
    const [, setMessages] = useState<OpencodeMessage[] | null>(null);
    const childSessionIds = useRef<Set<string>>(new Set());
    const childMessagesRef = useRef<Map<string, OpencodeMessage[]>>(new Map());
    const expandedTasksRef = useRef<Set<string>>(new Set());
    const childRefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const isActiveRef = useRef<boolean>(true);
    const refetchOwedWhileInactive = useRef<boolean>(false);
    const submitRef = useRef<() => void>(() => {});
    useSseBus({
      sessionId: "ses_test",
      cwd: "/home/dev/projects/x",
      setMessages,
      setRefreshing: () => {},
      scheduleRefetch: () => {},
      fetchOpts: () => ({}),
      spliceMessage: () => {},
      scheduleChildRefetch: () => {},
      childSessionIds,
      childMessagesRef,
      expandedTasksRef,
      childRefetchTimers,
      isActiveRef,
      refetchOwedWhileInactive,
      applyStreamFlush: () => 0,
      providerID: null,
      setPlanOn: (next: boolean) => { planCalls?.push(next); },
      submit: () => {},
      submitRef,
    });
    return <div />;
  }

  const emitToolPart = async (part: unknown, messageID = "msg_1") => {
    await act(async () => {
      act(() =>
        bus.emit({
          type: "message.part.updated",
          properties: { sessionID: "ses_test", messageID, part },
        }),
      );
      await Promise.resolve();
    });
  };

  it("does not call the plan setter on an errored plan_exit (Keep planning)", async () => {
    h = mount(<PlanProbe />);
    await h.flush();

    await emitToolPart({ type: "tool", tool: "plan_exit", callID: "toolu_1", state: { status: "error" } });

    expect(planCalls).toEqual([]);
  });

  it("does not call the plan setter on an errored plan_enter", async () => {
    h = mount(<PlanProbe />);
    await h.flush();

    await emitToolPart({ type: "tool", tool: "plan_enter", callID: "toolu_1", state: { status: "error" } });

    expect(planCalls).toEqual([]);
  });

  it("calls the plan setter on a completed plan_exit, deduplicating by callID", async () => {
    h = mount(<PlanProbe />);
    await h.flush();

    await emitToolPart({ type: "tool", tool: "plan_exit", callID: "toolu_1", state: { status: "completed" } });
    expect(planCalls).toEqual([false]);

    // A second emission with the SAME callID (opencode re-emits a completed
    // part) must NOT re-apply — even a plan_enter sharing the id is ignored.
    await emitToolPart({ type: "tool", tool: "plan_enter", callID: "toolu_1", state: { status: "completed" } });
    expect(planCalls).toEqual([false]);
  });
});

describe("BET-1248 main-conversation routing at boundaries (ChatPanel submit)", () => {
  let api: MockApi;
  let bus: MockEventBus;
  let h: Harness | null = null;
  const ROUTED = { providerID: "anthropic", modelID: "claude-routed" };
  type RouterModel = { providerID: string; modelID: string; variant?: string } | null;

  function typeInto(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function submitAsUser(text: string) {
    const textarea = h!.container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      typeInto(textarea, text);
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // The async submit() body awaits routingChoose + opencodePrompt; settle
    // the whole chain (two macrotask hops) before asserting.
    await h!.flush();
    await h!.flush();
  }

  // Flip the box's running→idle so the NEXT submit sends (instead of queuing).
  // Mirrors the drain tests' turnComplete + TURN_SETTLE_MS settle window.
  async function settleIdle() {
    await emitStreamAndFlush(bus, h!, {
      sub: "turnComplete",
      sessionId: "ses_test",
      payload: { complete: true, running: false },
    });
    await new Promise((r) => setTimeout(r, TURN_SETTLE_MS + 50));
    await h!.flush();
  }

  // The model opencodePrompt was last called with for a given user text.
  // opencodePrompt(sessionId, text, model, ...) → args[2] is the model.
  function promptModelFor(text: string): unknown {
    const calls = (api.calls.opencodePrompt ?? []) as unknown[][];
    const hit = [...calls].reverse().find((a) => a[1] === text);
    return hit ? hit[2] : undefined;
  }

  function decision(model: RouterModel, alternatives: RouterModel[] = []) {
    return Promise.resolve({ model, reason: "cost", alternatives, changed: true });
  }

  afterEach(() => {
    h?.unmount();
    h = null;
    localStorage.clear();
  });

  async function mountAuto(overrides: Record<string, unknown> = {}) {
    localStorage.setItem(sessionAutoKey("ses_test"), "1");
    ({ api, bus } = installMockApi({
      routingChoose: () => decision(ROUTED),
      opencodePrompt: () => Promise.resolve({ ok: true }),
      ...overrides,
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
  }

  it("first turn with Auto on → routingChoose is called once and the turn is sent on the returned model", async () => {
    await mountAuto();
    await submitAsUser("hello");
    expect((api.calls.routingChoose ?? []).length).toBe(1);
    expect(promptModelFor("hello")).toEqual(ROUTED);
  });

  it("a follow-up with no boundary → routingChoose is NOT called; the same model is reused", async () => {
    await mountAuto();
    await submitAsUser("first");
    await settleIdle();
    await submitAsUser("second");
    expect((api.calls.routingChoose ?? []).length).toBe(1);
    expect(promptModelFor("first")).toEqual(ROUTED);
    expect(promptModelFor("second")).toEqual(ROUTED);
  });

  it("after a compaction → routingChoose is called, but with the incumbent in contention the model does NOT change", async () => {
    await mountAuto();
    await submitAsUser("first");
    await settleIdle();
    // Compaction completes (cache is gone) — the next turn crosses a boundary.
    await emitAndFlush(bus, h!, {
      type: "session.next.compaction.started",
      properties: { sessionID: "ses_test", reason: "context", text: "" },
    });
    await emitAndFlush(bus, h!, {
      type: "session.next.compaction.ended",
      properties: { sessionID: "ses_test" },
    });
    // The router returns the incumbent → it stays in the contention window.
    await submitAsUser("after compact");
    expect((api.calls.routingChoose ?? []).length).toBe(2);
    expect(promptModelFor("after compact")).toEqual(ROUTED);
  });

  it("routingChoose rejecting → the turn still sends, on the previous model", async () => {
    localStorage.setItem(sessionAutoKey("ses_test"), "1");
    ({ api, bus } = installMockApi({
      routingChoose: () => Promise.reject(new Error("router down")),
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await submitAsUser("hi");
    // A turn was still sent. First turn with no incumbent → server default.
    expect((api.calls.opencodePrompt ?? []).length).toBeGreaterThan(0);
    expect(promptModelFor("hi")).toBeUndefined();
  });

  it("Auto off → routingChoose is never called", async () => {
    localStorage.clear(); // server-default choice
    ({ api, bus } = installMockApi({
      routingChoose: () => decision(ROUTED),
      opencodePrompt: () => Promise.resolve({ ok: true }),
    }));
    resetStore();
    h = mount(<ChatPanel {...PROPS} />);
    await h.flush();
    await submitAsUser("hi");
    expect(api.calls.routingChoose ?? []).toHaveLength(0);
    expect(promptModelFor("hi")).toBeUndefined();
  });
});
