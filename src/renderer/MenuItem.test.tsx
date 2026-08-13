// @vitest-environment jsdom
//
// Component tests for the MenuItem / Dropdown chrome primitives (BET-535,
// stage 6 of M527).
//
// As with Card/Field/Pill/IconButton, the primitive's "tokens" are class
// names that map through tailwind.config.js to the design tokens
// (bg-bg-elev → --panel, border-border → --border, shadow-md → --shadow-md,
// rounded-md → --r-md, bg-bg-soft → --card, text-text → --tx1,
// text-danger → --danger, bg-danger-bg → --danger-bg, text-accent → --accent,
// text-label → 13px, px-2/py-2 → sp-2/sp-2). jsdom loads no stylesheet, so
// the contract is asserted on the exact class strings — a retune of the
// primitive's chrome fails here.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { Zap } from "lucide-react";
import { mount, mountSessionHeader, type Harness } from "./testHarness";
import { Dropdown, MenuItem } from "./MenuItem";

const ITEM_BASE =
  "flex w-full items-center gap-3 px-2 py-2 mb-1 last:mb-0 rounded-md text-left " +
  "text-label font-medium transition-colors duration-150";

// The surface `Dropdown` paints. A row's hover fill must never resolve to this
// — see the "hover fill is not the surface colour" case below.
const PANEL_SURFACE = "bg-bg-soft";

describe("Dropdown — the shared dropdown surface", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the panel tokens (bg-soft, border, shadow-lg, r-lg) and role=menu", () => {
    h = mount(<Dropdown>hello</Dropdown>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("menu");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain("border");
    expect(el.className).toContain("border-border");
    expect(el.className).toContain("bg-bg-soft");
    expect(el.className).toContain("shadow-lg");
    expect(el.textContent).toBe("hello");
  });

  it("carries a manta-* identity hook without accepting arbitrary className", () => {
    h = mount(<Dropdown hook="manta-session-menu-dropdown">x</Dropdown>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("manta-session-menu-dropdown");
  });

  it("wraps children in a scrolling body — the surface's only scroller", () => {
    h = mount(<Dropdown>row</Dropdown>);
    const body = h.container.querySelector("div.overflow-y-auto") as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.className).toContain("min-h-0");
    expect(body.textContent).toBe("row");
  });

  it("renders the fixed search / header / footer slots as flex-none regions", () => {
    h = mount(
      <Dropdown
        search={<input aria-label="Search models" />}
        header={<span>header</span>}
        footer={<button>footer</button>}
      >
        body
      </Dropdown>,
    );
    const root = h.container.firstElementChild as HTMLElement;
    expect(root.querySelector('input[aria-label="Search models"]')).toBeTruthy();
    expect(root.textContent).toContain("header");
    expect(root.textContent).toContain("footer");
    const searchStrip = root.querySelector("input")!.parentElement as HTMLElement;
    expect(searchStrip.className).toContain("flex-none");
  });

  it("placement=above flips to bottom-full, align=start to left-0", () => {
    h = mount(<Dropdown placement="above" align="start">x</Dropdown>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("bottom-full");
    expect(el.className).toContain("mb-1");
    expect(el.className).toContain("left-0");
  });

  it("width wide/narrow set the 340px / 250px spec panels", () => {
    h = mount(<Dropdown width="wide">x</Dropdown>);
    expect((h.container.firstElementChild as HTMLElement).className).toContain("w-[340px]");
    h.unmount();
    h = mount(<Dropdown width="narrow">x</Dropdown>);
    expect((h.container.firstElementChild as HTMLElement).className).toContain("w-[250px]");
  });

  it("role=listbox is honoured for the single-select pickers", () => {
    h = mount(<Dropdown role="listbox">x</Dropdown>);
    expect((h.container.firstElementChild as HTMLElement).getAttribute("role")).toBe("listbox");
  });
});

describe("MenuItem", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("normal renders the 13px label, sp-2/sp-2 padding and the --fill-hover highlight per the contract", () => {
    h = mount(<MenuItem>Fork session</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe(
      `${ITEM_BASE} text-text-muted hover:bg-fill-hover hover:text-text`,
    );
    expect(el.className).toContain("text-label");
    expect(el.className).toContain("px-2");
    expect(el.className).toContain("py-2");
    expect(el.className).toContain("hover:bg-fill-hover");
    expect(el.getAttribute("role")).toBe("menuitem");
  });

  it("danger renders --danger text with a --danger-bg hover (C1)", () => {
    h = mount(<MenuItem variant="danger">Delete session</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("text-danger");
    expect(el.className).toContain("hover:bg-danger-bg");
    expect(el.className).not.toContain("hover:bg-fill-hover");
  });

  it("active renders --accent text with the --fill-hover highlight", () => {
    h = mount(<MenuItem variant="active">Chat</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("text-accent");
    expect(el.className).toContain("hover:bg-fill-hover");
  });

  // The regression this contract exists to prevent. Every variant painted its
  // hover with `bg-bg-soft` — the SAME token `Dropdown` paints its panel with
  // — so hovering a row drew card-on-card and produced no visible feedback at
  // all. Only `danger` looked alive, because `--danger-bg` happens to differ
  // from the panel. Asserting "not the surface" (rather than a literal) keeps
  // the rule true if the panel token is ever re-pointed.
  it("no variant's hover fill is the dropdown surface colour", () => {
    for (const variant of ["normal", "danger", "active"] as const) {
      h?.unmount();
      h = mount(<MenuItem variant={variant}>row</MenuItem>);
      const el = h.container.firstElementChild as HTMLElement;
      expect(
        el.className,
        `${variant}: hover fill must not resolve to the panel's own ${PANEL_SURFACE}`,
      ).not.toContain(`hover:${PANEL_SURFACE}`);
    }
  });

  // The fill has to be a rounded pill inset in the panel's `p-2`, like
  // MenuOption's — a square fill inside a 12px-rounded panel reads as a
  // rendering fault, which is how the old chrome's one visible hover looked.
  it("carries the row radius and row gap so the highlight is a rounded, separated pill", () => {
    h = mount(<MenuItem>row</MenuItem>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toContain("rounded-md");
    expect(el.className).toContain("mb-1");
    expect(el.className).toContain("last:mb-0");
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

  // Non-zero context so the context pill renders alongside the ⋯ trigger —
  // this suite asserts the MENU's row highlight, and a populated header is the
  // realistic surface for that.
  function renderHeader() {
    h = mountSessionHeader({
      ctxBreakdown: {
        freshInput: 1,
        cacheRead: 1,
        cacheWrite: 1,
        totalInput: 100,
        pct: 12,
        segments: [],
      },
      ctxLimit: 200000,
    });
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
    expect(surface.className).toContain("bg-bg-soft");
    expect(surface.className).toContain("shadow-lg");

    for (const label of ["Fork session", "Compact context", "Clear session"]) {
      const row = itemByText(label);
      expect(row.className).toContain("text-text-muted");
      expect(row.className).toContain("hover:bg-fill-hover");
      expect(row.className).toContain("rounded-md");
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

describe("SessionHeader session menu — Delete/Clear confirm (BET-724 §D7)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function openMenuWith(overrides: Parameters<typeof mountSessionHeader>[0]) {
    h = mountSessionHeader(overrides);
    const trigger = h.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Session actions"]',
    );
    expect(trigger).toBeTruthy();
    act(() => trigger!.click());
  }

  // The menu row and the confirm's own action button can share a label
  // ("Delete session") — this only searches the DROPDOWN's menuitem rows.
  function menuItemByText(text: string): HTMLElement {
    const menu = h!.container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    const rows = [...menu.querySelectorAll<HTMLElement>("button[role='menuitem']")];
    const el = rows.find((b) => b.textContent?.trim().includes(text));
    expect(el, `expected a "${text}" menu row`).toBeTruthy();
    return el!;
  }

  // The confirm's own action button lives inside the Modal's dialog panel —
  // this only searches there, never the dropdown's menuitem rows.
  function confirmButtonByText(text: string): HTMLButtonElement {
    const dialog = h!.container.querySelector('div[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    const el = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    ) as HTMLButtonElement | undefined;
    expect(el, `expected a "${text}" confirm button`).toBeTruthy();
    return el!;
  }

  it("Delete session opens a confirm instead of calling onDelete immediately", () => {
    let deleted = 0;
    openMenuWith({ onDelete: () => deleted++ });
    act(() => menuItemByText("Delete session").click());
    expect(deleted).toBe(0);
    expect(h!.text()).toContain("Delete this session?");
  });

  it("confirming Delete calls onDelete exactly once", () => {
    let deleted = 0;
    openMenuWith({ onDelete: () => deleted++ });
    act(() => menuItemByText("Delete session").click());
    act(() => confirmButtonByText("Delete session").click());
    expect(deleted).toBe(1);
  });

  it("cancelling the Delete confirm does not call onDelete", () => {
    let deleted = 0;
    openMenuWith({ onDelete: () => deleted++ });
    act(() => menuItemByText("Delete session").click());
    act(() => confirmButtonByText("Cancel").click());
    expect(deleted).toBe(0);
  });

  it("Clear session opens a confirm instead of calling onClear immediately", () => {
    let cleared = 0;
    openMenuWith({ onClear: () => cleared++ });
    act(() => menuItemByText("Clear session").click());
    expect(cleared).toBe(0);
    expect(h!.text()).toContain("Clear this conversation?");
  });

  it("confirming Clear calls onClear exactly once", () => {
    let cleared = 0;
    openMenuWith({ onClear: () => cleared++ });
    act(() => menuItemByText("Clear session").click());
    act(() => confirmButtonByText("Clear").click());
    expect(cleared).toBe(1);
  });

  it("the Delete confirm names the session from the breadcrumb window", () => {
    openMenuWith({
      breadcrumb: { project: "better-ui", window: "fix-onboarding" },
      onDelete: () => {},
    });
    act(() => menuItemByText("Delete session").click());
    expect(h!.text()).toContain("fix-onboarding");
  });
});
