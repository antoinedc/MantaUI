// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { TranscriptTail, type TranscriptContext } from "./Transcript";

const ctx = (over: Partial<TranscriptContext> = {}): TranscriptContext => ({
  running: false,
  liveTurn: null,
  showLoadEarlier: false,
  loadingEarlier: false,
  onLoadEarlier: () => {},
  activeTodos: null,
  questions: [],
  onReplyQuestion: () => {},
  onRejectQuestion: () => {},
  ...over,
});

describe("TranscriptTail", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("is a flex column that owns the gap between its children", () => {
    h = mount(<TranscriptTail context={ctx()} />);
    const root = h.container.firstElementChild as HTMLElement;
    expect(root.style.display).toBe("flex");
    expect(root.style.flexDirection).toBe("column");
    expect(root.style.gap).toBe("var(--block-gap)");
  });

  it("separates the tail from the last message row without depending on the working row", () => {
    // The working row unmounts when the turn ends; the gap above the tail must
    // not unmount with it (that was the "Reflected for … touches the TODO card"
    // bug). It lives on the container, so it is there in BOTH states.
    for (const running of [true, false]) {
      h?.unmount();
      h = mount(<TranscriptTail context={ctx({ running })} />);
      const root = h.container.firstElementChild as HTMLElement;
      expect(root.style.paddingTop).toBe("var(--block-gap)");
    }
  });
});
