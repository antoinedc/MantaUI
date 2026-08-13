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
//     (Undo / Save / Reveal / Remind me / Keep going). A toast may opt out of
//     auto-dismiss entirely with ttl: null (e.g. user-invoked reference
//     content like /help).
//   - Zero to TWO action slots (BET-739: the usage limit toast needs two) + a
//     close button. More than two render the first two.
//   - Mobile: same component, respecting the safe-area inset.
//
// `toastTtl` is extracted as a pure function so the auto-dismiss decision is
// unit-tested without mounting the component.

import { useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { MOTION_BASE, MOTION_EASE } from "./chatMotion";

export type ToastAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

/** A toast may carry up to this many action buttons (BET-739). */
export const MAX_TOAST_ACTIONS = 2;

export type ToastItem = {
  id: string;
  message: ReactNode;
  /** Tonal variant. `"error"` renders a danger left-edge accent (BET-723 §D5);
   *  defaults to the plain info look. */
  tone?: "info" | "error";
  /** Optional action buttons (Undo / Save / Reveal / Remind me / Keep going).
   *  Presence of any disables auto-dismiss. Capped at MAX_TOAST_ACTIONS. */
  actions?: ToastAction[];
  /** Auto-dismiss timeout in ms. Defaults to 6000 when there is no action;
   *  `null` opts out entirely (reference content). Ignored when an action is
   *  present (never auto-dismisses). */
  ttl?: number | null;
};

/** Default auto-dismiss for a toast that carries no action. */
export const TOAST_DEFAULT_TTL_MS = 6000;

/**
 * Pure: decide whether a toast auto-dismisses, and after how long.
 *  - any action present  → never (null)
 *  - ttl === null        → never (null)
 *  - ttl === number      → that many ms
 *  - otherwise           → TOAST_DEFAULT_TTL_MS
 */
export function toastTtl(toast: ToastItem): number | null {
  if (toast.actions?.length) return null;
  if (toast.ttl === null) return null;
  if (typeof toast.ttl === "number") return toast.ttl;
  return TOAST_DEFAULT_TTL_MS;
}

export type ToastProps = {
  toast: ToastItem;
  onDismiss: (id: string) => void;
};

// Shared compact banner action pill (Toast / UpdateBar / ReconnectingBanner).
// Intentionally SMALLER than the 32px Button primitive — the three banner bars
// render a slim text pill inside an ~24px-high strip, so they stay hand-rolled
// (BET-727 §7). One source of truth for the three copies that used to drift
// (ReconnectingBanner was missing the focus ring). Carries the standard
// focus-visible ring.
export const BANNER_BTN =
  "shrink-0 rounded-xs bg-accent/20 px-2 py-px text-accent hover:bg-accent/30 font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

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
      className={`w-full max-w-[420px] rounded-lg border border-border bg-bg-soft px-3 py-2 text-meta text-text-muted flex items-start gap-2 shadow-md ${
        toast.tone === "error" ? "border-l-2 border-l-danger" : ""
      }`}
    >
      {/* Message and actions stack VERTICALLY, always — one layout, no
          conditional branch on how many actions there are. The old single-row
          layout put `shrink-0` buttons next to a `flex-1 min-w-0` message, so
          two actions squeezed the text to a few characters per line. The close
          button stays on the right of the whole block, which is why the root is
          now `items-start` (it aligns with the message's FIRST line rather than
          the vertical middle of a two-row block). */}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <span className="whitespace-pre-wrap break-words">{toast.message}</span>
        {(toast.actions ?? []).length > 0 && (
          <div className="flex items-center gap-2">
            {(toast.actions ?? []).slice(0, MAX_TOAST_ACTIONS).map((action) => (
              <button
                key={action.label}
                onClick={action.onClick}
                disabled={action.disabled}
                className={BANNER_BTN}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-text-faint hover:text-text leading-none inline-flex items-center focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
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
            transition={{ duration: MOTION_BASE, ease: MOTION_EASE }}
            className="pointer-events-auto w-full max-w-[420px]"
          >
            <Toast toast={t} onDismiss={onDismiss} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
