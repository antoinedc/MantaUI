// @vitest-environment jsdom
//
// Component test for PaletteShell's Escape handling (BET-724). Before this
// change, the Escape/ArrowUp/ArrowDown/Enter `onKeyDown` handler lived on the
// search `<input>` only, so Escape closed the palette exclusively while that
// input was focused. It's now bound on the overlay so it fires regardless of
// which inner element has focus, matching Modal's Escape ownership (BET-724
// Task 1) for the sibling full-window overlay primitive.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { PaletteShell } from "./PaletteShell";

describe("PaletteShell — Escape (BET-724)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function render(onClose: () => void) {
    h = mount(
      <PaletteShell
        label="Test palette"
        placeholder="Search…"
        query=""
        setQuery={() => {}}
        itemCount={1}
        sel={0}
        setSel={() => {}}
        onPick={() => {}}
        onClose={onClose}
      >
        {() => <button>row</button>}
      </PaletteShell>,
    );
  }

  it("Escape closes while the search input is focused (existing behavior)", async () => {
    let closed = 0;
    render(() => closed++);
    const input = h!.container.querySelector("input")!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // requestClose defers the actual onClose call by CLOSE_MS (100ms) so the
    // exit animation can play.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(closed).toBe(1);
  });

  it("Escape closes even when focus is on a row, not the input (the bug this fixes)", async () => {
    let closed = 0;
    render(() => closed++);
    const row = h!.container.querySelector("button")!;
    row.focus();
    expect(document.activeElement).toBe(row);
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(closed).toBe(1);
  });

  // BET-724 review cycle 1 nit: moving the handler to the overlay meant Enter
  // was intercepted for ANY focused element, including the "ESC" chip button
  // — `e.preventDefault()` there suppressed the chip's own click (which calls
  // requestClose), so Tabbing to it and pressing Enter silently ran pick(sel)
  // instead. Enter/Arrow navigation is now scoped to the search input only.
  it("Enter on the ESC chip does not pick a row (only the input's Enter does)", () => {
    let picked: number | null = null;
    h = mount(
      <PaletteShell
        label="Test palette"
        placeholder="Search…"
        query=""
        setQuery={() => {}}
        itemCount={1}
        sel={0}
        setSel={() => {}}
        onPick={(i) => {
          picked = i;
        }}
        onClose={() => {}}
      >
        {() => <button>row</button>}
      </PaletteShell>,
    );
    const escChip = h.container.querySelector('button[title="Close (Esc)"]') as HTMLButtonElement;
    expect(escChip).toBeTruthy();
    escChip.focus();
    act(() => {
      escChip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(picked).toBeNull();

    const input = h.container.querySelector("input")!;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(picked).toBe(0);
  });
});
