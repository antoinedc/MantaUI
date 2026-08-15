// @vitest-environment jsdom
//
// Render-harness tests for ProvidersStep (BET-960). The provider step is
// always shown: it must NOT auto-advance on mount, and it must render
// already-connected providers ticked with Continue enabled.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { ProvidersStep } from "./ProvidersStep";

function noop() {
  /* swallow */
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
      (btns.find((b) => b.textContent?.includes("Continue")) as
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
});
