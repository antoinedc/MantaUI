// M527.IconButton — the icon-button chrome primitive (BET-532, stage 3).
//
// Owns the ONE shared chrome for a square icon button with NO `className`
// escape hatch (epic standing decision 3): a caller cannot shear the hit
// area, radius, resting/hover icon colour or hover fill, so the icon-button
// family can only drift if IconButton itself is retuned.
//
// Chrome contract (BET-529 inventory): square hit area (`p-1` → 24px md /
// 28px lg), radius `--r-xs` (`rounded`), resting icon `--tx3` → `--tx1` on
// hover with `--fill-hover` bg, accent focus ring, 16px md icon / 20px lg
// standalone. C1 (validated constraints): the hover sets a background, so it
// also sets the matching foreground (`hover:text-text`); the resting state
// sets `--tx3`.
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

import type { ReactElement } from "react";
import { cloneElement } from "react";

const CHROME =
  "inline-flex items-center justify-center rounded p-1 text-text-faint hover:text-text hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

export function IconButton({
  label,
  icon,
  onClick,
  title,
  size = "md",
  ariaHaspopup,
  ariaExpanded,
  hook,
}: {
  /** Accessible name for the button (required — the icon is decorative). */
  label: string;
  /** The icon glyph (a lucide icon). Its `size` / `aria-hidden` are set by the primitive. */
  icon: ReactElement;
  onClick?: () => void;
  /** Native `title` tooltip; defaults to `label`. */
  title?: string;
  /** md = 16px icon (default), lg = 20px standalone. */
  size?: "md" | "lg";
  /** Menu/popover semantics for a trigger-style icon button. */
  ariaHaspopup?: "menu" | "dialog" | "listbox" | "grid" | "tree" | "true" | "false";
  ariaExpanded?: boolean;
  /**
   * A stable `manta-*` identity class for the call site (repo contract for
   * popup triggers — the visual coverage registry keys on it). This is an
   * IDENTITY hook, not a chrome class: it has no styling and cannot shear the
   * chrome, so it is not the `className` escape hatch the epic forbids.
   */
  hook?: string;
}) {
  const iconSize = size === "lg" ? 20 : 16;
  const className = hook ? `${hook} ${CHROME}` : CHROME;
  return (
    <button
      type="button"
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
