// useFocusTrap.ts — focus trap + initial focus + restore (BET-724 Task 1).
//
// Lifted out of Settings.tsx's `useDialog` (BET-419 §C), which already
// implemented this correctly for Settings' own top-level dialog chrome. The
// Modal primitive (`Modal.tsx`) previously had NO focus management at all —
// every Modal dialog could be Tabbed behind the overlay. Both now share this
// one implementation instead of Settings carrying a second copy.
//
// On activation (`active` flips/starts true): remembers the element that had
// focus, focuses the first focusable element inside the container (falling
// back to the container itself, made programmatically focusable via
// `tabIndex=-1`), and traps Tab/Shift+Tab within it. On deactivation (or
// unmount): restores focus to the element that had it before, if it's still
// attached to the document.
//
// Nested dialogs (e.g. a confirm Modal rendered inline inside Settings'
// full-screen dialog — NOT portaled) get their OWN trap on their OWN panel.
// To avoid the outer container's trap fighting the inner one over Tab, the
// handler bails out whenever the focused element's nearest `[role="dialog"]`
// ancestor isn't this hook's own container — the innermost open dialog owns
// Tab, matching how Escape ownership works in Modal.tsx.

import { useEffect, type RefObject } from "react";

// Elements that participate in the natural Tab cycle.
const FOCUSABLE_SELECTOR =
  'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
// Initial-focus target additionally allows a heading carrying `tabIndex={-1}`
// (the "focus the dialog title" a11y pattern Settings uses for its own <h2>)
// even though such a heading isn't part of the Tab cycle above.
const INITIAL_FOCUS_SELECTOR = `h2[tabindex], ${FOCUSABLE_SELECTOR}`;

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const opener = document.activeElement as HTMLElement | null;
    const firstFocusable = root.querySelector<HTMLElement>(INITIAL_FOCUS_SELECTOR);
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      root.tabIndex = -1;
      root.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const target = e.target as HTMLElement | null;
      // Defer to a nested dialog's own trap when focus is inside one that
      // isn't this container itself (see file header).
      const nestedDialog = target?.closest('[role="dialog"]');
      if (nestedDialog && nestedDialog !== root) return;

      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        opener.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
