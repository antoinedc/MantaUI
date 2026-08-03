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
// beside the label. There is deliberately no size prop: the spec has no
// `.btn.sm` rule, so there is one size only.
//
// `block` is a WIDTH axis, not a size one: the spec puts a full-width, centred
// button at the foot of a narrow panel (the context popover's "Clear session"
// — `width:100%;justify-content:center`), which the inline-flex base cannot
// express. It is optional and additive, and it is NOT the C4 abstract-variant
// trap: a button without it renders as a real button. It lives here rather
// than as a `w-full` at the call site precisely because that would be the
// className escape hatch by another name.

import type { ReactNode } from "react";

const BUTTON_BASE =
  "inline-flex items-center gap-[6px] h-8 px-[14px] rounded-md border " +
  "text-[12.5px] font-medium leading-none transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

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
  onClick,
  disabled,
  type = "button",
  title,
  children,
  hook,
}: {
  /** The visual tone. REQUIRED — the bare base is abstract (C4), so there is no safe default. */
  tone: keyof typeof BUTTON_TONE;
  /** Full-width, centred label — the spec's panel-footer action. */
  block?: boolean;
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
}) {
  const className =
    `${hook ? `${hook} ` : ""}${BUTTON_BASE} ${BUTTON_TONE[tone]}` +
    (block ? ` ${BUTTON_BLOCK}` : "");
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={className}
    >
      {children}
    </button>
  );
}
