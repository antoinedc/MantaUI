// M527.Tag — the inline mono metadata badge chrome primitive (BET-614, stage 4).
//
// Owns the ONE shared chrome for a small faint filled pill that labels a
// caller-supplied icon + short mono text (e.g. a branch indicator in a header),
// with NO `className` escape hatch (epic standing decision 3). A caller cannot
// shear the pill, the fill, the faint mono label or the icon gap, so a tag
// can only drift if Tag itself is retuned.
//
// The icon AND the text are the caller's job: the caller passes a lucide icon
// (at `size={12}` for `md`, `size={11}` for `sm`) and the label as `children`
// (which may itself carry a `truncate` span — the primitive owns the pill, not
// the label's overflow policy). Vertically the pill resolves to the 23px hit
// area; the 5px icon gap and the 12.5px label are the spec's other off-grid
// values.
//
// `size` is a separate axis from the tone, and optional — unlike `tone` it is
// NOT the C4 abstract-variant trap (a tag with no size renders as a real tag).
// `md` is the canonical badge (the model menu's context count, the settings
// model rows). `sm` is the header-density variant: the session header packs
// the branch tag alongside the context pill on one floating row, so it wants a
// tag that reads as metadata rather than as a control — 20px tall and 11px,
// against md's 23px/11.5px.
//
// `plain` drops the tag's OWN surface — the edge and the fill — for the case
// where the tag sits on a surface that already supplies them, e.g. the session
// header's floating glass pill (which brings its own translucent fill, 1px
// edge, blur and capsule radius). Without it the tag would draw a second
// border inside the first and a second fill on top of the blur. This mirrors
// `Pill`'s optional `border` flag rather than inventing a new pattern, and it
// is what keeps the branch chip's metrics + typography owned by this primitive
// instead of being hand-rolled at the call site: the alternative that shipped
// briefly was a raw `<div>` re-deriving the gap, padding, radius and label
// size inline, which is precisely the drift the primitive layer exists to
// prevent.

import type { ReactNode } from "react";

const TAG_BASE = "inline-flex items-center font-mono leading-none font-medium";
const TAG_SURFACE = "rounded-full border border-border";
const TAG_SIZE: Record<"md" | "sm", string> = {
  md: "gap-[5px] h-[23px] px-2 text-[11.5px]",
  sm: "gap-1 h-5 px-2 text-[11px]",
};
const TAG_TONE: Record<"default" | "accent", string> = {
  default: "bg-fill text-text-faint",
  accent: "bg-transparent text-accent-tx",
};
// The foreground half of each tone, for `plain` — the fill is the host
// surface's job, but the label still has to carry the tone's colour (C1).
const TAG_TONE_PLAIN: Record<"default" | "accent", string> = {
  default: "text-text-faint",
  accent: "text-accent-tx",
};

export function Tag({
  icon,
  title,
  numeric,
  tone = "default",
  size = "md",
  plain = false,
  children,
}: {
  /** Optional lucide icon rendered before the label (12px on md, 11px on sm). */
  icon?: ReactNode;
  /** Native `title` tooltip. */
  title?: string;
  /** Tabular numerals — for a count / context badge (BET-644). */
  numeric?: boolean;
  /** Accent state — a selected menu row's badge (`.opt.on .ctx`, BET-644). */
  tone?: "default" | "accent";
  /** md = 23px badge (default); sm = the 20px header-density tag. */
  size?: "md" | "sm";
  /** Drop the tag's own edge + fill — for a tag on a host surface that has both. */
  plain?: boolean;
  /** The tag label. */
  children: ReactNode;
}) {
  return (
    <span
      className={[
        TAG_BASE,
        plain ? "" : TAG_SURFACE,
        TAG_SIZE[size],
        plain ? TAG_TONE_PLAIN[tone] : TAG_TONE[tone],
        numeric ? "tabular-nums" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}
