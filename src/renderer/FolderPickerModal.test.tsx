// @vitest-environment jsdom
//
// FolderPickerModal tests. Two concerns pinned here:
//  - BET-724 review cycle 1's Question: the path input used to dismiss a live
//    inline path-completion suggestion on the FIRST Escape press and only
//    close the dialog on a SECOND, suggestion-free press. Restored via a
//    local `stopPropagation` when a suggestion is live, pinned below.
//  - BET-1074: the hidden-folder toggle (Ctrl+H / footer button) and the
//    guarantee that the per-listing git probe runs once regardless of row
//    count (the per-row stampede regression guard).
//
// All tests share one mount/mock scaffold via `mountPicker`, so each test only
// declares what makes it different (the fsListDirs mock and/or onCancel).

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { installMockApi, mount, type Harness, type MockApi } from "./testHarness";
import { FolderPickerModal, LIST_DEBOUNCE_MS } from "./FolderPickerModal";

// The one harness alive right now; the shared afterEach unmounts it so no test
// leaks a mounted dialog into the next.
let mounted: Harness | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

// The picker debounces its directory listing; give the timer + the fetch
// it schedules room to land before asserting on rows or ghost text.
async function settle(h: Harness) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, LIST_DEBOUNCE_MS + 80));
  });
  await h.flush();
}

// Install a mock api, mount the picker at the default path, and flush its
// effects. `apiOverrides` are spread on top of the shared fetch/stub defaults,
// so a test supplies ONLY its fsListDirs listing (or a gitListWorktrees
// override) and nothing else.
async function mountPicker(
  apiOverrides: Record<string, unknown> = {},
  onCancel: () => void = () => {},
): Promise<{ h: Harness; api: MockApi }> {
  const { api } = installMockApi({
    fsListDirs: (dir: unknown) =>
      Promise.resolve({ dir: dir as string, entries: [] }),
    gitListWorktrees: () => Promise.reject(new Error("not a repo")),
    ...apiOverrides,
  });
  mounted = mount(
    <FolderPickerModal
      open
      initialPath="/home/dev"
      onSelect={() => {}}
      onCancel={onCancel}
    />,
  );
  await mounted.flush();
  await settle(mounted);
  return { h: mounted, api };
}

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
  it("first Escape dismisses a live suggestion; second Escape closes the dialog", async () => {
    let cancelled = 0;
    const { h } = await mountPicker(
      {
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
      },
      () => cancelled++,
    );

    const input = h.docQuery("input") as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      typeInto(input, "/home/dev/pro");
    });
    await settle(h);
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
    const { h } = await mountPicker({}, () => cancelled++);

    const input = h.docQuery("input") as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(1);
  });
});

describe("FolderPickerModal — hidden-folder toggle (BET-1074)", () => {
  it("hidden folder is absent initially, present after toggling on, absent after toggling off", async () => {
    const { h } = await mountPicker({
      fsListDirs: () =>
        Promise.resolve({
          dir: "/home",
          entries: [
            { name: "projects", path: "/home/projects", hidden: false },
            { name: ".config", path: "/home/.config", hidden: true },
          ],
        }),
    });

    // Hidden folder hidden by default.
    expect(h.docText()).not.toContain(".config");
    expect(h.docText()).toContain("projects");

    // Toggle on → hidden folder appears, button reads "Hide hidden".
    await act(async () => {
      clickButton("Show hidden");
      await h.flush();
    });
    expect(h.docText()).toContain(".config");
    expect(h.docText()).toContain("Hide hidden");

    // Toggle off → hidden folder gone again.
    await act(async () => {
      clickButton("Hide hidden");
      await h.flush();
    });
    expect(h.docText()).not.toContain(".config");
  });

  it("runs gitListWorktrees at most once per listing regardless of row count", async () => {
    const { api } = await mountPicker({
      fsListDirs: () =>
        Promise.resolve({
          dir: "/home",
          entries: Array.from({ length: 5 }, (_, i) => ({
            name: `dir${i}`,
            path: `/home/dir${i}`,
            hidden: false,
          })),
        }),
    });

    // Only the footer probe for the current directory runs — never one per
    // row. This is the regression guard for the old per-row git stampede.
    expect(api.calls.gitListWorktrees?.length ?? 0).toBe(1);
  });
});

describe("FolderPickerModal — per-keystroke re-list (BET-1117)", () => {
  it("typing inside one path segment does not re-list the directory", async () => {
    let listCalls = 0;
    const { h } = await mountPicker({
      fsListDirs: (dir: unknown) => {
        listCalls++;
        return Promise.resolve({ dir: dir as string, entries: [] });
      },
    });

    const baseline = listCalls;
    const input = h.docQuery("input") as HTMLInputElement;
    act(() => {
      typeInto(input, "/home/dev/p");
    });
    act(() => {
      typeInto(input, "/home/dev/pr");
    });
    act(() => {
      typeInto(input, "/home/dev/pro");
    });
    await settle(h);

    expect(listCalls).toBeLessThanOrEqual(baseline + 1);
  });
});
