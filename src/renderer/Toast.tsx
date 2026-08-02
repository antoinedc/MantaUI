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

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;
  // Newest on top, capped at MAX_TOASTS.
  const visible = toasts.slice(0, MAX_TOASTS);
  return (
    // Bottom-centre stack. pb-2 + safe-area inset so it clears the composer on
    // mobile; the stack sits above the composer (rendered before it in flow).
    <div
      className="shrink-0 w-full flex flex-col items-center gap-2 px-4 pt-1 pb-2"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}
    >
      {visible.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
