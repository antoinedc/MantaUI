// @vitest-environment jsdom
//
// ConnectPanel render tests (BET-961, BET-1007). This component is
// presentational — it renders a ConnectPanelState descriptor plus a target /
// targetSummary ReactNode, log lines and an onAction callback. These tests pin
// the behaviours the BET-1007 acceptance criteria call out:
//   1. Zone B (status) is absent when status is null.
//   2. Zone C is absent when details.kind === "none" and there are no prompt
//      children — no empty placeholder row.
//   3. The first action renders as the primary button; the rest as default.
//   4. The log pane header ("Install log") renders below the panel when log is
//      set and logLines is non-empty; it does not render when log is null.
//   5. targetSummary renders instead of target when targetCollapsed is true.
//
// Pattern from PairStep.test.tsx (uses the shared render harness).

import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ConnectPanel } from "./ConnectPanel";
import type { ConnectPanelState } from "./connectPanelLogic";

function makeState(patch: Partial<ConnectPanelState> = {}): ConnectPanelState {
  return {
    status: null,
    details: { kind: "none" },
    log: null,
    actions: ["install"],
    targetCollapsed: false,
    ...patch,
  };
}

function renderPanel(
  state: ConnectPanelState,
  children?: React.ReactNode,
  opts: { targetSummary?: React.ReactNode } = {},
) {
  return mount(
    <ConnectPanel
      state={state}
      target={<div>target-zone</div>}
      targetSummary={opts.targetSummary ?? <div>summary-zone</div>}
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
    expect(h.text()).not.toContain("Nothing was installed or changed");
    // Zone A + zone D still render.
    expect(h.text()).toContain("target-zone");
  });

  it("renders zone C when a prompt child is present even with details.kind === 'none'", () => {
    h = renderPanel(makeState(), <div>Trust this host?</div>);
    expect(h.text()).toContain("Trust this host?");
  });

  it("omits zone B entirely when status is null", () => {
    h = renderPanel(makeState({ status: null }));
    expect(h.text()).not.toContain("Ready to install");
    expect(h.text()).toContain("target-zone");
    expect(h.text()).toContain("Install & pair");
  });

  it("renders the status meta in zone B when status is set", () => {
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

  it("renders target instead of targetSummary when not collapsed", () => {
    h = renderPanel(makeState({ targetCollapsed: false }));
    expect(h.text()).toContain("target-zone");
    expect(h.text()).not.toContain("summary-zone");
  });

  it("renders targetSummary instead of target when collapsed", () => {
    h = renderPanel(makeState({ targetCollapsed: true }));
    expect(h.text()).toContain("summary-zone");
    expect(h.text()).not.toContain("target-zone");
  });
});

describe("ConnectPanel — log pane below the panel (BET-1007)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("does not render a log pane when log is null", () => {
    h = renderPanel(makeState({ log: null }));
    expect(h.text()).not.toContain("Install log");
  });

  it("renders the 'Install log' header when log is set and logLines is non-empty", () => {
    h = mount(
      <ConnectPanel
        state={makeState({
          log: { defaultOpen: true, showCopyDiagnostics: false },
        })}
        target={<div>target-zone</div>}
        targetSummary={<div>summary-zone</div>}
        logLines={["line one", "line two"]}
        onAction={() => {}}
      />,
    );
    expect(h.text()).toContain("Install log");
    expect(h.text()).toContain("line one");
    expect(h.text()).toContain("line two");
  });

  it("shows Copy diagnostics in the log header when set", () => {
    h = mount(
      <ConnectPanel
        state={makeState({
          log: { defaultOpen: true, showCopyDiagnostics: true },
        })}
        target={<div>target-zone</div>}
        targetSummary={<div>summary-zone</div>}
        logLines={["a"]}
        onAction={() => {}}
      />,
    );
    expect(h.text()).toContain("Copy diagnostics");
  });
});
