// M527.MeasureColumn — the reading-column chrome primitive (BET-637, BET-646).
//
// The session spec used to draw ONE reading column in two places with
// identical metrics — the transcript and the composer (`.wrap` / `.comp-in`).
// BET-646 splits them by owner decision (this issue): the transcript runs the
// full width of the session panel, while the composer stack keeps the 72ch
// measure. The primitive owns that split with a `width` variant so a surface
// picks a side by NAME instead of re-deriving the metrics — with NO `className`
// escape hatch (epic standing decision 3): a caller cannot shear the cap, the
// centring or the inset.
//
//   .wrap    { max-width:var(--measure); margin:0 auto; padding:0 28px;
//              display:flex; flex-direction:column; gap:var(--turn-gap) }
//   .comp-in { max-width:var(--measure); margin:0 auto; padding:0 28px }
//
// `width` picks the spec form:
//   - "measure" (default) — today's behaviour exactly: `max-width:
//     var(--measure)` + `mx-auto` (the composer, the user bubble's container,
//     and the pinned cards above the composer).
//   - "full" — no cap and no centring, at the WIDER `--transcript-inset`
//     gutter. The gutter is what makes this "full width of the panel" rather
//     than "edge to edge" (the transcript column and the working indicator),
//     and in the transcript it is load-bearing rather than decorative: the
//     per-turn timestamp is positioned INTO it (see MessageRow), so narrowing
//     it back to 28px would push the stamps off the panel edge.
//
// `stacked` picks the two spec forms within a width: true → flex column with
// `--turn-gap` between children (the transcript); false → a plain block (the
// composer, the working indicator and the queued-message notice).
//
// SimpleTypeScript: `gap` resolves through an inline style because the turn
// gap is a CSS custom property (--turn-gap), not a Tailwind scale class, and
// `maxWidth` resolves through the inline style so "full" can be the absence of
// a cap.

import type { ReactNode } from "react";

export function MeasureColumn({
  stacked = false,
  width = "measure",
  children,
}: {
  /** true → flex column with `--turn-gap` between children (the transcript). */
  stacked?: boolean;
  /** "measure" (default) → capped + centred; "full" → no cap, no centring. */
  width?: "measure" | "full";
  children: ReactNode;
}) {
  const full = width === "full";
  return (
    <div
      className={`w-full${full ? "" : " mx-auto"}${stacked ? " flex flex-col" : ""}`}
      style={{
        maxWidth: full ? undefined : "var(--measure)",
        paddingInline: full ? "var(--transcript-inset)" : "28px",
        gap: stacked ? "var(--turn-gap)" : undefined,
      }}
    >
      {children}
    </div>
  );
}
