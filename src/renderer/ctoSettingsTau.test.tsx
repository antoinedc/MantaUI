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
): Promise<{ h: Harness; api: MockApi }> {
  const { api } = installMockApi({
    configGet: () => Promise.resolve(config),
    configUpdate: (patch: unknown) => Promise.resolve(patch),
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
