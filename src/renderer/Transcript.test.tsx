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
    scrollerElRef: { current: null },
    followingRef: { current: true },
    onFollowingChange: () => {},
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
    voiceNoteByMessageId: new Map(),
    mediaByMessageId: new Map(),
    widgetsByMessageId: new Map(),
    pendingVoiceNote: null,
    onRetryVoiceNote: () => {},
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

  it("pops the collapsed tool line once, when the run settles inline", () => {
    // While the turn runs, the tail run lives in the WORKING LINE, so nothing
    // inline animates. When the turn settles the run becomes one collapsed
    // line on its owning message; that line (not a stack of cards) pops, and
    // exactly once — the always-present motion wrapper never remounts.
    h = open();
    render(h, [...HISTORY, OPTIMISTIC], true);

    const streaming = [...HISTORY, OPTIMISTIC, toolMsg("a_new", "bash")];
    render(h, streaming, true);
    expect(partsIn(h)).toBe(0); // withheld: the working line shows it
    expect(h.container.querySelector(".manta-tool-group")).toBeNull();

    render(h, streaming, false); // turn settles → one line, popping in
    expect(partsIn(h)).toBe(1);
    expect(h.container.querySelectorAll(".manta-tool-group").length).toBe(1);

    render(h, streaming, false); // re-render storm — still exactly one
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

  it("skips a row whose only parts are todowrite (BET-874)", () => {
    // A turn that only updated the checklist must not occupy a Virtuoso slot
    // (a zero-height item poisons the size cache). The surrounding rows still
    // render; the todowrite-only row renders nothing and gets no data id.
    const todoOnly = {
      info: {
        id: "todo-1",
        sessionID: "s1",
        role: "assistant",
        time: { created: 1_700_000_000_000 },
      },
      parts: [
        { id: "todo-1-p0", messageID: "todo-1", type: "tool", tool: "todowrite" },
      ],
    } as unknown as OpencodeMessage;
    const h = mount(
      <Transcript
        {...props([msg("u1", "user", "before"), todoOnly, msg("u2", "user", "after")])}
      />,
    );
    const ids = Array.from(h.container.querySelectorAll("[data-message-id]")).map(
      (el) => el.getAttribute("data-message-id"),
    );
    expect(ids).toContain("u1");
    expect(ids).toContain("u2");
    expect(ids).not.toContain("todo-1");
    h.unmount();
  });
});

// ===== Follow state (BET-933 follow-up) =====
//
// The pure decision is covered in chatUtils.test.ts; what shipped broken was
// the WIRING, and only a mounted transcript with a real scroll listener can
// see it. The reported symptom was that every tool call detached the
// transcript and left the user clicking "jump to latest": react-virtuoso
// writes to the scroller itself (upward-scrolling compensation after a row is
// re-measured), which arrives as an ordinary scroll event with a lower
// scrollTop and was indistinguishable from the user dragging up.
describe("Transcript follow state", () => {
  // jsdom has no layout, so the three scroll metrics are permanently 0. Define
  // them on the instance to drive classifyFollowOnScroll deterministically.
  function measure(el: HTMLElement, m: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
    for (const [k, v] of Object.entries(m)) {
      Object.defineProperty(el, k, { value: v, configurable: true, writable: true });
    }
  }

  function mountFollowing() {
    const scrollerElRef: React.MutableRefObject<HTMLElement | null> = { current: null };
    const followingRef = { current: true };
    const changes: boolean[] = [];
    motionStateRef = { current: null };
    const h = mount(
      <Transcript
        {...props(HISTORY)}
        scrollerElRef={scrollerElRef}
        followingRef={followingRef}
        onFollowingChange={(v: boolean) => {
          followingRef.current = v;
          changes.push(v);
        }}
      />,
    );
    return { h, el: scrollerElRef.current!, changes };
  }

  it("REGRESSION: a scroll-up with no user gesture keeps the transcript following", () => {
    const { h, el, changes } = mountFollowing();
    expect(el).not.toBeNull();
    // Pinned at the tail.
    measure(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    // Virtuoso compensates for a re-measured row: 500px up, no input event.
    measure(el, { scrollTop: 1000, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(changes).not.toContain(false);
    h.unmount();
  });

  it("still detaches when the same scroll follows a wheel gesture", () => {
    const { h, el, changes } = mountFollowing();
    measure(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    act(() => el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 })));
    measure(el, { scrollTop: 1000, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(changes.at(-1)).toBe(false);
    h.unmount();
  });

  it("detaches on a scrollbar drag (a button is held while the scroll fires)", () => {
    // The path geometry could not cover: under overlay scrollbars (macOS) a
    // press on the bar lands INSIDE the content box, so only the held button
    // distinguishes it from a click. Measured in headed Chromium: every scroll
    // of a thumb drag fires with the button down.
    const { h, el, changes } = mountFollowing();
    measure(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    act(() => el.dispatchEvent(new Event("pointerdown")));
    measure(el, { scrollTop: 1000, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(changes.at(-1)).toBe(false);
    h.unmount();
  });

  it("REGRESSION: clicking a tool card open does not detach", () => {
    // A click scrolls nothing while held; the expansion re-measures the row and
    // Virtuoso compensates a few ms LATER. That compensation must not inherit
    // intent from the click that caused it.
    const { h, el, changes } = mountFollowing();
    measure(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    act(() => el.dispatchEvent(new Event("pointerdown")));
    act(() => window.dispatchEvent(new Event("pointerup")));
    measure(el, { scrollTop: 1000, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(changes).not.toContain(false);
    h.unmount();
  });

  it("re-attaches when a scroll lands back at the bottom, gesture or not", () => {
    const { h, el, changes } = mountFollowing();
    measure(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    act(() => el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 })));
    measure(el, { scrollTop: 1000, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(changes.at(-1)).toBe(false);
    measure(el, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(changes.at(-1)).toBe(true);
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

// ===== Collapsed tool activity =====
//
// The transcript shows text; each run of consecutive tool calls is ONE quiet
// line. The tail run of a RUNNING turn lives in the working line instead.
describe("Transcript collapsed tool activity", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const part = (id: string, mid: string, p: Record<string, unknown>) =>
    ({ id, messageID: mid, ...p }) as unknown as OpencodeMessage["parts"][number];
  const asst = (id: string, parts: OpencodeMessage["parts"]): OpencodeMessage =>
    ({
      info: { id, sessionID: "s1", role: "assistant", time: { created: 1_700_000_000_000 } },
      parts,
    }) as unknown as OpencodeMessage;
  const text = (id: string, mid: string, t: string) => part(id, mid, { type: "text", text: t });
  const read = (id: string, mid: string, file: string, status = "completed") =>
    part(id, mid, {
      type: "tool",
      tool: "read",
      state: { status, input: { filePath: `/src/${file}` }, title: file, output: "contents" },
    });
  const bash = (id: string, mid: string, status = "completed") =>
    part(id, mid, {
      type: "tool",
      tool: "bash",
      state: {
        status,
        input: { description: "Run the tests", command: "npm test" },
        output: "SENTINEL-OUTPUT",
      },
    });

  const lines = (hh: Harness | null) => hh!.container.querySelectorAll(".manta-tool-group");
  // Tool-card disclosure buttons (the group line / working line are excluded).
  const cards = (hh: Harness | null) =>
    hh!.container.querySelectorAll('button[aria-expanded]:not([title$="tool calls"])');
  const rowIds = (hh: Harness | null) =>
    Array.from(hh!.container.querySelectorAll("[data-message-id]")).map((e) =>
      e.getAttribute("data-message-id"),
    );

  // A burst spread over three assistant messages (one per model step), then
  // the closing text and its footer.
  const FINISHED = [
    msg("u1", "user", "go"),
    asst("a1", [text("a1t", "a1", "Looking."), read("a1r", "a1", "a.ts")]),
    asst("a2", [read("a2r", "a2", "b.ts")]),
    asst("a3", [bash("a3b", "a3")]),
    asst("a4", [text("a4t", "a4", "All done.")]),
  ];

  it("renders text plus ONE collapsed line per run, and no tool cards until clicked", () => {
    motionStateRef = { current: null };
    h = mount(<Transcript {...props(FINISHED)} />);
    expect(h.text()).toContain("Looking.");
    expect(h.text()).toContain("All done.");
    expect(lines(h)).toHaveLength(1);
    expect(lines(h)[0].textContent).toContain("Read 2 files, ran a command");
    expect(cards(h)).toHaveLength(0);
    // The messages the run spilled into draw nothing and get no Virtuoso row.
    expect(rowIds(h)).toEqual(["u1", "a1", "a4"]);
  });

  it("clicking the line expands the run's tool cards, and again collapses it", () => {
    motionStateRef = { current: null };
    h = mount(<Transcript {...props(FINISHED)} />);
    act(() => (lines(h)[0] as HTMLElement).click());
    expect(cards(h)).toHaveLength(3);
    // Each card keeps its own disclosure: the output is still hidden.
    expect(h.text()).not.toContain("SENTINEL-OUTPUT");
    expect(lines(h)[0].getAttribute("aria-expanded")).toBe("true");
    // (The cards leave on CardMount's exit animation, so assert the line's
    // own state rather than racing the unmount.)
    act(() => (lines(h)[0] as HTMLElement).click());
    expect(lines(h)[0].getAttribute("aria-expanded")).toBe("false");
  });

  it("a run with exactly one tool call opens with its card expanded", () => {
    motionStateRef = { current: null };
    h = mount(
      <Transcript
        {...props([msg("u1", "user", "go"), asst("a1", [bash("a1b", "a1")]), asst("a2", [text("a2t", "a2", "ok")])])}
      />,
    );
    expect(lines(h)[0].textContent).toContain("Run the tests");
    expect(h.text()).not.toContain("SENTINEL-OUTPUT");
    act(() => (lines(h)[0] as HTMLElement).click());
    expect(cards(h)).toHaveLength(1);
    expect(h.text()).toContain("SENTINEL-OUTPUT");
  });

  it("a failed call turns the count red and the line reports it", () => {
    motionStateRef = { current: null };
    h = mount(
      <Transcript
        {...props([
          msg("u1", "user", "go"),
          asst("a1", [read("r1", "a1", "a.ts"), read("r2", "a1", "b.ts", "error")]),
          asst("a2", [text("a2t", "a2", "hm")]),
        ])}
      />,
    );
    expect(lines(h)[0].textContent).toContain("1 failed");
    expect(lines(h)[0].querySelector(".text-danger")).toBeTruthy();
  });

  it("while the turn runs, the tail run is NOT drawn inline — the working line shows it", () => {
    motionStateRef = { current: null };
    const running = [
      msg("u1", "user", "go"),
      asst("a1", [text("a1t", "a1", "Looking."), read("a1r", "a1", "a.ts")]),
      asst("a2", [read("a2r", "a2", "b.ts", "running")]),
    ];
    h = mount(
      <Transcript
        {...props(running, true)}
        liveTurn={{ startedAt: Date.now() - 5_000, tokens: 300, verbSeedId: "a1" }}
      />,
    );
    expect(lines(h)).toHaveLength(0);
    expect(rowIds(h)).toEqual(["u1", "a1"]); // the tool-only rows are withheld too
    const working = h.container.querySelector(".manta-working-indicator")!;
    expect(working.textContent).toContain("Reading b.ts…");
    expect(working.textContent).toContain("2 tools");
    // Clicking it expands the same tool list.
    expect(cards(h)).toHaveLength(0);
    act(() => (working.querySelector("button") as HTMLElement).click());
    expect(cards(h)).toHaveLength(2);
  });

  it("once text follows the run it settles inline as a normal collapsed line", () => {
    motionStateRef = { current: null };
    const base = [
      msg("u1", "user", "go"),
      asst("a1", [read("a1r", "a1", "a.ts")]),
    ];
    h = mount(<Transcript {...props(base, true)} />);
    expect(lines(h)).toHaveLength(0);
    h.rerender(<Transcript {...props([...base, asst("a2", [text("a2t", "a2", "Found it.")])], true)} />);
    expect(lines(h)).toHaveLength(1);
    expect(lines(h)[0].textContent).toContain("Read a.ts");
  });
});
