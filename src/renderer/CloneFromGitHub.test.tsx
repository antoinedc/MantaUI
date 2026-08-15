// @vitest-environment jsdom
//
// Regression tests for the clone picker layout + selection semantics
// (BET-944).
//
// The two defects this pins:
//   1. `selected` was derived from `filtered`, so once a search term stopped
//      matching a checked repo, the repo silently vanished from the selection
//      and from the "Clone N selected" count — the clone could no longer be
//      started for it. Selection must derive from the full `repos` array.
//   2. The pick panel was a plain, unbounded div, so with enough repos the
//      row list pushed the search box and clone button out of view inside the
//      `overflow-hidden` panel. Now the panel is a bounded flex column whose
//      repo rows scroll (`overflow-y-auto`) while the search field and button
//      row stay pinned outside the scroller.
//
// These mount the real CloneFromGitHub, stubbing `window.api` with an
// existing credential (so the picker renders immediately) and a fixed repo
// list.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CloneFromGitHub } from "./CloneFromGitHub";
import { installMockApi, type MockApi } from "./testHarness";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Repo = {
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  pushedAt: number | null;
  defaultBranch: string;
  cloneUrl: string;
  url: string;
};

const REPOS: Repo[] = [
  { name: "alpha", fullName: "me/alpha", owner: "me", description: "Alpha", pushedAt: 1000, defaultBranch: "main", cloneUrl: "https://github.com/me/alpha.git", url: "https://github.com/me/alpha" },
  { name: "beta", fullName: "me/beta", owner: "me", description: "Beta", pushedAt: 800, defaultBranch: "main", cloneUrl: "https://github.com/me/beta.git", url: "https://github.com/me/beta" },
  { name: "gamma", fullName: "other/gamma", owner: "other", description: "Gamma", pushedAt: 500, defaultBranch: "main", cloneUrl: "https://github.com/other/gamma.git", url: "https://github.com/other/gamma" },
];

const CLONE_IN_PROGRESS = {
  id: "c1",
  name: "alpha",
  url: "https://github.com/me/alpha.git",
  dest: "/root/alpha",
  percent: 0,
  bytes: 0,
  done: false,
  ok: false,
  error: null,
  cancelled: false,
};

let container: HTMLElement | null = null;
let root: Root | null = null;
let api: MockApi;

function mountPicker(): void {
  ({ api } = installMockApi({
    // Existing credential — the picker renders immediately, skipping the
    // device-connect screen.
    forgeDeviceStart: () => Promise.resolve({ connected: true, grant: null }),
    forgeRepos: () => Promise.resolve({ repos: REPOS, stale: false, error: null }),
    forgeCloneStart: () => Promise.resolve({ id: "c1" }),
    forgeCloneStatus: () => Promise.resolve(CLONE_IN_PROGRESS),
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <CloneFromGitHub defaultRoot="/root" onCancel={() => {}} onCloned={() => {}} />,
    );
  });
}

async function flushMicro(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function unmount(): void {
  act(() => {
    root?.unmount();
  });
  root = null;
  if (container) {
    container.remove();
    container = null;
  }
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function searchInput(): HTMLInputElement {
  return container!.querySelector(
    'input[aria-label="Search repositories"]',
  ) as HTMLInputElement;
}

function cloneButtonFor(name: string): HTMLButtonElement {
  return Array.from(container!.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.includes(`Clone ${name}`),
  ) as HTMLButtonElement;
}

afterEach(() => {
  unmount();
});

describe("CloneFromGitHub picker", () => {
  it("keeps a checked repo selected when the search term excludes it, and clones it on submit", async () => {
    mountPicker();
    await flushMicro();

    const alphaBox = container!.querySelector(
      'input[aria-label="Clone alpha"]',
    ) as HTMLInputElement;
    expect(alphaBox).toBeTruthy();
    act(() => {
      alphaBox.click();
    });
    expect(cloneButtonFor("1 selected")).toBeTruthy();

    // Search for something that no longer matches alpha.
    typeInto(searchInput(), "gamma");
    await flushMicro();

    // alpha's row is filtered out of view…
    expect(container!.querySelector('input[aria-label="Clone alpha"]')).toBeNull();
    // …but the selection and the button survive, and are independent of the
    // filter (§1 regression).
    expect(cloneButtonFor("1 selected")).toBeTruthy();

    act(() => {
      cloneButtonFor("1 selected").click();
    });
    await flushMicro();

    const startCalls = api.calls.forgeCloneStart ?? [];
    expect(startCalls.length).toBe(1);
    // The clone runs for the still-selected (but filtered-out) repo.
    expect(startCalls[0][0]).toMatchObject({ url: REPOS[0].cloneUrl });
  });

  it("puts the repo rows in an overflow-y-auto container that excludes the button row", async () => {
    mountPicker();
    await flushMicro();

    const scroller = container!.querySelector<HTMLElement>(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    // The repo rows live inside the scroller…
    const alphaBox = container!.querySelector(
      'input[aria-label="Clone alpha"]',
    ) as HTMLElement;
    expect(scroller!.contains(alphaBox)).toBe(true);
    // …but the button row and the search field do not (§2 — DOM containment,
    // not class-string matching on the whole tree).
    expect(scroller!.contains(cloneButtonFor("0 selected"))).toBe(false);
    expect(scroller!.contains(searchInput())).toBe(false);
  });
});
