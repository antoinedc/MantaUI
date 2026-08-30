// @vitest-environment jsdom
//
// Regression tests for nested-modal Escape ownership inside Settings (BET-724,
// requested by BET-736). BET-724 made the Modal primitive own Escape / focus
// trap / restore, and Settings' own dialog is built on `useDialog` (not on
// Modal), so a confirm opened INSIDE Settings (a nested Modal rendered as a
// child of Settings' dialog) must own Escape and Tab — closing only the
// confirm, never the Settings dialog around it.
//
// Test-only file. Settings is not mounted anywhere else in the suite; this
// file mounts it for the first time via the shared testHarness `mount()` and
// stubs `window.api` with the installMockApi pattern, stubbing only the calls
// Settings makes on mount (getClientVersion / getServerVersion / configGet).
//
// Test 1 uses the "Reset all settings?" confirm (confirmReset): it sits on the
// default General tab, so no tab navigation is needed to reach its trigger.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mount, installMockApi, clickCheckbox, type Harness } from "./testHarness";
import { Settings } from "./Settings";
import { useStore } from "./store";

// The confirm used for test 1. "Reset all settings?" (confirmReset) opens from
// the default General tab's Danger zone.
const CONFIRM_LABEL = "Reset all settings?";

describe("Settings — Escape + nested-confirm ownership (BET-724 regression)", () => {
  let h: Harness | null = null;

  const stubApi = () =>
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
    });

  // Settings' own full-screen dialog lives in `container`; the nested
  // ConfirmModal renders through Modal's portal to document.body — so to see
  // BOTH (and count them), query document.body (the container is its child).
  const dialogs = (): HTMLElement[] =>
    [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')];

  const confirmDialog = (): HTMLElement | null =>
    h!.docQuery<HTMLElement>(`[role="dialog"][aria-label="${CONFIRM_LABEL}"]`);

  const clickResetConfirm = () => {
    const btn = [...h!.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Reset all settings…",
    );
    expect(btn, "Reset all settings… trigger button").toBeTruthy();
    act(() => (btn as HTMLButtonElement).click());
  };

  // Let a Modal's exit animation (0.18s) run to completion and drain the
  // mock-api promise microtasks.
  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await h!.flush();
  };

  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("Escape with the confirm open closes only the confirm — Settings stays mounted, onClose not called", async () => {
    const closeCalls: number[] = [];
    stubApi();
    h = mount(<Settings onClose={() => closeCalls.push(1)} />);
    await h.flush();

    expect(dialogs().length).toBe(1);

    clickResetConfirm();
    await h.flush();

    // Confirm is now open: Settings dialog + nested confirm dialog.
    expect(dialogs().length).toBe(2);
    const confirm = confirmDialog();
    expect(confirm, "confirm dialog should be open").toBeTruthy();

    // Focus is trapped inside the confirm; press Escape on its first focusable
    // (Cancel) — the innermost open Modal owns Escape, so only it closes.
    const confirmBtn = confirm!.querySelector<HTMLElement>("button");
    expect(confirmBtn, "confirm has a focusable control").toBeTruthy();
    act(() => {
      confirmBtn!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    // Confirm gone, Settings dialog still mounted, and onClose was NOT called.
    expect(confirmDialog()).toBeNull();
    expect(dialogs().length).toBe(1);
    expect(closeCalls.length).toBe(0);
  });

  it("Escape with no confirm open closes Settings (onClose called exactly once)", async () => {
    const closeCalls: number[] = [];
    stubApi();
    h = mount(<Settings onClose={() => closeCalls.push(1)} />);
    await h.flush();

    const search = h.container.querySelector<HTMLElement>(
      'input[placeholder="Find a setting…"]',
    );
    expect(search, "settings search field").toBeTruthy();

    act(() => {
      search!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await h.flush();

    expect(closeCalls.length).toBe(1);
  });

  it("Escape with focus fallen back to document.body still closes Settings (BET-1052)", async () => {
    const closeCalls: number[] = [];
    stubApi();
    h = mount(<Settings onClose={() => closeCalls.push(1)} />);
    await h.flush();

    // Focus frequently falls back to document.body after clicking a control
    // that unmounts or blurs itself. The old guard treated body as "outside
    // the dialog" and swallowed the Escape, so Settings never closed.
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await h.flush();

    expect(closeCalls.length).toBe(1);
  });

  it("Escape while a nested dialog is mounted does not close Settings (BET-1052)", async () => {
    const closeCalls: number[] = [];
    stubApi();
    h = mount(<Settings onClose={() => closeCalls.push(1)} />);
    await h.flush();

    clickResetConfirm();
    await h.flush();
    expect(confirmDialog(), "confirm dialog should be open").toBeTruthy();

    // Even with focus dropped to document.body, the still-mounted confirm owns
    // Escape — Settings must not close around it.
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    expect(closeCalls.length).toBe(0);
    expect(dialogs().length).toBe(2);
  });

  it("with the confirm open, Tab stays within the confirm (Settings' trap does not fight the nested Modal's)", async () => {
    stubApi();
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();

    clickResetConfirm();
    await h.flush();

    const confirm = confirmDialog();
    expect(confirm, "confirm dialog should be open").toBeTruthy();
    const focusables = [
      ...confirm!.querySelectorAll<HTMLElement>("button"),
    ];
    expect(focusables.length).toBe(2); // Cancel + Reset

    // Tab off the LAST focusable in the confirm: the nested Modal's trap wraps
    // within the confirm, rather than Settings' outer trap claiming the Tab.
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(document.activeElement).toBe(last);

    act(() => {
      last.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Wrapped to the confirm's first control (Cancel) — still inside it.
    expect(document.activeElement).toBe(focusables[0]);
    expect(confirm!.contains(document.activeElement)).toBe(true);
  });
});

// BET-1055: Undo has been removed from every toast. The forge disconnect toast
// (BET-942) is the last confirmation toast Settings keeps, and this test now
// pins the invariant that it carries NO action array — a toast with an action
// never auto-dismisses. The disconnect is one RPC call, and the connected row
// flips to not-connected.
describe("Settings — Forge Disconnect (BET-942)", () => {
  let h: Harness | null = null;

  const stubApi = (forgeDisconnectMock: () => void) =>
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      pluginsRegistry: () => Promise.resolve([]),
      launchersList: () => Promise.resolve([]),
      forgeStatus: () =>
        Promise.resolve({
          connected: true,
          login: "octocat",
          kind: "github",
          source: "cli",
          valid: null,
        }),
      forgeRulesList: () => Promise.resolve([]),
      forgeDisconnect: () => Promise.resolve({ ok: true }).then(forgeDisconnectMock),
    });

  afterEach(() => {
    h?.unmount();
    h = null;
    useStore.setState({ appToasts: [] });
  });

  it("clicking Disconnect calls forgeDisconnect once and the toast has no Undo action", async () => {
    const calls: string[] = [];
    const { api } = stubApi(() => {
      calls.push("disconnect");
    });
    h = mount(<Settings onClose={() => {}} initialSection="extensions" />);
    await h.flush();
    await h.flush();

    const disconnect = [...h.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Disconnect",
    );
    expect(disconnect, "the Disconnect button on the connected row").toBeTruthy();
    act(() => (disconnect as HTMLButtonElement).click());
    await h.flush();

    expect(api.calls.forgeDisconnect ?? []).toHaveLength(1);
    expect(calls).toEqual(["disconnect"]);

    const toast = useStore
      .getState()
      .appToasts.find((t) => String(t.message).includes("Disconnected GitHub"));
    expect(toast, "the disconnect confirmation toast").toBeTruthy();
    expect(toast!.message).toContain(
      "Your gh CLI is untouched — Manta will ignore it until you reconnect.",
    );
    expect(toast!.actions, "no Undo action — reconnect only via device sign-in").toBeUndefined();
  });
});

// BET-1055: schema-driven settings toasts become error-only. A successful
// change (optimistic store → configUpdate → reconcile) raises NO toast; a
// failing configUpdate raises exactly one error toast carrying the disclosure.
describe("Settings — schema-driven toasts are error-only (BET-1055)", () => {
  let h: Harness | null = null;

  // "Auto-rename sessions" is a schema toggle (platform "both",
  // configKey "autoRenameSessions"), committed through applySetting →
  // configUpdate, and lives on the Sessions tab.
  const stubApi = (configUpdate?: () => Promise<unknown>) =>
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      launchersList: () => Promise.resolve([]),
      // configUpdate always resolves to the updated config object in prod; a
      // bare `undefined` made `next[key]` throw and trip the error path.
      configUpdate: configUpdate ?? (() => Promise.resolve({})),
    });

  const toggleAutoRename = () => {
    clickCheckbox(h!, "Auto-rename sessions");
  };

  afterEach(() => {
    h?.unmount();
    h = null;
    useStore.setState({ appToasts: [] });
  });

  it("no toast when a schema-driven change succeeds", async () => {
    const { api } = stubApi();
    h = mount(<Settings onClose={() => {}} initialSection="sessions" />);
    await h.flush();

    toggleAutoRename();
    await h.flush();

    expect(api.calls.configUpdate ?? []).toHaveLength(1);
    expect(useStore.getState().appToasts).toHaveLength(0);
  });

  it("exactly one error toast with the disclosure when configUpdate fails", async () => {
    const { api } = stubApi(() => Promise.reject(new Error("boom")));
    h = mount(<Settings onClose={() => {}} initialSection="sessions" />);
    await h.flush();

    toggleAutoRename();
    await h.flush();

    const toasts = useStore.getState().appToasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toMatch(/^err-/);
    const disclosure = renderToStaticMarkup(
      toasts[0].message as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    expect(disclosure).toContain("set auto-rename sessions.");
    expect(api.calls.configUpdate ?? []).toHaveLength(1);
  });
});

// BET-1455 — Settings > General > Backup, the one user-facing affordance for
// topology restore (the server side shipped in BET-1452/1453). Pins the four
// preview states and the "never a dead control" rule: hidden when there is no
// backup, disabled-with-title when nothing is restorable, enabled + loading
// when it is, and both toast branches on completion.
describe("Settings — Backup section (BET-1455)", () => {
  let h: Harness | null = null;

  const previewStub = (response: unknown) => {
    let current = response;
    const { api } = installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      tmuxRestorePreview: () => Promise.resolve(current),
      tmuxRestoreTopology: () => Promise.resolve({ ok: true, created: 2, failed: 0, message: "Restored 2 windows." }),
    });
    return {
      api,
      setPreview: (next: unknown) => { current = next; },
    };
  };

  const restoreButton = (): HTMLButtonElement | undefined =>
    [...h!.container.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Restore windows",
    ) as HTMLButtonElement | undefined;

  const generalText = (): string => (h!.container.querySelector('[role="tabpanel"]')?.textContent ?? "");

  afterEach(() => {
    h?.unmount();
    h = null;
    useStore.setState({ appToasts: [] });
  });

  it("state 1 — available:false shows the no-backup copy and NO button (not a disabled dead control)", async () => {
    previewStub({ available: false, capturedAt: null, ops: [], skipped: [], restorable: 0 });
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();
    await h.flush();

    expect(generalText()).toContain("No backup yet. Manta saves your window layout automatically as you work.");
    expect(restoreButton(), "Restore windows must not render without a backup").toBeUndefined();
  });

  it("state 3 — restorable>0 shows the timestamp census line and an enabled button", async () => {
    const capturedAt = Date.parse("2026-08-30T20:00:00Z");
    previewStub({
      available: true,
      capturedAt,
      ops: [
        { kind: "create-session", tmuxSession: "proj-a", mantaOwned: true, index: 0, name: "w0", opencodeSessionId: "oc-1", cwd: "/tmp/a", worktreePath: null },
        { kind: "create-window", tmuxSession: "proj-a", mantaOwned: true, index: 2, name: "w2", opencodeSessionId: "oc-2", cwd: "/tmp/a", worktreePath: null },
        { kind: "create-window", tmuxSession: "proj-b", mantaOwned: true, index: 1, name: "w1", opencodeSessionId: "oc-3", cwd: "/tmp/b", worktreePath: null },
      ],
      skipped: [
        { tmuxSession: "proj-b", index: 3, name: "w3", opencodeSessionId: "oc-4", reason: "index-occupied" },
      ],
      restorable: 3,
    });
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();
    await h.flush();

    const text = generalText();
    expect(text).toContain("Manta saves your chat window layout");
    expect(text).toContain("3 window(s) can be restored.");
    // W/P census derives from the ONE preview response: ops+skipped = 4 windows
    // across the 2 distinct tmux sessions.
    expect(text).toContain("4 windows across 2 projects");
    const btn = restoreButton();
    expect(btn, "Restore windows button").toBeTruthy();
    expect(btn!.disabled, "enabled when something is restorable").toBe(false);
    expect(btn!.getAttribute("title")).toBeNull();
  });

  it("state 2 — restorable===0 renders the button disabled with the nothing-to-restore title", async () => {
    previewStub({
      available: true,
      capturedAt: Date.parse("2026-08-30T20:00:00Z"),
      ops: [],
      skipped: [
        { tmuxSession: "proj-a", index: 0, name: "w0", opencodeSessionId: "oc-1", reason: "already-restored" },
      ],
      restorable: 0,
    });
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();
    await h.flush();

    expect(generalText()).toContain("Every saved window is already open.");
    const btn = restoreButton();
    expect(btn, "button still renders (never a hidden no-op)").toBeTruthy();
    expect(btn!.disabled, "disabled when nothing is restorable").toBe(true);
    expect(btn!.getAttribute("title")).toBe("Nothing to restore — every saved window is already open.");
  });

  it("restore reports success via the server's describeRestore copy, then re-previews in place", async () => {
    const capturedAt = Date.parse("2026-08-30T20:00:00Z");
    const { api, setPreview } = previewStub({
      available: true,
      capturedAt,
      ops: [
        { kind: "create-window", tmuxSession: "proj-a", mantaOwned: true, index: 1, name: "w1", opencodeSessionId: "oc-1", cwd: "/tmp/a", worktreePath: null },
      ],
      skipped: [],
      restorable: 1,
    });
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();
    await h.flush();
    expect((api.calls.tmuxRestorePreview ?? []).length, "one preview on entering General").toBe(1);

    // By the time the post-restore re-preview runs, the restored windows are
    // live — the stub models that world so the in-place flip is observable.
    setPreview({
      available: true,
      capturedAt,
      ops: [],
      skipped: [
        { tmuxSession: "proj-a", index: 1, name: "w1", opencodeSessionId: "oc-1", reason: "already-restored" },
      ],
      restorable: 0,
    });
    act(() => restoreButton()!.click());
    await h.flush();
    await h.flush();

    expect(api.calls.tmuxRestoreTopology ?? []).toHaveLength(1);
    const toast = useStore.getState().appToasts.find((t) => String(t.id).startsWith("restore-"));
    expect(toast, "success toast").toBeTruthy();
    expect(String(toast!.message)).toContain("Restored 2 windows.");

    // The section re-previewed AFTER the restore (2nd call) and flipped to the
    // nothing-to-restore state in place — the server plan is now empty.
    expect((api.calls.tmuxRestorePreview ?? []).length, "preview re-run after restore").toBe(2);
    expect(generalText()).toContain("Every saved window is already open.");
  });

  it("restore reports failure through the error disclosure when the call throws or returns ok:false", async () => {
    const capturedAt = Date.parse("2026-08-30T20:00:00Z");
    const preview = {
      available: true as const,
      capturedAt,
      ops: [
        { kind: "create-window" as const, tmuxSession: "proj-a", mantaOwned: true, index: 1, name: "w1", opencodeSessionId: "oc-1", cwd: "/tmp/a", worktreePath: null },
      ],
      skipped: [],
      restorable: 1,
    };
    installMockApi({
      configGet: () => Promise.resolve({}),
      getClientVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      getServerVersion: () => Promise.resolve({ version: "0.0.0-test" }),
      tmuxRestorePreview: () => Promise.resolve(preview),
      tmuxRestoreTopology: () => Promise.reject(new Error("tmux exploded")),
    });
    h = mount(<Settings onClose={() => {}} />);
    await h.flush();
    await h.flush();

    act(() => restoreButton()!.click());
    await h.flush();
    await h.flush();

    const toast = useStore.getState().appToasts.find((t) => String(t.id).startsWith("err-restore-"));
    expect(toast, "error toast").toBeTruthy();
    const disclosure = renderToStaticMarkup(
      toast!.message as unknown as Parameters<typeof renderToStaticMarkup>[0],
    );
    // renderToStaticMarkup HTML-escapes the apostrophe in the headline.
    expect(disclosure).toContain("restore your windows.");
    expect(disclosure).toContain("tmux exploded");
  });
});
