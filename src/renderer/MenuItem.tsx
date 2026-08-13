// M527.MenuItem — the dropdown menu-item chrome primitive (BET-535, stage 6).
//
// Owns the ONE shared menu chrome with NO `className` escape hatch (epic
// standing decision 3): a caller cannot shear a row's surface, hover fill,
// variant colour or padding, so the menu family can only drift if MenuItem
// itself is retuned. Ships alongside `Dropdown`, the shared dropdown surface
// that owns the panel chrome under the anchor.
//
// Chrome contract (BET-529 inventory; surface updated BET-644, collision 1;
// row highlight corrected against the spec's `.mi` — see below):
//   - dropdown surface: `--card`/`bg-bg-soft` (the proposal's `.dd` won C5
//     over the old `--panel`/`bg-bg-elev` contract, for the whole menu
//     family), `--border` edge, `--shadow-lg`, `--r-lg` (`rounded-lg`),
//     max-h 460px, a flex column whose search/header/footer regions are fixed
//     and whose body is the only scroller.
//   - item label 13px medium `--tx2` (`text-label font-medium text-text-muted`)
//     brightening to `--tx1` on hover, padding `sp-2/sp-2` (`px-2 py-2`),
//     `sp-3` icon gap, `--r-md` radius, hover fill `--fill-hover`, icon 14px.
//   - variants danger (`--danger` + hover `--danger-bg`) and active
//     (`--accent`).
//
// THE HIGHLIGHT IS THE HOVER FILL, AND IT MUST NOT BE THE SURFACE COLOUR.
// The contract used to say hover `--card` (`bg-bg-soft`) — the exact colour
// `Dropdown`'s own panel carries, so hovering a `normal` row painted card-on-
// card and NOTHING moved. Only `danger` looked interactive (its `--danger-bg`
// differs from the panel), and because the base carried no radius that one
// visible fill was a square block inside a 12px-rounded panel. Both are fixed
// here rather than at the call site: the fill is `--fill-hover` (the spec's
// `.mi:hover`, a translucent white/ink wash that reads on ANY surface the menu
// is ever moved to) and the row carries `--r-md` + the 4px row gap, so the
// highlight is a soft-cornered pill inset in the panel's `p-2` — the same
// affordance `MenuOption` gives the model/effort menus. A hover that resolves
// to the surface it sits on is not a subtle bug; it is no feedback at all.
//
// Variant + C1 (validated constraints). C1: a variant that sets a hover
// background also sets the matching foreground, so the contrast stays valid
// on the fill. `normal` is the common case (SessionMenu's Fork / Compact /
// Clear all omit a modifier), so it is the DEFAULT — this is not the C4
// abstract-base trap, because normal is used without a modifier and renders
// as a real row. `danger` and `active` are explicit opt-ins carried as
// variant names, not a bare escape hatch.

import type { ReactElement, ReactNode } from "react";
import { cloneElement } from "react";

type MenuItemVariant = "normal" | "danger" | "active";

// `mb-1 last:mb-0` is MenuOption's row gap, for the same reason it has one:
// without it a highlighted row's fill touches the fill boundary of the row
// below and the two read as one block instead of one item.
const ITEM_BASE =
  "flex w-full items-center gap-3 px-2 py-2 mb-1 last:mb-0 rounded-md text-left text-label font-medium transition-colors duration-150";
// C1: every variant that sets a hover background also declares the matching
// foreground so the row never renders low-contrast text on its fill.
const VARIANT: Record<MenuItemVariant, string> = {
  normal: "text-text-muted hover:bg-fill-hover hover:text-text",
  danger: "text-danger hover:bg-danger-bg",
  active: "text-accent hover:bg-fill-hover",
};

export function MenuItem({
  variant = "normal",
  icon,
  children,
  trailing,
  onSelect,
  highlighted = false,
}: {
  /** Which surface + foreground the row carries. normal is the default. */
  variant?: MenuItemVariant;
  /** Optional leading icon, rendered at 14px per the chrome contract. */
  icon?: ReactElement;
  /** The row's label. */
  children?: ReactNode;
  /** Optional right-aligned affordance (e.g. the active-mode ✓ mark). */
  trailing?: ReactNode;
  /** Called when the row is chosen. */
  onSelect?: () => void;
  /** The roving keyboard highlight (BET-726 Task 3.1) — the SAME static
   *  `--fill-hover` fill MenuOption's `active` prop gives the model/effort
   *  menus, applied unconditionally instead of only on `:hover`. */
  highlighted?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`${ITEM_BASE} ${VARIANT[variant]}${highlighted ? " bg-fill-hover" : ""}`}
    >
      {icon && cloneElement(icon, { size: 14, "aria-hidden": true })}
      <span className="flex-1">{children}</span>
      {trailing}
    </button>
  );
}

// The shared dropdown surface under an anchor trigger. Owns the panel chrome
// (surface, edge, shadow, radius) plus the four-region anatomy from the
// redesign spec's `.dd`: a fixed search strip, a fixed header, a scrolling
// body, a fixed footer. The surface is a flex column with `overflow-hidden`
// and `max-h-[460px]`; the body is the ONLY scroller. Every region that is
// absent is simply not rendered (SessionHeader's menu passes only children,
// so it land in the scroll body). The `hook` prop is a stable `manta-*`
// identity class for the call site (repo contract for popup surfaces — the
// visual coverage registry keys on it). It is an IDENTITY hook, not a chrome
// class: it has no styling and cannot shear the panel chrome, so it is not
// the `className` escape hatch the epic forbids.
type DropdownPlacement = "below" | "above";
type DropdownAlign = "start" | "end";
type DropdownWidth = "menu" | "wide" | "narrow";

const DROPDOWN_SURFACE =
  "absolute z-30 overflow-hidden flex flex-col max-h-[460px] rounded-lg border border-border bg-bg-soft shadow-lg";
const DROPDOWN_WIDTH: Record<DropdownWidth, string> = {
  menu: "min-w-[11.25rem]",
  wide: "w-[340px]",
  narrow: "w-[250px]",
};
const DROPDOWN_PLACEMENT: Record<DropdownPlacement, string> = {
  below: "top-full mt-1",
  above: "bottom-full mb-1",
};
const DROPDOWN_ALIGN: Record<DropdownAlign, string> = {
  start: "left-0",
  end: "right-0",
};
const DROPDOWN_SEARCH =
  "flex items-center gap-2 h-[38px] px-3 border-b border-border-subtle flex-none";
const DROPDOWN_HEADER = "p-2 border-b border-border-subtle flex-none";
const DROPDOWN_SCROLL = "overflow-y-auto p-2 min-h-0";
const DROPDOWN_FOOTER = "border-t border-border-subtle p-2 flex-none";

export function Dropdown({
  hook,
  placement = "below",
  align = "end",
  width = "menu",
  role = "menu",
  search,
  header,
  footer,
  children,
}: {
  /** Optional `manta-*` identity class for the call site (no styling). */
  hook?: string;
  /** below (top-full, SessionHeader's menu) | above (bottom-full, composer). */
  placement?: DropdownPlacement;
  /** start (left-0) | end (right-0, today's right-aligned default). */
  align?: DropdownAlign;
  /** menu (11.25rem min) | wide (340px, model list) | narrow (250px, effort). */
  width?: DropdownWidth;
  /** menu (SessionHeader) | listbox (single-select pickers). */
  role?: "menu" | "listbox";
  /** Optional fixed search strip rendered above the header. */
  search?: ReactNode;
  /** Optional fixed header region (e.g. the pinned server-default row). */
  header?: ReactNode;
  /** Optional fixed footer region (e.g. a "Manage models…" action). */
  footer?: ReactNode;
  /** The scrolling body. */
  children?: ReactNode;
}) {
  return (
    <div
      role={role}
      className={
        `${hook ? `${hook} ` : ""}` +
        `${DROPDOWN_SURFACE} ${DROPDOWN_WIDTH[width]} ${DROPDOWN_PLACEMENT[placement]} ${DROPDOWN_ALIGN[align]}`
      }
    >
      {search && <div className={DROPDOWN_SEARCH}>{search}</div>}
      {header && <div className={DROPDOWN_HEADER}>{header}</div>}
      <div className={DROPDOWN_SCROLL}>{children}</div>
      {footer && <div className={DROPDOWN_FOOTER}>{footer}</div>}
    </div>
  );
}
