// M527.MessageBubble — the user-message bubble chrome primitive (BET-637, BET-646).
//
// The session spec draws a typed user message as a right-aligned pill bubble
// capped at 88% of its reading column (`.uwrap` / `.umsg`):
//
//   .uwrap { display:flex; justify-content:flex-end }
//   .umsg  { background:var(--fill); border:1px solid var(--border-subtle);
//            border-radius:var(--r-lg); padding:11px var(--sp-4);
//            font:400 15px/1.55 var(--font-sans); color:var(--tx1);
//            max-width:min(88%, var(--measure)) }
//
// The cap is the `min()` of 88% and the reading measure (BET-646): the second
// term exists because the transcript column is now uncapped (full panel
// width), so a bare 88% of a 2000px column would stretch the bubble into a
// wide grey band instead of a pill. Narrow windows keep today's 88% behaviour
// exactly; wide windows hold the bubble at the measure — `--measure` is the
// token for "how wide prose should be", doing its job on the surface that
// still wants it.
//
// This primitive owns that chrome — the 88%/measure cap, the 11px vertical
// padding and the fill/subtle-border surface — with NO `className` escape
// hatch (epic standing decision 3). The user message is the only bubble in
// the app today; it carries a formal single-adopter exemption (see
// primitives.test.ts SKIP_REASON) because the owner wants the chrome owned by
// a primitive now rather than re-derived when mobile and any future review
// surface need it.

import type { ReactNode } from "react";

export const BUBBLE_CHROME =
  "bg-fill border border-border-subtle rounded-lg px-4 py-[11px] text-prose text-text " +
  "max-w-[min(88%,var(--measure))] whitespace-pre-wrap break-words";

export function MessageBubble({
  children,
  entering = false,
}: {
  children: ReactNode;
  // The iMessage-style send pop, and the ONE thing that must stay gated: this
  // class used to be unconditional, so every bubble in a transcript the user
  // merely opened popped on mount and a session switch replayed every send
  // they had ever made. Only a message that arrives while they are watching
  // animates (decided in Transcript, see `updateEntryMotion`).
  entering?: boolean;
}) {
  return (
    <div className="flex justify-end">
      <div className={entering ? BUBBLE_CHROME + " manta-bubble-in" : BUBBLE_CHROME}>
        {children}
      </div>
    </div>
  );
}
