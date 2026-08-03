// M527.OutputWell — the recessed mono output surface primitive (BET-636).
//
// The spec's `.tool-b` (a tool's output, inside a tool card) and `.ask-cmd`
// (a permission card's command) are the same recessed monospace well in two
// places. Two variants:
//
//   - `attached` — lives inside a card, sitting below its header: a top border
//     only, square corners, no radius. Used for tool output and the diff.
//   - `standalone` — a full bordered box with `--r-md` radius, for content on
//     the page surface (e.g. a permission card's command).
//
// `maxHeight` caps the well and makes it scroll vertically (the tool output
// body passes it; the ask command does not).
//
// No `className` escape hatch (epic standing decision 3). Off-grid chrome:
// the `9px` standalone vertical padding and the `12.5px` mono size.

import type { ReactNode } from "react";

const WELL_SHARED =
  "bg-inset text-[12.5px] leading-[1.55] font-mono overflow-x-auto whitespace-pre";
const WELL_ATTACHED = "border-t border-border-subtle px-3 py-2";
const WELL_STANDALONE = "border border-border-subtle rounded-md px-3 py-[9px] text-text";
const WELL_MAX = "max-h-64 overflow-y-auto";

export function OutputWell({
  variant,
  maxHeight = false,
  children,
}: {
  /** `attached` (inside a card — top border only) or `standalone` (full border + radius). */
  variant: "attached" | "standalone";
  /** Cap the height and scroll vertically (the tool output body; the ask card does not). */
  maxHeight?: boolean;
  children: ReactNode;
}) {
  const variantCls = variant === "attached" ? WELL_ATTACHED : WELL_STANDALONE;
  return (
    <div className={`${WELL_SHARED} ${variantCls}${maxHeight ? ` ${WELL_MAX}` : ""}`}>
      {children}
    </div>
  );
}
