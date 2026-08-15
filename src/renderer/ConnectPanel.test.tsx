// @vitest-environment jsdom
//
// ConnectPanel render tests (BET-961). This component is presentational —
// it renders a ConnectPanelState descriptor plus a target ReactNode, log
// lines and an onAction callback. These tests pin the three behaviours the
// acceptance criteria call out:
//   1. Zone C is absent when details.kind === "none" and there are no
//      prompt children — no empty placeholder row.
//   2. The first action renders as the primary button; the rest as default.
//   3. The status meta renders in zone B.
//
// Pattern from PairStep.test.tsx (uses the shared render harness).

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ConnectPanel } from "./ConnectPanel";
import type { ConnectPanelState } from "./connectPanel";

function makeState(patch: Partial<ConnectPanelState> = {}): ConnectPanelState {
  return {
    status: {
      tone: "idle",
      text: "Ready to install",
      meta: null,
      progress: null,
      sub: null,
    },
    details: { kind: "none" },
    actions: ["install"],
    hint: null,
    targetLocked: false,
    ...patch,
  };
}

function renderPanel(state: ConnectPanelState, children?: React.ReactNode) {
  return mount(
    <ConnectPanel
      state={state}
      target={<div>target-zone</div>}
      logLines={[]}
      onAction={() => {}}
    >
      {children}
    </ConnectPanel>,
  );
}

describe("ConnectPanel (BET-961)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("omits zone C entirely when details.kind === 'none' and there are no children", () => {
    h = renderPanel(makeState());
    // No zone-C surface: no log toggle, no failures copy, no hint/detail body.
    expect(h.text()).not.toContain("Show log");
    expect(h.text()).not.toContain("Hide log");
    expect(h.text()).not.toContain("Nothing was installed or changed");
    // Zone A + zone B + zone D still render.
    expect(h.text()).toContain("target-zone");
    expect(h.text()).toContain("Ready to install");
  });

  it("renders zone C when a prompt child is present even with details.kind === 'none'", () => {
    h = renderPanel(makeState(), <div>Trust this host?</div>);
    expect(h.text()).toContain("Trust this host?");
  });

  it("renders the status meta in zone B", () => {
    h = renderPanel(
      makeState({
        status: {
          tone: "running",
          text: "Installing files",
          meta: "3 of 6 · 0:24",
          progress: 0.5,
          sub: null,
        },
      }),
    );
    expect(h.text()).toContain("3 of 6 · 0:24");
    expect(h.text()).toContain("Installing files");
  });

  it("renders the first action as the primary button and the rest as default", () => {
    h = renderPanel(makeState({ actions: ["install", "cancel"] }));
    const buttons = Array.from(h.container.querySelectorAll("button"));
    expect(buttons.length).toBe(2);
    // Primary (first) carries the filled accent tone; secondary (default) does not.
    expect(buttons[0].className).toContain("bg-accent-solid");
    expect(buttons[1].className).not.toContain("bg-accent-solid");
    expect(buttons[0].textContent).toBe("Install & pair");
    expect(buttons[1].textContent).toBe("Cancel");
  });

  it("labels the pairManually action 'Enter code manually' when it is the primary", () => {
    h = renderPanel(makeState({ actions: ["pairManually", "retry"] }));
    const buttons = Array.from(h.container.querySelectorAll("button"));
    expect(buttons[0].textContent).toBe("Enter code manually");
    expect(buttons[1].textContent).toBe("Try again");
  });

  it("renders the 'next' hint right-aligned in zone D", () => {
    h = renderPanel(
      makeState({
        status: {
          tone: "ok",
          text: "Connected — your box is ready",
          meta: "6 of 6 · 1:12",
          progress: 1,
          sub: null,
        },
        actions: ["next"],
        hint: "next: connect a provider",
      }),
    );
    expect(h.text()).toContain("next: connect a provider");
    expect(h.text()).toContain("Next →");
  });
});
