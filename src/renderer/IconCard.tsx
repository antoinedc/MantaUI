// M527.IconCard — the icon-above-label tile chrome primitive (BET-614, stage 4).
//
// Owns the ONE shared chrome for a small vertical tile that pairs a
// caller-supplied icon (a lucide icon at `size={20}`) above a short mono label,
// with NO `className` escape hatch (epic standing decision 3). A caller cannot
// shear the bordered raised tile, the vertical centering, the icon gap or the
// faint mono label, so an icon card can only drift if IconCard itself is
// retuned.
//
// Both the icon and the label are the caller's job; the primitive only owns
// the tile + label chrome and the `gap-2` between them.

import type { ReactNode } from "react";

const ICARD =
  "flex flex-col items-center gap-2 rounded-md border border-border-subtle " +
  "bg-bg-elev px-2 py-3 text-text-muted";
const ICARD_LABEL = "font-mono text-[10.5px] leading-none font-medium text-text-faint";

export function IconCard({
  icon,
  label,
}: {
  /** The tile icon, a lucide icon at `size={20}`. */
  icon: ReactNode;
  /** The short mono label below the icon. */
  label: ReactNode;
}) {
  return (
    <div className={ICARD}>
      {icon}
      <span className={ICARD_LABEL}>{label}</span>
    </div>
  );
}
