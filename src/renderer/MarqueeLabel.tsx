// MarqueeLabel — a reusable hover-marquee text label for truncated names.
//
// Renders an overflow-clipping outer span (the clip) containing one nowrap
// inner span (the text). When the inner text is wider than the clip (i.e. it
// WOULD truncate), hovering the clip slides the text on a loop with a dwell at
// each end. When not hovered — or not truncated, or reduced-motion — the inner
// span has transform:none, so the title ALWAYS reads from the start (R1). The
// animation is applied only under :hover in index.css, so lifting the pointer
// snaps the text back to the start by construction; there is no scroll offset
// to remember or reset.

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const CLIP = "overflow-hidden";
const INNER = "manta-marquee-inner inline-block whitespace-nowrap max-w-full overflow-hidden text-ellipsis";

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
    ro.observe(inner);
    return () => ro.disconnect();
  }, [children]);

  return (
    <span
      ref={clipRef}
      title={title}
      className={`${CLIP}${over ? " manta-marquee" : ""} ${className}`}
      style={over ? ({ "--marquee-shift": `${shift}px` } as CSSProperties) : undefined}
    >
      <span ref={innerRef} className={INNER}>
        {children}
      </span>
    </span>
  );
}
