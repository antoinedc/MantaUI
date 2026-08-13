// M527.MenuOption — the menu option row chrome primitive (BET-644).
//
// The redesign spec's single option row, used at both densities — one
// component, two densities: `sub` presence drives the row height (34px
// single-line, 44px with a sub-line). There is deliberately NO `size` prop —
// density is derived, and derived only from `sub`. No `className` escape
// hatch (epic standing decision 3): a caller cannot shear the row's surface,
// hover fill, accent tint or the reserved check slot.
//
// C1 (validated constraint): `selected` sets BOTH the --accent-bg fill and
// the --accent-tx foreground (the tinted row + visible check + accent label),
// so the contrast stays valid on the fill. The 16px check tick slot is ALWAYS
// reserved (opacity 0 when unselected, never conditionally unmounted) so the
// labels do not shift by 16px as selection moves.
//
// a11y: rendered as `role="option"` with `aria-selected` (the surfaces that
// use it — the model + effort menus — are single-select listboxes). The
// parent owns the roving highlight, so the row takes `active` for
// aria-activedescendant styling and an `id` for the descendant target.

import type { ReactNode } from "react";
import { Check } from "lucide-react";
// BET-726 Task 1: keep the keyboard-highlighted row visible when arrow-keying
// past the fold. Reuses the SAME hook the ⌘K / ⌘F palettes already use for
// their SessionRow (PaletteShell.tsx) — do not add a second scrollIntoView
// idiom for the model/effort menus.
import { useSelectedIntoView } from "./PaletteShell";

// `mb-1` is the same 4px the sidebar's session rows carry between each other
// (SessionRow's ROW_BASE). Without it the rows are flush, so a highlighted row
// — keyboard or pointer — has its fill touching the fill boundary of the row
// below and the two read as one block instead of one selected item.
const OPT_BASE =
  "flex w-full items-center gap-3 min-h-[34px] px-2 mb-1 last:mb-0 rounded-md text-left transition-colors duration-150";

export function MenuOption({
  selected = false,
  active = false,
  label,
  sub,
  trailing,
  onSelect,
  id,
}: {
  /** The tinted row + visible check + accent label (C1). */
  selected?: boolean;
  /** Roving-highlight target — the aria-activedescendant styling state. */
  active?: boolean;
  /** The row's name — single line, truncates. */
  label: ReactNode;
  /** Optional second line; its presence is what makes the row 44px. */
  sub?: ReactNode;
  /** Optional right-side node (the context badge). */
  trailing?: ReactNode;
  /** Called when the row is chosen. */
  onSelect?: () => void;
  /** Option id, used as the aria-activedescendant target. */
  id?: string;
}) {
  // `active` is the roving keyboard highlight — the same signal that should
  // keep this row scrolled into view.
  const ref = useSelectedIntoView<HTMLButtonElement>(active);
  return (
    <button
      ref={ref}
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={
        `${OPT_BASE} ${sub ? "min-h-[44px]" : ""} ` +
        // Pointer hover gets the SAME fill as the roving keyboard highlight —
        // they are one affordance ("this is the row you are about to choose")
        // and only the keyboard half was implemented, so a mouse user got no
        // feedback at all. `selected` keeps its accent tint on hover: the tint
        // carries the accent foreground with it (C1), and swapping to the grey
        // hover fill under the pointer would flip that contrast pairing.
        `${selected ? "bg-accent-bg" : active ? "bg-fill-hover" : "hover:bg-fill-hover"}`
      }
    >
      <span
        aria-hidden="true"
        className={`w-4 flex-none grid place-items-center text-accent-tx ${
          selected ? "opacity-100" : "opacity-0"
        }`}
      >
        <Check size={14} />
      </span>
      <span className="flex-1 min-w-0 text-left">
        <span
          className={`block truncate text-label font-medium ${
            selected ? "text-accent-tx font-semibold" : "text-text"
          }`}
        >
          {label}
        </span>
        {sub && (
          <span className="block truncate text-[11.5px] text-text-faint mt-[2px]">
            {sub}
          </span>
        )}
      </span>
      {trailing}
    </button>
  );
}
