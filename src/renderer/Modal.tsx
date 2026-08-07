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
//   onDismiss — overlay click; omit for a modal that must be answered
//
// Escape handling stays at the call sites (two of them already bind it;
// owning it here would double-handle). The five migrating dialogs are the
// adopter set that clears the two-adopter rule (Sidebar / NewSessionScreen /
// Settings ×2 / FolderPickerModal).

import { motion, AnimatePresence } from "framer-motion";
import type { MouseEvent, ReactNode } from "react";

const SIZES = {
  sm: "w-[420px]",
  md: "w-[480px]",
  lg: "w-[560px]",
} as const;

// The modal chrome's entrance/exit ease — the same cubic-bezier as the chat
// message entry animation (MESSAGE_IN_ENTER in chatMotion.ts) and the
// Artifacts-panel slide, so every in-app transition reads in one motion
// language. 0.18s for the panel scale+fade.
const MODAL_PANEL_TRANSITION = { type: "tween", duration: 0.18, ease: [0.22, 1, 0.36, 1] } as const;

// backdrop fade is a touch faster (0.15s) than the panel (0.18s).
const MODAL_BACKDROP_TRANSITION = { type: "tween", duration: 0.15 } as const;

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
  const panel = [
    "bg-bg-elev border border-border rounded-lg shadow-lg max-w-[92vw]",
    SIZES[size],
    padded ? "p-4" : "",
    tall ? "max-h-[80vh] flex flex-col overflow-hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={onDismiss}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_BACKDROP_TRANSITION}
        >
          <motion.div
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
    </AnimatePresence>
  );
}
