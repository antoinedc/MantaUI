// @vitest-environment jsdom
//
// Render-harness tests for PairStep (BET-382 §"Tests").
//
// Covers:
//   1. Deep-link-open — a pending manta://pair prefill opens the manual
//      form on first paint and pre-fills Box ID + Code, and hides the
//      SSH picker.
//   2. Closed-by-default — no pending deep link + no preload, the manual
//      form is NOT in the DOM until "Pair to an existing box" is pressed;
//      pressing it mounts the form, and the button flips to "Hide".
//   3. Submit-stays-disabled — the manual form's Connect button stays
//      disabled until Box ID + Code are both valid, and is enabled when
//      they are. Reuses the same canConnectSetup gate the production
//      component uses — no validation logic is duplicated here.

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

describe("PairStep render harness (BET-382)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    // PairStep renders SshInstallStep when getMantaPreload() is non-null,
    // which would try to call installerListHosts() on mount. Force the
    // preload off so the SSH picker path doesn't enter these tests —
    // the SSH path is its own component (SshInstallStep.tsx) and is
    // covered by BET-355/383, not here.
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

  it("closed by default — manual form is NOT in the DOM until the button is pressed", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    // No input rows on first paint (SSH picker is off; the form lives
    // behind the toggle).
    expect(h.container.querySelector("#pair-box-id")).toBeNull();
    expect(h.container.querySelector("#pair-code")).toBeNull();
    expect(h.container.querySelector("#pair-host")).toBeNull();

    const toggle = h.container.querySelector(
      "button",
    ) as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toBe("Pair to an existing box");

    // Open it.
    act(() => toggle?.click());
    expect(h.container.querySelector("#pair-box-id")).not.toBeNull();
    expect(h.container.querySelector("#pair-code")).not.toBeNull();
    expect(h.container.querySelector("#pair-host")).not.toBeNull();
    // Button label flips while open.
    expect(toggle?.textContent).toBe("Hide");

    // Close again — form unmounts.
    act(() => toggle?.click());
    expect(h.container.querySelector("#pair-box-id")).toBeNull();
    expect(h.container.querySelector("#pair-code")).toBeNull();
  });

  it("deep-link-open — pending pair link opens the form pre-filled and hides the SSH picker", () => {
    act(() => {
      useStore.setState({ pendingPairLink: VALID_LINK });
    });
    h = mount(<PairStep onPaired={noopOnPaired} />);

    // Form is open on first paint.
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

    // Toggle button reads "Hide".
    const toggle = h.container.querySelector("button");
    expect(toggle?.textContent).toBe("Hide");

    // SSH picker must be hidden — no <select id="ssh-host"> (which is what
    // SshInstallStep renders). This is the same assertion BET-335 already
    // covers; we re-state it here because the BET-382 dedupe touches the
    // same showSshPicker branch.
    expect(h.container.querySelector("#ssh-host")).toBeNull();
  });

  it("Connect stays disabled until Box ID + Code are both valid", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    act(() => {
      (
        h!.container.querySelector("button") as HTMLButtonElement | null
      )?.click();
    });
    const submit = h.container.querySelector(
      "button[type=submit]",
    ) as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(true);

    const boxId = h.container.querySelector(
      "#pair-box-id",
    ) as HTMLInputElement | null;
    const code = h.container.querySelector(
      "#pair-code",
    ) as HTMLInputElement | null;

    // Box ID alone — still disabled.
    act(() => {
      boxId!.focus();
      // emulate a React-style input event by setting the native value +
      // dispatching an input event the React state listens to.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(boxId, VALID_BOX);
      boxId!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit?.disabled).toBe(true);

    // Bad code — still disabled.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(code, "12345");
      code!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit?.disabled).toBe(true);

    // Good code — now enabled.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(code, VALID_CODE);
      code!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit?.disabled).toBe(false);

    // Now blank the Box ID — must disable again (gate re-evaluates).
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(boxId, "");
      boxId!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit?.disabled).toBe(true);
  });

  it("Host field surfaces the inline server-URL validation error", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    act(() => {
      (
        h!.container.querySelector("button") as HTMLButtonElement | null
      )?.click();
    });
    const host = h.container.querySelector(
      "#pair-host",
    ) as HTMLInputElement | null;
    expect(host).not.toBeNull();

    // Type a non-http(s) value — should flag invalid.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(host, "ftp://nope.example.com");
      host!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host?.getAttribute("aria-invalid")).toBe("true");
    expect(h.text()).toContain(
      "Server URL must start with http:// or https://",
    );

    // A valid https URL clears it.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(host, "https://box.example.com");
      host!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host?.getAttribute("aria-invalid")).toBe("false");
    expect(h.text()).not.toContain(
      "Server URL must start with http:// or https://",
    );
  });

  it("footer hint mentions `manta pair` and there is no Skip-setup button", () => {
    h = mount(<PairStep onPaired={noopOnPaired} />);
    act(() => {
      (
        h!.container.querySelector("button") as HTMLButtonElement | null
      )?.click();
    });
    expect(h.text()).toContain("manta pair");
    // The form-footer hint AND the toggle button are the only buttons on
    // the step when the form is open — no third "Skip setup" anywhere.
    const buttons = Array.from(h.container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels.some((l) => l === "Skip setup")).toBe(false);
    // And the footer hint is in a <p>, not in the per-input help text under
    // the Code input.
    const codeInput = h.container.querySelector("#pair-code");
    expect(codeInput?.parentElement?.querySelector("p")).toBeNull();
  });
});
