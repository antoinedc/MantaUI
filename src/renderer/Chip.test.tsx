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

const CHIP_BASE =
  "inline-flex items-center h-[29px] rounded-md border whitespace-nowrap text-meta leading-none transition-colors";
// Single chip = medium (a labelled action). Split chip = regular (a status
// readout). The divergence is deliberate — see Chip.tsx's header.
const CHIP_SHELL = `${CHIP_BASE} font-medium`;
const SPLIT_SHELL = `${CHIP_BASE} font-normal`;
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

  // Every case below mounts the same two-segment baseline and varies ONE prop,
  // so the four required props are supplied here once. Re-mounting inside a
  // case (the "absent the prop, nothing leaks" half of several tests) goes
  // through the same helper, which unmounts the previous harness for you.
  type SplitProps = Partial<Parameters<typeof SplitChip>[0]>;
  function mountSplit(props: SplitProps = {}): HTMLElement {
    h?.unmount();
    h = mount(
      <SplitChip
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
    // @ts-expect-error — SplitChip must NOT accept className (M527 decision 3)
    void <SplitChip left={<>l</>} right={<>r</>} onLeftClick={() => {}} onRightClick={() => {}} className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("renders the split shell (rest chrome, no padding) around two segments", () => {
    const shell = mountSplit();
    expect(shell.className).toBe(`${SPLIT_SHELL} p-0 overflow-hidden ${CHIP_REST}`);
    const [l, r] = buttons();
    expect(l.className).toBe(`inline-flex items-center ${CHIP_PAD} h-full hover:bg-fill-hover hover:text-text`);
    expect(r.className).toBe(`inline-flex items-center ${CHIP_PAD} h-full border-l border-border hover:bg-fill-hover`);
  });

  it("fills the hovered segment, not the shell — Chip keeps the outline hover, SplitChip does not (BET-634)", () => {
    // A single Chip's shell still darkens its outline on hover.
    h = mount(<Chip>Hello</Chip>);
    expect(button(h).className).toContain("hover:border-border-strong");

    // The split control's shell carries NO outline hover; both segments fill.
    const shell = mountSplit();
    expect(shell.className).not.toContain("hover:border-border-strong");
    expect(shell.className).not.toContain("hover:text-text");
    const [l, r] = buttons();
    expect(l.className).toContain("hover:bg-fill-hover");
    expect(r.className).toContain("hover:bg-fill-hover");
  });

  it("adds accent-tx — COLOUR ONLY, no weight bump — to the right segment only when rightAccent", () => {
    mountSplit({ rightAccent: true });
    const [l, r] = buttons();
    expect(r.className).toContain("text-accent-tx");
    // The accent carries the emphasis; a weight bump on top made the effort
    // label the heaviest text in the composer.
    expect(r.className).not.toContain("font-semibold");
    expect(l.className).not.toContain("text-accent-tx");

    mountSplit();
    expect(buttons()[1].className).not.toContain("text-accent-tx");
  });

  it("fires onLeftClick and onRightClick independently", () => {
    let l = 0;
    let r = 0;
    mountSplit({ onLeftClick: () => l++, onRightClick: () => r++ });
    const [bl, br] = buttons();
    bl.click();
    expect(l).toBe(1);
    expect(r).toBe(0);
    br.click();
    expect(l).toBe(1);
    expect(r).toBe(1);
  });

  it("sets leftTitle and rightTitle", () => {
    mountSplit({ leftTitle: "model", rightTitle: "effort" });
    const [l, r] = buttons();
    expect(l.title).toBe("model");
    expect(r.title).toBe("effort");
  });

  it("applies leftHook/rightHook identity classes to the segment buttons, not just the shell (BET-635)", () => {
    const shell = mountSplit({
      leftHook: "manta-model-picker-btn",
      rightHook: "manta-effort-picker-btn",
    });
    const [l, r] = buttons();
    // The coverage registry scans the aria-haspopup segment buttons for a
    // `manta-*` class, so the hooks must land on the buttons, not the shell.
    expect(shell.className).not.toContain("manta-model-picker-btn");
    expect(shell.className).not.toContain("manta-effort-picker-btn");
    expect(l.className).toContain("manta-model-picker-btn");
    expect(r.className).toContain("manta-effort-picker-btn");
    // Absent the props, no hook class leaks onto the buttons.
    mountSplit();
    expect(buttons()[0].className).not.toContain("manta-");
    expect(buttons()[1].className).not.toContain("manta-");
  });

  it("sets aria-expanded per segment only when the caller provides it (BET-635)", () => {
    mountSplit({ popup: true, leftExpanded: true, rightExpanded: false });
    const [l, r] = buttons();
    expect(l.getAttribute("aria-expanded")).toBe("true");
    expect(r.getAttribute("aria-expanded")).toBe("false");
    // Absent the props, no aria-expanded leaks onto the buttons — a non-popup
    // or stateless adopter stays clean.
    mountSplit({ popup: true });
    const [pl, pr] = buttons();
    expect(pl.hasAttribute("aria-expanded")).toBe(false);
    expect(pr.hasAttribute("aria-expanded")).toBe(false);
  });

  it("loading drops every segment's hover affordance together and marks the shell aria-busy", () => {
    const shell = mountSplit({ loading: true, rightAccent: true });
    expect(shell.getAttribute("aria-busy")).toBe("true");
    const [l, r] = buttons();
    // No segment offers a hover it can't honour, and the accent is withheld:
    // the right segment's colour asserts a resolved value it doesn't have yet.
    expect(l.className).not.toContain("hover:");
    expect(r.className).not.toContain("hover:");
    expect(r.className).not.toContain("text-accent-tx");
    expect(l.className).toContain("cursor-default");
    expect(r.className).toContain("cursor-default");

    // Absent the prop nothing leaks — aria-busy is omitted, not "false".
    const rest = mountSplit();
    expect(rest.hasAttribute("aria-busy")).toBe(false);
  });

  it("loading is presentational: it must NOT disable the segments (a failed fetch would strand the user)", () => {
    let l = 0;
    mountSplit({ loading: true, onLeftClick: () => l++ });
    const [bl, br] = buttons();
    expect(bl.disabled).toBe(false);
    expect(br.disabled).toBe(false);
    bl.click();
    // The left segment still opens its (self-describing) menu while loading.
    expect(l).toBe(1);
  });

  it("does NOT assume popup semantics: aria-haspopup is absent unless popup is opted in", () => {
    mountSplit();
    const [l, r] = buttons();
    expect(l.hasAttribute("aria-haspopup")).toBe(false);
    expect(r.hasAttribute("aria-haspopup")).toBe(false);

    mountSplit({ popup: true });
    const [pl, pr] = buttons();
    expect(pl.getAttribute("aria-haspopup")).toBe("listbox");
    expect(pr.getAttribute("aria-haspopup")).toBe("listbox");
  });

  it("per-segment popup: an object marks only the named segment (BET-948)", () => {
    // `{ right: true }` — a caller whose LEFT segment is a plain action and
    // whose RIGHT opens a listbox. The action must not falsely claim
    // aria-haspopup while the listbox segment stays in the coverage registry.
    mountSplit({ popup: { right: true } });
    const [l, r] = buttons();
    expect(l.hasAttribute("aria-haspopup")).toBe(false);
    expect(r.getAttribute("aria-haspopup")).toBe("listbox");

    // `{ left: true }` — the mirror case.
    mountSplit({ popup: { left: true } });
    const [ml, mr] = buttons();
    expect(ml.getAttribute("aria-haspopup")).toBe("listbox");
    expect(mr.hasAttribute("aria-haspopup")).toBe(false);

    // Both segments opted in by object behaves like `true`.
    mountSplit({ popup: { left: true, right: true } });
    const [bl, br] = buttons();
    expect(bl.getAttribute("aria-haspopup")).toBe("listbox");
    expect(br.getAttribute("aria-haspopup")).toBe("listbox");

    // An all-false object is the non-popup default.
    mountSplit({ popup: { right: false } });
    const [fl, fr] = buttons();
    expect(fl.hasAttribute("aria-haspopup")).toBe(false);
    expect(fr.hasAttribute("aria-haspopup")).toBe(false);
  });
});
