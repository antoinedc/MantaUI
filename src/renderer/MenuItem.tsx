// M527.MenuItem — the dropdown menu-item chrome primitive (BET-535, stage 6).
//
// Owns the ONE shared menu chrome with NO `className` escape hatch (epic
// standing decision 3): a caller cannot shear a row's surface, hover fill,
// variant colour or padding, so the menu family can only drift if MenuItem
// itself is retuned. Ships alongside `Dropdown`, the shared dropdown surface
// that owns the panel chrome under the anchor.
//
// Chrome contract (BET-529 inventory):
//   - dropdown surface: `--panel`/`bg-bg-elev`, `--border` edge,
//     `--shadow-md`, `--r-md` (8px / `rounded-md`), `py-1`.
//   - item label 13px `--tx1` (`text-label text-text`), padding `sp-2/sp-2`
//     (`px-2 py-2`), hover `--card` (`bg-bg-soft`), icon 14px.
//   - variants danger (`--danger` + hover `--danger-bg`) and active
//     (`--accent`).
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

const ITEM_BASE = "flex w-full items-center gap-2 px-2 py-2 text-left text-label";
// C1: every variant that sets a hover background also declares the matching
// foreground so the row never renders low-contrast text on its fill.
const VARIANT: Record<MenuItemVariant, string> = {
  normal: "text-text hover:bg-bg-soft",
  danger: "text-danger hover:bg-danger-bg",
  active: "text-accent hover:bg-bg-soft",
};

export function MenuItem({
  variant = "normal",
  icon,
  children,
  trailing,
  onSelect,
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
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`${ITEM_BASE} ${VARIANT[variant]}`}
    >
      {icon && cloneElement(icon, { size: 14, "aria-hidden": true })}
      <span className="flex-1">{children}</span>
      {trailing}
    </button>
  );
}

// The shared dropdown surface under an anchor trigger. Owns the panel chrome
// (surface, edge, shadow, radius, padding) plus the standard right-aligned
// placement. The `hook` prop is a stable `manta-*` identity class for the
// call site (repo contract for popup surfaces — the visual coverage registry
// keys on it). It is an IDENTITY hook, not a chrome class: it has no styling
// and cannot shear the panel chrome, so it is not the `className` escape
// hatch the epic forbids.
export function Dropdown({
  hook,
  children,
}: {
  /** Optional `manta-*` identity class for the call site (no styling). */
  hook?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="menu"
      className={
        `${hook ? `${hook} ` : ""}` +
        "absolute right-0 top-full mt-1 z-30 min-w-[11.25rem] rounded-md border border-border bg-bg-elev shadow-md py-1"
      }
    >
      {children}
    </div>
  );
}
