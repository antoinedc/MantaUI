// @vitest-environment jsdom
//
// Component tests for the Settings → CTO τ round-trip (BET-1521, §9.3/§9.4).
// The issue's Tests deliverable: "τ load/save round-trips through
// `configGet`/`configUpdate` (mock the api)". These mount the REAL
// SettingsView through the shared test harness (mocked window.api + jsdom)
// and drive the actual input — load renders the persisted value, Enter/blur
// commits the edited value through configUpdate, and an out-of-range value is
// rejected with a user-visible toast and NO write.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, type Harness, type MockApi } from "./testHarness";
import { SettingsView } from "./CtoPanel";
import { useStore } from "./store";

// Drive a controlled React input the way a user types: native value setter +
// bubbling `input` event (React's onChange delegation).
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Enter keydown — the τ editor commits on Enter (its other commit path is blur).
function pressEnter(input: HTMLElement): void {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

async function mountSettings(
  config: Record<string, unknown>,
  // What the box answers a config:update with. Default: echo the patch
  // verbatim. The doctrine tests overlay the transient
  // `ctoDoctrineRestartPending` flag the real server adds to the response —
  // that answer is exactly what each scenario varies on.
  configUpdateEcho: (patch: unknown) => Promise<unknown> = (patch) =>
    Promise.resolve(patch),
): Promise<{ h: Harness; api: MockApi }> {
  const { api } = installMockApi({
    configGet: () => Promise.resolve(config),
    configUpdate: configUpdateEcho,
    ctoHealthGet: () => Promise.resolve({ stats: [], calibration: null }),
  });
  const h = mount(
    <SettingsView
      paused={false}
      pausedAt={null}
      onBack={() => {}}
      onLedger={() => {}}
      onProfile={() => {}}
      onBlackboard={() => {}}
      onTools={() => {}}
      onResume={() => {}}
    />,
  );
  await h.flush();
  return { h, api };
}

const tauInput = (h: Harness) =>
  h.container.querySelector<HTMLInputElement>(
    'input[aria-label="Autonomy threshold tau, between 0 and 1"]',
  );

describe("SettingsView τ round-trip (BET-1521)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    act(() => useStore.setState({ appToasts: [] }));
  });

  it("load: renders the persisted ctoAutonomyThreshold from configGet", async () => {
    const m = await mountSettings({
      ctoEnabled: true,
      ctoTier: "medium",
      ctoAmbientCap: 2.5,
      ctoAutonomyThreshold: 0.7,
    });
    h = m.h;
    const input = tauInput(h);
    expect(input).not.toBeNull();
    expect(input!.value).toBe("0.7");
  });

  it("load: empty input when the box has no τ configured yet", async () => {
    const m = await mountSettings({ ctoEnabled: true, ctoTier: "low", ctoAmbientCap: 2.5 });
    h = m.h;
    expect(tauInput(h)!.value).toBe("");
  });

  it("save: Enter commits the edited τ through configUpdate", async () => {
    const m = await mountSettings({ ctoAutonomyThreshold: 0.7 });
    h = m.h;
    const input = tauInput(h)!;
    typeInto(input, "0.85");
    pressEnter(input);
    await h.flush();
    expect(m.api.calls.configUpdate).toContainEqual([{ ctoAutonomyThreshold: 0.85 }]);
  });

  it("save: two-decimal rounding — 0.856 writes 0.86", async () => {
    const m = await mountSettings({ ctoAutonomyThreshold: 0.7 });
    h = m.h;
    const input = tauInput(h)!;
    typeInto(input, "0.856");
    pressEnter(input);
    await h.flush();
    expect(m.api.calls.configUpdate).toContainEqual([{ ctoAutonomyThreshold: 0.86 }]);
  });

  it("save: out-of-range τ is rejected — user-visible toast, no configUpdate write", async () => {
    const m = await mountSettings({ ctoAutonomyThreshold: 0.7 });
    h = m.h;
    const toastsBefore = useStore.getState().appToasts.length;
    const input = tauInput(h)!;
    typeInto(input, "5");
    pressEnter(input);
    await h.flush();
    expect(m.api.calls.configUpdate).toBeUndefined();
    const toasts = useStore.getState().appToasts;
    expect(toasts.length).toBeGreaterThan(toastsBefore);
    expect(toasts[toasts.length - 1]?.message).toContain("between 0 and 1");
  });
});

// ---------------------------------------------------------------------------
// Doctrine restart visibility (review fix): a doctrine edit (style radio /
// house rules) used to restart opencode SILENTLY — killing every in-flight
// turn box-wide with no user-visible signal. The server now defers the
// restart until the box is idle and reports `ctoDoctrineRestartPending` on
// the config responses; the settings page must SHOW that state.
// ---------------------------------------------------------------------------

describe("SettingsView doctrine-restart visibility", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    act(() => useStore.setState({ appToasts: [] }));
  });

  it("a deferred restart is visible: the save response's pending flag shows the pending note + toast", async () => {
    // The save answer carries the pending flag (box was busy → deferred).
    const m = await mountSettings(
      { ctoEnabled: true, cto: { enabled: true }, ctoStyle: "executive" },
      (patch) => Promise.resolve({ ...(patch as object), ctoDoctrineRestartPending: true }),
    );
    h = m.h;
    const radios = h.container.querySelectorAll<HTMLInputElement>('input[name="cto-style"]');
    expect(radios.length).toBeGreaterThan(1);
    const toastsBefore = useStore.getState().appToasts.length;
    await act(async () => {
      radios[1]!.click();
    });
    await h.flush();
    expect(m.api.calls.configUpdate?.length).toBe(1);
    const toasts = useStore.getState().appToasts;
    // The user is TOLD the restart is pending (a toast says the box is busy).
    expect(toasts.length).toBeGreaterThan(toastsBefore);
    expect(toasts[toasts.length - 1]?.message).toContain("idle");
    expect(h.text()).toContain("applies when the box is idle");
  });

  it("an immediate apply (box was idle) does not claim a pending restart", async () => {
    // The save answer reports nothing pending (box was idle → applied now).
    const m = await mountSettings(
      { ctoEnabled: true, cto: { enabled: true }, ctoStyle: "executive" },
      (patch) => Promise.resolve({ ...(patch as object), ctoDoctrineRestartPending: false }),
    );
    h = m.h;
    const radios = h.container.querySelectorAll<HTMLInputElement>('input[name="cto-style"]');
    const toastsBefore = useStore.getState().appToasts.length;
    await act(async () => {
      radios[1]!.click();
    });
    await h.flush();
    expect(m.api.calls.configUpdate?.length).toBe(1);
    // Nothing pending → no pending toast.
    expect(useStore.getState().appToasts.length).toBe(toastsBefore);
    expect(h.text()).not.toContain("applies when the box is idle");
  });

  it("configGet's pending flag renders the note on load (truth survives a reload)", async () => {
    // The CONFIG already carries the pending flag — the note must render from
    // the load path alone, before any save.
    const m = await mountSettings({
      ctoEnabled: true,
      cto: { enabled: true },
      ctoStyle: "executive",
      ctoDoctrineRestartPending: true,
    });
    h = m.h;
    expect(m.api.calls.configGet?.length).toBeGreaterThan(0);
    expect(h.text()).toContain("applies when the box is idle");
  });
});
