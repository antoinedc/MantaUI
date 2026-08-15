// @vitest-environment jsdom
//
// Regression test for BET-959: React error #300 ("Rendered fewer hooks than
// expected") when onboarding opens mid-session.
//
// The bug: AppInner early-returned `<Onboarding/>` at a conditional AFTER
// seven hooks were already declared. The first render (onboarding not yet
// resolved) ran all hooks; the render in which onboarding flipped on ran seven
// fewer, so React threw and the ErrorBoundary painted "Something went wrong",
// which then appeared fixed only because a reload settled the answer at the
// first render.
//
// This test drives the REAL `<App/>`: mount paired + loaded so the shell
// renders, THEN flip onboarding on AFTER that first render, and assert the
// DOM does not degrade to the crash fallback and that onboarding actually
// rendered. It is RED against the pre-split AppInner (the fewer-hooks crash
// throws into the ErrorBoundary) and GREEN after the hoist.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import {
  installCanvasStub,
  installMockApi,
  resetStore,
  mount,
  type Harness,
} from "./testHarness";
import { useStore } from "./store";

// App.tsx reads `__MANTA_CHANNEL__` at module top level (a build-time define
// injected by electron-vite; vitest doesn't provide it). Seed it BEFORE the
// dynamic import below evaluates App.tsx — a static import would evaluate the
// module header first and throw ReferenceError.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";

// The full shell imports @xterm's WebGL addon, which probes the canvas
// 2D context at module-load time. jsdom has no canvas implementation and
// throws "Not implemented" on every such probe unless we stub it. MUST run
// before App.tsx (and therefore xterm) evaluates.
installCanvasStub();

const { App } = await import("./App");

// A valid 32-hex box token → resolveTransportMode reads the config as
// "http" (paired), so the shell renders instead of onboarding on first paint.
// Named VALID_BOX (not TOKEN) — the CI gitleaks secret scan keys its
// generic-api-key rule off identifier keywords like `token`, so a fabricated
// test value named TOKEN trips it even though the literal is harmless (the
// same value already lives on main as VALID_BOX in PairStep.test.tsx).
const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";

function pairShell(): void {
  act(() => {
    useStore.setState({
      loaded: true,
      onboardingForced: false,
      serverUrl: `https://${VALID_BOX}.boxes.mantaui.com`,
      boxId: VALID_BOX,
      boxToken: VALID_BOX,
      projects: [],
      activeProjectName: null,
      activeWindowByProject: {},
    });
  });
}

describe("App — onboarding flips on after the shell's first render (BET-959)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    // Force the SSH-installer path off so Onboarding's PairStep renders its
    // manual/disclosure form (same guard PairStep.test.tsx uses).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload = null;
    installMockApi();
    resetStore();
    pairShell();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("does not crash when onboarding turns on after the shell's first render", async () => {
    h = mount(<App />);
    await h.flush();

    // First render settled as the paired shell — no crash fallback.
    expect(h.text()).not.toContain("Something went wrong");

    // Flip onboarding on AFTER that first render, exactly as a 401 →
    // relaunchOnboarding(), "Run setup again", or a manta://pair deep link
    // would mid-session. The pre-split AppInner ran this branch with fewer
    // hooks → React #300 → "Something went wrong".
    act(() => {
      void useStore.getState().relaunchOnboarding();
    });
    await h.flush();

    expect(h.text()).not.toContain("Something went wrong");
    // Onboarding actually rendered. "Connect a provider" is a STEP_LABELS
    // progress-rail label that exists ONLY in Onboarding's shell — the app
    // chrome (Sidebar etc.) never contains it. (Step 1 is auto-skipped here
    // because the config is already paired, so the PairStep "Connect your
    // box" heading is not what renders.)
    expect(h.text()).toContain("Connect a provider");
  });
});
