// PaletteShell.tsx — the shared palette chrome (⌘K session switcher, ⌘F
// conversation search). The palette-pattern counterpart to Modal.tsx: Modal
// owns centered DIALOG chrome; PaletteShell owns the top-anchored, animated
// input+list+footer palette. Like Modal, there is NO className escape hatch:
// consumers supply rows via the children render-prop and nothing else about
// the chrome can be sheared per-consumer.
//
// Owns ALL open/close/keyboard mechanics:
//   - enter/exit animation (manta-palette-* classes in index.css); exit is a
//     100ms `closing` phase before onClose unmounts us
//   - Esc / overlay click / ESC chip → requestClose
//   - ArrowUp/ArrowDown with wraparound; Enter → pick(sel)
//   - pick(i) = onPick(i) then requestClose. Rows receive the SAME pick via
//     the children render-prop, so mouse click and keyboard Enter share one
//     activation path. Consumers must NOT call onClose themselves.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";

const CLOSE_MS = 100; // matches the manta-palette-*-out animation duration

export function PaletteShell({
  label,
  placeholder,
  query,
  setQuery,
  itemCount,
  sel,
  setSel,
  onPick,
  onClose,
  footerExtra,
  children,
}: {
  label: string;
  placeholder: string;
  query: string;
  setQuery: (v: string) => void;
  itemCount: number;
  sel: number;
  setSel: (n: number) => void;
  onPick: (index: number) => void;
  onClose: () => void;
  footerExtra?: ReactNode;
  children: (pick: (index: number) => void) => ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, CLOSE_MS);
  };
  const pick = (i: number) => {
    onPick(i);
    requestClose();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Always closes, regardless of which inner element has focus.
      e.preventDefault();
      requestClose();
      return;
    }
    // Arrow/Enter navigation only makes sense while the search input itself
    // is focused. Bound here (not on the input) so Escape still works
    // regardless of focus (above), but leave native button activation (e.g.
    // Tabbing to the "ESC" chip and pressing Enter) alone otherwise — review
    // cycle 1 nit: intercepting Enter here for a focused button suppressed
    // its own click (requestClose) and ran pick(sel) instead.
    if (e.target !== inputRef.current) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (itemCount > 0) setSel((sel + 1) % itemCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (itemCount > 0) setSel((sel - 1 + itemCount) % itemCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (itemCount > 0) pick(sel);
    }
  };
  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-black/40 manta-palette-overlay ${closing ? "manta-palette-overlay-out" : ""}`}
      onClick={requestClose}
      // BET-724: bound on the overlay (not just the input below) so Escape
      // closes the palette regardless of which inner element has focus —
      // previously it only fired while the search input itself was focused.
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`manta-palette-panel w-[620px] max-w-[92vw] bg-bg-elev border border-border rounded-lg shadow-lg overflow-hidden ${closing ? "manta-palette-panel-out" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
          <Search size={16} className="text-text-faint shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent text-prose text-text outline-none placeholder:text-text-faint"
          />
          <button
            onClick={requestClose}
            title="Close (Esc)"
            className="font-mono text-micro text-text-faint hover:text-text border border-border-subtle rounded-sm px-1 py-px"
          >
            ESC
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-2 py-1">{children(pick)}</div>
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border-subtle bg-inset text-meta text-text-faint">
          <span>
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> select
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
          {footerExtra != null && <span className="ml-auto">{footerExtra}</span>}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="font-mono text-micro text-text-faint bg-raised border border-border-subtle rounded-xs px-1">
      {children}
    </kbd>
  );
}

// Keeps the selected row visible when arrow keys move the selection past the
// scroll fold. Rows are consumer-rendered, so consumers attach this ref to
// their row element. (The old ⌘K palette lacked this — arrowing below the
// fold left the selection off-screen.)
export function useSelectedIntoView<T extends HTMLElement>(selected: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    // Optional-call the method itself, not just the element: jsdom (the test
    // environment) doesn't implement `scrollIntoView` at all, and BET-726
    // widened this hook's adopters (MenuOption, the @-file typeahead) into
    // component tests that actually render a `selected` row on mount — the
    // first tests to exercise this path — so the gap needs to be inert here,
    // not papered over per call site.
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return ref;
}
