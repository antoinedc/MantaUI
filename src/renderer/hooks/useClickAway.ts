import { useEffect, type RefObject } from "react";

// Dismiss an open popover/menu when the user clicks outside its root or
// presses Escape. Extracted from the identical inline pattern that was
// duplicated in SessionHeader (ContextPill + SessionMenu) and ModelPicker
// (model + variant dropdowns) — BET-415 duplication gate.
//
// `active` gates the listeners so they're only attached while the popover is
// open (avoids a global mousedown listener on every render). `onClose` is
// stable across renders in the callers (a setState updater), so it isn't in
// the dep array.
export function useClickAway(
  rootRef: RefObject<Node | null>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [rootRef, active, onClose]);
}
