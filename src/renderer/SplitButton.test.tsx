// @vitest-environment jsdom
//
// Component tests for the SplitButton chrome primitive (BET-971).
//
// SplitButton is a two-segment ACTION wearing `Button`'s chrome — the split
// brother of SplitChip (a 29px status readout). It exists so a split control
// sitting in a row of `Button`s is itself a `Button` (32px / medium). The
// contract is asserted on the exact class strings, same as the other
// primitives (see Chip.test.tsx): a retune of either primitive's chrome fails
// here immediately.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { SplitButton } from "./Button";

const BUTTON_CHROME =
  "inline-flex items-center h-8 rounded-md border " +
  "text-[12.5px] font-medium leading-none transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:opacity-50 disabled:cursor-not-allowed";
const BUTTON_PAD = "gap-[6px] px-[14px]";
const SPLIT_BUTTON_TONE = "border-border bg-bg text-text";
const SEG_BASE = `inline-flex items-center ${BUTTON_PAD} h-full transition-colors`;

describe("SplitButton", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function buttons(): HTMLButtonElement[] {
    const els = h!.container.querySelectorAll("button");
    expect(els.length).toBe(2);
    return Array.from(els) as HTMLButtonElement[];
  }

  // Every case mounts the same two-segment baseline and varies ONE prop.
  type SplitProps = Partial<Parameters<typeof SplitButton>[0]>;
  function mountBtn(props: SplitProps = {}): HTMLElement {
    h?.unmount();
    h = mount(
      <SplitButton
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        {...props}
      />,
    );
    return h.container.firstElementChild as HTMLElement;
  }

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — SplitButton must NOT accept className (M527 decision 3)
    void <SplitButton left={<>l</>} right={<>r</>} onLeftClick={() => {}} onRightClick={() => {}} className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("wears Button's shell chrome — h-8 (32px), medium weight — not SplitChip's 29px status shell", () => {
    const shell = mountBtn();
    expect(shell.className).toBe(`${BUTTON_CHROME} p-0 overflow-hidden ${SPLIT_BUTTON_TONE}`);
    expect(shell.className).toContain("h-8");
    expect(shell.className).toContain("font-medium");
    expect(shell.className).not.toContain("h-[29px]");
  });

  it("renders both segments as <button> with the shared padding", () => {
    mountBtn();
    const [l, r] = buttons();
    expect(l.tagName).toBe("BUTTON");
    expect(r.tagName).toBe("BUTTON");
    expect(l.className).toBe(`${SEG_BASE} hover:bg-fill-hover`);
    expect(r.className).toBe(`${SEG_BASE} border-l border-border hover:bg-fill-hover`);
  });

  it("right segment carries aria-haspopup=listbox and its hook (the popup coverage registry key)", () => {
    mountBtn({ rightHook: "manta-plan-delegate-model-btn" });
    const [l, r] = buttons();
    expect(r.getAttribute("aria-haspopup")).toBe("listbox");
    expect(r.className).toContain("manta-plan-delegate-model-btn");
    // The LEFT segment is a plain action — it must not claim aria-haspopup.
    expect(l.hasAttribute("aria-haspopup")).toBe(false);
    // Without the prop, no hook class leaks.
    mountBtn();
    expect(buttons()[1].className).not.toContain("manta-");
  });

  it("applies leftHook/rightHook to the segment buttons, not the shell", () => {
    const shell = mountBtn({
      leftHook: "manta-plan-delegate-btn",
      rightHook: "manta-plan-delegate-model-btn",
    });
    expect(shell.className).not.toContain("manta-plan-delegate-btn");
    expect(shell.className).not.toContain("manta-plan-delegate-model-btn");
    const [l, r] = buttons();
    expect(l.className).toContain("manta-plan-delegate-btn");
    expect(r.className).toContain("manta-plan-delegate-model-btn");
  });

  it("disabled marks BOTH segment buttons native-disabled (dimmed, not clickable)", () => {
    mountBtn({ disabled: true });
    const [l, r] = buttons();
    expect(l.disabled).toBe(true);
    expect(r.disabled).toBe(true);
  });

  it("fires onLeftClick and onRightClick independently", () => {
    let l = 0;
    let r = 0;
    mountBtn({ onLeftClick: () => l++, onRightClick: () => r++ });
    const [bl, br] = buttons();
    bl.click();
    expect(l).toBe(1);
    expect(r).toBe(0);
    br.click();
    expect(l).toBe(1);
    expect(r).toBe(1);
  });

  it("rightAccent colours the right segment only (--accent-tx, no weight change)", () => {
    mountBtn({ rightAccent: true });
    const [l, r] = buttons();
    expect(r.className).toContain("text-accent-tx");
    expect(l.className).not.toContain("text-accent-tx");

    mountBtn();
    expect(buttons()[1].className).not.toContain("text-accent-tx");
  });

  it("loading is presentational: shell aria-busy, segments not disabled, hover dropped", () => {
    const shell = mountBtn({ loading: true });
    expect(shell.getAttribute("aria-busy")).toBe("true");
    const [l, r] = buttons();
    expect(l.disabled).toBe(false);
    expect(r.disabled).toBe(false);
    expect(l.className).not.toContain("hover:");
    expect(r.className).not.toContain("hover:");

    // Absent the prop nothing leaks.
    const rest = mountBtn();
    expect(rest.hasAttribute("aria-busy")).toBe(false);
  });
});
