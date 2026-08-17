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

// Click the (footer) button whose trimmed label matches, wrapping in act.
function clickButton(label: string) {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(btn, `expected a button labelled "${label}"`).toBeTruthy();
  act(() => btn!.click());
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
      fsListDirs: (dir: unknown) => {
        const d = dir as string;
        if (d === "/home/dev") {
          return Promise.resolve({
            dir: d,
            entries: [{ name: "projects", path: "/home/dev/projects", hidden: false }],
          });
        }
        return Promise.resolve({
          dir: d,
          entries: [{ name: "dev", path: "/home/dev", hidden: false }],
        });
      },
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
      fsListDirs: (dir: unknown) =>
        Promise.resolve({ dir: dir as string, entries: [] }),
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

describe("FolderPickerModal — hidden-folder toggle (BET-1074)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function listingWithHidden() {
    return installMockApi({
      fsListDirs: (dir: unknown) =>
        Promise.resolve({
          dir: dir as string,
          entries: [
            { name: "projects", path: "/home/projects", hidden: false },
            { name: ".config", path: "/home/.config", hidden: true },
          ],
        }),
      gitListWorktrees: () => Promise.reject(new Error("not a repo")),
    });
  }

  it("hidden folder is absent initially, present after toggling on, absent after toggling off", async () => {
    listingWithHidden();
    h = mount(
      <FolderPickerModal
        open
        initialPath="/home/dev"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    await h.flush();

    // Hidden folder hidden by default.
    expect(h.docText()).not.toContain(".config");
    expect(h.docText()).toContain("projects");

    // Toggle on → hidden folder appears, button reads "Hide hidden".
    await act(async () => {
      clickButton("Show hidden");
      await h!.flush();
    });
    expect(h.docText()).toContain(".config");
    expect(h.docText()).toContain("Hide hidden");

    // Toggle off → hidden folder gone again.
    await act(async () => {
      clickButton("Hide hidden");
      await h!.flush();
    });
    expect(h.docText()).not.toContain(".config");
  });

  it("runs gitListWorktrees at most once per listing regardless of row count", async () => {
    const { api } = installMockApi({
      fsListDirs: (dir: unknown) =>
        Promise.resolve({
          dir: dir as string,
          entries: Array.from({ length: 5 }, (_, i) => ({
            name: `dir${i}`,
            path: `/home/dir${i}`,
            hidden: false,
          })),
        }),
      gitListWorktrees: () => Promise.reject(new Error("not a repo")),
    });
    h = mount(
      <FolderPickerModal
        open
        initialPath="/home/dev"
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    );
    await h.flush();

    // Only the footer probe for the current directory runs — never one per
    // row. This is the regression guard for the old per-row git stampede.
    expect(api.calls.gitListWorktrees?.length ?? 0).toBe(1);
  });
});
