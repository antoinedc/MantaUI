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
import { installMockApi, resetStore, mount, type Harness, type MockApi } from "./testHarness";
import { NewSessionScreen } from "./NewSessionScreen";
import type { NewSessionDraft, DraftAttachment } from "./store";
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
    scratch: false,
    projectName: "",
    scratchRoot: "",
    attachments: [],
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
    expect(h.container.textContent).toContain("Let's get some code on this server");
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
          { id: "claude-x", providerID: "anthropic", name: "Claude X", limit: { context: 200000 }, capabilities: { input: ["text"] } },
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

// Scratch mode (BET-1093): "Start from scratch" — generated name, slugified
// typing, reroll, and the create-scratch / session-creation call sequence on
// submit with and without a prompt.
describe("NewSessionScreen scratch mode (BET-1093)", () => {
  let h: Harness | null = null;

  const scratchDraft = (overrides: Partial<NewSessionDraft> = {}): NewSessionDraft =>
    draft({
      mode: "new-project",
      cwd: "/x",
      wantWorktree: false,
      scratch: true,
      projectName: "fresh-app",
      scratchRoot: "/home",
      ...overrides,
    });

  // A helper to set a controlled <input>'s value the way React expects (native
  // setter + input event) so onChange fires — mirrors typeInto for textareas.
  function typeIntoInput(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function mountScratch(
    d: NewSessionDraft,
    apiOverrides: Record<string, unknown> = {},
    storeOverrides: Partial<ReturnType<typeof useStore.getState>> = {},
  ): MockApi {
    const { api } = installMockApi({
      fsListDirs: () => Promise.resolve({ dir: "/home", entries: [] }),
      ...apiOverrides,
    });
    refreshModelCatalog();
    refreshAgentCatalog();
    // Clear any leftover autoSubmitPrompt from a prior test in this file so the
    // "empty prompt must NOT queue a prompt" assertion is not polluted.
    resetStore({
      projects: [],
      activeDraftId: d.id,
      drafts: [d],
      autoSubmitPrompt: null,
      ...storeOverrides,
    });
    h = mount(<NewSessionScreen draftId={d.id} />);
    return api;
  }

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("clicking Start from scratch shows the composer with a three-word project name", async () => {
    // Reach the fresh zero state (probe succeeds, no repos) with a real home.
    installMockApi({
      forgeProbe: () => Promise.resolve({ repos: [], cli: null, homeDir: "/home/dev" }),
      fsListDirs: () => Promise.resolve({ dir: "/home/dev/projects", entries: [] }),
    });
    refreshModelCatalog();
    refreshAgentCatalog();
    const d = draft({ id: "d-0" });
    resetStore({ projects: [], activeDraftId: "d-0", drafts: [d], autoSubmitPrompt: null });
    h = mount(<NewSessionScreen draftId="d-0" />);
    await h!.flush();

    const btn = [...h!.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start from scratch"),
    );
    expect(btn).toBeTruthy();
    act(() => btn!.click());
    await h!.flush();

    const nameInput = h!.container.querySelector(
      'input[aria-label="Project name"]',
    ) as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    expect(nameInput!.value).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("keeps the typed project name verbatim and previews the derived folder", async () => {
    const d = scratchDraft();
    mountScratch(d);
    await h!.flush();

    const nameInput = h!.container.querySelector(
      'input[aria-label="Project name"]',
    ) as HTMLInputElement;
    act(() => typeIntoInput(nameInput, "My App"));
    await h!.flush();

    // The field keeps the typed text verbatim — never rewritten to a slug.
    expect(
      (
        h!.container.querySelector('input[aria-label="Project name"]') as HTMLInputElement
      ).value,
    ).toBe("My App");
    // The destination line previews the DERIVED folder slug (root is /home).
    expect(h!.text()).toContain("/home/my-app");
  });

  it("a name with no letters or digits disables create and explains why", async () => {
    const d = scratchDraft({ input: "" });
    mountScratch(d);
    await h!.flush();

    const nameInput = h!.container.querySelector(
      'input[aria-label="Project name"]',
    ) as HTMLInputElement;
    act(() => typeIntoInput(nameInput, "!!!"));
    await h!.flush();

    const create = h!.container.querySelector(
      'button[aria-label="Create workspace"]',
    ) as HTMLButtonElement;
    expect(create).toBeTruthy();
    expect(create.disabled).toBe(true);
    expect(h!.text()).toContain("Add at least one letter or number");
  });

  it("scratch mode renders no branch or worktree control", async () => {
    const d = scratchDraft();
    mountScratch(d);
    await h!.flush();

    expect(
      h!.container.querySelector('input[aria-label="Worktree branch name"]'),
    ).toBeNull();
    expect(
      h!.container.querySelector('input[aria-label="Create in a fresh git worktree"]'),
    ).toBeNull();
    expect(h!.text()).not.toContain("worktree");
  });

  it("submit with an empty prompt creates the scratch dir, no createDir, no queued prompt", async () => {
    const d = scratchDraft({ input: "" });
    const api = mountScratch(d, {
      projectCreateScratch: (input: { root: string; name: string }) =>
        Promise.resolve({ path: `${input.root}/${input.name}`, name: input.name }),
      tmuxNewSession: () =>
        Promise.resolve({ sessionId: "ses-x", windowIndex: 0, projects: [] }),
    }, {
      // Neutralize dismissDraft so the post-submit draft removal doesn't drop
      // the directly-mounted screen's hooks (mirrors the composer-parity tests).
      dismissDraft: () => {},
    });
    await h!.flush();

    const create = h!.container.querySelector(
      'button[aria-label="Create workspace"]',
    ) as HTMLButtonElement;
    expect(create, "expected the Create workspace button in scratch mode").toBeTruthy();
    act(() => create.click());
    await h!.flush();

    const ps = api.calls.projectCreateScratch ?? [];
    expect(ps.length).toBe(1);
    expect(ps[0][0]).toEqual({ root: "/home", name: "fresh-app" });

    const ts = api.calls.tmuxNewSession ?? [];
    expect(ts.length).toBe(1);
    const arg = ts[0][0] as Record<string, unknown>;
    expect(arg.cwd).toBe("/home/fresh-app");
    expect("createDir" in arg).toBe(false);

    expect(useStore.getState().autoSubmitPrompt).toBeNull();
  });

  it("submit with a prompt creates the dir AND queues the prompt", async () => {
    const d = scratchDraft({ input: "wire it up" });
    const api = mountScratch(d, {
      projectCreateScratch: (input: { root: string; name: string }) =>
        Promise.resolve({ path: `${input.root}/${input.name}`, name: input.name }),
      tmuxNewSession: () =>
        Promise.resolve({ sessionId: "ses-y", windowIndex: 0, projects: [] }),
    }, {
      dismissDraft: () => {},
    });
    await h!.flush();

    const start = h!.container.querySelector(
      'button[aria-label="Start a session"]',
    ) as HTMLButtonElement;
    expect(start).toBeTruthy();
    act(() => start.click());
    await h!.flush();

    const ps = api.calls.projectCreateScratch ?? [];
    expect(ps.length).toBe(1);
    expect(ps[0][0]).toEqual({ root: "/home", name: "fresh-app" });

    const ts = api.calls.tmuxNewSession ?? [];
    expect(ts.length).toBe(1);
    const arg = ts[0][0] as Record<string, unknown>;
    expect(arg.cwd).toBe("/home/fresh-app");
    expect("createDir" in arg).toBe(false);

    const asp = useStore.getState().autoSubmitPrompt;
    expect(asp?.text).toBe("wire it up");
  });
});

// BET-1124: attach files before starting a session. The attach icon opens a
// hidden file input; selected files are staged into the draft's attachments
// and rendered as removable chips; on submit they upload and ride the first
// prompt's autoSubmit channel.
describe("NewSessionScreen attach-before-start (BET-1124)", () => {
  let h: Harness | null = null;

  const GIT_WT: WorktreeInfo[] = [
    { path: "/x", head: "abc", branch: "main", bare: false, detached: false },
  ];

  function mountComposer(
    d: NewSessionDraft,
    apiOverrides: Record<string, unknown> = {},
    storeOverrides: Partial<ReturnType<typeof useStore.getState>> = {},
  ): MockApi {
    const { api } = installMockApi({
      gitListWorktrees: () => Promise.resolve(GIT_WT),
      ...apiOverrides,
    });
    refreshModelCatalog();
    refreshAgentCatalog();
    resetStore({
      projects: [],
      activeDraftId: d.id,
      drafts: [d],
      ...storeOverrides,
    });
    h = mount(<NewSessionScreen draftId={d.id} />);
    return api;
  }

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // jsdom can't open a native picker; drive the hidden input directly the way
  // a selection would (files + change event → onFiles).
  function stageFile(input: HTMLInputElement, file: File) {
    Object.defineProperty(input, "files", {
      value: [file] as unknown as FileList,
      configurable: true,
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  it("selecting a file through the hidden input stages a removable chip", async () => {
    const d = draft({ mode: { projectName: "proj" }, cwd: "/x", input: "build it" });
    mountComposer(d);
    await h!.flush();

    // The attach control is enabled (it was hard-coded disabled before) and
    // its title no longer says the feature is unavailable.
    const attach = [...h!.container.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Attach a file",
    ) as HTMLButtonElement | undefined;
    expect(attach).toBeTruthy();
    expect(attach!.disabled).toBe(false);
    expect(attach!.getAttribute("title")).toBe("Attach a file");

    const input = h!.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input, "expected the hidden file input").toBeTruthy();

    const file = new File(["content"], "note.md", { type: "text/markdown" });
    stageFile(input, file);
    await h!.flush();

    // The chip renders with the filename.
    expect(h!.text()).toContain("note.md");
    const staged = useStore.getState().drafts.find((x) => x.id === d.id)!.attachments;
    expect(staged).toHaveLength(1);
    expect(staged[0].filename).toBe("note.md");
    // text/markdown is not FilePart-safe → path ref.
    expect(staged[0].asPathRef).toBe(true);

    // Clicking the chip's remove splices it out of the draft.
    const remove = h!.container.querySelector(
      'button[aria-label="Remove attachment"]',
    ) as HTMLButtonElement;
    expect(remove, "expected a remove button on the chip").toBeTruthy();
    act(() => remove.click());
    await h!.flush();

    expect(h!.text()).not.toContain("note.md");
    expect(useStore.getState().drafts.find((x) => x.id === d.id)!.attachments).toHaveLength(0);
  });

  it("submit uploads staged files and carries them on the first prompt", async () => {
    const d = draft({ mode: { projectName: "proj" }, cwd: "/x", input: "summarize" });
    const api = mountComposer(
      d,
      {
        uploadBuffer: () => Promise.resolve("/remote/note.md"),
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
        // Neutralize dismissDraft (see the composer-parity tests — submit()
        // closes over the store binding from the render).
        dismissDraft: () => {},
      },
    );
    await h!.flush();

    const file = new File(["content"], "note.md", { type: "text/markdown" });
    // jsdom's File lacks arrayBuffer(); submit() reads bytes this way.
    (file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
      () => Promise.resolve(new ArrayBuffer(1));
    stageFile(h!.container.querySelector('input[type="file"]') as HTMLInputElement, file);
    await h!.flush();

    const start = h!.container.querySelector(
      'button[aria-label="Start a session"]',
    ) as HTMLButtonElement;
    act(() => start.click());
    await h!.flush();

    const ups = api.calls.uploadBuffer ?? [];
    expect(ups.length).toBe(1);
    expect(ups[0]?.[0]).toMatchObject({ projectName: "proj", filename: "note.md" });

    const asp = useStore.getState().autoSubmitPrompt;
    expect(asp?.text).toBe("summarize");
    expect(asp?.attachments).toHaveLength(1);
    expect(asp?.attachments![0]).toMatchObject({
      filename: "note.md",
      mime: "text/markdown",
      remotePath: "/remote/note.md",
      status: "ready",
      source: "drop",
      asPathRef: true,
    });
  });

  // BET-1204: drag-and-drop on the new-session draft screen stages through the
  // identical onFiles path as the paperclip button (onFiles → draft.attachments
  // → upload on submit). A synthetic drop must produce the same chip + upload.
  it("a drop on the screen root stages the file and uploads it on submit", async () => {
    const d = draft({ mode: { projectName: "proj" }, cwd: "/x", input: "summarize" });
    const api = mountComposer(
      d,
      {
        uploadBuffer: () => Promise.resolve("/remote/note.md"),
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
        dismissDraft: () => {},
      },
    );
    await h!.flush();

    const root = h!.container.querySelector('[data-screen="welcome"]') as HTMLElement;
    expect(root, "expected the screen root").toBeTruthy();

    const file = new File(["content"], "note.md", { type: "text/markdown" });
    // jsdom's File lacks arrayBuffer(); submit() reads bytes this way.
    (file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
      () => Promise.resolve(new ArrayBuffer(1));

    // jsdom has no DataTransfer; hand the drop event a minimal stub whose
    // types/files the handlers read (Array.from(types) + onFiles(files)).
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: [file] as unknown as FileList, dropEffect: "none" },
    });
    act(() => root.dispatchEvent(drop));
    await h!.flush();

    // The chip appears, staged through the same onFiles path as the button.
    expect(h!.text()).toContain("note.md");
    const staged = useStore.getState().drafts.find((x) => x.id === d.id)!.attachments;
    expect(staged).toHaveLength(1);
    expect(staged[0].filename).toBe("note.md");

    const start = h!.container.querySelector(
      'button[aria-label="Start a session"]',
    ) as HTMLButtonElement;
    act(() => start.click());
    await h!.flush();

    const ups = api.calls.uploadBuffer ?? [];
    expect(ups.length).toBe(1);
    expect(ups[0]?.[0]).toMatchObject({ projectName: "proj", filename: "note.md" });
  });
});

// BET-1127 follow-up: the fan-out submit path (submitFanOut — one session, one
// window per worktree) must carry staged attachments to the first window just
// like the single-folder submit() path does. Before BET-1124 the fan-out path
// silently dropped staged files; this closes the coverage gap on that fix.
describe("NewSessionScreen fan-out submit carries staged attachments (BET-1127)", () => {
  let h: Harness | null = null;

  // Two worktrees under /x — hasWorktreeFanOut needs >1. The first becomes the
  // session's initial window; the rest are added as new windows.
  const FANOUT_WTS: WorktreeInfo[] = [
    { path: "/x/main", head: "abc", branch: "main", bare: false, detached: false },
    { path: "/x/feature", head: "def", branch: "feat", bare: false, detached: false },
  ];

  // jsdom's File lacks arrayBuffer(); submitFanOut() reads bytes this way.
  function stagedFile(): DraftAttachment {
    const file = new File(["content"], "note.md", { type: "text/markdown" });
    (file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
      Promise.resolve(new ArrayBuffer(1));
    return { id: "att-1", filename: "note.md", mime: "text/markdown", asPathRef: true, file };
  }

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("uploads staged files against the session and passes them as the attachments arg to opencodePrompt", async () => {
    const d = draft({
      mode: "new-project",
      cwd: "/x",
      wantWorktree: false,
      input: "fan it",
      attachments: [stagedFile()],
    });
    const { api } = installMockApi({
      // Reach the "fresh" zero state so "Browse for a folder…" opens the
      // picker at the draft's cwd (/x) with pickerTarget "cwd".
      forgeProbe: () => Promise.resolve({ repos: [], cli: null, homeDir: "/home/dev" }),
      fsListDirs: (dir: unknown) => Promise.resolve({ dir: dir as string, entries: [] }),
      gitListWorktrees: (dir: unknown) =>
        Promise.resolve(dir === "/x" ? FANOUT_WTS : []),
      tmuxNewSession: () =>
        Promise.resolve({ sessionId: "ses-fan-1", windowIndex: 0, projects: [] }),
      tmuxNewWindow: () =>
        Promise.resolve({ sessionId: "ses-fan-1", windowIndex: 1, projects: [] }),
      uploadBuffer: () => Promise.resolve("/remote/note.md"),
      // submitFanOut awaits refresh(), which calls syncSnapshot; hand it a
      // benign envelope so the refresh resolves instead of crashing in
      // applySyncPayload (the default mock resolves undefined).
      syncSnapshot: () =>
        Promise.resolve({ gen: 1, seq: 1, changed: {} }) as never,
    });
    refreshModelCatalog();
    refreshAgentCatalog();
    // Neutralize dismissDraft (the direct-mount shim) so clearing the draft at
    // the end of submitFanOut doesn't drop the screen's hooks mid-assertion.
    resetStore({
      projects: [],
      activeDraftId: d.id,
      drafts: [d],
      dismissDraft: () => {},
    });
    h = mount(<NewSessionScreen draftId={d.id} />);
    await h.flush();

    // Open the folder picker from the fresh zero state.
    const browse = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim().startsWith("Browse for a folder"),
    );
    expect(browse, "expected a Browse for a folder… button").toBeTruthy();
    act(() => browse!.click());
    await h.flush();

    // The picker opens at /x (the draft cwd). Press Enter in the path field to
    // commit — select() probes gitListWorktrees("/x"), which returns >1
    // worktree, so the modal asks the fan-out question.
    const pathInput = h.docQuery("input") as HTMLInputElement;
    expect(pathInput, "expected the picker's path input").toBeTruthy();
    expect(pathInput.value).toBe("/x");
    act(() => {
      pathInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await h.flush();

    // The fan-out question appears; commit to one session per worktree.
    const fanBtn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "One per worktree",
    );
    expect(fanBtn, "expected the 'One per worktree' fan-out button").toBeTruthy();
    act(() => fanBtn!.click());
    await h.flush();

    // uploadBuffer fires against the fan-out session name (deriveProjectName
    // of /x → "x") for each staged file.
    const ups = api.calls.uploadBuffer ?? [];
    expect(ups.length).toBe(1);
    expect(ups[0]?.[0]).toMatchObject({ projectName: "x", filename: "note.md" });

    // opencodePrompt receives the attachments arg (4th param) — the
    // { remotePath, mime, filename } array — for the first window's prompt.
    const prompts = api.calls.opencodePrompt ?? [];
    expect(prompts.length).toBe(1);
    expect(prompts[0]?.[0]).toBe("ses-fan-1");
    expect(prompts[0]?.[1]).toBe("fan it");
    expect(prompts[0]?.[3]).toEqual([
      { remotePath: "/remote/note.md", mime: "text/markdown", filename: "note.md" },
    ]);
  });
});
