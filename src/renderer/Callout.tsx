// M527.Callout — the tonal advisory box chrome primitive (BET-614, stage 3).
//
// Owns the ONE shared chrome for a tinted inline advisory note with NO
// `className` escape hatch (epic standing decision 3): a 3px accent-left bar
// with a tinted background per tone, body text, muted text colour and a
// readable measure. A caller cannot shear the bar, the tint or the tone, so
// the callout family can only drift if Callout itself is retuned.
//
// C4 (validated constraints): the bare base is abstract — it has no tint and
// no bar colour, so it reads as an unstyled box. `tone` is therefore a
// REQUIRED prop with no default; the base only becomes a real callout once a
// tone picks both the bar and the surface. C1: every tone sets a background
// AND its bar colour together, so nothing rendered is invisible or orphaned.

import type { ReactNode } from "react";

const CALLOUT_BASE =
  "border-l-[3px] rounded-r-[var(--r-md)] px-4 py-3 my-4 max-w-[78ch] text-body text-text-muted";
const CALLOUT_TONE = {
  info: "border-l-accent bg-accent-bg",
  ok: "border-l-ok bg-ok-bg",
  warn: "border-l-warn bg-warn-bg",
  danger: "border-l-danger bg-danger-bg",
} as const;

export function Callout({
  tone,
  children,
}: {
  /** The tonal variant. REQUIRED — the bare base is abstract (C4), so there is no safe default. */
  tone: keyof typeof CALLOUT_TONE;
  children: ReactNode;
}) {
  return (
    <div className={`${CALLOUT_BASE} ${CALLOUT_TONE[tone]}`}>{children}</div>
  );
}
