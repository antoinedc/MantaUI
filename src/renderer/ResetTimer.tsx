// The usage popover's "in 2h20m" countdown, with a tooltip carrying the exact
// reset date. Hand-rolled handlers + a portal (not the native `interestfor` /
// popover="hint" pair): the desktop renderer ships Chromium 126, which has
// neither. Accessibility follows WCAG 1.4.13 and the interest-triggered-tooltip
// guide: the timer is focusable and described by the tooltip, the tooltip is
// hoverable, stays until dismissed, closes on Escape, and focus never moves
// into it. It is portalled + fixed so the popover's own scroll area can't clip
// it (the same pattern, and the same placement math, as Popover).

import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatResetDistance, formatResetTooltip } from "./chatUtils";
import { placeFloating } from "./Popover";

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 120;

export const ResetTimer = memo(function ResetTimer({
  resetsAt,
  startedAt,
  nowMs,
  className = "",
}: {
  resetsAt: number;
  startedAt?: number;
  nowMs: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Who is holding the tooltip open: the pointer over the timer, the pointer over
  // the tooltip itself, or keyboard focus on the timer.
  const holds = useRef({ hover: false, tip: false, focus: false });
  const id = useId();

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);
  const closeIfIdle = useCallback(() => {
    clear();
    timerRef.current = setTimeout(() => {
      const h = holds.current;
      if (!h.hover && !h.tip && !h.focus) setOpen(false);
    }, CLOSE_DELAY_MS);
  }, [clear]);

  useEffect(() => clear, [clear]);

  // Escape dismisses the tooltip — and only the tooltip. Captured at the document
  // so it also works when the tooltip was opened by hover (focus is elsewhere),
  // and so the usage popover's own Escape handler never sees the key.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      clear();
      holds.current = { hover: false, tip: false, focus: false };
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, clear]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const compute = () => {
      const r = tip.getBoundingClientRect();
      const { top, left } = placeFloating(
        anchor.getBoundingClientRect(),
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
        "above",
        "center",
        8,
      );
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  const tip = formatResetTooltip(resetsAt, startedAt, nowMs);

  return (
    <>
      <span
        ref={anchorRef}
        tabIndex={0}
        data-reset-timer="true"
        aria-describedby={open && tip ? id : undefined}
        className={
          "cursor-default rounded-xs underline decoration-dotted decoration-transparent underline-offset-[3px] " +
          "hover:text-text hover:decoration-text-faint focus:outline-none focus-visible:text-text " +
          "focus-visible:decoration-text-faint focus-visible:ring-2 focus-visible:ring-accent " +
          className
        }
        onPointerEnter={() => {
          holds.current.hover = true;
          if (open) return;
          clear();
          timerRef.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
        }}
        onPointerLeave={() => {
          holds.current.hover = false;
          closeIfIdle();
        }}
        onFocus={() => {
          holds.current.focus = true;
          clear();
          setOpen(true);
        }}
        onBlur={() => {
          holds.current.focus = false;
          closeIfIdle();
        }}
      >
        in {formatResetDistance(resetsAt - nowMs)}
      </span>
      {open && tip
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className="whitespace-nowrap rounded-sm border border-border bg-raised px-[10px] py-[7px] text-left text-meta text-text shadow-md"
              style={{
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                zIndex: 56,
                visibility: pos ? "visible" : "hidden",
              }}
              onPointerEnter={() => {
                holds.current.tip = true;
                clear();
              }}
              onPointerLeave={() => {
                holds.current.tip = false;
                closeIfIdle();
              }}
              // The usage popover treats a press outside its panel as "click away";
              // the tooltip is portalled outside it, so a press here must not count.
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="font-semibold">{tip.title}</div>
              <div className="text-text-faint">{tip.sub}</div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
});
