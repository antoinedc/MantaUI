// MarqueeLabel — a reusable hover-marquee text label for truncated names.
//
// The label box is defined by ONE in-flow child: the resting, ellipsized copy
// (`manta-marquee-rest`). It is always present and always one line tall, so the
// label's height and width are the same whether or not the text is truncated
// and whether or not the pointer is over it.
//
// When the text WOULD truncate, a second copy (`manta-marquee-inner`) is
// rendered ABSOLUTELY POSITIONED on top of it — out of flow, so it contributes
// no height and no width. Hovering swaps which copy is visible and animates the
// overlay with a pure transform; nothing about the box changes, so entering
// hover reflows nothing and the ResizeObserver (which watches only the clip)
// never re-fires from a hover.
//
// Note the overlay MUST stay out of flow. An in-flow hidden sibling — even
// `visibility:hidden` — reserves a second line and makes every truncated row
// double height (BET-1172's regression).

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const CLIP = "relative block overflow-hidden";
const REST = "manta-marquee-rest block w-full truncate";
const INNER = "manta-marquee-inner absolute left-0 top-0 inline-block whitespace-nowrap";

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
  const restRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [over, setOver] = useState(false);

  useLayoutEffect(() => {
    const clip = clipRef.current;
    const rest = restRef.current;
    if (!clip || !rest) return;
    // The resting copy is `truncate` (nowrap + overflow hidden), so its
    // scrollWidth is the FULL text width and its clientWidth is the visible
    // width — their difference is exactly how far the overlay must travel.
    const measure = () => {
      const w = rest.scrollWidth - rest.clientWidth;
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
      <span ref={restRef} className={REST}>
        {children}
      </span>
      {over && <span className={INNER}>{children}</span>}
    </span>
  );
}
