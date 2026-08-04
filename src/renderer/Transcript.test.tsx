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

function props(messages: OpencodeMessage[], running = false): TranscriptProps {
  return {
    messages,
    scrollRef: createRef<HTMLDivElement>(),
    questionCardRef: createRef<HTMLDivElement>(),
    taskContextValue: {
      childMessages: new Map(),
      liveChildStatus: new Map(),
      expandedTasks: new Set(),
      toggleTask: () => {},
    } as unknown as TranscriptProps["taskContextValue"],
    showThinking: false,
    running,
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

  it("slides in the assistant's parts once its turn settles", () => {
    // The whole point of the rewrite. The previous shape exempted the row
    // while it was streaming and considered it old once it was not, so this
    // count was 0 at every step of the sequence.
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);

    const streaming = [...HISTORY, OPTIMISTIC, msg("a_new", "assistant", "writing")];
    render(h, streaming, true);
    // Mid-stream the text part animates its own blocks (.manta-streaming), so
    // the part wrapper deliberately stays out of it.
    expect(partsIn(h)).toBe(0);

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
