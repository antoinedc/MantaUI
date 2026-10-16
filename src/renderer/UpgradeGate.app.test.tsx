// @vitest-environment jsdom
//
// OpenCode V2 cutover, slice C4: the upgrade gate inside the REAL <App/> shell.
// `UpgradeGate.test.tsx` proves the hook + screen against a fake K3 box; this
// file proves the wiring App.tsx owns — that the gate overlays the live shell,
// that "Upgrade box" runs the EXISTING confirm → applyServerUpdate flow (never
// `serverUpdateApply` directly), that a 503 reaches it, and that the shell
// re-reads its state when the gate clears.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";
import type { UpgradeStatus, UpgradeStep } from "../shared/api";

// The matrix bump to supportedMajor 1 is the server slice's (K4); simulate it
// here so "box on the old major" is expressible without depending on that PR.
vi.mock("../shared/compatibility.mjs", async (orig) => ({
  ...(await orig<typeof import("../shared/compatibility.mjs")>()),
  DEFAULT_COMPATIBILITY_MATRIX: { supportedMajor: 1 },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";
installCanvasStub();
const { App } = await import("./App");

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";

function pairShell(): void {
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
}

const step = (id: UpgradeStep["id"], status: UpgradeStep["status"]): UpgradeStep => ({ id, label: id, status, progress: null });
const running: UpgradeStatus = {
  state: "running",
  steps: [step("preflight", "done"), step("stop", "running")],
  overall: 0.1,
  etaSeconds: null,
  error: null,
};
const completed: UpgradeStatus = { ...running, state: "completed", overall: 1 };

const button = (text: string): HTMLButtonElement | null =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ?? null;
const press = (b: HTMLButtonElement | null) => {
  expect(b, "button to press").not.toBeNull();
  act(() => b!.click());
};
const gate = () => document.querySelector('[data-testid="upgrade-gate"]');

describe("UpgradeGate wired into <App/>", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload = null;
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("K4: an old-major box blocks the app; Upgrade box → the existing confirm → serverUpdateApply; the gate clears once the box is back on the new major", async () => {
    let boxVersion = "0.9.0";
    const serverUpdateApply = vi.fn(async () => ({ ok: true }));
    installMockApi({
      getClientVersion: async () => ({ version: "1.0.0" }),
      getServerVersion: async () => ({ version: boxVersion, minClient: "0.0.0", opencodeVersion: "1.0.0" }),
      upgradeStatus: async () => null, // an old box has no upgrade API
      serverUpdateApply,
    });
    resetStore();
    pairShell();
    act(() => {
      // refresh() re-reads the whole sync snapshot, which this mock box doesn't serve.
      useStore.setState({ connectionState: { state: "connected" }, refresh: vi.fn(async () => {}) });
    });
    h = mount(<App />);
    await h.flush();

    expect(gate()).not.toBeNull();
    expect(document.body.textContent).toContain("Your box needs to be upgraded");
    // Pressing it must NOT call serverUpdateApply directly — it raises the
    // confirm that warns running turns end.
    press(button("Upgrade box"));
    await h.flush();
    expect(serverUpdateApply).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Update Manta Server?");

    press(button("Update & restart"));
    await h.flush();
    expect(serverUpdateApply).toHaveBeenCalledTimes(1);
    // Busy state replaces the button — no second press, no silence.
    expect(document.body.textContent).toContain("Updating the box…");
    expect(button("Upgrade box")).toBeNull();

    // The box drops the stream while it restarts: the gate says so.
    act(() => {
      useStore.setState({ connectionState: { state: "reconnecting", attempt: 1, backoffMs: 500 } });
    });
    await h.flush();
    expect(document.body.textContent).toContain("Restarting the box…");

    // The box restarts onto the new release; the stream reconnects and the
    // version is re-read → K4 clears → the app opens.
    boxVersion = "1.0.0";
    act(() => {
      useStore.setState({ connectionState: { state: "connected" } });
    });
    await h.flush();
    expect(gate()).toBeNull();
  });

  it("K3: a 503 raises the gate, the box's frames drive it, and 'completed' re-reads the shell's state", async () => {
    let onFrame: ((s: UpgradeStatus) => void) | null = null;
    let onRefused: (() => void) | null = null;
    installMockApi({
      getClientVersion: async () => ({ version: "1.0.0" }),
      getServerVersion: async () => ({ version: "1.0.0", minClient: "0.0.0", opencodeVersion: "1.0.0" }),
      upgradeStatus: async () => {
        throw new Error("box restarting");
      },
      onUpgrade: (cb: (s: UpgradeStatus) => void) => {
        onFrame = cb;
        return () => {};
      },
      onBoxUpgrading: (cb: () => void) => {
        onRefused = cb;
        return () => {};
      },
    });
    resetStore();
    pairShell();
    const refresh = vi.fn(async () => {});
    act(() => {
      useStore.setState({ refresh });
    });
    h = mount(<App />);
    await h.flush();
    expect(gate()).toBeNull();
    const refreshesBefore = refresh.mock.calls.length;

    act(() => onRefused!());
    await h.flush();
    expect(document.body.textContent).toContain("Your box is upgrading");

    act(() => onFrame!(running));
    await h.flush();
    expect(document.body.textContent).toContain("Upgrading your box");

    act(() => onFrame!(completed));
    await h.flush();
    expect(gate()).toBeNull();
    expect(refresh.mock.calls.length).toBeGreaterThan(refreshesBefore);
  });

  it("a healthy same-major box shows no gate (patch skew stays with the existing banner)", async () => {
    installMockApi({
      getClientVersion: async () => ({ version: "1.2.0" }),
      getServerVersion: async () => ({ version: "1.0.0", minClient: "0.0.0", opencodeVersion: "1.0.0" }),
      upgradeStatus: async () => null,
    });
    resetStore();
    pairShell();
    h = mount(<App />);
    await h.flush();
    expect(gate()).toBeNull();
  });
});
