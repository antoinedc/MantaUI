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
export type PopoverAlign = "start" | "end";

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
      const r = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const w = p.width || 0;
      const h = p.height || 0;
      const top = placement === "below" ? r.bottom + 4 : r.top - h - 4;
      const left = align === "end" ? r.right - w : r.left;
      setPos({
        top: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
        left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
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
  // and toasts (z-[60]) so a modal opened over a menu still covers it.
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
      style={{ position: "fixed", top: pos?.top, left: pos?.left, zIndex: 40 }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
