// @vitest-environment jsdom
//
// Component tests for the SessionRow chrome primitive (BET-536, stage 7 of
// M527).
//
// As with Card/Field/Pill/IconButton/MenuItem, the primitive's "tokens" are
// class names that map through tailwind.config.js to the design tokens
// (min-h-[var(--row-h)] → --row-h, px-[var(--row-px)] → --row-px,
// rounded-lg → --r-md, mb-1 → --sp-1 (4px), bg-raised → --raised,
// text-text-muted → --tx2, text-text → --tx1, text-text-quiet → --tx4,
// text-label → 13px, text-micro → 11px, font-mono, tabular-nums,
// bg-warn/bg-danger/bg-accent/bg-ok, ring-accent-bg/ring-danger-bg).
// jsdom loads no stylesheet, so the contract is asserted on the exact class
// strings — a retune of the primitive's chrome fails here.

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { SessionRow, type SessionStatus } from "./SessionRow";

describe("SessionRow — one line: dot · name · age", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("owns the density-metric chrome via token references, never hardcoded (C2)", () => {
    h = mount(<SessionRow status="idle" name="Add CSV export" age="4m" />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("min-h-[var(--row-h)]");
    expect(el.className).toContain("px-[var(--row-px)]");
    expect(el.className).toContain("py-[var(--row-py)]");
    // The row must NOT hardcode its own metrics.
    expect(el.className).not.toContain("min-h-8");
    // The rest of the row element chrome.
    expect(el.className).toContain("flex");
    expect(el.className).toContain("items-center");
    expect(el.className).toContain("gap-2");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain("mb-1");
    // Resting: hover fill, no selection surface/marker.
    expect(el.className).toContain("hover:bg-fill-hover");
    expect(el.className).not.toContain("bg-raised");
  });

  it("renders dot · name · age in order, name flex-truncates, age is a never-shrinking mono slot", () => {
    h = mount(<SessionRow status="run" name="Deploy" age="2h" />);
    const el = h.container.firstElementChild as HTMLElement;
    // dot
    const dot = el.firstElementChild as HTMLElement;
    expect(dot.className).toContain("h-[7px]");
    expect(dot.className).toContain("w-[7px]");
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).toContain("shrink-0");
    // name: flex-1, min-w-0, truncate, 13px label
    const name = dot.nextElementSibling as HTMLElement;
    expect(name.className).toContain("flex-1");
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("text-label");
    expect(name.textContent).toBe("Deploy");
    // age: mono, tabular, right, shrink-0, min-width 20, 11px
    const age = name.nextElementSibling as HTMLElement;
    expect(age.className).toContain("shrink-0");
    expect(age.className).toContain("min-w-[20px]");
    expect(age.className).toContain("text-right");
    expect(age.className).toContain("font-mono");
    expect(age.className).toContain("tabular-nums");
    expect(age.className).toContain("text-micro");
    expect(age.textContent).toBe("2h");
  });

  it("status dot variants carry the spec'd tints (C4 data drive)", () => {
    const cases: Array<[SessionStatus, string, string]> = [
      ["run", "bg-accent", "animate-pulse"],
      ["att", "bg-danger", "animate-pulse"],
      ["idle", "bg-warn", ""],
      ["ok", "bg-ok", ""],
      ["default", "", ""],
    ];
    for (const [variant, tint, pulse] of cases) {
      h = mount(<SessionRow status={variant} name="x" />);
      const dot = h.container.firstElementChild?.firstElementChild as HTMLElement;
      if (variant === "default") expect(dot.className).toContain("bg-text-quiet");
      else expect(dot.className).not.toContain("bg-text-quiet");
      if (tint) expect(dot.className).toContain(tint);
      if (variant === "run" || variant === "att") {
        expect(dot.className).toContain("ring-[3px]");
      }
      if (pulse) expect(dot.className).toContain(pulse);
      else expect(dot.className).not.toContain("animate-pulse");
      h?.unmount();
      h = null;
    }
  });

  it("run/att invalidate the --tx4 base with the spec'd 3px ring of the matching -bg token", () => {
    h = mount(<SessionRow status="att" name="Refactor auth" />);
    const dot = h.container.firstElementChild?.firstElementChild as HTMLElement;
    expect(dot.className).toContain("bg-danger");
    expect(dot.className).toContain("ring-danger-bg");
    expect(dot.className).not.toContain("bg-text-quiet");
  });

  it("selected (.on) raises the surface and owns the C3 marker at left:-8px; name brightens + weights 600", () => {
    h = mount(<SessionRow status="run" name="Deploy" selected />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("bg-raised");
    // C3: the marker hangs at left:-8px — the primitive owns the marker, not a
    // left inset on itself.
    expect(el.className).toContain("before:left-[-8px]");
    // Resting hover is dropped once selected (the row is already surfaced).
    expect(el.className).not.toContain("hover:bg-fill-hover");
    const name = el.firstElementChild!.nextElementSibling as HTMLElement;
    expect(name.className).toContain("text-text");
    expect(name.className).toContain("font-semibold");
  });

  it("child (.child) indents 26px and owns the left:13px connectors, no marker", () => {
    h = mount(<SessionRow status="ok" name="subagent" child />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("pl-[26px]");
    expect(el.className).toContain("before:left-[13px]");
    expect(el.className).toContain("after:left-[13px]");
    expect(el.className).toContain("before:bg-border");
    expect(el.className).toContain("after:bg-border");
    expect(el.className).not.toContain("before:left-[-8px]");
  });

  it("a selected child turns its connectors --accent (`.srow.child.on`)", () => {
    h = mount(<SessionRow status="ok" name="subagent" child selected />);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("before:bg-accent");
    expect(el.className).toContain("after:bg-accent");
    expect(el.className).not.toContain("before:bg-border");
  });

  it("a stale age is visibility-hidden at rest and reveals on row hover", () => {
    h = mount(<SessionRow status="default" name="x" age="2h" ageStale />);
    const el = h.container.firstElementChild as HTMLElement;
    const age = el.lastElementChild as HTMLElement;
    expect(age.className).toContain("invisible");
    expect(age.className).toContain("group-hover:visible");
    // No standalone ` visible` utility (the only "visible" is inside
    // group-hover:visible).
    expect(age.className).not.toMatch(/\svisible(\s|$)/);
  });

  it("renders a right-aligned trailing affordance (pin slot) after the age", () => {
    h = mount(
      <SessionRow status="default" name="x" age="1m" trailing={<button>pin</button>} />,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.textContent).toContain("pin");
  });

  it("forwards the status-dot tooltip and tree a11y attributes", () => {
    h = mount(
      <SessionRow
        status="run"
        name="Deploy"
        statusTitle="Running · 2 subagents"
        title="row title"
        ariaSelected
        ariaLevel={2}
        tabIndex={0}
      />,
    );
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("treeitem");
    expect(el.getAttribute("aria-selected")).toBe("true");
    expect(el.getAttribute("aria-level")).toBe("2");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("title")).toBe("row title");
    const dot = el.firstElementChild as HTMLElement;
    expect(dot.getAttribute("title")).toBe("Running · 2 subagents");
    // The decorative dot is hidden from the a11y tree so its tooltip never
    // leaks into the row's accessible name (regression against the clean
    // "Deploy new billing service Pin" baseline names).
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("invokes onClick and onContextMenu on the row", () => {
    let clicked = 0;
    let ctx = 0;
    h = mount(
      <SessionRow
        status="idle"
        name="x"
        onClick={() => clicked++}
        onContextMenu={() => ctx++}
      />,
    );
    const el = h.container.firstElementChild as HTMLElement;
    el.click();
    expect(clicked).toBe(1);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(ctx).toBe(1);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If SessionRow ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — SessionRow must NOT accept className (M527 decision 3)
    void <SessionRow status="idle" name="x" className="bg-red-500" />;
    expect(true).toBe(true);
  });

  it("requires a status — a bare row with no status is a TYPE ERROR (C4)", () => {
    // @ts-expect-error — status is REQUIRED with no default (C4 applies to the dot)
    void <SessionRow name="x" />;
    expect(true).toBe(true);
  });
});
