// M527.MessageBubble — the user-message bubble chrome primitive (BET-637).
//
// The session spec draws a typed user message as a right-aligned pill bubble
// capped at 88% of the reading column (`.uwrap` / `.umsg`):
//
//   .uwrap { display:flex; justify-content:flex-end }
//   .umsg  { background:var(--fill); border:1px solid var(--border-subtle);
//            border-radius:var(--r-lg); padding:11px var(--sp-4);
//            font:400 15px/1.55 var(--font-sans); color:var(--tx1);
//            max-width:88% }
//
// This primitive owns that chrome — the 88% cap, the 11px vertical padding and
// the fill/subtle-border surface — with NO `className` escape hatch (epic
// standing decision 3). The user message is the only bubble in the app today;
// it carries a formal single-adopter exemption (see primitives.test.ts
// SKIP_REASON) because the owner wants the chrome owned by a primitive now
// rather than re-derived when mobile and any future review surface need it.

import type { ReactNode } from "react";

export function MessageBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="bg-fill border border-border-subtle rounded-lg px-4 py-[11px] text-prose text-text max-w-[88%] whitespace-pre-wrap break-words">
        {children}
      </div>
    </div>
  );
}
