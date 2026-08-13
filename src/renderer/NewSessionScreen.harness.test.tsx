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
import { NewSessionScreen, uniqueSessionName } from "./NewSessionScreen";
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

  it("new-project zero state is the repo-probe screen, not the folder-chip composer", async () => {
    // BET-787: the new-project (zero-project) zero state is now the repo-probe
    // screen. On a box with no repos it is the "fresh" state, not today's
    // folder-chip composer. In particular there is no worktree chip to pre-arm
    // (the old BET-445 concern) — the folder/composer path is reached via
    // "Browse for a folder…" instead.
    installMockApi();
    resetStore({ projects: [], worktreePerSession: true });

    h = mountDraft();
    await h.flush();

    // Fresh-box heading (probe succeeded, zero repos found).
    expect(h.container.textContent).toContain("Let's get some code on this box");
    // No worktree chip in the repo-probe zero state.
    const checkbox = h.container.querySelector(
      'input[aria-label="Create in a fresh git worktree"]',
    );
    expect(checkbox).toBeNull();
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

// BET-787: the numeric session-name de-dup is ONE shared helper — every path
// that creates a project (repo-probe batch, composer submit, worktree fan-out)
// must go through it, or two projects can land with the same tmux session
// name. Pin it here so the duplication can't silently re-split.
describe("uniqueSessionName", () => {
  it("returns the base name when it is free", () => {
    expect(uniqueSessionName("repo", new Set(["server", "other"]))).toBe("repo");
  });

  it("appends -2, -3, … until a free name is found", () => {
    expect(uniqueSessionName("repo", new Set(["repo"]))).toBe("repo-2");
    expect(uniqueSessionName("repo", new Set(["repo", "repo-2", "repo-3"]))).toBe("repo-4");
  });
});
