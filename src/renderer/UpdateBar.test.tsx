// @vitest-environment jsdom
//
// Component tests for the shared UpdateBar banner. The bar has two shapes:
//   - default: a message + an action button (+ optional dismiss ×).
//   - progress: a determinate progress bar in place of BOTH buttons (an
//     update in flight is not dismissible), driven by {step,total,label}.
//
// jsdom loads no stylesheet, so the progress-width contract is asserted on the
// inline style string and the aria-* attributes.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { UpdateBar } from "./UpdateBar";

describe("UpdateBar", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("without progress: renders the action button and clicking it fires onAction", () => {
    const onAction = vi.fn();
    h = mount(
      <UpdateBar text="Server update available" actionLabel="Update & restart" onAction={onAction} />,
    );
    const btn = [...h.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Update & restart",
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    // No progressbar in the default shape.
    expect(h.container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => btn!.click());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("with progress: renders a progressbar with correct aria values and NO action/dismiss buttons", () => {
    h = mount(
      <UpdateBar
        text="Server update available"
        actionLabel="Update & restart"
        onAction={() => {}}
        onDismiss={() => {}}
        progress={{ step: 3, total: 6, label: "Installing dependencies" }}
      />,
    );
    const bar = h.container.querySelector('[role="progressbar"]') as HTMLElement | null;
    expect(bar).toBeTruthy();
    expect(bar!.getAttribute("aria-valuenow")).toBe("3");
    expect(bar!.getAttribute("aria-valuemin")).toBe("1");
    expect(bar!.getAttribute("aria-valuemax")).toBe("6");
    // The action button and dismiss button are BOTH absent in progress mode.
    expect(h.container.querySelector("button")).toBeNull();
    // The label + step/total are shown.
    expect(h.text()).toContain("Installing dependencies");
    expect(h.text()).toContain("(3/6)");
  });

  it("progress width style reflects step/total (3/6 → 50%)", () => {
    h = mount(
      <UpdateBar
        text="x"
        actionLabel="x"
        onAction={() => {}}
        progress={{ step: 3, total: 6, label: "Installing dependencies" }}
      />,
    );
    const bar = h.container.querySelector('[role="progressbar"]') as HTMLElement;
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("50%");
  });

  it("percent progress renders a percentage label (Downloading finder-style 80%)", () => {
    h = mount(
      <UpdateBar
        text="x"
        actionLabel="x"
        onAction={() => {}}
        progress={{ step: 80, total: 100, label: "Downloading update", percent: true }}
      />,
    );
    // The label shows 80%, not 80/100.
    expect(h.text()).toContain("Downloading update 80%");
    expect(h.text()).not.toContain("80/100");
  });
});
