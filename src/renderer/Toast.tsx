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
  /** Tonal variant. `"error"` renders a danger left-edge accent (BET-723 §D5);
   *  defaults to the plain info look. */
  tone?: "info" | "error";
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
      className={`w-full max-w-[420px] rounded-lg border border-border bg-bg-soft px-3 py-2 text-meta text-text-muted flex items-center gap-2 shadow-md ${
        toast.tone === "error" ? "border-l-2 border-l-danger" : ""
      }`}
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

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  // Newest on top, capped at MAX_TOASTS.
  const visible = toasts.slice(0, MAX_TOASTS);
  return (
    // Layout-neutral stack (BET-677): it does NOT position itself absolutely.
    // Surface-specific overlay framing — the fixed/absolute container, its
    // bottom anchor and z-order — belongs to the CALLER so the same component
    // serves both the chat column (where the overlay floats just above the
    // composer) and the Settings dialog (which supplies its own fixed
    // bottom-of-dialog wrapper). What this component owns is the framed list:
    // centred, capped at 420px, each toast animating in/out.
    //
    // The root is `pointer-events-none` even though the stack is always
    // rendered (it must stay mounted so the LAST toast's exit animation
    // plays). The empty container still carries its padding, so at the
    // Settings call site — where it sits inside a click-catching wrapper —
    // that padding would otherwise read as a permanent invisible strip that
    // swallows clicks on whatever scrolls under it. Each toast re-enables
    // pointer events, so both surfaces keep fully interactive toasts and the
    // dead backdrop never captures a click.
    <div className="pointer-events-none shrink-0 w-full flex flex-col items-center gap-2 px-4 pt-1 pb-2">
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-auto w-full max-w-[420px]"
          >
            <Toast toast={t} onDismiss={onDismiss} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
