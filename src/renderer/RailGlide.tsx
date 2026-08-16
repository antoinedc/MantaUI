// The sidebar rail's single gliding hover highlight.
//
// Instead of every row painting its own `hover:bg-fill-hover` (which makes a
// pointer sweep down the rail read as a row of backgrounds blinking on and
// off), the rail owns ONE absolutely-positioned element that travels to the
// row under the pointer. Same idea as the gliding pill in the model menu.
//
// Two things make it a hook rather than a self-contained component:
//
//   - The highlight must be a child of the SCROLL CONTAINER (so it scrolls
//     with the rows and is positioned against the same box), while the hover
//     handlers must be on that same container. The hook hands the caller both
//     halves and owns the state between them.
//   - Hover is DELEGATED: one `mouseover` on the container resolves the row
//     via `closest("[data-rail-row]")`. Rows are rendered by four different
//     components (window rows, nested job rows, draft rows, create rows), and
//     threading an index + ref through all of them would be far more code
//     than one data attribute.
//
// Geometry is measured with getBoundingClientRect() against the container and
// then shifted by scrollTop/scrollLeft, giving a CONTENT-space coordinate.
// offsetTop would also work today but silently breaks the day any wrapper
// between the container and a row becomes positioned.

import { useCallback, useRef, useState } from "react";

type GlideBox = { top: number; left: number; width: number; height: number };

export function useRailGlide() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoveredRowRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<GlideBox | null>(null);
  const [shown, setShown] = useState(false);
  const [snap, setSnap] = useState(false);

  const onMouseOver = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const target = event.target as HTMLElement | null;
    const row = target?.closest?.("[data-rail-row]") as HTMLElement | null;
    if (!row || !container.contains(row)) {
      // Pointer is over the rail but not over a row (a group header, the
      // padding): hide rather than leave the highlight stranded.
      hoveredRowRef.current = null;
      setShown(false);
      return;
    }
    // `mouseover` fires for every descendant; re-measuring the row we are
    // already on would be pure waste (its content-space box cannot move
    // without a re-render or a scroll, and both re-fire this handler).
    if (hoveredRowRef.current === row && shown) return;
    hoveredRowRef.current = row;
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    setBox({
      top: rowRect.top - containerRect.top + container.scrollTop,
      left: rowRect.left - containerRect.left + container.scrollLeft,
      width: rowRect.width,
      height: rowRect.height,
    });
    if (!shown) {
      // First appearance: place it without a glide, then re-enable the
      // transition on the next frame so every later move animates.
      setSnap(true);
      setShown(true);
      requestAnimationFrame(() => setSnap(false));
    }
  }, [shown]);

  const onMouseLeave = useCallback(() => {
    hoveredRowRef.current = null;
    setShown(false);
  }, []);

  const glide = (
    <span
      aria-hidden="true"
      className="rail-glide"
      data-shown={shown && box ? "true" : "false"}
      data-snap={snap ? "true" : "false"}
      style={
        box
          ? { top: box.top, left: box.left, width: box.width, height: box.height }
          : undefined
      }
    />
  );

  return {
    /** Spread onto the rail's scroll container. */
    containerProps: { ref: containerRef, onMouseOver, onMouseLeave },
    /** Render as the FIRST child of that container. */
    glide,
  };
}
