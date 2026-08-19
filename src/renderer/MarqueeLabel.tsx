// MarqueeLabel — a reusable hover-marquee text label for truncated names.
//
// Renders an overflow-clipping outer span (the clip) containing one nowrap
// inner span (the text) plus an ellipsizing REST sibling. The inner span is
// ALWAYS full-width and is animated with a pure transform, so its box never
// changes on hover — lifting the pointer returns to the start with no reflow.
// At rest an ellipsizing REST sibling is shown; on hover CSS swaps to the
// animated inner. Because the inner keeps its layout size in both states
// (visibility, not display, hides it at rest), its scrollWidth stays
// measurable and the ResizeObserver (which observes only the clip) never
// re-fires on hover.

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const CLIP = "overflow-hidden";
const INNER = "manta-marquee-inner inline-block whitespace-nowrap";
const REST = "manta-marquee-rest block w-full truncate";

export function MarqueeLabel({
  children,
  className = "",
  title,
}: {
  /** The text (or a ReactNode) to show. */
  children: ReactNode;
  /** Applied to the OUTER clip span — carries the caller's flex/sizing/typography. */
  className?: string;
  /** Full-text tooltip, forwarded to the clip span (omit when the row already has one). */
  title?: string;
}) {
  const clipRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [over, setOver] = useState(false);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    const inner = innerRef.current;
    if (!clip || !inner) return;
    const measure = () => {
      const w = inner.scrollWidth - clip.clientWidth;
      setShift(Math.max(0, w));
      setOver(w > 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return; // jsdom / environments without RO
    const ro = new ResizeObserver(measure);
    ro.observe(clip);
    return () => ro.disconnect();
  }, [children]);

  return (
    <span
      ref={clipRef}
      title={title}
      className={`${CLIP}${over ? " manta-marquee" : ""} ${className}`}
      style={over ? ({ "--marquee-shift": `${shift}px` } as CSSProperties) : undefined}
    >
      {over && (
        <span className={REST}>
          {children}
        </span>
      )}
      <span ref={innerRef} className={INNER}>
        {children}
      </span>
    </span>
  );
}
