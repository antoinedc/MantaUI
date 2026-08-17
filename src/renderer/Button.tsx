// M527.Button — the button chrome primitive (BET-614, stage 1).
//
// Owns the ONE shared chrome for a labelled action button with NO `className`
// escape hatch (epic standing decision 3): a caller cannot shear the height,
// radius, padding, focus ring, tone or disabled state, so the button family can
// only drift if Button itself is retuned.
//
// Chrome contract (BET-529 inventory): h-8 (32px) hit area, `--r-md` radius
// (`rounded-md`), 14px inline padding (`px-[14px]` — a spec value, and the only
// off-grid px this primitive carries; 32px resolves via `h-8`), a 6px icon gap
// (`gap-[6px]`), 12.5px medium label (`text-[12.5px]`), `--accent` focus ring,
// and the four spec tones. C4 (validated constraints): the bare base is
// abstract (no background, no colour — invisible text), so `tone` is a REQUIRED
// prop with no default; the base only becomes a real button once a tone picks
// the surface. C1: every tone that sets a background or border also sets its
// foreground (default sets bg+border+text together; primary sets accent bg +
// `text-on-accent`; ghost/danger stay transparent-bg and set text only).
//
// Icons are the caller's job (a lucide icon at `size={14}`); the primitive does
// not style children — it only reserves the `gap-[6px]` so an inline icon sits
// beside the label. SIZE is an axis with exactly two steps (`md` and `lg`),
// both spec values — `md` is the existing chrome and stays the default, `lg`
// is the onboarding panel's primary action. Adding a third size is a spec
// change, not an implementation choice.
//
// `block` is a WIDTH axis, not a size one: the spec puts a full-width, centred
// button at the foot of a narrow panel (the context popover's "Clear session"
// — `width:100%;justify-content:center`), which the inline-flex base cannot
// express. It is optional and additive, and it is NOT the C4 abstract-variant
// trap: a button without it renders as a real button. It lives here rather
// than as a `w-full` at the call site precisely because that would be the
// className escape hatch by another name.

import type { ReactNode, RefObject } from "react";

const BUTTON_BASE =
  "inline-flex items-center gap-[6px] rounded-md border " +
  "font-medium leading-none transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

// SIZE is an axis like `block`, not a free number: two steps, both spec values.
// `md` is the existing chrome and stays the default, so every current call site
// is byte-identical. `lg` is the onboarding panel's primary action.
const BUTTON_SIZE = {
  md: "h-8 px-[14px] text-[12.5px]",
  lg: "h-10 px-6 text-body",
} as const;

// SplitButton's shell needs the md sizing (h-8 + text size) WITHOUT the
// `px-[14px]` — its segments carry their own segment padding. Kept as its own
// constant so the split shell stays byte-identical.
const SPLIT_BUTTON_CHROME =
  "inline-flex items-center h-8 rounded-md border text-[12.5px] " +
  "font-medium leading-none transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:opacity-50 disabled:cursor-not-allowed";
const BUTTON_PAD = "gap-[6px] px-[14px]";

const BUTTON_TONE = {
  default: "border-border bg-bg text-text hover:bg-raised hover:border-border-strong",
  primary: "border-accent-solid bg-accent-solid text-on-accent hover:brightness-110",
  ghost: "border-transparent bg-transparent text-text-faint hover:bg-fill-hover hover:text-text",
  danger: "border-transparent bg-transparent text-danger hover:bg-danger-bg",
} as const;

const BUTTON_BLOCK = "w-full justify-center";

export function Button({
  tone,
  block = false,
  size = "md",
  onClick,
  disabled,
  type = "button",
  title,
  children,
  hook,
  loading = false,
  ariaPressed,
}: {
  /** The visual tone. REQUIRED — the bare base is abstract (C4), so there is no safe default. */
  tone: keyof typeof BUTTON_TONE;
  /** Full-width, centred label — the spec's panel-footer action. */
  block?: boolean;
  /** Size step: `md` (default, the existing chrome) or `lg`. */
  size?: keyof typeof BUTTON_SIZE;
  onClick?: () => void;
  /** Renders the native `disabled` attribute + the not-allowed cursor, and dims the chrome. */
  disabled?: boolean;
  /** Native `type`; defaults to `"button"`. */
  type?: "button" | "submit" | "reset";
  /** Native `title` tooltip. */
  title?: string;
  /** The button label (optionally with a lucide icon at `size={14}`). */
  children: ReactNode;
  /**
   * A stable `manta-*` identity class for the call site (repo contract for
   * popup triggers — the visual coverage registry keys on it). This is an
   * IDENTITY hook, not a chrome class: it has no styling and cannot shear the
   * chrome, so it is not the `className` escape hatch the epic forbids.
   */
  hook?: string;
  /**
   * A transient resolving state (the action is in flight). The button renders
   * as disabled + `aria-busy` until the work settles. Presentational — the
   * caller owns the label that announces it.
   */
  loading?: boolean;
  /** Reflects a binary toggle state — renders the native `aria-pressed`. */
  ariaPressed?: boolean;
}) {
  const inert = disabled || loading;
  const className =
    `${hook ? `${hook} ` : ""}${BUTTON_BASE} ${BUTTON_SIZE[size]} ${BUTTON_TONE[tone]}` +
    (block ? ` ${BUTTON_BLOCK}` : "");
  return (
    <button
      type={type}
      disabled={inert}
      onClick={onClick}
      title={title}
      aria-busy={loading || undefined}
      aria-pressed={ariaPressed || undefined}
      className={className}
    >
      {children}
    </button>
  );
}

// M527.SplitButton — a two-segment ACTION with Button chrome (BET-951 follow-up).
//
// Same relationship to `Button` that `SplitChip` has to `Chip`: one shell, two
// segments, a `border-l` divider, and the split rule from BET-634 — the shell
// border is left alone on hover and the HOVERED SEGMENT fills
// (`hover:bg-fill-hover`), so you can tell which half you are about to click.
//
// It exists because a split control in a row of `Button`s must be a `Button`:
// `SplitChip` is 29px/regular-weight and reads as a status readout beside
// 32px/medium actions. There is deliberately NO `tone` prop — the split form is
// only ever the default tone (a primary split would put two accent surfaces in
// one control), and no `extra` third segment (that is the composer's ⚡ toggle,
// which is a Chip concern).
const SPLIT_BUTTON_TONE = "border-border bg-bg text-text";

export function SplitButton({
  left,
  right,
  onLeftClick,
  onRightClick,
  rightAccent = false,
  leftTitle,
  rightTitle,
  leftHook,
  rightHook,
  rightExpanded,
  rightBtnRef,
  disabled = false,
  loading = false,
}: {
  /** Left-segment content — the action label. */
  left: ReactNode;
  /** Right-segment content — what the action will run against (e.g. a model). */
  right: ReactNode;
  onLeftClick: () => void;
  onRightClick: () => void;
  /** Accent the right segment (`--accent-tx`). Colour only — never weight. */
  rightAccent?: boolean;
  leftTitle?: string;
  rightTitle?: string;
  /** Stable `manta-*` identity class for the LEFT segment button. */
  leftHook?: string;
  /**
   * Stable `manta-*` identity class for the RIGHT segment button. The right
   * segment always carries `aria-haspopup="listbox"`, so the popup coverage
   * registry keys on THIS hook, not on the shell.
   */
  rightHook?: string;
  /** `aria-expanded` for the right segment — whether its listbox is open. */
  rightExpanded?: boolean;
  /** Forwarded to the RIGHT segment button (the dropdown's anchor). */
  rightBtnRef?: RefObject<HTMLButtonElement>;
  /** Both segments become native-`disabled` (dimmed, not clickable). */
  disabled?: boolean;
  /**
   * The control is still resolving what it describes (e.g. the model catalog
   * has not loaded). Presentational only, mirroring SplitChip.loading: both
   * segments drop their hover affordance and the shell reports `aria-busy`.
   */
  loading?: boolean;
}) {
  const inert = disabled || loading;
  const segBase = `inline-flex items-center ${BUTTON_PAD} h-full transition-colors`;
  const hover = inert ? "" : " hover:bg-fill-hover";
  const leftClass = `${leftHook ? `${leftHook} ` : ""}${segBase}${hover}`;
  const rightClass =
    `${rightHook ? `${rightHook} ` : ""}${segBase} border-l border-border${hover}` +
    (rightAccent && !inert ? " text-accent-tx" : "");
  return (
    <div
      className={`${SPLIT_BUTTON_CHROME} p-0 overflow-hidden ${SPLIT_BUTTON_TONE}`}
      aria-busy={loading || undefined}
    >
      <button
        type="button"
        onClick={onLeftClick}
        disabled={disabled}
        title={leftTitle}
        className={leftClass}
      >
        {left}
      </button>
      <button
        ref={rightBtnRef}
        type="button"
        onClick={onRightClick}
        disabled={disabled}
        title={rightTitle}
        aria-haspopup="listbox"
        aria-expanded={rightExpanded}
        className={rightClass}
      >
        {right}
      </button>
    </div>
  );
}
