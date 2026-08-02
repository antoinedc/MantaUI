// M527.Chip — the chip/segmented-chip chrome primitive (BET-615, stage 2).
//
// Two components in one file: `Chip` (a single labelled chip, optionally in an
// "on"/active state) and `SplitChip` (two segments sharing one shell, with an
// optional accent on the right). They share the shell metrics and must not
// diverge, so they live together and own the ONE shared chrome with NO
// `className` escape hatch (epic standing decision 3): a caller cannot shear
// the height, radius, padding or tone, so the chip family can only drift if
// Chip.tsx itself is retuned.
//
// Chrome contract (BET-529 inventory): 29px hit area (`h-[29px]`), `--r-md`
// radius (`rounded-md`), 11px inline padding (`px-[11px]`) and a 6px gap
// (`gap-[6px]`) — the two off-grid px this primitive carries — plus `text-meta`
// medium chrome. `Chip` toggles between the rest tone (`CHIP_REST`, a bordered
// soft chip) and the "on" tone (`CHIP_ON`, accent border on an accent-bg
// surface — e.g. an enabled worktree). `SplitChip` takes the rest tone for its
// shell and divides it with a `border-l` divider; `rightAccent` colours the
// right segment with `--accent-tx` + semibold.
//
// Icons are the caller's job (a lucide icon at `size={13}`); the primitive does
// not style children beyond reserving the gap. There is deliberately no size
// prop: the spec has one chip size only.

import type { ReactNode } from "react";

const CHIP_SHELL =
  "inline-flex items-center h-[29px] rounded-md border whitespace-nowrap " +
  "text-meta font-medium leading-none transition-colors";
const CHIP_REST = "border-border bg-bg-soft text-text-muted hover:border-border-strong hover:text-text";
const CHIP_ON = "border-accent bg-accent-bg text-accent-tx";
const CHIP_PAD = "gap-[6px] px-[11px]";

export function Chip({
  on = false,
  onClick,
  title,
  children,
  hook,
}: {
  /** The "on"/active state — accent border + accent-bg surface. Default off. */
  on?: boolean;
  onClick?: () => void;
  /** Native `title` tooltip. */
  title?: string;
  /** The chip content (optionally a lucide icon at `size={13}`). */
  children: ReactNode;
  /**
   * A stable `manta-*` identity class for the call site (repo contract for
   * popup triggers — the visual coverage registry keys on it). This is an
   * IDENTITY hook, not a chrome class: it has no styling and cannot shear the
   * chrome, so it is not the `className` escape hatch the epic forbids.
   */
  hook?: string;
}) {
  const className = `${hook ? `${hook} ` : ""}${CHIP_SHELL} ${CHIP_PAD} ${on ? CHIP_ON : CHIP_REST}`;
  return (
    <button type="button" onClick={onClick} title={title} className={className}>
      {children}
    </button>
  );
}

export function SplitChip({
  left,
  right,
  onLeftClick,
  onRightClick,
  rightAccent = false,
  leftTitle,
  rightTitle,
  hook,
}: {
  /** Left-segment content (e.g. model name + an icon). */
  left: ReactNode;
  /** Right-segment content (e.g. an effort/variant label, or a toggle). */
  right: ReactNode;
  onLeftClick: () => void;
  onRightClick: () => void;
  /** Accent the right segment (`--accent-tx` + semibold) — the split control's one accent element. */
  rightAccent?: boolean;
  /** Native `title` on the left button. */
  leftTitle?: string;
  /** Native `title` on the right button. */
  rightTitle?: string;
  /** A stable `manta-*` identity class for the call site (identity only, never chrome). */
  hook?: string;
}) {
  const leftClass = `inline-flex items-center ${CHIP_PAD} h-full`;
  const rightClass = `inline-flex items-center ${CHIP_PAD} h-full border-l border-border${rightAccent ? " text-accent-tx font-semibold" : ""}`;
  return (
    <div className={`${hook ? `${hook} ` : ""}${CHIP_SHELL} p-0 overflow-hidden ${CHIP_REST}`}>
      <button type="button" onClick={onLeftClick} title={leftTitle} aria-haspopup="listbox" className={leftClass}>
        {left}
      </button>
      <button type="button" onClick={onRightClick} title={rightTitle} aria-haspopup="listbox" className={rightClass}>
        {right}
      </button>
    </div>
  );
}
