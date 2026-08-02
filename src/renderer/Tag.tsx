// M527.Tag — the inline mono metadata badge chrome primitive (BET-614, stage 4).
//
// Owns the ONE shared chrome for a small faint filled pill that labels a
// caller-supplied icon + short mono text (e.g. a branch indicator in a header),
// with NO `className` escape hatch (epic standing decision 3). A caller cannot
// shear the pill, the fill, the faint mono label or the icon gap, so a tag
// can only drift if Tag itself is retuned.
//
// The icon AND the text are the caller's job: the caller passes a lucide icon
// at `size={12}` and the label as `children` (which may itself carry a
// `truncate` span — the primitive owns the pill, not the label's overflow
// policy). Vertically the pill resolves to the 23px hit area; the 5px icon gap
// and the 12.5px label are the spec's other off-grid values.

import type { ReactNode } from "react";

const TAG =
  "inline-flex items-center gap-[5px] h-[23px] px-2 rounded-full border border-border " +
  "bg-fill font-mono text-[11.5px] leading-none font-medium text-text-faint";

export function Tag({
  icon,
  title,
  children,
}: {
  /** Optional lucide icon at `size={12}` rendered before the label. */
  icon?: ReactNode;
  /** Native `title` tooltip. */
  title?: string;
  /** The tag label. */
  children: ReactNode;
}) {
  return (
    <span className={TAG} title={title}>
      {icon}
      {children}
    </span>
  );
}
