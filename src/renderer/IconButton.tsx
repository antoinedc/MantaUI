// M527.IconButton — the icon-button chrome primitive (BET-532, stage 3).
//
// Owns the ONE shared chrome for a square icon button with NO `className`
// escape hatch (epic standing decision 3): a caller cannot shear the hit
// area, radius, resting/hover icon colour or hover fill, so the icon-button
// family can only drift if IconButton itself is retuned.
//
// Chrome contract (BET-529 inventory): square hit area (md 24px / xl 32px),
// radius `--r-xs` for md (`rounded-xs`) and `--r-md` for xl (`rounded-md`),
// resting icon `--tx3` → `--tx1` on hover with `--fill-hover` bg, accent focus
// ring, 16px icon on both sizes. `xl` is for a standalone control row where the
// button sits beside the 29px chips; `md` remains the dense-toolbar size. C1
// (validated constraints): the hover sets a background, so it also sets the
// matching foreground (`hover:text-text`); the resting state sets `--tx3`.
//
// The hover fill uses the `fill-hover` colour utility (`hover:bg-fill-hover`,
// registered by BET-539 → `--fill-hover`). No arbitrary value needed — the
// fill scale is a real Tailwind colour now, shared with the other hover-fill
// sites in the app.
//
// Adopters migrated in BET-532: the SessionHeader mode toggle + the
// session-menu trigger (identical chrome). `aria-haspopup` / `aria-expanded`
// are optional so the menu trigger keeps its role semantics without a class
// escape hatch.

import type { ReactElement, RefObject } from "react";
import { cloneElement } from "react";

const CHROME_BASE =
  "inline-flex items-center justify-center text-text-faint hover:text-text hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

// Padding + radius vary by size; everything else is shared. `xl` widens the
// hit area to 32px with `--r-md` so it sits correctly beside the 29px chips in
// a standalone control row.
const SIZE_CHROME: Record<"md" | "xl", string> = {
  md: "rounded-xs p-1",
  xl: "rounded-md p-2",
};

export function IconButton({
  label,
  icon,
  onClick,
  title,
  size = "md",
  ariaHaspopup,
  ariaExpanded,
  hook,
  disabled,
  buttonRef,
}: {
  /** Accessible name for the button (required — the icon is decorative). */
  label: string;
  /** The icon glyph (a lucide icon). Its `size` / `aria-hidden` are set by the primitive. */
  icon: ReactElement;
  onClick?: () => void;
  /** Native `title` tooltip; defaults to `label`. */
  title?: string;
  /** md = 16px icon on a 24px hit area (default), xl = 16px icon on a 32px hit area + `--r-md` radius, for a control row beside the 29px chips. */
  size?: "md" | "xl";
  /** Menu/popover semantics for a trigger-style icon button. */
  ariaHaspopup?: "menu" | "dialog" | "listbox" | "grid" | "tree" | "true" | "false";
  ariaExpanded?: boolean;
  /** Renders the native `disabled` attribute + the not-allowed cursor, and suppresses the hover fill (a disabled icon button stays flat). */
  disabled?: boolean;
  /**
   * A stable `manta-*` identity class for the call site (repo contract for
   * popup triggers — the visual coverage registry keys on it). This is an
   * IDENTITY hook, not a chrome class: it has no styling and cannot shear the
   * chrome, so it is not the `className` escape hatch the epic forbids.
   */
  hook?: string;
  /** Forwards a ref to the underlying <button> (used as a popover anchor /
   *  focus-restoration target, e.g. the session ⋯ menu's trigger, BET-865). */
  buttonRef?: RefObject<HTMLButtonElement>;
}) {
  const iconSize = 16;
  // Disabled-only classes are appended by the primitive itself (a disabled
  // icon button stays flat: no hover fill/foreground, not-allowed cursor) —
  // never by a caller, so the standing-decision-3 escape hatch still holds.
  const disabledClasses = "disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-faint";
  const className = `${hook ? `${hook} ` : ""}${CHROME_BASE} ${SIZE_CHROME[size]}${disabled ? ` ${disabledClasses}` : ""}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={className}
      aria-label={label}
      title={title ?? label}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
    >
      {cloneElement(icon, { size: iconSize, "aria-hidden": true })}
    </button>
  );
}
