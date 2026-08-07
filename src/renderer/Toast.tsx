// ===== Toast primitive (BET-416 §D) =====
//
// ONE toast component replaces the four previous in-app implementations
// (screenshot-detected, agent-sent-file, systemNotice, and the settings Undo
// that sub-issue 13 adds). The desktop OS Notification bridge
// (`new Notification(...)` in App.tsx) is a SEPARATE delivery channel — it
// fires when the user is NOT looking at the app, which an in-app toast cannot
// do — so it stays; see the BET-416 follow-up note in the PR.
//
// Rules (from the spec):
//   - Bottom-centre, max THREE stacked, newest on top.
//   - --card background, --border, --shadow-md, 12px radius.
//   - 6s default auto-dismiss; NEVER auto-dismiss when it carries an action
//     (Undo / Save / Reveal). A toast may opt out of auto-dismiss entirely
//     with ttl: null (e.g. user-invoked reference content like /help).
//   - One optional action slot + a close button.
//   - Mobile: same component, respecting the safe-area inset.
//
// `toastTtl` is extracted as a pure function so the auto-dismiss decision is
// unit-tested without mounting the component.

import { useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

export type ToastAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type ToastItem = {
  id: string;
  message: ReactNode;
  /** Optional single action (Undo / Save / Reveal). Presence disables
   *  auto-dismiss. */
  action?: ToastAction;
  /** Auto-dismiss timeout in ms. Defaults to 6000 when there is no action;
   *  `null` opts out entirely (reference content). Ignored when an action is
   *  present (never auto-dismisses). */
  ttl?: number | null;
};

/** Default auto-dismiss for a toast that carries no action. */
export const TOAST_DEFAULT_TTL_MS = 6000;

/**
 * Pure: decide whether a toast auto-dismisses, and after how long.
 *  - action present  → never (null)
 *  - ttl === null    → never (null)
 *  - ttl === number  → that many ms
 *  - otherwise       → TOAST_DEFAULT_TTL_MS
 */
export function toastTtl(toast: ToastItem): number | null {
  if (toast.action) return null;
  if (toast.ttl === null) return null;
  if (typeof toast.ttl === "number") return toast.ttl;
  return TOAST_DEFAULT_TTL_MS;
}

export type ToastProps = {
  toast: ToastItem;
  onDismiss: (id: string) => void;
};

export function Toast({ toast, onDismiss }: ToastProps) {
  const ttl = toastTtl(toast);
  useEffect(() => {
    if (ttl == null) return;
    const id = setTimeout(() => onDismiss(toast.id), ttl);
    return () => clearTimeout(id);
  }, [ttl, toast.id, onDismiss]);

  return (
    <div
      role="status"
      className="w-full max-w-[420px] rounded-lg border border-border bg-bg-soft px-3 py-2 text-meta text-text-muted flex items-center gap-2 shadow-md"
    >
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">{toast.message}</span>
      {toast.action && (
        <button
          onClick={toast.action.onClick}
          disabled={toast.action.disabled}
          className="shrink-0 rounded-xs bg-accent/20 px-2 py-px text-accent hover:bg-accent/30 font-medium disabled:opacity-50"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-text-faint hover:text-text leading-none inline-flex items-center"
        title="Dismiss"
        aria-label="Dismiss"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export type ToastStackProps = {
  /** Ordered newest-first; only the first `MAX_TOASTS` are rendered. */
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
};

/** Max simultaneous toasts (spec: three stacked). */
export const MAX_TOASTS = 3;

// How far above the bottom of the chat column the toast stack floats. This is
// the composer cluster's approximate height, so a toast hovers JUST ABOVE the
// composer (input box + model/effort row) instead of covering it. The stack is
// absolutely positioned, so this is a pure overlay — it never shifts the
// layout of the transcript or composer (BET-677).
const TOAST_BOTTOM = 112;

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  // Newest on top, capped at MAX_TOASTS.
  const visible = toasts.slice(0, MAX_TOASTS);
  return (
    // Overlay (BET-677): no longer an in-flow row that pushes the composer
    // down. Anchored just above the composer, horizontally centred, above the
    // transcript's z-order. The container is pointer-events-none so it never
    // blocks clicks on what it floats over; only each toast re-enables
    // pointer events. The safe-area inset keeps it clear of the bottom edge on
    // devices with a home indicator.
    <div
      className="pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-2 px-4"
      style={{
        bottom: TOAST_BOTTOM,
        paddingBottom: "max(env(safe-area-inset-bottom, 0px), 0px)",
      }}
    >
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-auto flex w-full justify-center"
          >
            <Toast toast={t} onDismiss={onDismiss} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
