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
import type { NewSessionDraft } from "./store";

// The two methods that live ONLY on httpApi and are therefore absent from
// the preload bridge a fresh desktop boot starts on.
const HTTP_ONLY = ["opencodeModels", "opencodeDefaultModel"];

// A minimal new-project draft the composer reads from the store. The screen is
// draft-backed (NewSessionDraft holds the persisted composer workspace), so
// every mount under test provisions one and passes its id.
function draft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
  return {
    id: "draft-1",
    mode: "new-project",
    cwd: "~",
    wantWorktree: false,
    worktreeBranch: "worktree",
    model: null,
    modelTouched: false,
    input: "",
    ...overrides,
  };
}

function mountDraft(overrides: Partial<NewSessionDraft> = {}): Harness {
  const d = draft(overrides);
  resetStore({ activeDraftId: d.id, drafts: [d] });
  return mount(<NewSessionScreen draftId={d.id} />);
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

    h = mountDraft();
    await h.flush();

    // The screen is still mounted — the pre-fix behaviour was an exception
    // thrown from the commit phase, which tears the tree down.
    expect(h.container.childElementCount).toBeGreaterThan(0);
  });

  it("empty state: worktree chip is unchecked + enabled even when config defaults it on", async () => {
    // BET-445: on a fresh box the demo/real config defaults worktreePerSession
    // to true, but the empty-state cwd is "~" (not a git repo) — pre-arming
    // wantWorktree from config shipped a "checked but can't be honored" chip.
    // The new-project (empty) state must render it unchecked and tappable so
    // the user can choose a folder first.
    installMockApi();
    resetStore({ projects: [], worktreePerSession: true });

    h = mountDraft();
    await h.flush();

    // The worktree toggle is now the Checkbox primitive (BET-589); its input
    // carries the same accessible name it always did, so select it that way.
    const checkbox = h.container.querySelector(
      'input[aria-label="Create in a fresh git worktree"]',
    ) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
  });

  it("still fetches models when window.api IS the paired httpApi", async () => {
    const { api } = installMockApi();

    h = mountDraft();
    await h.flush();

    // The guard must not have silently disabled the happy path.
    expect(api.calls.opencodeModels?.length ?? 0).toBe(1);
    expect(api.calls.opencodeDefaultModel?.length ?? 0).toBe(1);
  });
});
