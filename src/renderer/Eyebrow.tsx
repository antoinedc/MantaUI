// M527.Eyebrow — the uppercase section-label chrome primitive (BET-614, stage 4).
//
// Owns the ONE shared chrome for a small accent-tinted uppercase section
// eyebrow, with NO `className` escape hatch (epic standing decision 3). A
// caller cannot shear the block layout, the accent tint, the tracking, the
// size or the bottom margin, so an eyebrow can only drift if Eyebrow itself is
// retuned. Its sole off-grid value is the 11px label.

import type { ReactNode } from "react";

const EYEBROW =
  "block font-semibold text-[11px] leading-none tracking-[.1em] uppercase text-accent-tx mb-3";

export function Eyebrow({
  children,
}: {
  /** The section label text. */
  children: ReactNode;
}) {
  return <div className={EYEBROW}>{children}</div>;
}
