// @vitest-environment jsdom
//
// Component tests for the MenuItem / Dropdown chrome primitives (BET-535,
// stage 6 of M527).
//
// As with Card/Field/Pill/IconButton, the primitive's "tokens" are class
// names that map through tailwind.config.js to the design tokens
// (bg-bg-elev → --panel, border-border → --border, shadow-md → --shadow-md,
// rounded-lg → --r-md, bg-bg-soft → --card, text-text → --tx1,
// text-danger → --danger, bg-danger-bg → --danger-bg, text-accent → --accent,
// text-label → 13px, px-2/py-2 → sp-2/sp-2). jsdom loads no stylesheet, so
// the contract is asserted on the exact class strings — a retune of the
// primitive's chrome fails here.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { Zap } from "lucide-react";
import { mount, type Harness } from "./testHarness";
import { Dropdown, MenuItem } from "./MenuItem";
import { SessionHeader } from "./SessionHeader";

const ITEM_BASE = "flex w-full items-center gap-2 px-2 py-2 text-left text-label";

describe("Dropdown — the shared dropdown surface", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the panel tokens (bg-elev, border, shadow-md, r-md, py-1) and role=menu", () => {
    h = mount(<Dropdown>hello</Dropdown>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("menu");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain("border");
    expect(el.className).toContain("border-border");
    expect(el.className).toContain("bg-bg-elev");
    expect(el.className).toContain("shadow-md");
    expect(el.className).toContain("py-1");
    expect(el.textContent).toBe("hello");
  });

  it("carries a manta-* identity hook without accepting arbitrary className", () => {
    h = mount(<Dropdown hook="manta-session-menu-dropdown">x</Dropdown>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("manta-session-menu-dropdown");
  });
});

describe("MenuItem", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("normal renders the 13px label, sp-2/sp-2 padding and bg-soft hover per the contract", () => {
    h = mount(<MenuItem>Fork session</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe(`${ITEM_BASE} text-text hover:bg-bg-soft`);
    expect(el.className).toContain("text-label");
    expect(el.className).toContain("px-2");
    expect(el.className).toContain("py-2");
    expect(el.className).toContain("hover:bg-bg-soft");
    expect(el.className).toContain("text-text");
    expect(el.getAttribute("role")).toBe("menuitem");
  });

  it("danger renders --danger text with a --danger-bg hover (C1)", () => {
    h = mount(<MenuItem variant="danger">Delete session</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("text-danger");
    expect(el.className).toContain("hover:bg-danger-bg");
    expect(el.className).not.toContain("hover:bg-bg-soft");
  });

  it("active renders --accent text with the bg-soft hover", () => {
    h = mount(<MenuItem variant="active">Chat</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("text-accent");
    expect(el.className).toContain("hover:bg-bg-soft");
  });

  it("renders a leading icon at 14px, hidden from the a11y tree", () => {
    h = mount(<MenuItem icon={<Zap />}>Chat</MenuItem>);
    const svg = h.container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(h.container.firstElementChild?.textContent).toContain("Chat");
  });

  it("renders a trailing affordance (e.g. the active-mode ✓ mark) right-aligned", () => {
    h = mount(
      <MenuItem trailing={<span aria-hidden="true">✓</span>}>Chat</MenuItem>,
    );
    const el = h.container.firstElementChild as HTMLElement;
    const label = el.querySelector("span.flex-1");
    expect(label?.textContent).toBe("Chat");
    expect(el.textContent).toContain("✓");
  });

  it("invokes onSelect when clicked", () => {
    let clicked = false;
    h = mount(<MenuItem onSelect={() => (clicked = true)}>x</MenuItem>);
    (h.container.firstElementChild as HTMLElement).click();
    expect(clicked).toBe(true);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If MenuItem ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — MenuItem must NOT accept className (M527 decision 3)
    void <MenuItem className="bg-red-500">x</MenuItem>;
    expect(true).toBe(true);
  });
});

describe("MenuItem migration — SessionMenu call sites (BET-535)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function renderHeader() {
    h = mount(
      <SessionHeader
        branch={null}
        ctxBreakdown={{ freshInput: 1, cacheRead: 1, cacheWrite: 1, totalInput: 100, pct: 12, segments: [] }}
        ctxLimit={200000}
        staleCache={{ isStale: false, idleMs: 0, staleTokens: 0, ttlMs: 0 }}
        modelName={null}
        hasSession
        onFork={() => {}}
        onCompact={() => {}}
        onClear={() => {}}
        onDelete={() => {}}
        breadcrumb={null}
        mode="chat"
        onModeChange={() => {}}
      />,
    );
  }

  function openMenu() {
    renderHeader();
    const trigger = h!.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Session actions"]',
    );
    expect(trigger).toBeTruthy();
    act(() => trigger!.click());
  }

  function items(): HTMLElement[] {
    const menu = h!.container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    return [...menu.querySelectorAll<HTMLElement>("button[role='menuitem']")];
  }

  function itemByText(text: string): HTMLElement {
    const el = items().find((b) => b.textContent?.trim().includes(text));
    expect(el, `expected a "${text}" menu row`).toBeTruthy();
    return el!;
  }

  it("renders the dropdown surface and the normal Fork / Compact / Clear rows with MenuItem chrome", () => {
    openMenu();
    const surface = h!.container.querySelector(".manta-session-menu-dropdown") as HTMLElement;
    expect(surface.getAttribute("role")).toBe("menu");
    expect(surface.className).toContain("bg-bg-elev");
    expect(surface.className).toContain("shadow-md");

    for (const label of ["Fork session", "Compact context", "Clear session"]) {
      const row = itemByText(label);
      expect(row.className).toContain("text-text");
      expect(row.className).toContain("hover:bg-bg-soft");
      expect(row.className).not.toContain("text-danger");
    }
  });

  it("renders the danger Delete row with the --danger / --danger-bg chrome", () => {
    openMenu();
    const row = itemByText("Delete session");
    expect(row.className).toContain("text-danger");
    expect(row.className).toContain("hover:bg-danger-bg");
  });

  it("renders the active mode row with the --accent chrome and the ✓ mark", () => {
    openMenu();
    const row = itemByText("Chat");
    expect(row.className).toContain("text-accent");
    expect(row.textContent).toContain("✓");
  });

  it("migrated rows do not accept arbitrary injected classes", () => {
    openMenu();
    const row = itemByText("Fork session");
    expect(row.className).not.toContain("bg-red-500");
    expect(row.className).not.toContain("px-3");
  });
});
