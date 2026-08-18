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
import { act } from "react";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { NewSessionScreen, uniqueSessionName } from "./NewSessionScreen";
import type { NewSessionDraft } from "./store";
import { useStore } from "./store";
import { refreshModelCatalog } from "./modelCatalog";
import { refreshAgentCatalog } from "./agentCatalog";
import type { WorktreeInfo } from "../shared/types";

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
    plan: false,
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

  // The model/agent catalogs are module-level cached; a given test forces a
  // fresh fetch AFTER installing its window.api so counts stay deterministic
  // (see the "still fetches models" case) and snapshots don't leak across
  // mounts. The store reset here keeps the baseline reproducible.
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
    // Force a re-fetch with the freshly-installed api (the shared catalog is
    // module-cached, so without this an earlier mount's snapshot short-circuits).
    refreshModelCatalog();
    refreshAgentCatalog();

    h = mountDraft();
    await h.flush();

    // The guard must not have silently disabled the happy path.
    expect(api.calls.opencodeModels?.length ?? 0).toBe(1);
    expect(api.calls.opencodeDefaultModel?.length ?? 0).toBe(1);
  });
});

// Composer-parity tests (BET-1088): the pre-session composer renders the same
// controls as a real session's composer — read-only branch badge when the
// worktree isn't wanted, the configured default model (never the "Auto"
// label), the plan chip, the trust row + usage dial, and the plan flag carried
// into the created session's first prompt. All drive the new-session (composer)
// branch, reached with a project-scoped draft.
describe("NewSessionScreen composer parity (BET-1088)", () => {
  let h: Harness | null = null;

  const GIT_WT: WorktreeInfo[] = [
    { path: "/x", head: "abc", branch: "main", bare: false, detached: false },
  ];

  const composerDraft = (overrides: Partial<NewSessionDraft> = {}): NewSessionDraft =>
    draft({ mode: { projectName: "proj" }, cwd: "/x", ...overrides });

  function mountComposer(
    d: NewSessionDraft,
    apiOverrides: Record<string, unknown> = {},
    storeOverrides: Partial<ReturnType<typeof useStore.getState>> = {},
  ): Harness {
    installMockApi({
      gitListWorktrees: () => Promise.resolve(GIT_WT),
      ...apiOverrides,
    });
    // Fresh catalog fetch against the just-installed api — the catalogs are
    // module-cached and an earlier test's snapshot would otherwise short-circuit
    // the override below (e.g. the model-name test needs these models).
    refreshModelCatalog();
    refreshAgentCatalog();
    resetStore({ projects: [], activeDraftId: d.id, drafts: [d], ...storeOverrides });
    h = mount(<NewSessionScreen draftId={d.id} />);
    return h;
  }

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the branch as a non-button badge (no hover affordance) when worktree is unchecked", async () => {
    mountComposer(composerDraft({ wantWorktree: false }));
    await h!.flush();
    // The branch name is shown as metadata.
    expect(h!.text()).toContain("main");
    // It is NOT a button carrying the branch text — an inert Tag, not a control.
    const buttons = [...h!.container.querySelectorAll("button")].filter((b) =>
      b.textContent?.includes("main"),
    );
    expect(buttons).toHaveLength(0);
  });

  it("keeps the editable worktree branch input when worktree is wanted in a git repo", async () => {
    mountComposer(composerDraft({ wantWorktree: true }));
    await h!.flush();
    expect(
      h!.container.querySelector('input[aria-label="Worktree branch name"]'),
    ).toBeTruthy();
  });

  it("shows the configured default model's name, not the 'Auto' label", async () => {
    const d = composerDraft();
    // Seed the draft through createDraft so model comes from the store default
    // (mirror ChatPanel's readSavedModel ?? configDefaultModel seed).
    useStore.setState({ defaultModel: { providerID: "anthropic", modelID: "claude-x" } });
    mountComposer(d, {
      opencodeModels: () =>
        Promise.resolve([
          { id: "claude-x", providerID: "anthropic", name: "Claude X", limit: { context: 200000 } },
        ]),
      opencodeDefaultModel: () =>
        Promise.resolve({ providerID: "anthropic", modelID: "claude-x" }),
    });
    await h!.flush();
    expect(h!.text()).toContain("Claude X");
    expect(h!.text()).not.toContain("Auto");
  });

  it("toggles the Plan chip and ships plan:true on the created session's first prompt", async () => {
    const d = composerDraft({ input: "hello" });
    mountComposer(
      d,
      {
        opencodeAgents: () =>
          Promise.resolve([
            { name: "plan", mode: "primary", description: "plan", models: [], model: "x" },
          ]),
        tmuxNewWindow: () =>
          Promise.resolve({ sessionId: "ses-1", windowIndex: 0, projects: [] }),
      },
      {
        projects: [
          {
            tmuxSession: "proj",
            defaultCwd: "/x",
            attached: false,
            windows: [
              {
                index: 0,
                name: "w",
                active: true,
                paneCurrentPath: "/x",
                opencodeSessionId: "ses-1",
              },
            ],
          },
        ],
        // Neutralize dismissDraft (BEFORE mount, since submit() closes over the
        // store binding from the render): submit() removes the draft at the
        // end, and a directly-mounted NewSessionScreen then re-renders with the
        // removed draft — its early `if (!draft) return null` drops hooks and
        // React throws. In the real app App unmounts the screen on
        // activeDraftId change instead, so this stub is only a harness shim to
        // let the assertion reach the first-prompt channel.
        dismissDraft: () => {},
      },
    );
    await h!.flush();

    // Toggle plan on via the chip.
    const chip = [...h!.container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Plan",
    );
    expect(chip, "expected a Plan chip").toBeTruthy();
    act(() => chip!.click());
    await h!.flush();
    expect(
      useStore.getState().drafts.find((x) => x.id === d.id)?.plan,
    ).toBe(true);

    // Submit → the first-prompt channel carries plan:true.
    const start = h!.container.querySelector(
      'button[aria-label="Start a session"]',
    ) as HTMLButtonElement;
    expect(start).toBeTruthy();
    act(() => start.click());
    await h!.flush();

    const asp = useStore.getState().autoSubmitPrompt;
    expect(asp?.plan).toBe(true);
    expect(asp?.text).toBe("hello");
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
