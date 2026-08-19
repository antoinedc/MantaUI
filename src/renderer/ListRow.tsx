// ListRow — the shared list-row primitive (BET-787 [S2]/[S8]).
//
// The mockup's `.row` (manta-forge §8.2): a single flex row with the slots
// `leading (dot|checkbox) · name · secondary · trailing meta`. It recurs in
// [S2] [S3] [S6] [S8] [C6] [C7] [G1] and the work inbox — seven surfaces —
// so it is built here once and shared rather than per-call-site flex stacks.
//
// Chrome contract (`rounded-md`, `hover:bg-fill-hover`): the row is a
// 13px-slot row with a `text-text` truncated name, an optional `text-text-faint`
// secondary line, and an `ml-auto` mono trailing column. `onClick` promotes it
// from a plain row to a keyboard-activatable button so a checkbox/dot row and
// a clickable row share one component (docs/components.md decision 2).
//
// GOTCHA — a row that contains its own controls must not also handle those
// controls' clicks. A `<label>`-wrapped checkbox (see Checkbox.tsx) re-dispatches
// a click on its hidden `<input>`, so a user's single click on the visible box
// produces TWO click events at the row; an unguarded row `onClick` would toggle
// twice — selecting then instantly deselecting. The guard below therefore
// ignores any click whose target is (or is inside) an interactive control, and
// lets that control handle it. It deliberately does NOT stop propagation: the
// control's own handler still runs, the row just declines to act.
//
// Note the deliberate asymmetry with the chrome primitives (Button, Checkbox,
// StatusDot): this is a *composable container*, not a single chrome element,
// so it takes `className` (e.g. a `manta-*` identity hook). The slots stay the
// one way to vary content.

import type { ReactNode } from "react";

export function ListRow({
  leading,
  name,
  secondary,
  trailing,
  onClick,
  title,
  className,
}: {
  /** The row's leading slot: a checkbox, a status dot, or nothing. */
  leading?: ReactNode;
  /** The primary name — rendered `text-text font-medium`, truncated. */
  name: ReactNode;
  /** Optional secondary line under/after the name — `text-text-faint`. */
  secondary?: ReactNode;
  /** Optional trailing meta (e.g. an age) — `ml-auto`, mono, quiet. */
  trailing?: ReactNode;
  /** When set the row becomes a clickable button (tilts it to the onClick role). */
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={
        onClick
          ? (e) => {
              // A control inside the row owns its own click. A <label>-wrapped
              // checkbox additionally re-dispatches a click on its hidden <input>,
              // so the row sees TWO clicks for one user click and would toggle
              // twice — selecting then instantly deselecting.
              if (
                (e.target as HTMLElement).closest(
                  "label,input,button,a,select,textarea",
                )
              )
                return;
              onClick();
            }
          : undefined
      }
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      title={title}
      className={
        "flex items-center gap-[9px] px-[10px] py-2 rounded-md text-[13px] " +
        (onClick ? "cursor-pointer " : "") +
        "hover:bg-fill-hover " +
        (className ?? "")
      }
    >
      {leading}
      <span className="text-text font-medium truncate min-w-0">{name}</span>
      {secondary != null && (
        <span className="text-text-faint truncate min-w-0">{secondary}</span>
      )}
      {trailing != null && (
        <span className="ml-auto shrink-0 font-mono tabular-nums text-text-quiet">
          {trailing}
        </span>
      )}
    </div>
  );
}
