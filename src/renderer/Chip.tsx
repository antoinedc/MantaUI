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
// chrome. Weight is the one place the two diverge: `Chip` is medium (it is a
// labelled ACTION), `SplitChip` is regular (it is a status readout you glance
// at). `Chip` toggles between the rest tone (`CHIP_REST`, a bordered soft chip)
// and the "on" tone (`CHIP_ON`, accent border on an accent-bg surface — e.g. an
// enabled worktree). `SplitChip` takes the rest tone for its shell and divides
// it with a `border-l` divider; `rightAccent` colours the right segment with
// `--accent-tx` (colour only — no weight change).
//
// Split rule (BET-634): the shell hover is the SINGLE chip's (`hover:border
// -border-strong hover:text-text`) — a split control leaves its shell border
// untouched and instead fills the HOVERED SEGMENT (`hover:bg-fill-hover`), so
// you can tell which half you're about to click. `Chip` keeps both rest-tone +
// hover classes; `SplitChip` uses `CHIP_REST` alone on its shell and applies
// the fill to the segments.
//
// Icons are the caller's job (a lucide icon at `size={13}`); the primitive does
// not style children beyond reserving the gap. There is deliberately no size
// prop: the spec has one chip size only.

import type { ReactNode } from "react";

const CHIP_BASE =
  "inline-flex items-center h-[29px] rounded-md border whitespace-nowrap " +
  "text-meta leading-none transition-colors";
const CHIP_SHELL = `${CHIP_BASE} font-medium`;
// The SPLIT shell runs one weight lighter than the single chip. A split
// control is a STATUS readout you change occasionally (the model you're on,
// the effort it runs at), not a labelled action, and at medium it competed
// with the transcript for attention every time your eye crossed the composer.
const SPLIT_SHELL = `${CHIP_BASE} font-normal`;
const CHIP_REST = "border-border bg-bg-soft text-text-muted";
const CHIP_HOVER = "hover:border-border-strong hover:text-text";
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
  const className = `${hook ? `${hook} ` : ""}${CHIP_SHELL} ${CHIP_PAD} ${on ? CHIP_ON : `${CHIP_REST} ${CHIP_HOVER}`}`;
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
  leftHook,
  rightHook,
  leftExpanded,
  rightExpanded,
  popup = false,
  extra,
  onExtraClick,
  extraTitle,
  extraLabel,
  extraHook,
  extraPressed,
  extraDisabled = false,
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
  /** A stable `manta-*` identity class for the shell (identity only, never chrome). */
  hook?: string;
  /**
   * A stable `manta-*` identity class for the LEFT segment button. The popup
   * coverage registry (`assertSurfacesClosed`) keys on the SEGMENT buttons
   * (they carry `aria-haspopup` when `popup`), so a caller whose left segment
   * opens a popup must pass its hook here, not on the shell.
   */
  leftHook?: string;
  /** A stable `manta-*` identity class for the RIGHT segment button (see `leftHook`). */
  rightHook?: string;
  /**
   * `aria-expanded` for the left segment, reflecting whether its popup is open.
   * The popup coverage registry EXCLUDES an `aria-expanded="true"` trigger from
   * a row's closed-surface inventory, so the caller who owns the open state
   * must pass it here (a `popup` segment that never reports open reads as
   * permanently closed).
   */
  leftExpanded?: boolean;
  /** `aria-expanded` for the right segment (see `leftExpanded`). */
  rightExpanded?: boolean;
  /**
   * OPT-IN popup semantics. SplitChip is a generic split control — its two
   * segments are plain buttons and it does NOT assume either opens a popup.
   * A caller whose segments genuinely toggle a listbox (e.g. ModelPicker)
   * passes `popup` to add `aria-haspopup="listbox"` to both segment buttons;
   * a non-popup adopter (e.g. a checkbox row) omits it.
   */
  popup?: boolean;
  /**
   * OPTIONAL third segment, for a boolean TOGGLE that belongs to the same
   * control (e.g. the composer's ⚡ fast-mode switch, which modifies the model
   * the other two segments describe). It is deliberately NOT a popup — it gets
   * `aria-pressed`, never `aria-haspopup`, so the popup coverage registry does
   * not count it as a surface that must be closed. Omit it and the chip is the
   * plain two-segment split.
   */
  extra?: ReactNode;
  onExtraClick?: () => void;
  /** Native `title` on the extra segment — state-dependent explanatory copy. */
  extraTitle?: string;
  /**
   * STABLE accessible name for the extra segment. Required in practice for an
   * icon-only toggle: without it the name falls back to `title`, which changes
   * with state, so the control renames itself as the user toggles it (and every
   * aria snapshot containing it churns). The label names the control; `title`
   * explains the state; `aria-pressed` carries the state itself.
   */
  extraLabel?: string;
  /** A stable `manta-*` identity class for the extra segment button. */
  extraHook?: string;
  /** `aria-pressed` for the extra segment — its on/off state. */
  extraPressed?: boolean;
  /** Render the extra segment non-interactive (dimmed, `disabled`). */
  extraDisabled?: boolean;
}) {
  const listbox = popup ? { "aria-haspopup": "listbox" as const } : {};
  const leftAria = leftExpanded !== undefined ? { "aria-expanded": leftExpanded } : {};
  const rightAria = rightExpanded !== undefined ? { "aria-expanded": rightExpanded } : {};
  const leftClass = `${leftHook ? `${leftHook} ` : ""}inline-flex items-center ${CHIP_PAD} h-full hover:bg-fill-hover hover:text-text`;
  // `rightAccent` is a COLOUR accent only. It used to add `font-semibold` too,
  // which made the effort label the heaviest text in the composer — the accent
  // already carries the emphasis, and the extra weight only shouted.
  const rightClass = `${rightHook ? `${rightHook} ` : ""}inline-flex items-center ${CHIP_PAD} h-full border-l border-border hover:bg-fill-hover${rightAccent ? " text-accent-tx" : ""}`;
  // The toggle segment shares the divider + padding of the right segment, so
  // the three read as one control. Only its TONE differs, across three states
  // that must be told apart at a glance:
  //
  //   on        → accent (matching CHIP_ON's text)
  //   off       → --tx3, and it lights up on hover — the affordance IS the hover
  //   disabled  → --tx4 AND half-opacity, no hover, `cursor-not-allowed`
  //
  // Colour alone was not enough: --tx3 vs --tx4 is one step apart and the
  // toggle read as merely "off" when it was actually unavailable, so people
  // clicked it and nothing happened. Opacity is the second, unmistakable
  // channel (the caller is expected to swap the glyph too — see ModelPicker's
  // Zap/ZapOff). Tone is resolved BEFORE the disabled check so a control that
  // is on-but-frozen keeps its accent and dims, instead of flattening to grey
  // and lying about its state.
  const extraTone = extraPressed
    ? "text-accent-tx"
    : extraDisabled
      ? "text-text-quiet"
      : "text-text-faint";
  const extraInteraction = extraDisabled
    ? "opacity-50 cursor-not-allowed"
    : extraPressed
      ? "hover:bg-fill-hover"
      : "hover:bg-fill-hover hover:text-text";
  const extraClass =
    `${extraHook ? `${extraHook} ` : ""}inline-flex items-center ${CHIP_PAD} h-full border-l border-border ` +
    `${extraTone} ${extraInteraction}`;
  return (
    <div className={`${hook ? `${hook} ` : ""}${SPLIT_SHELL} p-0 overflow-hidden ${CHIP_REST}`}>
      <button type="button" onClick={onLeftClick} title={leftTitle} className={leftClass} {...listbox} {...leftAria}>
        {left}
      </button>
      <button type="button" onClick={onRightClick} title={rightTitle} className={rightClass} {...listbox} {...rightAria}>
        {right}
      </button>
      {extra !== undefined && (
        <button
          type="button"
          onClick={onExtraClick}
          title={extraTitle}
          aria-label={extraLabel}
          disabled={extraDisabled}
          aria-pressed={extraPressed}
          className={extraClass}
        >
          {extra}
        </button>
      )}
    </div>
  );
}
