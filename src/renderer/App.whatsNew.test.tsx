// @vitest-environment jsdom
//
// "What's new" wired into the real shell: it opens on connect when the server's
// changelog has an unseen release, never over Settings or the upgrade gate, a
// card link navigates (Settings at a section) and acknowledges, and Settings →
// About → What's new re-opens it by hand.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";
import { whatsNewStorageKey } from "./useWhatsNew";
import type { ServerChangelog, UpgradeStatus } from "../shared/api";
import { NOTES_ENTRY, OLDER_ENTRY, ROUTINES_ENTRY } from "./whatsNewFixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";
installCanvasStub();
const { App } = await import("./App");

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";
const SERVER = "srv-1";
const KEY = whatsNewStorageKey(SERVER);

const dialog = (label: string | RegExp) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => {
    const l = d.getAttribute("aria-label") ?? "";
    return typeof label === "string" ? l === label : label.test(l);
  });
const buttonIn = (root: ParentNode, label: string | RegExp) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof label === "string" ? (b.textContent ?? "").trim() === label : label.test(b.textContent ?? ""),
  );

describe("App — What's new", () => {
  let h: Harness | null = null;
  let changelog: ServerChangelog;
  let upgrade: UpgradeStatus | null;
  let fetches = 0;

  const connect = async () => {
    act(() => useStore.setState({ connectionState: { state: "connected" } as never }));
    await h!.flush();
    await h!.flush();
  };
  const reconnect = async () => {
    act(() => useStore.setState({ connectionState: { state: "reconnecting" } as never }));
    await connect();
  };

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload = null;
    window.localStorage.clear();
    changelog = { serverId: SERVER, entries: [NOTES_ENTRY, OLDER_ENTRY] };
    upgrade = null;
    fetches = 0;
    installMockApi({
      serverChangelog: () => {
        fetches += 1;
        return Promise.resolve(changelog);
      },
      upgradeStatus: () => Promise.resolve(upgrade),
      // The shell re-reads its state when the upgrade gate clears: nothing changed.
      syncSnapshot: () => Promise.resolve({ gen: "g", seq: 1, changed: {} }),
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
    });
    resetStore();
    act(() => {
      useStore.setState({
        loaded: true,
        onboardingForced: false,
        serverUrl: `https://${VALID_BOX}.boxes.mantaui.com`,
        boxId: VALID_BOX,
        boxToken: VALID_BOX,
        projects: [],
        activeProjectName: null,
        activeWindowByProject: {},
      });
    });
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("the first connect to a server records the changelog silently — no window", async () => {
    h = mount(<App />);
    await connect();
    expect(fetches).toBeGreaterThan(0);
    expect(dialog(/What's new/)).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(KEY)!).versions).toMatchObject({ "1.3.0": "fp-1.3.0" });
  });

  it("a release that appears later is shown on reconnect, once; Got it acknowledges it", async () => {
    h = mount(<App />);
    await connect();
    changelog = { serverId: SERVER, entries: [ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY] };
    await reconnect();

    const win = dialog("Routines are here");
    expect(win, "What's new window").toBeTruthy();
    act(() => buttonIn(win!, "Got it")!.click());
    await h.flush();
    await new Promise((r) => setTimeout(r, 400));
    expect(dialog("Routines are here")).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(KEY)!).versions["1.4.0"]).toBe("fp-1.4.0");

    await reconnect();
    expect(dialog("Routines are here")).toBeUndefined();
  });

  it("a card link opens Settings at its section and closes the window", async () => {
    h = mount(<App />);
    await connect();
    changelog = { serverId: SERVER, entries: [ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY] };
    await reconnect();

    const win = dialog("Routines are here")!;
    act(() => buttonIn(win, /Open Models settings/)!.click());
    await h.flush();
    await new Promise((r) => setTimeout(r, 400));
    expect(dialog("Routines are here")).toBeUndefined();
    expect(document.body.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Models");
    expect(JSON.parse(window.localStorage.getItem(KEY)!).versions["1.4.0"]).toBe("fp-1.4.0");
  });

  it("waits while the upgrade gate is up, then shows after a refetch when it clears", async () => {
    h = mount(<App />);
    await connect();
    changelog = { serverId: SERVER, entries: [ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY] };
    // The box reports an upgrade in progress.
    upgrade = {
      state: "running",
      steps: [{ id: "migrate", label: "Migrate", status: "running", progress: null }],
      overall: 0.5,
      etaSeconds: null,
      error: null,
    } as unknown as UpgradeStatus;
    act(() => useStore.setState({ connectionState: { state: "reconnecting" } as never }));
    await connect();
    expect(document.body.textContent).toContain("Migrate");
    expect(dialog("Routines are here")).toBeUndefined();

    const before = fetches;
    upgrade = null;
    await act(async () => {
      useStore.setState({ connectionState: { state: "reconnecting" } as never });
    });
    await connect();
    await new Promise((r) => setTimeout(r, 50));
    await h.flush();
    expect(fetches).toBeGreaterThan(before);
    expect(dialog("Routines are here")).toBeTruthy();
  });

  it("Settings → About → What's new closes Settings and opens the window, without acknowledging", async () => {
    h = mount(<App />);
    await connect();
    window.localStorage.setItem(KEY, JSON.stringify({ versions: { "1.2.0": "fp-1.2.0" } }));
    act(() => {
      window.dispatchEvent(new CustomEvent("manta-open-settings", { detail: { section: "general" } }));
    });
    await h.flush();
    expect(document.body.querySelector('[role="tab"][aria-selected="true"]')).toBeTruthy();

    // A release lands while Settings is open: the automatic window must wait.
    changelog = { serverId: SERVER, entries: [NOTES_ENTRY, OLDER_ENTRY] };
    const before = window.localStorage.getItem(KEY);
    act(() => buttonIn(document.body, "What's new")!.click());
    await h.flush();
    await h.flush();

    expect(document.body.querySelector('[role="tab"]')).toBeNull(); // Settings closed
    expect(dialog("What's new in Manta 1.3.0")).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe(before);

    act(() => buttonIn(dialog("What's new in Manta 1.3.0")!, "Got it")!.click());
    await h.flush();
    await new Promise((r) => setTimeout(r, 400));
    expect(dialog("What's new in Manta 1.3.0")).toBeUndefined();
    expect(window.localStorage.getItem(KEY)).toBe(before);
  });
});
