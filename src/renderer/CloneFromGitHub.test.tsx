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

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CloneFromGitHub } from "./CloneFromGitHub";
import { installMockApi, mount, clickCheckbox, type Harness, type MockApi } from "./testHarness";
import type { ForgeCloneStatus } from "../shared/types";

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
// The shared harness handle, used to drive checkboxes the way a user does
// (clickCheckbox) rather than poking the sr-only input.
let h: Harness | null = null;

type MountOverrides = {
  forgeCloneStart?: () => Promise<{ id?: string; error?: string; message?: string }>;
  forgeCloneStatus?: () => Promise<ForgeCloneStatus | null>;
  onCloned?: (paths: string[]) => void;
};

function mountPicker(overrides: MountOverrides = {}): void {
  ({ api } = installMockApi({
    // Existing credential — the picker renders immediately, skipping the
    // device-connect screen.
    forgeDeviceStart: () => Promise.resolve({ connected: true, grant: null }),
    forgeRepos: () => Promise.resolve({ repos: REPOS, stale: false, error: null }),
    forgeCloneStart: overrides.forgeCloneStart ?? (() => Promise.resolve({ id: "c1" })),
    forgeCloneStatus:
      overrides.forgeCloneStatus ?? (() => Promise.resolve(CLONE_IN_PROGRESS)),
  }));
  h = mount(
    <CloneFromGitHub
      defaultRoot="/root"
      onCancel={() => {}}
      onCloned={overrides.onCloned ?? (() => {})}
    />,
  );
  container = h.container;
}

async function flushMicro(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

// Microtask-only flush for use under vi.useFakeTimers(), where a real
// setTimeout(r, 0) would never fire. Mirrors ConnectGithub.test.tsx.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function unmount(): void {
  act(() => {
    root?.unmount();
  });
  root = null;
  h = null;
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
  vi.useRealTimers();
});

describe("CloneFromGitHub picker", () => {
  it("keeps a checked repo selected when the search term excludes it, and clones it on submit", async () => {
    mountPicker();
    await flushMicro();

    clickCheckbox(h!, "Clone alpha");
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

  it("hands off to onCloned when the last (single) repo completes without a render throw", async () => {
    // Regression for BET-945: driving the final repo to `done:true, ok:true`
    // used to advance the clone index past the end of the queue, so the very
    // next render called destFor(queue[index]) on `undefined` and threw
    // before the effect's completion guard could call onCloned — blanking
    // the panel instead of handing off.
    const clonedPaths: string[] = [];
    mountPicker({
      onCloned: (paths) => clonedPaths.push(...paths),
      // Complete the clone on the first status poll.
      forgeCloneStatus: () =>
        Promise.resolve({ ...CLONE_IN_PROGRESS, done: true, ok: true, percent: 100 }),
    });
    await flushMicro();

    clickCheckbox(h!, "Clone alpha");
    act(() => {
      cloneButtonFor("1 selected").click();
    });

    // Drive the poll loop to completion. If the crash regressed, the render
    // throws here and the act() wrapper rethrows it — the test fails red.
    await flushMicro();
    await flushMicro();

    expect(clonedPaths).toEqual(["/root/alpha"]);
  });

  it("shows the server's preflight destination message (names the folder), not a generic start failure (BET-1073)", async () => {
    // The server preflights the destination before starting a clone and, when
    // it rejects, returns `{ error, message }` with no id. The picker must
    // surface that specific message verbatim rather than the generic
    // "Couldn't start the clone."
    mountPicker({
      forgeCloneStart: () =>
        Promise.resolve({
          error: "dest_not_empty",
          message: "/root/alpha already exists and isn't empty.",
        }),
    });
    await flushMicro();

    clickCheckbox(h!, "Clone alpha");
    act(() => {
      cloneButtonFor("1 selected").click();
    });
    await flushMicro();

    const body = container!.textContent ?? "";
    expect(body).toContain("/root/alpha already exists and isn't empty.");
    expect(body).not.toContain("Couldn't start the clone.");
  });

  it("falls back to the generic start failure when the server returns no message (BET-1073)", async () => {
    mountPicker({
      forgeCloneStart: () => Promise.resolve({ error: "bad_request" }),
    });
    await flushMicro();

    clickCheckbox(h!, "Clone alpha");
    act(() => {
      cloneButtonFor("1 selected").click();
    });
    await flushMicro();

    const body = container!.textContent ?? "";
    expect(body).toContain("Couldn't start the clone.");
  });

  it("fetches repos exactly once, after sign-in completes, and never shows not_connected (BET-1011)", async () => {
    // The broken sequence: fetch fired on mount (before a credential
    // existed), cached { repos: [], error: "not_connected" } as a permanent
    // error, and no later sign-in could clear it. With the fix the fetch is
    // keyed on `connected`, so it runs only once the device flow completes.
    vi.useFakeTimers();
    let repoCallCount = 0;
    // Mirrors the box: without a credential it answers `not_connected`; with
    // one it returns the real list. Only flipped once the device flow turns
    // `connected` on — so if the fetch ever ran pre-connect it would hit the
    // error branch (reproducing the old stuck state).
    let connected = false;
    installMockApi({
      forgeDeviceStart: () =>
        Promise.resolve({
          connected: false,
          grant: {
            grantId: "g1",
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
            expiresIn: 900,
            pollInterval: 5,
          },
          error: null,
        }),
      forgeDevicePoll: () => Promise.resolve({ status: "done" }),
      forgeRepos: () => {
        repoCallCount++;
        return Promise.resolve(
          connected
            ? { repos: REPOS, stale: false, error: null }
            : { repos: [], stale: false, error: "not_connected" },
        );
      },
      forgeCloneStart: () => Promise.resolve({ id: "c1" }),
      forgeCloneStatus: () => Promise.resolve(CLONE_IN_PROGRESS),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <CloneFromGitHub defaultRoot="/root" onCancel={() => {}} onCloned={() => {}} />,
      );
    });

    // Let forgeDeviceStart settle so the code panel mounts and schedules the
    // first poll at max(pollInterval, 5) seconds.
    await flushMicrotasks();
    // Complete the device flow — advance past the first poll, which resolves
    // "done" → onConnected → connected=true → the picker (and the fetch).
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Mirror the component's new `connected` state before the flushed effects
    // run, so the post-sign-in fetch returns the real list, not an error.
    connected = true;
    await flushMicrotasks();
    await flushMicrotasks();

    expect(repoCallCount).toBe(1);
    const text = container!.textContent ?? "";
    expect(text).not.toContain("not_connected");
    expect(container!.querySelector('input[aria-label="Clone alpha"]')).toBeTruthy();
  });

  it("shows the loader + 'Loading repositories…' while the repo list is in flight, then the rows (BET-1011)", async () => {
    let resolveRepos: (r: unknown) => void;
    const reposPromise = new Promise((resolve) => {
      resolveRepos = resolve;
    });
    installMockApi({
      forgeDeviceStart: () => Promise.resolve({ connected: true, grant: null }),
      forgeRepos: () => reposPromise,
      forgeCloneStart: () => Promise.resolve({ id: "c1" }),
      forgeCloneStatus: () => Promise.resolve(CLONE_IN_PROGRESS),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <CloneFromGitHub defaultRoot="/root" onCancel={() => {}} onCloned={() => {}} />,
      );
    });
    // The fetch is pending — the picker must show the loading state, not
    // "Search 0 repositories…" / "No repositories match.".
    await flushMicro();
    expect(container!.querySelector(".manta-loader")).toBeTruthy();
    expect(container!.textContent).toContain("Loading repositories…");

    // Resolve the fetch; the loader goes away and the real rows render.
    act(() => {
      resolveRepos!({ repos: REPOS, stale: false, error: null });
    });
    await flushMicro();
    expect(container!.querySelector(".manta-loader")).toBeNull();
    expect(container!.querySelector('input[aria-label="Clone alpha"]')).toBeTruthy();
  });

  it("routes a rejected repo listing back to the connect panel, not an error message (BET-1059)", async () => {
    // First forgeDeviceStart call: an existing credential, so the picker (and
    // the repo fetch) run. When the box reports `rejected` and the component
    // drops to `connected: false`, the second call keeps it OFF the picker and
    // ON the connect screen so the user can sign in again — this is what makes
    // the box's behaviour after clearing a dead credential testable instead of
    // an infinite re-connect loop.
    let deviceStartCalls = 0;
    installMockApi({
      forgeDeviceStart: () => {
        deviceStartCalls++;
        return Promise.resolve(
          deviceStartCalls === 1
            ? { connected: true, grant: null }
            : {
                connected: false,
                grant: {
                  grantId: "g1",
                  userCode: "ABCD-1234",
                  verificationUri: "https://github.com/login/device",
                  expiresIn: 900,
                  pollInterval: 5,
                },
                error: null,
              },
        );
      },
      forgeRepos: () => Promise.resolve({ repos: [], stale: false, error: "rejected" }),
      forgeCloneStart: () => Promise.resolve({ id: "c1" }),
      forgeCloneStatus: () => Promise.resolve(CLONE_IN_PROGRESS),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <CloneFromGitHub defaultRoot="/root" onCancel={() => {}} onCloned={() => {}} />,
      );
    });
    await flushMicro();
    await flushMicro();
    await flushMicro();

    const text = container!.textContent ?? "";
    // The connect screen (its device code) is the next screen after the box
    // clears a dead credential — NOT a permanent error stuck on the picker.
    expect(text).toContain("ABCD-1234");
    expect(text).not.toContain("Couldn't list your repositories from GitHub.");
    expect(text).not.toContain("Clone a repository");
  });

  it("renders an error message for a network failure and does NOT drop to the connect panel (BET-1059)", async () => {
    installMockApi({
      forgeDeviceStart: () => Promise.resolve({ connected: true, grant: null }),
      forgeRepos: () => Promise.resolve({ repos: [], stale: false, error: "network" }),
      forgeCloneStart: () => Promise.resolve({ id: "c1" }),
      forgeCloneStatus: () => Promise.resolve(CLONE_IN_PROGRESS),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <CloneFromGitHub defaultRoot="/root" onCancel={() => {}} onCloned={() => {}} />,
      );
    });
    await flushMicro();
    await flushMicro();

    const text = container!.textContent ?? "";
    // The network message renders inside the picker's error callout…
    expect(text).toContain(
      "Couldn't reach GitHub from your server. Check its connection and try again.",
    );
    // …and the picker stays up — a blip must not look like a sign-out.
    expect(text).toContain("Clone a repository");
    expect(container!.querySelector('input[aria-label="Search repositories"]')).toBeTruthy();
  });

  it("selects a repo when its row (not the hidden checkbox) is clicked, and updates the button (BET-1199)", async () => {
    mountPicker();
    await flushMicro();

    // The row is the ListRow rendered as a role=button; its name text is alpha's.
    const alphaRow = Array.from(
      container!.querySelectorAll<HTMLElement>('div[role="button"]'),
    ).find((r) => r.textContent?.includes("alpha"));
    expect(alphaRow).toBeTruthy();
    act(() => {
      alphaRow!.click();
    });
    expect(cloneButtonFor("1 selected")).toBeTruthy();
  });
});
