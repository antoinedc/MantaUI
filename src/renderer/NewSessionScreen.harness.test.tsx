// @vitest-environment jsdom
//
// Regression harness for the zero-project composer's mount effect.
//
// THE BUG (staging build, first launch): NewSessionScreen is the app's
// zero-project state, and App renders that branch on the FIRST paint —
// before the async config read has resolved, so before main.tsx has had a
// chance to swap `window.api` from the Electron preload bridge to httpApi.
// On a fresh, unpaired install the swap never happens at all (no boxToken),
// and the preload exposes only the OS-bridge subset: `opencodeModels` and
// `opencodeDefaultModel` are undefined there. The mount effect called them
// unguarded, so React threw "opencodeModels is not a function" during the
// commit phase — which a `.catch()` cannot see — and unmounted the whole
// tree. The app went blank on first launch and onboarding was unreachable.
//
// Two fixes; this file pins the second (the one that makes the crash
// unreachable no matter who mounts the screen):
//   1. App gates the zero-project branch on `loaded`.
//   2. The mount effect probes for each httpApi-only method first, the same
//      way App.tsx's launchersList effect does.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { NewSessionScreen } from "./NewSessionScreen";

// The two methods that live ONLY on httpApi and are therefore absent from
// the preload bridge a fresh desktop boot starts on.
const HTTP_ONLY = ["opencodeModels", "opencodeDefaultModel"];

function noop() {
  /* the tests assert on mount behaviour, not the callbacks */
}

describe("NewSessionScreen mount against an unpaired window.api", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    resetStore({ projects: [] });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("mounts without throwing when the httpApi-only methods are absent", async () => {
    const { api } = installMockApi({}, { absent: HTTP_ONLY });
    // Precondition: the harness really is modelling the preload subset.
    expect(api.opencodeModels).toBeUndefined();
    expect(api.opencodeDefaultModel).toBeUndefined();

    h = mount(
      <NewSessionScreen projectName={null} onDone={noop} onCancel={noop} />,
    );
    await h.flush();

    // The screen is still mounted — the pre-fix behaviour was an exception
    // thrown from the commit phase, which tears the tree down.
    expect(h.container.childElementCount).toBeGreaterThan(0);
  });

  it("still fetches models when window.api IS the paired httpApi", async () => {
    const { api } = installMockApi();

    h = mount(
      <NewSessionScreen projectName={null} onDone={noop} onCancel={noop} />,
    );
    await h.flush();

    // The guard must not have silently disabled the happy path.
    expect(api.calls.opencodeModels?.length ?? 0).toBe(1);
    expect(api.calls.opencodeDefaultModel?.length ?? 0).toBe(1);
  });
});
