// @vitest-environment jsdom
//
// Render tests for ProcessPanel — the shared "long opaque operation" surface
// used by the SSH installer, onboarding verification and provider sign-in.
//
// Two shipped defects motivated this file (there was no coverage at all):
//
//   1. "Show log" was a DEAD button in the only consumer that has a log. The
//      pane was gated on `!children`, and JSX passes every child expression
//      positionally — so SshInstallStep's two conditional prompt cards make
//      `children` the array [false, false] even when neither prompt renders.
//      A truthy array meant the pane could never open. Children and the log
//      are designed to coexist, so the gate is gone.
//
//   2. "Copy diagnostics" rendered whenever the callback was passed — i.e.
//      for the whole run and on success, in the danger color, implying
//      failure where there was none. It is now error-only.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, type Harness } from "./testHarness";
import { ProcessPanel, formatElapsed } from "./ProcessPanel";

const STAGES = ["Checking the box", "Installing files", "Starting services"];

function panel(props: Partial<React.ComponentProps<typeof ProcessPanel>> = {}) {
  return (
    <ProcessPanel
      stages={STAGES}
      activeIndex={1}
      status="running"
      elapsedSeconds={33}
      logLines={["line one", "line two"]}
      {...props}
    />
  );
}

// Find the log toggle by its label; it carries aria-expanded.
function logToggle(h: Harness): HTMLButtonElement | null {
  return h.container.querySelector<HTMLButtonElement>("button[aria-expanded]");
}

function buttonByText(h: Harness, text: string): HTMLButtonElement | null {
  return (
    Array.from(h.container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(text),
    ) ?? null
  );
}

describe("ProcessPanel", () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  describe("log pane", () => {
    it("opens on toggle and shows the lines", () => {
      h = mount(panel());
      expect(h.text()).not.toContain("line one");

      const btn = logToggle(h);
      expect(btn?.textContent).toContain("Show log");
      act(() => btn!.click());

      expect(h.text()).toContain("line one");
      expect(h.text()).toContain("line two");
      expect(logToggle(h)?.textContent).toContain("Hide log");
    });

    it("REGRESSION: opens even when the parent passes prompt children", () => {
      // The exact shape SshInstallStep produces: two conditional children,
      // both false. Pre-fix this made `children` a truthy [false, false] and
      // the pane never rendered, so "Show log" did nothing at all.
      const fingerprintPrompt = null;
      const passphrasePrompt = null;
      h = mount(
        <ProcessPanel
          stages={STAGES}
          activeIndex={1}
          status="running"
          elapsedSeconds={33}
          logLines={["installer output"]}
        >
          {fingerprintPrompt && <div>fingerprint</div>}
          {passphrasePrompt && <div>passphrase</div>}
        </ProcessPanel>,
      );

      act(() => logToggle(h!)!.click());
      expect(h.text()).toContain("installer output");
    });

    it("renders the log alongside a child prompt that IS showing", () => {
      h = mount(
        <ProcessPanel
          stages={STAGES}
          activeIndex={1}
          status="running"
          elapsedSeconds={1}
          logLines={["installer output"]}
        >
          <div>Trust this host?</div>
        </ProcessPanel>,
      );

      act(() => logToggle(h!)!.click());
      expect(h.text()).toContain("Trust this host?");
      expect(h.text()).toContain("installer output");
    });

    it("hides the toggle entirely when there are no lines", () => {
      h = mount(panel({ logLines: [] }));
      expect(logToggle(h)).toBeNull();
    });
  });

  describe("Copy diagnostics", () => {
    it("is hidden while running", () => {
      h = mount(panel({ status: "running", onCopyDiagnostics: () => {} }));
      expect(buttonByText(h, "Copy diagnostics")).toBeNull();
    });

    it("is hidden on success", () => {
      h = mount(panel({ status: "done", onCopyDiagnostics: () => {} }));
      expect(buttonByText(h, "Copy diagnostics")).toBeNull();
    });

    it("appears on error and fires the callback", () => {
      let called = 0;
      h = mount(
        panel({ status: "error", onCopyDiagnostics: () => { called += 1; } }),
      );
      const btn = buttonByText(h, "Copy diagnostics");
      expect(btn).not.toBeNull();
      act(() => btn!.click());
      expect(called).toBe(1);
    });

    it("stays absent on error when no callback is supplied", () => {
      h = mount(panel({ status: "error" }));
      expect(buttonByText(h, "Copy diagnostics")).toBeNull();
    });
  });

  it("formatElapsed renders m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(33)).toBe("0:33");
    expect(formatElapsed(605)).toBe("10:05");
  });
});
