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
//
// `secondRef` is an EXTRA node whose subtree also counts as "inside" — a
// click there does NOT close. Popover ports its panel to <body>, so a click
// on a button inside the panel is no longer inside the anchor's subtree; the
// second ref is that portalled panel. One place (Popover) is the only caller
// that uses the second node (BET-865 gives `useClickAway` exactly one
// importer).
export function useClickAway(
  rootRef: RefObject<Node | null>,
  active: boolean,
  onClose: () => void,
  secondRef?: RefObject<Node | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inRoot = rootRef.current?.contains(target);
      const inSecond = secondRef?.current?.contains(target);
      if (inRoot || inSecond) return;
      onClose();
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
