// @vitest-environment jsdom
//
// Component tests for the MeasureColumn reading-column chrome primitive
// (BET-637). As with the other primitives, the "tokens" are class names or
// token references (maxWidth var(--measure) → the 72ch measure,
// paddingInline var(--transcript-inset) → the wider transcript gutter that
// holds the per-turn timestamp). jsdom loads no stylesheet, so the contract
// is asserted on the exact class strings and the inline style. The two adopters (Transcript.tsx, InputArea.tsx) migrate
// through the real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { MeasureColumn } from "./MeasureColumn";

describe("MeasureColumn", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — MeasureColumn must NOT accept className (M527 decision 3)
    void <MeasureColumn className="bg-red-500">x</MeasureColumn>;
    expect(true).toBe(true);
  });

  it("renders the non-stacked reading chrome (block, 28px inset, measure-capped)", () => {
    h = mount(<MeasureColumn>Hello</MeasureColumn>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe("w-full mx-auto");
    expect(el.style.paddingInline).toBe("28px");
    expect(el.style.maxWidth).toBe("var(--measure)");
    expect(el.style.gap).toBe("");
    expect(el.textContent).toBe("Hello");
  });

  it("adds the flex-column + turn-gap chrome when stacked (the transcript)", () => {
    h = mount(
      <MeasureColumn stacked>
        <span>a</span>
        <span>b</span>
      </MeasureColumn>,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe("w-full mx-auto flex flex-col");
    expect(el.style.paddingInline).toBe("28px");
    expect(el.style.gap).toBe("var(--turn-gap)");
  });

  it('renders the "full" variant uncapped and uncentred, at the wider transcript inset', () => {
    h = mount(<MeasureColumn width="full">Hello</MeasureColumn>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe("w-full");
    // The wider gutter is what the per-turn timestamp is positioned into.
    expect(el.style.paddingInline).toBe("var(--transcript-inset)");
    expect(el.style.maxWidth).toBe("");
    expect(el.style.gap).toBe("");
    expect(el.textContent).toBe("Hello");
  });

  it('keeps the turn-gap flex column under "full" when stacked', () => {
    h = mount(
      <MeasureColumn width="full" stacked>
        <span>a</span>
        <span>b</span>
      </MeasureColumn>,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe("w-full flex flex-col");
    expect(el.style.paddingInline).toBe("var(--transcript-inset)");
    expect(el.style.maxWidth).toBe("");
    expect(el.style.gap).toBe("var(--turn-gap)");
  });

  it('renders "measure" explicitly as today\'s capped+centred behaviour', () => {
    h = mount(<MeasureColumn width="measure">Hello</MeasureColumn>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe("w-full mx-auto");
    expect(el.style.paddingInline).toBe("28px");
    expect(el.style.maxWidth).toBe("var(--measure)");
    expect(el.style.gap).toBe("");
  });
});
