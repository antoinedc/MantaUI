// M527.Pill — the status-pill chrome primitive (BET-534, stage 5).
//
// Owns the ONE shared pill chrome with NO `className` escape hatch (epic
// standing decision 3): a caller cannot shear the capsule radius, the tone
// surface, the optional edge or the padding, so the pill family can only
// drift if Pill itself is retuned.
//
// Chrome contract (BET-529 inventory):
//   - capsule `--r-full` (`rounded-full`).
//   - `sp-2` padding — `px-2 py-px` (the vertical step is the pill's 1px
//     breathing room, matching the canonical ContextPill; the horizontal is
//     `sp-2` = 8px).
//   - gap-2 between the icon and the metric/label.
//   - a leading icon at 14px (the chrome contract's "icon 14px");
//     label/mono content is free-form `children`.
//
// Tone + C1 (validated constraints). The tone carries the surface decision
// and is a REQUIRED prop with no default (C4): the spec's bare `.pill` is an
// abstract base — 0 of its 81 uses omit a modifier — so a `<Pill>` without a
// tone must be a TYPE ERROR, not invisible text.
//   - `neutral` sets no background (it inherits the surface it sits on) and
//     therefore may inherit its foreground — a muted `--tx2` is declared as
//     the resting label colour so a bare neutral pill reads as a label.
//   - `accent` / `warn` / `ok` set a surface (`--accent-bg` / `--warn-bg` /
//     `--ok-bg`) that differs from the page, so C1 makes them declare the
//     matching foreground token (`text-accent` / `text-warn` / `text-ok`) to
//     keep contrast valid.
//
// An optional `border` flag adds the `--border` edge. `size` is a separate
// axis from the tone — "meta" (12px, the ContextPill size) is the default,
// "label" (13px) covers the larger standing tag — and is optional because it
// is not the abstract-variant trap C4 guards against; only `tone` is.

import type { ReactElement, ReactNode } from "react";
import { cloneElement } from "react";

type PillTone = "neutral" | "accent" | "warn" | "ok";
type PillSize = "meta" | "label";

const PILL_BASE = "inline-flex items-center gap-2 rounded-full px-2 py-px font-semibold";
const TONE: Record<PillTone, string> = {
  neutral: "text-text-muted",
  accent: "bg-accent-bg text-accent",
  warn: "bg-warn-bg text-warn",
  ok: "bg-ok-bg text-ok",
};
const SIZE: Record<PillSize, string> = {
  meta: "text-meta",
  label: "text-label",
};
const EDGE = "border border-border";

export function Pill({
  tone,
  border = false,
  size = "meta",
  icon,
  children,
}: {
  /**
   * Which surface + foreground the pill carries. REQUIRED with no default
   * (C4) — a pill that omitted a tone would render as invisible text.
   */
  tone: PillTone;
  /** Optional `--border` edge around the pill. */
  border?: boolean;
  /** meta = 12px (default, the ContextPill size); label = 13px (standing tag). */
  size?: PillSize;
  /** Optional leading icon, rendered at 14px per the chrome contract. */
  icon?: ReactElement;
  children?: ReactNode;
}) {
  return (
    <span className={`${PILL_BASE} ${SIZE[size]} ${TONE[tone]}${border ? ` ${EDGE}` : ""}`}>
      {icon && cloneElement(icon, { size: 14, "aria-hidden": true })}
      {children}
    </span>
  );
}
