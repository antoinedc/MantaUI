// BET-865 — the ONE anchored-surface primitive.
//
// Every menu/popover ports to <body> and is positioned `fixed` from its
// trigger's rect. That is the fix for "the session-header popover renders
// behind the transcript": an `absolute` box in the header's subtree is clipped
// by any overflow ancestor (StatusOverflow), trapped below a later sibling by
// any stacking-context ancestor (the reported symptom), and subject to the
// header's Electron drag-region compositing. Portalled + fixed, no ancestor
// can clip it, no stacking context can trap it, and the drag region is
// irrelevant. It does not own the trigger — every call site keeps its own
// trigger button chrome.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useClickAway } from "./hooks/useClickAway";

// The ONE anchored-surface chrome — no second definition anywhere. shadow-lg
// (Dropdown's value) is the single shadow; the old shadow-md popovers adopt it.
export const POPOVER_SURFACE =
  "manta-menu-in rounded-lg border border-border bg-bg-soft shadow-lg";

export type PopoverPlacement = "below" | "above";
export type PopoverAlign = "start" | "end" | "center";

type PlaceRect = { top: number; bottom: number; left: number; right: number };

/**
 * The ONE placement computation behind Popover and the reset tooltip
 * (ResetTimer): prefer `placement`, flip to the other side only when the
 * preferred one cannot fit the surface and the other has more room, then clamp
 * into the viewport with an 8px margin. Pure — rects and sizes in, top/left out.
 */
export function placeFloating(
  anchor: PlaceRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: PopoverPlacement,
  align: PopoverAlign,
  gap = 4,
): { top: number; left: number; side: PopoverPlacement } {
  const w = size.width || 0;
  const h = size.height || 0;
  const roomAbove = anchor.top - 8;
  const roomBelow = viewport.height - anchor.bottom - 8;
  const side: PopoverPlacement =
    placement === "above" && h + gap > roomAbove && roomBelow > roomAbove
      ? "below"
      : placement === "below" && h + gap > roomBelow && roomAbove > roomBelow
        ? "above"
        : placement;
  const top = side === "below" ? anchor.bottom + gap : anchor.top - h - gap;
  const left =
    align === "end" ? anchor.right - w : align === "center" ? (anchor.left + anchor.right) / 2 - w / 2 : anchor.left;
  return {
    top: Math.max(8, Math.min(top, viewport.height - h - 8)),
    left: Math.max(8, Math.min(left, viewport.width - w - 8)),
    side,
  };
}

export function Popover({
  open,
  onClose,
  anchorRef,
  placement = "below",
  align = "end",
  role = "dialog",
  ariaLabel,
  id,
  hook,
  surfaceClassName,
  panelRef,
  onKeyDown,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The trigger element — positioning and click-away both key on it. */
  anchorRef: RefObject<HTMLElement>;
  placement?: PopoverPlacement;
  align?: PopoverAlign;
  role?: "dialog" | "menu" | "listbox";
  ariaLabel?: string;
  id?: string;
  /** Stable `manta-*` identity class (visual-gate contract). Identity only. */
  hook?: string;
  /** Width + padding utilities ONLY ("w-[360px] p-4"). Never chrome. */
  surfaceClassName?: string;
  /** External ref to the portalled surface (callers that query it for roving). */
  panelRef?: RefObject<HTMLDivElement>;
  /** Keyboard nav for content INSIDE the surface (the surface is portalled, so
   *  a handler on the trigger wrapper would never see events from within it). */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const resolvedPanel = panelRef ?? surfaceRef;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position `fixed` from the anchor's rect (4px = the old mt-1/mb-1 gap),
  // clamped into the viewport, recomputed on resize/scroll while open.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const panel = resolvedPanel.current;
    if (!anchor || !panel) return;
    const compute = () => {
      const p = panel.getBoundingClientRect();
      const { top, left } = placeFloating(
        anchor.getBoundingClientRect(),
        { width: p.width, height: p.height },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
        align,
      );
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    // A surface whose content grows after it opened (the usage popover's inline
    // "switch seat?" confirm) must re-clamp, or it spills off the viewport.
    // jsdom has no ResizeObserver; the open/resize/scroll paths still apply.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(compute) : null;
    ro?.observe(panel);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
      ro?.disconnect();
    };
  }, [open, anchorRef, resolvedPanel, placement, align]);

  // Click-away on the anchor OR the panel (the panel is portalled, so a click
  // on its own buttons is no longer inside the anchor's subtree).
  useClickAway(anchorRef, open, onClose, resolvedPanel);

  // Escape closes and hands focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, anchorRef]);

  // The surface exists only while open (the repo contract) — no aria-hidden
  // on a closed-but-present surface.
  if (!open) return null;

  // z-40: above the pane's in-pane z-30 surfaces, below modals/palettes (z-50)
  // and toasts (z-[60]) so a modal opened over a menu still covers it. A menu
  // opened FROM a modal (its trigger is inside the dialog) goes above it, z-55.
  const inModal = !!anchorRef.current?.closest('[aria-modal="true"]');
  return createPortal(
    <div
      ref={resolvedPanel}
      id={id}
      role={role}
      aria-label={ariaLabel}
      className={
        `${hook ? `${hook} ` : ""}${POPOVER_SURFACE}` +
        (surfaceClassName ? ` ${surfaceClassName}` : "")
      }
      style={{ position: "fixed", top: pos?.top, left: pos?.left, zIndex: inModal ? 55 : 40 }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // Escape closes THIS surface only: React bubbles portalled events up the
        // component tree, so without this an enclosing Modal would close too.
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!e.defaultPrevented) onClose();
          anchorRef.current?.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
