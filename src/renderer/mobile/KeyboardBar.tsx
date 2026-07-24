// Mobile keyboard accessory bar (BET-259).
//
// Slim key bar that docks on top of the on-screen keyboard on mobile chat
// windows. Soft keyboards don't ship arrow keys, Esc, @ or / — chat mode on
// a phone loses prompt-history nav, interrupt, and the typeahead prefixes
// without this affordance.
//
// The bar REUSES the existing input-handling logic instead of duplicating it:
//
//   esc / ↑ / ↓  →  dispatch a synthetic keydown to .mobile-body textarea;
//                   React's root delegation re-runs InputArea.tsx's existing
//                   onKeyDown (typeahead nav, history nav, queued-pop,
//                   esc-abort-while-running).
//   @ / /        →  insert the character through the normal execCommand
//                   "insertText" path so React's onChange/input event picks
//                   it up — opening the file/command typeahead naturally.
//   clear        →  confirm with the user, then dispatch the `manta-run-clear`
//                   CustomEvent. ChatPanel owns the /clear builtin path
//                   (optimistic-message cleanup + model-override carry-over)
//                   and the bridge hands control to it.
//
// Visibility: shown when the composer textarea is focused OR the session is
// running. When running + keyboard closed, the bar sits above the composer as
// the intended interrupt affordance replacing the header Esc.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { computeKeyboardInset } from "./keyboardInset";

type Props = {
  sessionId: string;
  projectName: string;
  windowIndex: number;
};

const composerTextarea = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(".mobile-body textarea");

function dispatchKey(ta: HTMLTextAreaElement, key: string) {
  ta.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function insertChar(ta: HTMLTextAreaElement, ch: string) {
  ta.focus();
  // execCommand is deprecated but universally supported in WebKit/Chromium
  // and fires the input event React's onChange listens to. The native setter
  // fallback covers engines that return false (or for the few that have
  // removed execCommand entirely).
  const ok = document.execCommand("insertText", false, ch);
  if (ok) return;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(ta, ta.value + ch);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

export function KeyboardBar({ sessionId, projectName, windowIndex }: Props) {
  const running = useStore(
    (s) => s.status[projectName]?.[windowIndex]?.running === true,
  );
  const [focused, setFocused] = useState(false);

  // Composer-focus tracking via window-level focusin/focusout. The pointerdown
  // preventDefault on every key below means tapping a bar key never fires
  // focusout on the textarea — the only way to lose focus is the OS-level
  // blur (tap outside, dismiss keyboard, etc.).
  useEffect(() => {
    const onFocusIn = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches?.(".mobile-body textarea")) setFocused(true);
    };
    const onFocusOut = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches?.(".mobile-body textarea")) setFocused(false);
    };
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Visual-viewport keyboard inset. iOS Safari overlay: inset > 0, translate
  // the bar up. Capacitor resize: inset ≈ 0, normal flow. The hook is a
  // no-op when visualViewport is undefined (older browsers).
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const recompute = () => {
      setInset(computeKeyboardInset(window.innerHeight, vv.height, vv.offsetTop));
    };
    recompute();
    vv.addEventListener("resize", recompute);
    vv.addEventListener("scroll", recompute);
    return () => {
      vv.removeEventListener("resize", recompute);
      vv.removeEventListener("scroll", recompute);
    };
  }, []);

  if (!focused && !running) return null;

  const onKeyPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Classic accessory-bar gotcha: tapping a key blurs the textarea and
    // dismisses the keyboard. preventDefault on pointerdown keeps the
    // textarea focused for the entire gesture.
    e.preventDefault();
  };

  const onEsc = () => {
    const ta = composerTextarea();
    if (!ta) return;
    dispatchKey(ta, "Escape");
  };
  const onArrowUp = () => {
    const ta = composerTextarea();
    if (!ta) return;
    dispatchKey(ta, "ArrowUp");
  };
  const onArrowDown = () => {
    const ta = composerTextarea();
    if (!ta) return;
    dispatchKey(ta, "ArrowDown");
  };
  const onAt = () => {
    const ta = composerTextarea();
    if (!ta) return;
    insertChar(ta, "@");
  };
  const onSlash = () => {
    const ta = composerTextarea();
    if (!ta) return;
    insertChar(ta, "/");
  };
  const onClear = () => {
    // The confirm lives here and only here — no confirm is added to any other
    // clear path (typing /clear, voice, etc.).
    const ok = window.confirm(
      "Clear session? The transcript is discarded and context resets.",
    );
    if (!ok) return;
    window.dispatchEvent(
      new CustomEvent("manta-run-clear", { detail: { sessionId } }),
    );
  };

  return (
    <div
      className="mobile-kbar"
      style={inset > 0 ? { transform: `translateY(-${inset}px)` } : undefined}
    >
      <button
        type="button"
        className={`mobile-kbar-key${
          running ? " mobile-kbar-key--danger" : ""
        } mobile-kbar-key--wide`}
        onPointerDown={onKeyPointerDown}
        onClick={onEsc}
        aria-label="Esc"
      >
        esc
      </button>
      <button
        type="button"
        className="mobile-kbar-key"
        onPointerDown={onKeyPointerDown}
        onClick={onArrowUp}
        aria-label="Previous prompt"
      >
        ↑
      </button>
      <button
        type="button"
        className="mobile-kbar-key"
        onPointerDown={onKeyPointerDown}
        onClick={onArrowDown}
        aria-label="Next prompt"
      >
        ↓
      </button>
      <span className="mobile-kbar-spacer" />
      <button
        type="button"
        className="mobile-kbar-key"
        onPointerDown={onKeyPointerDown}
        onClick={onAt}
        aria-label="Mention file or agent"
      >
        @
      </button>
      <button
        type="button"
        className="mobile-kbar-key"
        onPointerDown={onKeyPointerDown}
        onClick={onSlash}
        aria-label="Slash command"
      >
        /
      </button>
      <button
        type="button"
        className="mobile-kbar-key mobile-kbar-key--wide"
        onPointerDown={onKeyPointerDown}
        onClick={onClear}
        aria-label="Clear session"
      >
        clear
      </button>
    </div>
  );
}
