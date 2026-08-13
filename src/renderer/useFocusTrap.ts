// useFocusTrap.ts — focus trap + initial focus + restore (BET-724 Task 1).
//
// Lifted out of Settings.tsx's `useDialog` (BET-419 §C), which already
// implemented this correctly for Settings' own top-level dialog chrome. The
// Modal primitive (`Modal.tsx`) previously had NO focus management at all —
// every Modal dialog could be Tabbed behind the overlay. Both now share this
// one implementation instead of Settings carrying a second copy.
//
// On activation (`active` flips/starts true): remembers the element that had
// focus, focuses the first focusable element inside the container UNLESS
// something inside it is already focused (e.g. a child with `autoFocus` —
// see the BET-724 review-cycle-1 Block note below), falling back to the
// container itself (made programmatically focusable via `tabIndex=-1`) when
// there's nothing focusable at all, and traps Tab/Shift+Tab within it. On
// deactivation (or unmount): restores focus to the element that had it
// before, if it's still attached to the document.
//
// BET-724 review cycle 1 Block: the original version read
// `document.activeElement` and force-focused the first focusable element
// from inside a passive `useEffect`. React applies `autoFocus` during the
// commit phase, which always runs BEFORE passive effects (and even before
// `useLayoutEffect`, for host-component autoFocus specifically) — so for any
// panel that autofocuses a field (e.g. FolderPickerModal's path input), the
// trap ran second, stole focus onto whatever the panel's first focusable
// element happened to be (its Close button), AND captured that same,
// already-wrong element as the "opener", making focus-restore silently
// no-op on close. Fixed by:
//   1. Capturing the opener SYNCHRONOUSLY DURING RENDER (not in an effect) —
//      render always runs before commit/autoFocus, so `document.activeElement`
//      read there is still the real pre-open opener. This is the same
//      "adjusting state during render" pattern React's docs use for
//      previous-value tracking (a ref compared/updated in the render body,
//      guarded so it only fires on the false→true transition).
//   2. Skipping the forced initial-focus entirely when something inside the
//      container is ALREADY focused when the effect runs — an `autoFocus`ed
//      child already satisfies "focus starts inside the panel"; forcing a
//      different element here would be the regression, not a fix.
//
// Nested dialogs (e.g. a confirm Modal rendered inline inside Settings'
// full-screen dialog — NOT portaled) get their OWN trap on their OWN panel.
// To avoid the outer container's trap fighting the inner one over Tab, the
// handler bails out whenever the focused element's nearest `[role="dialog"]`
// ancestor isn't this hook's own container — the innermost open dialog owns
// Tab, matching how Escape ownership works in Modal.tsx.

import { useEffect, useRef, type RefObject } from "react";

// Elements that participate in the natural Tab cycle. Excludes disabled/
// hidden controls — focusing one is a silent no-op that would leave focus on
// `<body>` and defeat the trap (BET-724 review cycle 1 nit).
const FOCUSABLE_SELECTOR =
  'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), ' +
  'select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), ' +
  'a[href]:not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])';
// Initial-focus target additionally allows a heading carrying `tabIndex={-1}`
// (the "focus the dialog title" a11y pattern Settings uses for its own <h2>)
// even though such a heading isn't part of the Tab cycle above.
const INITIAL_FOCUS_SELECTOR = `h2[tabindex], ${FOCUSABLE_SELECTOR}`;

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasActiveRef = useRef(false);
  // Capture the pre-open opener DURING RENDER, on the false→true transition
  // only — see the file header for why an effect is too late.
  if (active && !wasActiveRef.current) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }
  wasActiveRef.current = active;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    // Leave focus alone if something inside the panel already has it (e.g.
    // an `autoFocus`ed field) — that already satisfies "focus starts inside
    // the panel". Only force it when nothing inside claimed it.
    if (!root.contains(document.activeElement)) {
      const firstFocusable = root.querySelector<HTMLElement>(INITIAL_FOCUS_SELECTOR);
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        root.tabIndex = -1;
        root.focus();
      }
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
      const opener = openerRef.current;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        opener.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
