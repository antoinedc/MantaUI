// @vitest-environment jsdom
//
// Entry-motion wiring for the transcript (transcript-motion).
//
// These are DOM tests, not logic tests, and that distinction is the whole
// reason the file exists. The gate's pure logic is covered in
// chatUtils.test.ts; what shipped broken was the WIRING around it. The first
// version of this feature was merged with a test that asserted a class-name
// string on a component and nothing else, and it hid two failures that only a
// mounted transcript can see:
//
//   - The animation class was computed for a row that was, at that instant,
//     rendering nothing (an assistant message with no parts yet) and was
//     classified as "no longer new" by the time it had content. The class
//     therefore never reached a visible element in the real send → stream →
//     settle sequence, in any of its three steps.
//   - The user bubble's class was unconditional, so it was present on rows
//     that had merely been loaded from history.
//
// So every assertion below queries the rendered DOM after driving the actual
// message sequence ChatPanel produces.

import { describe, it, expect, afterEach } from "vitest";
import { act, createRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { mount, installMockApi, type Harness } from "./testHarness";
import { Transcript, TranscriptList, type TranscriptProps } from "./Transcript";
import { TRANSCRIPT_TAIL_LIMIT } from "./hooks/useTranscriptState";
import type { OpencodeMessage } from "../shared/types";
import type { EntryMotionState } from "./chatUtils";

// Mirrors ChatPanel's SINGLE `motionStateRef`: one ref per mounted transcript.
// `open()` resets it so each opened session starts a fresh gate; `render()`
// reuses it so the gate persists across the re-render storm of a live turn
// (the prime/sticky contract). Passing a fresh object per re-render would
// reset the gate and break the sticky/prime assertions.
let motionStateRef: React.MutableRefObject<EntryMotionState | null> = { current: null };

function msg(id: string, role: "user" | "assistant", text: string): OpencodeMessage {
  return {
    info: { id, sessionID: "s1", role, time: { created: 1_700_000_000_000 } },
    parts: [{ id: `${id}-p0`, messageID: id, type: "text", text }],
  } as unknown as OpencodeMessage;
}

// An assistant message whose only part is a completed tool call — the unit that
// actually slides in (a text part is exempt; a tool card is not).
function toolMsg(id: string, tool: string): OpencodeMessage {
  return {
    info: { id, sessionID: "s1", role: "assistant", time: { created: 1_700_000_000_000 } },
    parts: [
      {
        id: `${id}-p0`,
        messageID: id,
        type: "tool",
        tool,
        state: { status: "completed", output: "done" },
      },
    ],
  } as unknown as OpencodeMessage;
}

function props(messages: OpencodeMessage[], running = false): TranscriptProps {
  return {
    messages,
    virtuosoRef: createRef<VirtuosoHandle>(),
    sessionId: "s1",
    setMessages: () => {},
    loadedAllRef: { current: false },
    onAtBottomChange: () => {},
    taskContextValue: {
      childMessages: new Map(),
      liveChildStatus: new Map(),
      expandedTasks: new Set(),
      toggleTask: () => {},
    } as unknown as TranscriptProps["taskContextValue"],
    showThinking: false,
    running,
    liveTurn: null,
    progress: null,
    // Entry-motion tests assume the panel is being watched (a hidden panel
    // never animates — that is the session-switch fix).
    isActive: true,
    activeTodos: null,
    questions: [],
    turnInfo: new Map(),
    finishByMessageId: new Map(),
    userCommandInfo: new Map(),
    onReplyQuestion: () => {},
    onRejectQuestion: () => {},
    motionStateRef,
  };
}

// `data-motion` is the framer-motion gate hook: "bubble" on a live user
// bubble, "part" on a live assistant part (tool card, streaming text). Absent
// means the element stayed still (history). See MessageBubble / AssistantPart.
const bubblesIn = (h: Harness) => h.container.querySelectorAll('[data-motion="bubble"]').length;
const partsIn = (h: Harness) => h.container.querySelectorAll('[data-motion="part"]').length;

// The transcript a session opens with: already on screen, never animated.
const HISTORY = [msg("u1", "user", "first"), msg("a1", "assistant", "reply")];
// What a send appends before the server answers.
const OPTIMISTIC = msg("optimistic-user-1", "user", "new");

/** Mount an opened session, i.e. everything here counts as history. */
function open(messages: OpencodeMessage[] = HISTORY): Harness {
  motionStateRef = { current: null };
  return mount(<Transcript {...props(messages)} />);
}

/** Push one more render of `messages` through the mounted transcript. */
function render(h: Harness, messages: OpencodeMessage[], running = false): void {
  h.rerender(<Transcript {...props(messages, running)} />);
}

describe("Transcript entry motion", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("opens a loaded transcript completely still", () => {
    // The reported symptom: opening a session replayed every user bubble.
    h = open([...HISTORY, msg("u2", "user", "second"), msg("a2", "assistant", "reply two")]);
    expect(bubblesIn(h)).toBe(0);
    expect(partsIn(h)).toBe(0);
  });

  it("pops the bubble for a message sent right now", () => {
    h = open();
    expect(bubblesIn(h)).toBe(0);
    render(h, [...HISTORY, OPTIMISTIC], true);
    expect(bubblesIn(h)).toBe(1);
  });

  it("keeps the send animation through the re-render storm of a live turn", () => {
    // This is the regression that made the feature invisible: the flag lasted
    // exactly one render, and a streaming turn re-renders every few ms, so the
    // class was pulled off roughly one frame after the animation started.
    h = open();
    const sent = [...HISTORY, OPTIMISTIC];
    for (let i = 0; i < 20; i++) render(h, sent, true);
    expect(bubblesIn(h)).toBe(1);
  });

  it("does not pop a second time when the canonical message replaces the placeholder", () => {
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);
    render(h, [...HISTORY, msg("msg_real", "user", "new")], true);
    expect(bubblesIn(h)).toBe(0);
  });

  it("pops in a tool card that arrives live, immediately at mount", () => {
    // A tool card is ALWAYS the last (streaming) part at the instant it
    // appears. `entering` is frozen at mount: once a part is marked, the
    // framer-motion wrapper keeps `initial`/`animate` through the re-render
    // storm (motion plays once on mount), and settling the turn never
    // re-derives it onto a remounted wrapper — the always-present motion.div
    // avoids the unmount/remount that would replay the pop.
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);

    const streaming = [...HISTORY, OPTIMISTIC, toolMsg("a_new", "bash")];
    render(h, streaming, true);
    expect(partsIn(h)).toBe(1); // popped immediately, mid-stream

    render(h, streaming, false); // turn settles — still exactly one, no remount
    expect(partsIn(h)).toBe(1);
  });

  it("animates the live streaming text part with the same motion as a card", () => {
    // Prose is NOT exempt from the motion anymore — every part of a live
    // message (streaming text included) pops with the same framer-motion
    // entry, so the AI reply reads like the prompt. The container plays once
    // on mount. Settling the turn must not retro-add a second pop.
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);

    const streaming = [...HISTORY, OPTIMISTIC, msg("a_new", "assistant", "writing")];
    render(h, streaming, true);
    expect(partsIn(h)).toBe(1);

    // Frozen at mount: settling the turn must not replay the pop.
    render(h, streaming, false);
    expect(partsIn(h)).toBe(1);
  });

  it("leaves history still even after new messages have arrived", () => {
    h = open();
    render(h, [...HISTORY, msg("u2", "user", "second")]);
    // Exactly the new one — the two rows already on screen are untouched.
    expect(bubblesIn(h)).toBe(1);
    expect(partsIn(h)).toBe(0);
  });
});

describe("Transcript virtualization (react-virtuoso)", () => {
  afterEach(() => {
    (window as unknown as { api?: unknown }).api = undefined;
  });

  it("renders only a subset of rows for a long transcript (virtualization active)", () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      msg(`m${i}`, i % 2 ? "assistant" : "user", `row ${i}`),
    );
    const h = mount(<Transcript {...props(many)} />);
    const rows = h.container.querySelectorAll("[data-message-id]").length;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(many.length);
    h.unmount();
  });
});

describe("TranscriptList padding pass-through (BET-691)", () => {
  it("leaves Virtuoso's vertical offsets intact on the list element", () => {
    // react-virtuoso writes the virtualization offsets into this element's
    // inline style as paddingTop/paddingBottom. The list adapter must never
    // overwrite them, or the Footer (the working row) is drawn inside the last
    // rendered row instead of below it.
    const h = mount(
      <TranscriptList
        data-testid="transcript-list"
        style={{ paddingTop: 111, paddingBottom: 222 }}
      >
        <span>row</span>
      </TranscriptList>,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.style.paddingTop).toBe("111px");
    expect(el.style.paddingBottom).toBe("222px");
    h.unmount();
  });
});

describe("Transcript composer column pin + wrap classes (BET-687)", () => {
  afterEach(() => {
    // Leave the harness's window.api mock in a clean state.
    (window as unknown as { api?: unknown }).api = undefined;
  });

  it("carries flex-1 min-h-0 on the empty-state AnimatePresence wrapper", () => {
    // The wrapper (motion.div key="empty") is what must fill flex-1 in the
    // empty/short session so the composer sits flush with the pane bottom.
    const h = mount(<Transcript {...props([])} />);
    const wrapper = Array.from(h.container.querySelectorAll<HTMLElement>("[class]")).find(
      (el) =>
        el.classList.contains("min-h-0") &&
        el.classList.contains("flex") &&
        el.textContent?.includes("Welcome"),
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("flex-1");
    h.unmount();
  });

  it("carries overflow-x-hidden and max-w-full on the Virtuoso root", () => {
    const h = mount(<Transcript {...props(HISTORY)} />);
    const root = Array.from(h.container.querySelectorAll<HTMLElement>("[class]")).find(
      (el) => el.classList.contains("overflow-x-hidden") && el.classList.contains("max-w-full"),
    );
    expect(root).not.toBeNull();
    h.unmount();
  });
});

describe("Transcript LoadEarlier (tail-first loading)", () => {
  afterEach(() => {
    // Leave the harness's window.api mock in a clean state.
    (window as unknown as { api?: unknown }).api = undefined;
  });

  it("hides the button until the tail fills the panel", () => {
    const few = [msg("u1", "user", "first"), msg("a1", "assistant", "reply")];
    const h = mount(<Transcript {...props(few)} />);
    expect(h.text()).not.toContain("Load earlier");
    h.unmount();
  });

  it("pulls the FULL history on click, marks loadedAll, and forwards no limit", async () => {
    const many = Array.from({ length: TRANSCRIPT_TAIL_LIMIT }, (_, i) =>
      msg(`m${i}`, i % 2 ? "assistant" : "user", `row ${i}`),
    );
    const loadedAllRef = { current: false };
    const fetchCalls: Array<[string, unknown]> = [];
    installMockApi({
      opencodeMessages: (sessionId: string, opts?: { limit?: number }) => {
        fetchCalls.push([sessionId, opts]);
        return Promise.resolve(many);
      },
    });
    const h = mount(
      <Transcript
        {...props(many)}
        setMessages={() => {}}
        loadedAllRef={loadedAllRef}
      />,
    );
    const loadBtn = Array.from(h.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Load earlier"),
    );
    expect(loadBtn).not.toBeNull();
    await act(async () => loadBtn!.click());
    await h.flush();
    // applied the full-history fetch (no limit) and flipped loadedAll so the
    // button disappears and future fetches pull everything.
    expect(fetchCalls).toEqual([["s1", {}]]);
    expect(loadedAllRef.current).toBe(true);
    h.unmount();
  });
});
