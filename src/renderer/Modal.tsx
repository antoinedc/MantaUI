// Modal.tsx — the modal shell primitive (BET-588, M527 stage 2).
//
// Owns the ONE shared modal chrome with NO `className` escape hatch (epic
// standing decision 3): a caller cannot shear the overlay tint / panel
// surface / width / padding, so a dialog library can only drift if Modal
// itself is retuned. The four props express what every in-app dialog needs:
//
//   size      — fixed panel width: "sm" 420px | "md" 480px | "lg" 560px
//   padded    — true → p-4; false → the child owns its own insets
//   tall      — true → max-h-[80vh] + flex flex-col + clips (list dialogs)
//   onDismiss — overlay click AND Escape; omit for a modal that must be
//               answered (no dismiss path at all)
//
// BET-724: Modal now OWNS Escape + focus trap + restore — every dialog built
// on it inherits this for free, rather than each call site hand-rolling its
// own (inconsistent) Escape handler. Escape is handled overlay-scoped (a
// plain `onKeyDown` on the backdrop div): the focus trap below guarantees
// focus never leaves the panel while it's open, so a bubble-phase handler on
// the overlay is sufficient to catch it regardless of which inner element is
// focused. Focus trap + initial focus + restore are the shared
// `useFocusTrap` hook (lifted from Settings' `useDialog`, BET-419 §C).

import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { MOTION_BASE, MOTION_EASE, MOTION_FAST } from "./chatMotion";

const SIZES = {
  sm: "w-[420px]",
  md: "w-[480px]",
  lg: "w-[560px]",
} as const;

// The modal chrome's entrance/exit ease — the shared MOTION_EASE, so every
// in-app transition reads in one motion language. Panel uses MOTION_BASE.
const MODAL_PANEL_TRANSITION = { type: "tween", duration: MOTION_BASE, ease: MOTION_EASE } as const;

// backdrop fade is a touch faster — MOTION_FAST (the 20ms delta over the
// old 0.15s is imperceptible; the token wins).
const MODAL_BACKDROP_TRANSITION = { type: "tween", duration: MOTION_FAST } as const;

export function Modal({
  size = "md",
  padded = true,
  tall = false,
  onDismiss,
  label,
  // Controlled presence. Callers render <Modal open={cond}> and keep it
  // MOUNTED so AnimatePresence can play the exit; the chrome is removed only
  // after the close animation completes. Default true keeps the primitive
  // drop-in for callers that gate mounting themselves.
  open = true,
  children,
}: {
  size?: "sm" | "md" | "lg";
  padded?: boolean;
  tall?: boolean;
  onDismiss?: () => void;
  label: string;
  open?: boolean;
  children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, open);

  const panel = [
    "bg-bg-elev border border-border rounded-lg shadow-lg max-w-[92vw]",
    SIZES[size],
    padded ? "p-4" : "",
    tall ? "max-h-[80vh] flex flex-col overflow-hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const onOverlayKeyDown = onDismiss
    ? (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
        }
      }
    : undefined;
  // Portal the whole chrome to document.body (BET-885): Modal's overlay is
  // `position: fixed`, and a containment/stacks-transform declaration on any
  // ANCESTOR (contain, transform, filter, backdrop-filter, perspective,
  // container-type, will-change) silently turns that ancestor into the
  // containing block / stacking context for the fixed overlay — rendering the
  // dialog relative to an arbitrary DOM region (e.g. a 44px header strip)
  // with dead buttons. Portal to body makes every such ancestor irrelevant,
  // for every dialog, present and future.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={onDismiss}
          onKeyDown={onOverlayKeyDown}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_BACKDROP_TRANSITION}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={panel}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={MODAL_PANEL_TRANSITION}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
