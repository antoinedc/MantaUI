// M527.MeasureColumn — the transcript reading-column chrome primitive (BET-637).
//
// The session spec uses ONE reading column in two places with identical
// metrics — the transcript and the composer (`.wrap` / `.comp-in`):
//
//   .wrap    { max-width:var(--measure); margin:0 auto; padding:0 28px;
//              display:flex; flex-direction:column; gap:var(--turn-gap) }
//   .comp-in { max-width:var(--measure); margin:0 auto; padding:0 28px }
//
// This primitive owns that 28px side padding (`px-[28px]`) so the transcript,
// the composer and the working indicator all share one left/right edge inside
// the 72ch measure — with NO `className` escape hatch (epic standing decision
// 3): a caller cannot shear the measure cap or the inset.
//
// `stacked` picks the two spec forms: true → flex column with `--turn-gap`
// between children (the transcript); false → a plain block (the composer and
// the working indicator).
//
// SimpleTypeScript: `gap` resolves through an inline style because the turn
// gap is a CSS custom property (--turn-gap), not a Tailwind scale class.

import type { ReactNode } from "react";

export function MeasureColumn({
  stacked = false,
  children,
}: {
  /** true → flex column with `--turn-gap` between children (the transcript). */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`w-full mx-auto px-[28px]${stacked ? " flex flex-col" : ""}`}
      style={{
        maxWidth: "var(--measure)",
        gap: stacked ? "var(--turn-gap)" : undefined,
      }}
    >
      {children}
    </div>
  );
}
