// useTranscriptSelection (BET-1351) — one-shot transcript quote detection.
//
// Event-driven, NOT a live tracker: it shows the quote bar the moment the
// user FINISHES selecting text (pointerup / shift-arrow keyup) and hides on
// the next gesture, scroll, Escape, an action firing, or a session change.
//
// Why not a `selectionchange` live tracker: the transcript is virtualised
// (react-virtuoso unmounts rows outside its viewport window), so a range whose
// row has been recycled reports a zero rect — keeping the bar "live" over a
// selection would paint a ghost bar over unrelated content. Instead we capture
// the position ONCE, from the selection's rect at the pointerup/keyup moment,
// and hide deterministically on any subsequent scroll (which is what would
// otherwise make that frozen position lie).
//
// Deliberately NOT solved here: press-and-hold drag already detaches the
// transcript's auto-scroll-to-bottom (see the note in chatUtils.ts on
// createUserScrollIntent), so this hook adds no follow-suppression of its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { QUOTE_HEAD, QUOTE_MAX, QUOTE_TAIL, buildQuoteBlock } from "../chatUtils";

export type QuoteSelection = {
  /** The built `"> ...\n\n"` block, ready to prepend to the composer. */
  block: string;
  /** Viewport-space top of the selection rect (fixed positioning). */
  top: number;
  /** Viewport-space left of the selection rect. */
  left: number;
};

export function useTranscriptSelection(params: {
  scrollerRef: React.RefObject<HTMLElement | null>;
  /** Root of the quote bar, so pointer/selection events ON the bar don't
   *  collapse it (which would unmount the buttons before their click lands). */
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string;
  /** Fired with the quote block for the "Quote" action. */
  onQuote: (block: string) => void;
  /** Fired with the quote block for the "Quote in new session" action. */
  onQuoteNewSession: (block: string) => void;
}): {
  quote: QuoteSelection | null;
  quoteNow: () => void;
  quoteNewSessionNow: () => void;
} {
  const { scrollerRef, toolbarRef, sessionId, onQuote, onQuoteNewSession } = params;

  const [quote, setQuote] = useState<QuoteSelection | null>(null);
  const hide = useCallback(() => setQuote(null), []);

  // Always-fresh accessors so the document-level listeners and the action
  // wrappers never close over a stale callback / session / quote value.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;
  const onQuoteNewSessionRef = useRef(onQuoteNewSession);
  onQuoteNewSessionRef.current = onQuoteNewSession;
  const quoteRef = useRef(quote);
  quoteRef.current = quote;

  const insideToolbar = useCallback(
    (node: Node | null): boolean => !!toolbarRef.current && !!node && toolbarRef.current.contains(node),
    [toolbarRef],
  );

  const maybeShow = useCallback(() => {
    const scroller = scrollerRef.current;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !scroller) {
      setQuote(null);
      return;
    }
    if (!sel.anchorNode || !scroller.contains(sel.anchorNode)) {
      setQuote(null);
      return;
    }
    const text = sel.toString();
    const block = buildQuoteBlock(text, QUOTE_MAX, QUOTE_HEAD, QUOTE_TAIL);
    if (!block) {
      setQuote(null);
      return;
    }
    if (sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setQuote(null);
      return;
    }
    setQuote({ block, top: rect.top, left: rect.left });
  }, [scrollerRef]);

  // Clear on session change so a bar from the previous session can't linger.
  useEffect(() => {
    setQuote(null);
  }, [sessionId]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (insideToolbar(e.target as Node)) return;
      setQuote(null);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (insideToolbar(e.target as Node)) return;
      maybeShow();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (insideToolbar(e.target as Node)) return;
      if (e.key === "Escape") {
        setQuote(null);
        return;
      }
      maybeShow();
    };
    const onScroll = () => setQuote(null);
    // "the selection becoming empty" — keyboard deselect / click that clears
    // the selection without the pointerdown above. Ignored while focus is on
    // the bar itself (clicking a button collapses the selection; that must
    // surface as the button's action, not an instant hide).
    const onSelectionChange = () => {
      if (insideToolbar(document.activeElement)) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setQuote(null);
    };

    const scroller = scrollerRef.current;
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [insideToolbar, maybeShow, scrollerRef]);

  const quoteNow = useCallback(() => {
    const current = quoteRef.current;
    if (!current) return;
    hide();
    onQuoteRef.current(current.block);
  }, [hide]);

  const quoteNewSessionNow = useCallback(() => {
    const current = quoteRef.current;
    if (!current) return;
    hide();
    onQuoteNewSessionRef.current(current.block);
  }, [hide]);

  return { quote, quoteNow, quoteNewSessionNow };
}
