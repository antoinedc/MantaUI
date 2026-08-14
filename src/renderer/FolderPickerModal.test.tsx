// @vitest-environment jsdom
//
// Regression test for BET-724 review cycle 1's Question: FolderPickerModal's
// path input used to dismiss a live inline path-completion suggestion on the
// FIRST Escape press and only close the dialog on a SECOND, suggestion-free
// press. Deleting the hand-rolled handler (so Modal's own Escape ownership
// takes over unconditionally) silently lost that two-stage behavior. This
// restores it via a local `stopPropagation` when a suggestion is live, and
// pins the restored behavior here.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { installMockApi, mount, type Harness } from "./testHarness";
import { FolderPickerModal } from "./FolderPickerModal";

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FolderPickerModal — Escape (BET-724 review cycle 1 Question)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("first Escape dismisses a live suggestion; second Escape closes the dialog", async () => {
    let cancelled = 0;
    installMockApi({
      fsListDirs: (dir: unknown) =>
        dir === "/home/dev/pro"
          ? Promise.resolve(["/home/dev/projects"])
          : Promise.resolve(["/home/dev"]),
      gitListWorktrees: () => Promise.reject(new Error("not a repo")),
    });
    h = mount(
      <FolderPickerModal
        open
        initialPath="/home/dev"
        onSelect={() => {}}
        onCancel={() => cancelled++}
      />,
    );
    await h.flush();

    const input = h.docQuery("input") as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      typeInto(input, "/home/dev/pro");
    });
    // The suggestion fetch is debounced 80ms; give it (and the state update
    // it triggers) room to land.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(h.docText()).toContain("jects/"); // the ghost-text tail of "/home/dev/projects/"

    // First Escape: dismisses the suggestion, dialog stays open.
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(0);
    expect(h.docText()).not.toContain("jects/");

    // Second Escape, no suggestion live: bubbles to Modal and closes.
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(1);
  });

  it("Escape with no suggestion closes on the first press (unchanged case)", async () => {
    let cancelled = 0;
    installMockApi({
      fsListDirs: () => Promise.resolve([]),
      gitListWorktrees: () => Promise.reject(new Error("not a repo")),
    });
    h = mount(
      <FolderPickerModal
        open
        initialPath="/home/dev"
        onSelect={() => {}}
        onCancel={() => cancelled++}
      />,
    );
    await h.flush();

    const input = h.docQuery("input") as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(1);
  });
});
