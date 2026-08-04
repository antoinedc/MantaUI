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
import { createRef } from "react";
import { mount, type Harness } from "./testHarness";
import { Transcript, type TranscriptProps } from "./Transcript";
import type { OpencodeMessage } from "../shared/types";

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
    scrollRef: createRef<HTMLDivElement>(),
    contentRef: createRef<HTMLDivElement>(),
    questionCardRef: createRef<HTMLDivElement>(),
    taskContextValue: {
      childMessages: new Map(),
      liveChildStatus: new Map(),
      expandedTasks: new Set(),
      toggleTask: () => {},
    } as unknown as TranscriptProps["taskContextValue"],
    showThinking: false,
    running,
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
  };
}

const bubblesIn = (h: Harness) => h.container.querySelectorAll(".manta-bubble-in").length;
const partsIn = (h: Harness) => h.container.querySelectorAll(".manta-part-in").length;

// The transcript a session opens with: already on screen, never animated.
const HISTORY = [msg("u1", "user", "first"), msg("a1", "assistant", "reply")];
// What a send appends before the server answers.
const OPTIMISTIC = msg("optimistic-user-1", "user", "new");

/** Mount an opened session, i.e. everything here counts as history. */
function open(messages: OpencodeMessage[] = HISTORY): Harness {
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

  it("slides in a tool card that arrives live, immediately at mount", () => {
    // A tool card is ALWAYS the last (streaming) part at the instant it
    // appears. The slide decision is frozen at mount: `entering && !(streaming
    // && text)` — a tool part is not text, so it slides right away and keeps
    // sliding through the re-render storm (the class is stable, never re-derived
    // when `streaming` later flips false and the card remounts is avoided by the
    // always-present wrapper). This is the bug the old `streaming` guard caused:
    // the tool card was exempted and never slid.
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);

    const streaming = [...HISTORY, OPTIMISTIC, toolMsg("a_new", "bash")];
    render(h, streaming, true);
    expect(partsIn(h)).toBe(1); // slid immediately, mid-stream

    render(h, streaming, false); // turn settles — still exactly one, no remount
    expect(partsIn(h)).toBe(1);
  });

  it("does NOT slide the live text part — it owns its own per-block fade", () => {
    // The streaming TEXT part is the sole exemption: `.manta-streaming` fades
    // its markdown blocks in individually, so wrapping it in the container
    // slide too would animate the same content twice. Frozen at mount as
    // non-sliding, it stays non-sliding even after the turn settles.
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);

    const streaming = [...HISTORY, OPTIMISTIC, msg("a_new", "assistant", "writing")];
    render(h, streaming, true);
    expect(partsIn(h)).toBe(0);

    render(h, streaming, false);
    expect(partsIn(h)).toBe(0);
  });

  it("leaves history still even after new messages have arrived", () => {
    h = open();
    render(h, [...HISTORY, msg("u2", "user", "second")]);
    // Exactly the new one — the two rows already on screen are untouched.
    expect(bubblesIn(h)).toBe(1);
    expect(partsIn(h)).toBe(0);
  });
});
