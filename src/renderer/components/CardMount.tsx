// ===== CardMount (BET-677) =====
//
// ONE shared mount/unmount animation for everything that appears and
// disappears in the composer stack (permission / retry / compaction /
// approval / schedules / secrets / webhooks / queued prompts / send-error)
// and, via a sibling issue, tool-card expansion.
//
// Layout-shift-free by construction: mounting a card animates its height
// 0 → auto (and opacity 0 → 1) instead of popping into the flow in one
// frame, so the transcript and composer never jump. Unmounting reverses it
// (height auto → 0) before the card is removed from the tree.
//
// `initial={false}` on <AnimatePresence> means the FIRST render of a card
// shows it instantly with no entrance animation — only later show/hide
// transitions animate, which is what "no reflow on load" wants. `key` is
// stable per slot so React identifies each mount target across toggles.
//
// Deliberately generic: it owns no card-specific styling — a sibling issue
// reuses it for tool-card expansion.

import { motion, AnimatePresence } from "framer-motion";
import type { ReactNode } from "react";

export type CardMountProps = {
  /** Whether the card is currently visible. */
  show: boolean;
  /** Stable identity for this mount slot (e.g. "permission"). */
  k: string;
  children: ReactNode;
};

export function CardMount({ show, k, children }: CardMountProps) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key={k}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
