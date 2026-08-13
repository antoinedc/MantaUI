// M527.Callout — the tonal advisory box chrome primitive (BET-614, stage 3).
//
// Owns the ONE shared chrome for a tinted inline advisory note with NO
// `className` escape hatch (epic standing decision 3): a left accent bar with a
// tinted background per tone, muted text colour and a readable measure. A
// caller cannot shear the bar, the tint or the tone, so the callout family can
// only drift if Callout itself is retuned.
//
// `size` is a second, intended axis (the review pane's inline diff note is the
// spec's `.note-inline` — the same advisory box in a smaller scale: a 2px bar,
// `--r-sm` right radius and tighter padding/metrics, per §4.5②). `size` only
// picks the geometry; `tone` still owns the tint, so every tone works at every
// size.
//
// C4 (validated constraints): the bare base is abstract — it has no tint and
// no bar colour, so it reads as an unstyled box. `tone` is therefore a
// REQUIRED prop with no default; the base only becomes a real callout once a
// tone picks both the bar and the surface. C1: every tone sets a background
// AND its bar colour together, so nothing rendered is invisible or orphaned.

import type { ReactNode } from "react";

const CALLOUT_SIZE = {
  // The default advisory box: a 3px bar, `--r-md` right radius, prose metrics.
  md: "border-l-[3px] rounded-r-[var(--r-md)] px-4 py-3 my-4 max-w-[78ch] text-body",
  // The review pane's inline diff note (§4.5② `.note-inline`): a 2px bar, a
  // `--r-sm` right radius, tighter spacing and `text-meta` (the note sits
  // between diff lines at 12.5px-equivalent).
  note: "border-l-2 rounded-r-[var(--r-sm)] px-[11px] py-2 my-[6px] max-w-[62ch] text-meta",
} as const;
const CALLOUT_TONE = {
  info: "border-l-accent bg-accent-bg",
  ok: "border-l-ok bg-ok-bg",
  warn: "border-l-warn bg-warn-bg",
  danger: "border-l-danger bg-danger-bg",
} as const;

export function Callout({
  tone,
  size = "md",
  children,
}: {
  /** The tonal variant. REQUIRED — the bare base is abstract (C4), so there is no safe default. */
  tone: keyof typeof CALLOUT_TONE;
  /** Geometry scale: "md" (default advisory box) or "note" (the review pane's inline diff note). */
  size?: keyof typeof CALLOUT_SIZE;
  children: ReactNode;
}) {
  return (
    <div className={`${CALLOUT_SIZE[size]} text-text-muted ${CALLOUT_TONE[tone]}`}>
      {children}
    </div>
  );
}
