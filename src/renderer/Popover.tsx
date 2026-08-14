// BET-865 — the ONE anchored-surface primitive.
//
// Every menu and popover in the renderer ports to `document.body` and is
// positioned `fixed` from its trigger's rect through this single component.
// This is the fix for "the session-header popover renders behind the
// transcript": an `absolute` box nested in the header's DOM subtree is fragile
// in three independent ways that are all live today —
//   1. any ancestor with `overflow` clips it (the StatusOverflow dropdown is
//      rendered inside an `overflow-hidden` menu body today, reproducing when
//      the pane is narrow enough to overflow),
//   2. any ancestor that becomes a stacking context traps its `z-30` below a
//      later sibling (the reported symptom),
//   3. the header is an Electron drag region, which composites differently.
// Portalling to `<body>` and positioning `fixed` from the trigger's rect means
// no ancestor can clip it, no ancestor stacking context can trap it, and the
// drag region is irrelevant.
//
// It does NOT own the trigger — every call site keeps its own trigger button
// chrome (pill, icon button, chip). It owns portalling, positioning, dismissal
// and the surface chrome constant.
//
// z-index rationale (§ the mandated single value): `z-40` sits above the pane's
// in-pane anchored surfaces (`z-30`), below modals/palettes/toasts (`z-50`,
// `z-[60]`). A modal opened over a menu would otherwise be covered by it, which
// is exactly wrong.

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

// The ONE anchored-surface chrome. Every menu and popover uses this string;
// there is no second definition. shadow-lg (Dropdown's value) is the single
// shadow — the old shadow-md popovers adopt it.
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
  /** The trigger element. Positioning and click-away both key on it. */
  anchorRef: RefObject<HTMLElement>;
  placement?: PopoverPlacement;
  align?: PopoverAlign;
  role?: "dialog" | "menu" | "listbox";
  ariaLabel?: string;
  id?: string;
  /** Stable `manta-*` identity class (visual-gate contract). Identity only, no styling. */
  hook?: string;
  /** Width + padding utilities ONLY (e.g. "w-[360px] p-4"). Never chrome. */
  surfaceClassName?: string;
  /** Optional external ref to the portalled surface (for callers — e.g. the
   *  session ⋯ menu — that query the surface's own DOM for keyboard roving). */
  panelRef?: RefObject<HTMLDivElement>;
  /** Keyboard navigation for content INSIDE the surface (e.g. the session ⋯
   *  menu's roving). Attached to the portalled panel because the panel is no
   *  longer in the trigger's subtree, so a handler on the trigger wrapper would
   *  never see key events from within the surface. */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const resolvedPanel = panelRef ?? surfaceRef;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position `fixed` from the anchor's rect, recompute on resize/scroll while
  // open. Runs in a layout effect so the first paint is already positioned.
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
      const panelW = p.width || 0;
      const panelH = p.height || 0;
      // 4px is the gap the old `mt-1`/`mb-1` added.
      let top = placement === "below" ? r.bottom + 4 : r.top - panelH - 4;
      let left = align === "end" ? r.right - panelW : r.left;
      // Clamp into the viewport.
      left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - panelH - 8));
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    // capture so scroll events inside the page (not just the window) recompute.
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, anchorRef, resolvedPanel, placement, align]);

  // Click-away on the anchor OR the panel. Because the panel is portalled to
  // <body>, a click on a button INSIDE the popover is no longer inside the
  // anchor's subtree — ignoring the panel here would close the popover on its
  // own buttons before the click landed.
  useClickAway(anchorRef, open, onClose, resolvedPanel);

  // Escape closes and hands focus back to the trigger (the one place this
  // existed across PopoverChip + SessionMenu + ContextPill before).
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

  // The surface exists only while open (the repo contract) — render nothing
  // when closed rather than hiding with aria-hidden.
  if (!open) return null;

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
      style={{
        position: "fixed",
        top: pos?.top,
        left: pos?.left,
        zIndex: 40,
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
