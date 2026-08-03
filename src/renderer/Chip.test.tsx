// @vitest-environment jsdom
//
// Component tests for the Chip chrome primitive (BET-615, stage 2 of M527).
//
// As with the other primitives, the "tokens" are class names that map through
// tailwind.config.js to the design tokens (rounded-md → --r-md, h-[29px] →
// 29px, text-accent-tx → --accent-tx). jsdom loads no stylesheet, so the
// contract is asserted on the exact class strings — a retune of Chip's chrome
// fails here immediately. The two adopters (ModelPicker.tsx via SplitChip and
// NewSessionScreen.tsx via Chip) are migrated through the real exported
// components.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { Chip, SplitChip } from "./Chip";

const CHIP_SHELL =
  "inline-flex items-center h-[29px] rounded-md border whitespace-nowrap text-meta font-medium leading-none transition-colors";
const CHIP_REST = "border-border bg-bg-soft text-text-muted";
const CHIP_HOVER = "hover:border-border-strong hover:text-text";
const CHIP_ON = "border-accent bg-accent-bg text-accent-tx";
const CHIP_PAD = "gap-[6px] px-[11px]";

function button(h: Harness): HTMLButtonElement {
  const el = h.container.querySelector("button") as HTMLButtonElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Chip", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Chip ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Chip must NOT accept className (M527 decision 3)
    void <Chip className="bg-red-500">x</Chip>;
    expect(true).toBe(true);
  });
  it("renders the shell + pad + rest chrome when off", () => {
    h = mount(<Chip>Hello</Chip>);
    expect(button(h).className).toBe(`${CHIP_SHELL} ${CHIP_PAD} ${CHIP_REST} ${CHIP_HOVER}`);
  });

  it("switches to the 'on' chrome when on=true", () => {
    h = mount(<Chip on>Hello</Chip>);
    expect(button(h).className).toBe(`${CHIP_SHELL} ${CHIP_PAD} ${CHIP_ON}`);
  });

  it("fires onClick and passes title through", () => {
    let clicked = 0;
    h = mount(<Chip onClick={() => clicked++} title="folder">/x</Chip>);
    expect(button(h).title).toBe("folder");
    button(h).click();
    expect(clicked).toBe(1);
  });

  it("renders children and prepends a hook class", () => {
    h = mount(<Chip hook="manta-folder-chip">leasebot</Chip>);
    expect(button(h).textContent).toBe("leasebot");
    expect(button(h).className).toBe(`manta-folder-chip ${CHIP_SHELL} ${CHIP_PAD} ${CHIP_REST} ${CHIP_HOVER}`);
  });
});

describe("SplitChip", () => {
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

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // @ts-expect-error — SplitChip must NOT accept className (M527 decision 3)
    void <SplitChip left={<>l</>} right={<>r</>} onLeftClick={() => {}} onRightClick={() => {}} className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("renders the split shell (rest chrome, no padding) around two segments", () => {
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
      />,
    );
    const shell = h.container.firstElementChild as HTMLElement;
    expect(shell.className).toBe(`${CHIP_SHELL} p-0 overflow-hidden ${CHIP_REST}`);
    const [l, r] = buttons();
    expect(l.className).toBe(`inline-flex items-center ${CHIP_PAD} h-full hover:bg-fill-hover hover:text-text`);
    expect(r.className).toBe(`inline-flex items-center ${CHIP_PAD} h-full border-l border-border hover:bg-fill-hover`);
  });

  it("fills the hovered segment, not the shell — Chip keeps the outline hover, SplitChip does not (BET-634)", () => {
    // A single Chip's shell still darkens its outline on hover.
    h = mount(<Chip>Hello</Chip>);
    expect(button(h).className).toContain("hover:border-border-strong");

    h.unmount();
    // The split control's shell carries NO outline hover; both segments fill.
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
      />,
    );
    const shell = h.container.firstElementChild as HTMLElement;
    expect(shell.className).not.toContain("hover:border-border-strong");
    expect(shell.className).not.toContain("hover:text-text");
    const [l, r] = buttons();
    expect(l.className).toContain("hover:bg-fill-hover");
    expect(r.className).toContain("hover:bg-fill-hover");
  });

  it("adds accent-tx + semibold to the right segment only when rightAccent", () => {
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        rightAccent
      />,
    );
    const [l, r] = buttons();
    expect(r.className).toContain("text-accent-tx");
    expect(r.className).toContain("font-semibold");
    expect(l.className).not.toContain("text-accent-tx");

    h.unmount();
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
      />,
    );
    expect(buttons()[1].className).not.toContain("text-accent-tx");
  });

  it("fires onLeftClick and onRightClick independently", () => {
    let l = 0;
    let r = 0;
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => l++}
        onRightClick={() => r++}
      />,
    );
    const [bl, br] = buttons();
    bl.click();
    expect(l).toBe(1);
    expect(r).toBe(0);
    br.click();
    expect(l).toBe(1);
    expect(r).toBe(1);
  });

  it("sets leftTitle and rightTitle", () => {
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        leftTitle="model"
        rightTitle="effort"
      />,
    );
    const [l, r] = buttons();
    expect(l.title).toBe("model");
    expect(r.title).toBe("effort");
  });

  it("applies leftHook/rightHook identity classes to the segment buttons, not just the shell (BET-635)", () => {
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        leftHook="manta-model-picker-btn"
        rightHook="manta-effort-picker-btn"
      />,
    );
    const shell = h.container.firstElementChild as HTMLElement;
    const [l, r] = buttons();
    // The coverage registry scans the aria-haspopup segment buttons for a
    // `manta-*` class, so the hooks must land on the buttons, not the shell.
    expect(shell.className).not.toContain("manta-model-picker-btn");
    expect(shell.className).not.toContain("manta-effort-picker-btn");
    expect(l.className).toContain("manta-model-picker-btn");
    expect(r.className).toContain("manta-effort-picker-btn");
    // Absent the props, no hook class leaks onto the buttons.
    h.unmount();
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
      />,
    );
    expect(buttons()[0].className).not.toContain("manta-");
    expect(buttons()[1].className).not.toContain("manta-");
  });

  it("sets aria-expanded per segment only when the caller provides it (BET-635)", () => {
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        popup
        leftExpanded
        rightExpanded={false}
      />,
    );
    const [l, r] = buttons();
    expect(l.getAttribute("aria-expanded")).toBe("true");
    expect(r.getAttribute("aria-expanded")).toBe("false");
    // Absent the props, no aria-expanded leaks onto the buttons — a non-popup
    // or stateless adopter stays clean.
    h.unmount();
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        popup
      />,
    );
    const [pl, pr] = buttons();
    expect(pl.hasAttribute("aria-expanded")).toBe(false);
    expect(pr.hasAttribute("aria-expanded")).toBe(false);
  });

  it("does NOT assume popup semantics: aria-haspopup is absent unless popup is opted in", () => {
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
      />,
    );
    const [l, r] = buttons();
    expect(l.hasAttribute("aria-haspopup")).toBe(false);
    expect(r.hasAttribute("aria-haspopup")).toBe(false);

    h.unmount();
    h = mount(
      <SplitChip
        left={<span>L</span>}
        right={<span>R</span>}
        onLeftClick={() => {}}
        onRightClick={() => {}}
        popup
      />,
    );
    const [pl, pr] = buttons();
    expect(pl.getAttribute("aria-haspopup")).toBe("listbox");
    expect(pr.getAttribute("aria-haspopup")).toBe("listbox");
  });
});
