// @vitest-environment jsdom
//
// Render-harness tests for ProvidersStep (BET-960). The provider step is
// always shown: it must NOT auto-advance on mount, and it must render
// already-connected providers ticked with Continue enabled.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { ProvidersStep } from "./ProvidersStep";

function noop() {
  /* swallow */
}

function buttonByText(h: Harness, text: string): HTMLButtonElement | undefined {
  const btns = Array.from(h.container.querySelectorAll("button"));
  return (btns.find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined);
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ProvidersStep render harness (BET-960)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function continueButton(): HTMLButtonElement | null {
    const btns = Array.from(h!.container.querySelectorAll("button"));
    return (
      (btns.find((b) => b.textContent?.includes("Start using Manta")) as
        | HTMLButtonElement
        | undefined) ?? null
    );
  }

  it("does not advance on mount and enables Continue when one provider is connected", async () => {
    installMockApi({
      opencodeProviderAuth: () =>
        Promise.resolve({
          action: "status",
          providers: [
            { id: "anthropic", label: "Anthropic", plan: "Pro", connected: true },
          ],
        }),
    });
    const onContinue = vi.fn(noop);
    h = mount(<ProvidersStep onBack={noop} onContinue={onContinue} />);
    await h.flush();

    expect(onContinue).not.toHaveBeenCalled();
    expect(h.text()).toContain("Anthropic");
    expect(h.text()).toContain("connected");
    expect(continueButton()?.disabled).toBe(false);
  });

  it("keeps Continue disabled when zero providers are connected", async () => {
    installMockApi({
      opencodeProviderAuth: () =>
        Promise.resolve({
          action: "status",
          providers: [
            { id: "anthropic", label: "Anthropic", plan: "Pro", connected: false },
          ],
        }),
    });
    h = mount(<ProvidersStep onBack={noop} onContinue={noop} />);
    await h.flush();

    expect(h.text()).toContain("Anthropic");
    expect(continueButton()?.disabled).toBe(true);
  });

  it("shows the Manta loader beside 'Checking connected providers…' while the mount probe is in flight", async () => {
    // Never resolves — the mount probe stays in flight, statuses stays null,
    // so the probing row must be showing rather than a silent blank line.
    installMockApi({
      opencodeProviderAuth: () => new Promise(() => {}),
    });
    h = mount(<ProvidersStep onBack={noop} onContinue={noop} />);
    await h.flush();

    expect(h.text()).toContain("Checking connected providers…");
    expect(h.container.querySelector(".manta-loader")).toBeTruthy();
  });

  it("shows the loader row again while a post-connect refresh re-probes (list never sits stale)", async () => {
    let authCalls = 0;
    installMockApi({
      opencodeProviderAuth: () => {
        authCalls += 1;
        if (authCalls === 1) {
          // Mount probe resolves: one provider, not connected.
          return Promise.resolve({
            action: "status",
            providers: [
              { id: "anthropic", label: "Anthropic", plan: "Pro", connected: false },
            ],
          });
        }
        // The post-connect re-probe stays in flight, so `refreshing` remains
        // true and the stale list must not just sit there.
        return new Promise(() => {});
      },
      opencodeDiscoverModels: () =>
        Promise.resolve({ ok: true, models: [{ id: "m1" }, { id: "m2" }] }),
      opencodeSetProviders: () => Promise.resolve({ ok: true }),
      opencodeRestart: () => Promise.resolve(),
    });
    h = mount(<ProvidersStep onBack={noop} onContinue={noop} />);
    await h.flush();

    // Mount probe settled: the list is up and the loader row is gone.
    expect(h.text()).toContain("Anthropic");
    expect(h.text()).not.toContain("Checking connected providers…");

    // Reveal the custom-endpoint form, fill it, and probe a model list.
    act(() => {
      buttonByText(h!, "Use your own API endpoint instead")?.click();
    });
    await h.flush();
    const inputs = Array.from(h!.container.querySelectorAll("input"));
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    act(() => {
      setInputValue(inputs[0] as HTMLInputElement, "MyCustom");
      setInputValue(inputs[1] as HTMLInputElement, "https://api.example.com/v1");
      setInputValue(inputs[2] as HTMLInputElement, "sekret");
    });
    await h.flush();
    act(() => {
      buttonByText(h!, "Probe endpoint")?.click();
    });
    await h.flush();
    // The probe's model checklist rendered (the counter line that replaces the
    // removed "{n} models found" header, BET-1312).
    expect(h!.text()).toContain("selected");

    // Save the custom endpoint. onSaved fires the parent refresh (which now
    // hangs), so the loader row must reappear while the list re-probes.
    act(() => {
      buttonByText(h!, "Save")?.click();
    });
    await h.flush();

    expect(h!.text()).toContain("Checking connected providers…");
    expect(h!.container.querySelector(".manta-loader")).toBeTruthy();
  });
});
