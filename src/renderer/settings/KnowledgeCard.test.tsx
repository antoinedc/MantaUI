// @vitest-environment jsdom
//
// Settings → Sessions "Knowledge" (shared-knowledge spec §4, §8, §11.6): the
// master switch, daily cap, defaults and per-project radio groups, status lines,
// View knowledge, and Recent changes with Undo. Every outcome is reported.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { KnowledgeChange, KnowledgeProjectRow, KnowledgeSettings } from "../../shared/api";
import { EXPLORER_OPEN_EVENT, type OpenFileRequest } from "../explorer/types";
import { useStore } from "../store";
import { installMockApi, mount, type Harness, type MockApi } from "../testHarness";
import { KnowledgeCard } from "./KnowledgeCard";

const row = (over: Partial<KnowledgeProjectRow> = {}): KnowledgeProjectRow => ({
  slug: "manta-0123456789",
  displayName: "manta",
  canonicalId: "github.com/acme/manta",
  repoRules: "box-only",
  sharing: "share-and-read",
  outwardAllowed: true,
  ...over,
});

const settings = (over: Partial<KnowledgeSettings> = {}): KnowledgeSettings => ({
  enabled: true,
  dailyCapUsd: 1,
  repoRules: "box-only",
  sharing: "share-and-read",
  projects: [row()],
  ...over,
});

const change = (over: Partial<KnowledgeChange> = {}): KnowledgeChange => ({
  id: "d_1",
  at: Date.now() - 5 * 60_000,
  kind: "applied",
  summary: "Added how to run the tests",
  reason: "Three sessions needed it",
  area: "project",
  slug: "manta-0123456789",
  undoable: true,
  ...over,
});

describe("KnowledgeCard", () => {
  let h: Harness | null = null;
  let api: MockApi;
  afterEach(() => {
    h?.unmount();
    h = null;
    act(() => {
      useStore.setState({ projects: [], activeProjectName: null, activeWindowByProject: {} } as never);
    });
  });

  async function open(overrides: Record<string, unknown> = {}, props: { onNavigated?: () => void } = {}) {
    ({ api } = installMockApi({
      knowledgeSettingsGet: () => Promise.resolve(settings()),
      knowledgeChanges: () => Promise.resolve({ items: [], nextCursor: null }),
      ...overrides,
    }));
    h = mount(<KnowledgeCard {...props} />);
    await h.flush();
    return h;
  }
  const q = <T extends HTMLElement>(sel: string) => h!.container.querySelector(sel) as T | null;
  const button = (text: string) =>
    Array.from(h!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  const radio = (name: string, value: string) => q<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`);
  const notice = () => q('[data-testid="knowledge-notice"]')?.textContent ?? "";
  async function click(el: HTMLElement | null | undefined) {
    expect(el, "expected the control to exist").toBeTruthy();
    await act(async () => {
      el!.click();
    });
    await h!.flush();
  }
  async function typeInto(el: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function blur(el: HTMLElement) {
    await act(async () => {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      el.blur();
    });
  }
  async function submitCap() {
    await act(async () => {
      q<HTMLFormElement>("form")!.requestSubmit();
    });
    await h!.flush();
  }

  it("an older box (unknown channel) says to update and offers no controls", async () => {
    await open({ knowledgeSettingsGet: () => Promise.reject(new Error("unknown rpc channel: knowledge:settings-get")) });
    expect(h!.text()).toContain("Update your box to use this");
    expect(q('[role="switch"]')).toBeNull();
  });

  it("a transport that answers nothing is treated as unsupported", async () => {
    await open({ knowledgeSettingsGet: () => Promise.resolve(null) });
    expect(h!.text()).toContain("Update your box to use this");
  });

  it("a failed load shows the error and Try again reloads", async () => {
    let calls = 0;
    await open({ knowledgeSettingsGet: () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(settings())) });
    expect(h!.text()).toContain("offline");
    await click(button("Try again"));
    expect(q('[role="switch"]')).toBeTruthy();
  });

  it("renders the switch, cap, defaults and the project's radio groups from the payload", async () => {
    await open({ knowledgeSettingsGet: () => Promise.resolve(settings({ dailyCapUsd: 2.5, sharing: "read-only" })) });
    expect(q('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("2.50");
    expect(radio("knowledge-default-repoRules", "box-only")!.checked).toBe(true);
    expect(radio("knowledge-default-sharing", "read-only")!.checked).toBe(true);
    const slug = "manta-0123456789";
    expect(h!.text()).toContain("github.com/acme/manta");
    expect(radio(`knowledge-${slug}-repoRules`, "default")!.checked).toBe(true);
    expect(radio(`knowledge-${slug}-sharing`, "default")!.checked).toBe(false);
    expect(h!.text()).toContain("Use default (Box only)");
    // the sharing-is-not-access-control note
    expect(h!.text()).toContain("not access control");
  });

  it("groups are native fieldsets with legends", async () => {
    await open();
    const legends = Array.from(h!.container.querySelectorAll("fieldset > legend")).map((l) => l.textContent);
    expect(legends).toEqual(expect.arrayContaining(["Repo rules", "Sharing", "manta"]));
  });

  it("the master switch saves and reports", async () => {
    await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ enabled: false })) });
    await click(q('[role="switch"]'));
    expect(api.calls.knowledgeSettingsSet).toEqual([[{ patch: { enabled: false } }]]);
    expect(q('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    expect(notice()).toBe("Shared knowledge turned off.");
  });

  it("a rejected save shows the box's message and keeps the old value", async () => {
    await open({ knowledgeSettingsSet: () => Promise.reject(new Error("invalid-setting")) });
    await click(q('[role="switch"]'));
    expect(notice()).toBe("Couldn't save: The box rejected that value.");
    expect(q('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="knowledge-notice"]')!.getAttribute("role")).toBe("alert");
  });

  it("while a save is in flight the groups are aria-busy and ignore picks, but stay focusable (not disabled)", async () => {
    let release!: (s: KnowledgeSettings) => void;
    await open({ knowledgeSettingsSet: () => new Promise<KnowledgeSettings>((r) => (release = r)) });
    await act(async () => {
      q<HTMLButtonElement>('[role="switch"]')!.click();
    });
    expect(q<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
    const sharing = radio("knowledge-default-sharing", "private")!;
    expect(sharing.disabled).toBe(false);
    expect(sharing.closest("fieldset")!.getAttribute("aria-busy")).toBe("true");
    await click(sharing); // ignored while busy
    expect(api.calls.knowledgeSettingsSet).toHaveLength(1);
    await act(async () => {
      release(settings({ enabled: false }));
    });
    await h!.flush();
    expect(q<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false);
    expect(sharing.closest("fieldset")!.getAttribute("aria-busy")).toBeNull();
  });

  it("changing a default sends only that key", async () => {
    await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ sharing: "private" })) });
    await click(radio("knowledge-default-sharing", "private"));
    expect(api.calls.knowledgeSettingsSet).toEqual([[{ patch: { sharing: "private" } }]]);
    expect(notice()).toBe("Default sharing set to Private.");
    expect(radio("knowledge-default-sharing", "private")!.checked).toBe(true);
  });

  it("a per-project choice patches that project; 'use default' sends null", async () => {
    const slug = "manta-0123456789";
    await open({
      knowledgeSettingsSet: () => Promise.resolve(settings({ projects: [row({ sharing: "private", sharingOverride: true })] })),
    });
    await click(radio(`knowledge-${slug}-sharing`, "private"));
    expect(api.calls.knowledgeSettingsSet![0]).toEqual([{ patch: { projects: { [slug]: { sharing: "private" } } } }]);
    expect(radio(`knowledge-${slug}-sharing`, "private")!.checked).toBe(true);
    expect(notice()).toBe("Saved manta.");
    await click(radio(`knowledge-${slug}-sharing`, "default"));
    expect(api.calls.knowledgeSettingsSet![1]).toEqual([{ patch: { projects: { [slug]: { sharing: null } } } }]);
  });

  it("refetches the settings when the set answer carries no rows", async () => {
    let gets = 0;
    await open({
      knowledgeSettingsGet: () => Promise.resolve(++gets === 1 ? settings() : settings({ enabled: false })),
      knowledgeSettingsSet: () => Promise.resolve({ enabled: false }),
    });
    await click(q('[role="switch"]'));
    expect(gets).toBe(2);
    expect(q('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
  });

  describe("Repo rules (pending selection + Apply)", () => {
    const slug = "manta-0123456789";
    const applyBtn = (group: string) =>
      q(`fieldset:has(input[name="${group}"])`)!.querySelector("button.manta-knowledge-apply") as HTMLButtonElement;
    const arrowDown = async (el: HTMLElement) => {
      // A native radio group moves the selection and fires `change` on an arrow key.
      await act(async () => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
    };

    it("picking an option (what ArrowDown does) saves NOTHING until Apply", async () => {
      await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ repoRules: "box-only" })) });
      const group = "knowledge-default-repoRules";
      expect(applyBtn(group).getAttribute("aria-disabled")).toBe("true");
      await arrowDown(radio(group, "box-only")!);
      await click(radio(group, "pull-request"));
      expect(radio(group, "pull-request")!.checked).toBe(true);
      expect(api.calls.knowledgeSettingsSet).toBeUndefined();
      expect(applyBtn(group).getAttribute("aria-disabled")).toBeNull();
    });

    it("Apply on Pull request / Direct asks to confirm first; Cancel keeps the pending pick and saves nothing; Confirm saves", async () => {
      await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ repoRules: "pull-request" })) });
      const group = "knowledge-default-repoRules";
      await click(radio(group, "pull-request"));
      await click(applyBtn(group));
      expect(api.calls.knowledgeSettingsSet).toBeUndefined();
      const confirm = q(`[data-testid="${group}-confirm"]`)!;
      expect(confirm.textContent).toContain("open one pull request");
      await click(Array.from(confirm.querySelectorAll("button")).find((b) => b.textContent === "Cancel"));
      expect(q(`[data-testid="${group}-confirm"]`)).toBeNull();
      expect(api.calls.knowledgeSettingsSet).toBeUndefined();
      expect(radio(group, "pull-request")!.checked).toBe(true);
      await click(applyBtn(group));
      await click(Array.from(q(`[data-testid="${group}-confirm"]`)!.querySelectorAll("button")).find((b) => b.textContent === "Confirm"));
      expect(api.calls.knowledgeSettingsSet).toEqual([[{ patch: { repoRules: "pull-request" } }]]);
      expect(notice()).toBe("Default repo rules set to Pull request.");
      expect(q(`[data-testid="${group}-confirm"]`)).toBeNull();
    });

    it("Direct says it commits to the default branch", async () => {
      await open();
      const group = "knowledge-default-repoRules";
      await click(radio(group, "direct"));
      await click(applyBtn(group));
      expect(q(`[data-testid="${group}-confirm"]`)!.textContent).toContain("default branch");
    });

    it("Box only needs no confirmation; Apply saves it straight away", async () => {
      await open({
        knowledgeSettingsGet: () => Promise.resolve(settings({ repoRules: "pull-request" })),
        knowledgeSettingsSet: () => Promise.resolve(settings({ repoRules: "box-only" })),
      });
      const group = "knowledge-default-repoRules";
      await click(radio(group, "box-only"));
      await click(applyBtn(group));
      expect(q(`[data-testid="${group}-confirm"]`)).toBeNull();
      expect(api.calls.knowledgeSettingsSet).toEqual([[{ patch: { repoRules: "box-only" } }]]);
    });

    it("a project's group works the same way and 'Use default' sends null without a confirm", async () => {
      await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ projects: [row({ repoRules: "pull-request", repoRulesOverride: true })] })) });
      const group = `knowledge-${slug}-repoRules`;
      await click(radio(group, "pull-request"));
      expect(api.calls.knowledgeSettingsSet).toBeUndefined();
      await click(applyBtn(group));
      expect(q(`[data-testid="${group}-confirm"]`)!.textContent).toContain("for manta");
      await click(Array.from(q(`[data-testid="${group}-confirm"]`)!.querySelectorAll("button")).find((b) => b.textContent === "Confirm"));
      expect(api.calls.knowledgeSettingsSet![0]).toEqual([{ patch: { projects: { [slug]: { repoRules: "pull-request" } } } }]);
      // the box now reports the override; going back to the default needs no confirm
      await click(radio(group, "default"));
      await click(applyBtn(group));
      expect(q(`[data-testid="${group}-confirm"]`)).toBeNull();
      expect(api.calls.knowledgeSettingsSet![1]).toEqual([{ patch: { projects: { [slug]: { repoRules: null } } } }]);
    });

    it("Apply keeps keyboard focus through its own save (aria-disabled, never disabled)", async () => {
      let release!: (s: KnowledgeSettings) => void;
      await open({ knowledgeSettingsSet: () => new Promise<KnowledgeSettings>((r) => (release = r)) });
      const group = "knowledge-default-repoRules";
      await click(radio(group, "box-only")); // no-op pick of the saved value
      await click(radio(group, "pull-request"));
      await click(applyBtn(group));
      const confirmBtn = Array.from(q(`[data-testid="${group}-confirm"]`)!.querySelectorAll("button")).find((b) => b.textContent === "Confirm") as HTMLButtonElement;
      await click(confirmBtn);
      const apply = applyBtn(group);
      expect(apply.disabled).toBe(false);
      expect(apply.getAttribute("aria-disabled")).toBe("true");
      expect(apply.textContent).toBe("Applying…");
      expect(radio(group, "direct")!.closest("fieldset")!.getAttribute("aria-busy")).toBe("true");
      await act(async () => {
        release(settings({ repoRules: "pull-request" }));
      });
      await h!.flush();
      expect(applyBtn(group).textContent).toBe("Apply");
      expect(applyBtn(group).getAttribute("aria-disabled")).toBe("true"); // nothing pending any more
    });

    it("a rejected save keeps the pending pick and reports the error", async () => {
      await open({ knowledgeSettingsSet: () => Promise.reject(new Error("invalid-setting")) });
      const group = "knowledge-default-repoRules";
      await click(radio(group, "direct"));
      await click(applyBtn(group));
      await click(Array.from(q(`[data-testid="${group}-confirm"]`)!.querySelectorAll("button")).find((b) => b.textContent === "Confirm"));
      expect(notice()).toBe("Couldn't save: The box rejected that value.");
      expect(radio(group, "direct")!.checked).toBe(true);
    });
  });

  it("outward options are disabled with the reason as visible text", async () => {
    const slug = "manta-0123456789";
    await open({
      knowledgeSettingsGet: () =>
        Promise.resolve(
          settings({
            projects: [
              row({
                repoRules: "pull-request",
                repoRulesOverride: true,
                outwardAllowed: false,
                outwardReason: "No GitHub login on this box.",
              }),
            ],
          }),
        ),
    });
    expect(radio(`knowledge-${slug}-repoRules`, "pull-request")!.disabled).toBe(true);
    expect(radio(`knowledge-${slug}-repoRules`, "direct")!.disabled).toBe(true);
    expect(radio(`knowledge-${slug}-repoRules`, "box-only")!.disabled).toBe(false);
    expect(radio(`knowledge-${slug}-repoRules`, "pull-request")!.checked).toBe(true);
    expect(q(`[data-testid="knowledge-project-${slug}"]`)!.textContent).toContain("Acting as Box only. No GitHub login on this box.");
    const describedBy = radio(`knowledge-${slug}-repoRules`, "direct")!.getAttribute("aria-describedby")!;
    expect(h!.container.querySelector(`[id="${describedBy}"]`)!.textContent).toContain("No GitHub login");
  });

  describe("daily cap", () => {
    it("rejects an invalid amount without calling the box and marks the field", async () => {
      await open();
      const input = q<HTMLInputElement>('input[name="dailyCapUsd"]')!;
      await typeInto(input, "abc");
      await submitCap();
      expect(api.calls.knowledgeSettingsSet).toBeUndefined();
      expect(q('[role="alert"]')!.textContent).toContain("dollar amount");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      await typeInto(input, "3");
      expect(input.getAttribute("aria-invalid")).toBeNull();
    });

    it("shows the error on blur but not while typing", async () => {
      await open();
      const input = q<HTMLInputElement>('input[name="dailyCapUsd"]')!;
      await typeInto(input, "1.234");
      expect(q('[role="alert"]')).toBeNull();
      await blur(input);
      expect(q('[role="alert"]')!.textContent).toContain("two decimals");
    });

    it("saves a valid cap and reports it; Save is disabled until the value changes", async () => {
      await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ dailyCapUsd: 2 })) });
      expect(button("Save cap")!.disabled).toBe(true);
      await typeInto(q<HTMLInputElement>('input[name="dailyCapUsd"]')!, "2");
      expect(button("Save cap")!.disabled).toBe(false);
      await submitCap();
      expect(api.calls.knowledgeSettingsSet).toEqual([[{ patch: { dailyCapUsd: 2 } }]]);
      expect(notice()).toBe("Daily cap set to $2.00.");
      expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("2.00");
    });

    it("keeps a half-typed cap when another setting saves", async () => {
      await open({ knowledgeSettingsSet: () => Promise.resolve(settings({ sharing: "private" })) });
      await typeInto(q<HTMLInputElement>('input[name="dailyCapUsd"]')!, "7");
      await click(radio("knowledge-default-sharing", "private"));
      expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("7");
    });
  });

  describe("status lines", () => {
    it("shows only what the payload carries", async () => {
      await open();
      expect(q('[data-testid="knowledge-status"]')).toBeNull();
    });

    it("renders spend, waiting for a capable model and missed briefings", async () => {
      await open({
        knowledgeSettingsGet: () =>
          Promise.resolve(settings({ spentTodayUsd: 0.4, waitingForCapableModel: true, sessionsWithoutBriefingThisWeek: 2 })),
      });
      const lines = Array.from(h!.container.querySelectorAll("[data-status]")).map((l) => l.textContent);
      expect(lines).toEqual([
        "Spent $0.40 of the $1.00 daily cap today.",
        "Waiting for a capable model. Rule and skill work is on hold until one is available.",
        "2 sessions started without a briefing this week.",
      ]);
    });

    it("shows why Knowledge is unavailable, even with the switch off", async () => {
      await open({
        knowledgeSettingsGet: () =>
          Promise.resolve(settings({ enabled: false, unavailableReason: "Node 24 is required.", spentTodayUsd: 0 })),
      });
      expect(q('[data-testid="knowledge-status"]')!.textContent).toBe("Knowledge is off on this box: Node 24 is required.");
    });
  });

  describe("View knowledge", () => {
    const seat = () =>
      act(() => {
        useStore.setState({
          projects: [
            {
              tmuxSession: "manta",
              defaultCwd: "/home/u/manta",
              windows: [{ index: 0, name: "main", active: true, paneCurrentPath: "/home/u/manta", opencodeSessionId: "ses_a" }],
            },
          ],
          activeProjectName: "manta",
          activeWindowByProject: { manta: 0 },
        } as never);
      });

    it("is disabled with a visible reason when no chat session is active", async () => {
      await open();
      const b = button("View knowledge")!;
      expect(b.disabled).toBe(true);
      expect(b.title).toContain("chat session");
      expect(h!.text()).toContain("Open a chat session");
    });

    it("resolves the folder and opens it in the Explorer, then closes Settings", async () => {
      seat();
      let navigated = 0;
      const seen: OpenFileRequest[] = [];
      const on = (e: Event) => seen.push((e as CustomEvent<OpenFileRequest>).detail);
      window.addEventListener(EXPLORER_OPEN_EVENT, on);
      try {
        await open(
          {
            fsResolvePaths: () =>
              Promise.resolve({ results: [{ input: "~/.manta/knowledge", ok: true, abs: "/home/u/.manta/knowledge", kind: "dir", size: 0, mtimeMs: 0 }] }),
          },
          { onNavigated: () => navigated++ },
        );
        await click(button("View knowledge"));
      } finally {
        window.removeEventListener(EXPLORER_OPEN_EVENT, on);
      }
      expect(api.calls.fsResolvePaths).toEqual([[{ base: "/home/u/manta", paths: ["~/.manta/knowledge"] }]]);
      expect(seen).toEqual([{ abs: "/home/u/.manta/knowledge", kind: "dir", owner: { sessionId: "ses_a", cwd: "/home/u/manta" } }]);
      expect(navigated).toBe(1);
    });

    it("says why when the folder can't be opened", async () => {
      seat();
      let navigated = 0;
      await open(
        { fsResolvePaths: () => Promise.resolve({ results: [{ input: "~/.manta/knowledge", ok: false, reason: "missing" }] }) },
        { onNavigated: () => navigated++ },
      );
      await click(button("View knowledge"));
      expect(q('[data-testid="knowledge-view-error"]')!.textContent).toContain("doesn't exist yet");
      expect(navigated).toBe(0);
    });
  });

  describe("Recent changes", () => {
    it("shows the empty state", async () => {
      await open();
      expect(q('[data-testid="knowledge-no-changes"]')).toBeTruthy();
    });

    it("a failed read shows the error and Try again reloads", async () => {
      let calls = 0;
      await open({
        knowledgeChanges: () => (++calls === 1 ? Promise.reject(new Error("db busy")) : Promise.resolve({ items: [change()], nextCursor: null })),
      });
      expect(h!.text()).toContain("db busy");
      await click(Array.from(h!.container.querySelectorAll("button")).filter((b) => b.textContent === "Try again").pop());
      expect(q('[data-testid="knowledge-change-d_1"]')).toBeTruthy();
    });

    it("lists what, why, where and when; only undoable items get Undo", async () => {
      await open({
        knowledgeChanges: () =>
          Promise.resolve({
            items: [change(), change({ id: "d_2", kind: "skipped", summary: "Dropped a note", undoable: false, area: "user", slug: undefined })],
            nextCursor: null,
          }),
      });
      const first = q('[data-testid="knowledge-change-d_1"]')!.textContent!;
      expect(first).toContain("Added how to run the tests");
      expect(first).toContain("Three sessions needed it");
      expect(first).toContain("Project: manta");
      expect(first).toContain("5 min ago");
      expect(q('[data-testid="knowledge-change-d_1"] button')).toBeTruthy();
      expect(q('[data-testid="knowledge-change-d_2"] button')).toBeNull();
      expect(q('[data-testid="knowledge-change-d_2"]')!.textContent).toContain("Your preferences");
    });

    it("pages with the cursor and appends without duplicates", async () => {
      const cursors: Array<string | undefined> = [];
      await open({
        knowledgeChanges: (input?: { cursor?: string }) => {
          cursors.push(input?.cursor);
          return Promise.resolve(
            input?.cursor
              ? { items: [change({ id: "d_1" }), change({ id: "d_2", summary: "Second" })], nextCursor: null }
              : { items: [change({ id: "d_1" })], nextCursor: "c1" },
          );
        },
      });
      await click(button("Load more"));
      expect(cursors).toEqual([undefined, "c1"]);
      expect(h!.container.querySelectorAll('[data-testid^="knowledge-change-"]')).toHaveLength(2);
      expect(button("Load more")).toBeUndefined();
    });

    it("a failed page load says so and keeps the list", async () => {
      await open({
        knowledgeChanges: (input?: { cursor?: string }) =>
          input?.cursor ? Promise.reject(new Error("timeout")) : Promise.resolve({ items: [change()], nextCursor: "c1" }),
      });
      await click(button("Load more"));
      expect(h!.text()).toContain("Couldn't load more changes: timeout");
      expect(q('[data-testid="knowledge-change-d_1"]')).toBeTruthy();
      expect(button("Load more")).toBeTruthy();
    });

    it("Undo awaits the result, is disabled in flight, then shows Undone", async () => {
      let release!: (r: { ok: true }) => void;
      await open({
        knowledgeChanges: () => Promise.resolve({ items: [change()], nextCursor: null }),
        knowledgeUndo: () => new Promise((r) => (release = r as typeof release)),
      });
      await act(async () => {
        button("Undo")!.click();
      });
      const inflight = q<HTMLButtonElement>('[data-testid="knowledge-change-d_1"] button')!;
      expect(inflight.disabled).toBe(true);
      expect(inflight.textContent).toBe("Undoing…");
      await act(async () => {
        release({ ok: true });
      });
      await h!.flush();
      expect(api.calls.knowledgeUndo).toEqual([[{ id: "d_1" }]]);
      expect(q('[data-testid="knowledge-undone-d_1"]')!.textContent).toBe("Undone");
      expect(button("Undo")).toBeUndefined();
    });

    it("an undo that succeeded WITH a warning shows it; one without shows none", async () => {
      await open({
        knowledgeChanges: () => Promise.resolve({ items: [change(), change({ id: "d_2" })], nextCursor: null }),
        knowledgeUndo: (input: { id: string }) =>
          Promise.resolve(input.id === "d_1" ? { ok: true, warning: "the global AGENTS.md block could not be re-written" } : { ok: true }),
      });
      const undoIn = (id: string) => Array.from(q(`[data-testid="knowledge-change-${id}"]`)!.querySelectorAll("button")).find((b) => b.textContent === "Undo");
      await click(undoIn("d_1"));
      await click(undoIn("d_2"));
      expect(q('[data-testid="knowledge-undone-d_1"]')).toBeTruthy();
      expect(q('[data-testid="knowledge-undo-warning-d_1"]')!.textContent).toBe("Undone, but: the global AGENTS.md block could not be re-written");
      expect(q('[data-testid="knowledge-undone-d_2"]')).toBeTruthy();
      expect(q('[data-testid="knowledge-undo-warning-d_2"]')).toBeNull();
    });

    it("an undo conflict names the later change and keeps Undo available", async () => {
      await open({
        knowledgeChanges: () => Promise.resolve({ items: [change()], nextCursor: null }),
        knowledgeUndo: () => Promise.resolve({ ok: false, reason: "a later commit changed the same page", conflictWith: "d_9" }),
      });
      await click(button("Undo"));
      const err = q('[data-testid="knowledge-undo-error-d_1"]')!;
      expect(err.textContent).toContain("a later commit changed the same page");
      expect(err.textContent).toContain("d_9");
      expect(err.getAttribute("role")).toBe("alert");
      expect(button("Undo")!.disabled).toBe(false);
    });

    it("a thrown undo error is shown on the item", async () => {
      await open({
        knowledgeChanges: () => Promise.resolve({ items: [change()], nextCursor: null }),
        knowledgeUndo: () => Promise.reject(new Error("HTTP 503")),
      });
      await click(button("Undo"));
      expect(q('[data-testid="knowledge-undo-error-d_1"]')!.textContent).toBe("Couldn't undo: HTTP 503");
    });

    it("an item the box already marks undone shows Undone, not Undo", async () => {
      await open({ knowledgeChanges: () => Promise.resolve({ items: [change({ undoneAt: Date.now() })], nextCursor: null }) });
      expect(q('[data-testid="knowledge-undone-d_1"]')).toBeTruthy();
      expect(button("Undo")).toBeUndefined();
    });
  });
});
