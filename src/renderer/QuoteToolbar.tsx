// QuoteToolbar (BET-1351) — the floating action bar shown once the user
// finishes selecting text in the transcript. "Quote" seeds the current
// composer; "Quote in new session" forks the session with the quote seeded.
//
// position:fixed + clamped into the viewport (same arithmetic as Popover) and
// rendered from ChatPanel's transcript wrapper — NOT inside the Virtuoso root,
// whose overflow-x-hidden would clip it. It is deliberately NOT built on
// Popover: Popover needs a real anchorRef element and a selection only has a
// rectangle.
import { useLayoutEffect, useState } from "react";
import type { QuoteSelection } from "./hooks/useTranscriptSelection";

export function QuoteToolbar(props: {
  quote: QuoteSelection | null;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  onQuote: () => void;
  onQuoteNewSession: () => void;
}) {
  const { quote, toolbarRef, onQuote, onQuoteNewSession } = props;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!quote) {
      setPos(null);
      return;
    }
    const el = toolbarRef.current;
    if (!el) return;
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;
    const top = Math.max(8, Math.min(quote.top - h - 4, window.innerHeight - h - 8));
    const left = Math.max(8, Math.min(quote.left, window.innerWidth - w - 8));
    setPos((prev) =>
      prev && prev.top === top && prev.left === left ? prev : { top, left },
    );
  }, [quote, toolbarRef]);

  if (!quote) return null;

  return (
    <div
      ref={toolbarRef as React.RefObject<HTMLDivElement>}
      className="manta-quote-toolbar"
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      role="toolbar"
      aria-label="Quote selection"
    >
      <button type="button" className="text-label" onClick={onQuote}>
        Quote
      </button>
      <button type="button" className="text-label" onClick={onQuoteNewSession}>
        Quote in new session
      </button>
    </div>
  );
}
