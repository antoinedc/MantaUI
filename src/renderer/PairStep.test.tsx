// @vitest-environment jsdom
//
// Render-harness tests for PairStep (BET-382 §"Tests", rewritten for BET-962).
//
// PairStep now owns a single Connect panel whose zone A switches between the
// SSH host picker (`ssh`) and manual code entry (`manual`). With no SSH
// installer (the harness forces `__mantaPreload = null`) there is no picker,
// so manual mode is the default. Covers:
//   1. Default — manual fields are in the DOM, idle status, mode-switch link.
//   2. Deep-link — a pending manta://pair prefill forces manual mode, fills
//      the fields, shows "Pairing link ready" + Discard, and hides the picker.
//   3. Connect-disabled — the manual panel's Connect stays disabled until
//      Box ID + Code are both valid (same canConnectSetup gate in use).
//   4. Mode switch — "Back to the host picker" swaps zone A out of manual.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import {
  installMockApi,
  resetStore,
  mount,
  type Harness,
} from "./testHarness";
import { PairStep } from "./PairStep";
import { useStore } from "./store";

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";
const VALID_CODE = "123456";
const VALID_LINK = `manta://pair?box=${VALID_BOX}&code=${VALID_CODE}`;

function noopOnPaired() {
  /* swallow — tests assert on DOM, not the callback */
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll("button"));
  return (buttons.find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined) ?? null;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("PairStep render harness (BET-382 / BET-962)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    // Force the SSH installer off so the picker path doesn't enter these
    // tests — the SSH path is its own component (SshInstallStep.tsx). With
    // no installer, PairStep enters manual mode by default (BET-962).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload = null;
    installMockApi();
    resetStore();
    // Default: no pending deep link. Individual tests opt in.
    act(() => {
      useStore.setState({ pendingPairLink: null, pairLinkError: null });
    });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders ONE <h2> and exactly the new copy (BET-382 dedupe)", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    const headings = h.container.querySelectorAll("h2");
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe("Connect your box");
    expect(h.text()).toContain(
      "Pick the machine you want to run Manta on.",
    );
    expect(h.text()).not.toContain("Connect to your box");
    expect(h.text()).not.toContain("Set up your box via SSH");
    expect(h.text()).not.toContain("Skip setup");
    expect(h.text()).not.toContain("Pair manually with a code");
    expect(h.text()).not.toContain("Advanced");
  });

  it("defaults to manual mode without an installer — fields in the DOM, idle status", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    // No pending link + no installer → manual mode is the default (no picker
    // to show instead). The manual fields render in zone A.
    expect(h.container.querySelector("#pair-box-id")).not.toBeNull();
    expect(h.container.querySelector("#pair-code")).not.toBeNull();
    expect(h.container.querySelector("#pair-host")).not.toBeNull();
    // Zone B shows the idle manual status; zone A carries the mode-switch link.
    expect(h.text()).toContain("Enter the 6-digit code from the box");
    expect(h.text()).toContain("Back to the host picker");
  });

  it("deep-link — pending pair link forces manual mode and pre-fills the fields", () => {
    act(() => {
      useStore.setState({ pendingPairLink: VALID_LINK });
    });
    h = mount(<PairStep onPaired={noopOnPaired} />);

    const boxId = h.container.querySelector(
      "#pair-box-id",
    ) as HTMLInputElement | null;
    const code = h.container.querySelector(
      "#pair-code",
    ) as HTMLInputElement | null;
    expect(boxId).not.toBeNull();
    expect(code).not.toBeNull();
    expect(boxId?.value).toBe(VALID_BOX);
    expect(code?.value).toBe(VALID_CODE);

    // The prefill row (M1): the status zone is omitted (nothing is happening),
    // so there is no "Pairing link ready" line — just Connect/Discard.
    expect(h.text()).not.toContain("Pairing link ready");
    expect(h.text()).toContain("Discard");
    expect(buttonByText(h.container, "Connect")).not.toBeNull();

    // SSH picker must be hidden — no <select id="ssh-host">.
    expect(h.container.querySelector("#ssh-host")).toBeNull();
  });

  it("Connect stays disabled until Box ID + Code are both valid", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    const container = h.container;

    const connect = () => buttonByText(container, "Connect");
    expect(connect()).not.toBeNull();
    expect(connect()?.disabled).toBe(true);

    const boxId = container.querySelector(
      "#pair-box-id",
    ) as HTMLInputElement | null;
    const code = container.querySelector(
      "#pair-code",
    ) as HTMLInputElement | null;

    // Box ID alone — still disabled.
    act(() => setInputValue(boxId!, VALID_BOX));
    expect(connect()?.disabled).toBe(true);

    // Bad code — still disabled.
    act(() => setInputValue(code!, "12345"));
    expect(connect()?.disabled).toBe(true);

    // Good code — now enabled.
    act(() => setInputValue(code!, VALID_CODE));
    expect(connect()?.disabled).toBe(false);

    // Now blank the Box ID — must disable again (gate re-evaluates).
    act(() => setInputValue(boxId!, ""));
    expect(connect()?.disabled).toBe(true);
  });

  it("Host field surfaces the inline server-URL validation error", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    const host = h.container.querySelector(
      "#pair-host",
    ) as HTMLInputElement | null;
    expect(host).not.toBeNull();

    // Type a non-http(s) value — should flag invalid.
    act(() => setInputValue(host!, "ftp://nope.example.com"));
    expect(host?.getAttribute("aria-invalid")).toBe("true");
    expect(h.text()).toContain(
      "Server URL must start with http:// or https://",
    );

    // A valid https URL clears it.
    act(() => setInputValue(host!, "https://box.example.com"));
    expect(host?.getAttribute("aria-invalid")).toBe("false");
    expect(h.text()).not.toContain(
      "Server URL must start with http:// or https://",
    );
  });

  it("zone C hint mentions `manta pair` and there is no Skip-setup button", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    expect(h.text()).toContain("manta pair");
    const labels = Array.from(h.container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels.some((l) => l === "Skip setup")).toBe(false);
    // The hint is in zone C, not under the Code input.
    const codeInput = h.container.querySelector("#pair-code");
    expect(codeInput?.parentElement?.querySelector("p")).toBeNull();
  });

  it("mode switch — 'Back to the host picker' swaps zone A out of manual", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    expect(h.container.querySelector("#pair-box-id")).not.toBeNull();

    const back = buttonByText(h.container, "Back to the host picker");
    expect(back).not.toBeNull();
    act(() => back!.click());

    // Without an installer, ssh mode renders SshInstallStep's fallback; the
    // manual fields leave the DOM.
    expect(h.container.querySelector("#pair-box-id")).toBeNull();
    expect(h.container.querySelector("#pair-code")).toBeNull();
    expect(h.text()).toContain("SSH installer");
  });
});
