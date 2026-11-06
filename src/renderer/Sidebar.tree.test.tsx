// @vitest-environment jsdom
//
// Session tree, stage (b) (docs/superpowers/specs/2026-11-05-session-tree.md §10): the sidebar renders the box's
// `Project.tree` — window rows as before plus window-less (virtual) rows — and opens a virtual row through
// `sessions:materialize`. Without a tree it renders from `windows` exactly as before (Sidebar.test.tsx).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { Sidebar } from "./Sidebar";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { useStore } from "./store";
import type { Project, SessionMaterializeResult, SessionTreeNode, TmuxWindow } from "../shared/types";

const win = (index: number, name: string, sid: string | null): TmuxWindow => ({
  index,
  name,
  active: index === 0,
  paneCurrentPath: "/x",
  opencodeSessionId: sid,
});

const node = (over: Partial<SessionTreeNode> & { key: string }): SessionTreeNode => ({
  sessionId: null,
  kind: "window",
  windowIndex: null,
  title: over.key,
  job: null,
  outside: false,
  children: [],
  ...over,
});

const winNode = (w: TmuxWindow, children: SessionTreeNode[] = []): SessionTreeNode =>
  node({ key: w.opencodeSessionId ?? `window:proj:${w.index}`, sessionId: w.opencodeSessionId, windowIndex: w.index, title: w.name, children });

const virt = (sid: string, title: string, children: SessionTreeNode[] = [], outside = false): SessionTreeNode =>
  node({ key: sid, sessionId: sid, kind: "virtual", title, children, outside });

const WINDOWS = [win(0, "orch", "ses_o"), win(1, "jobwin", "ses_j"), win(2, "term", null)];

function treeProject(windows: TmuxWindow[] = WINDOWS, tree?: SessionTreeNode[]): Project {
  return {
    tmuxSession: "proj",
    defaultCwd: "~",
    attached: false,
    windows,
    tree: tree ?? [
      winNode(windows[0], [virt("ses_sub", "subagent", [winNode(windows[1])])]),
      winNode(windows[2]),
      virt("ses_out", "driver", [], true),
    ],
  };
}

describe("Sidebar — session tree rows", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const mountSidebar = async (): Promise<Harness> => {
    h = mount(
      <Sidebar
        onOpenSettings={() => {}}
        onNewProject={() => {}}
        onNewSessionInProject={() => {}}
        onOpenResumeModal={() => {}}
        onOpenCto={() => {}}
        ctoState={null}
        onOpenRoutines={() => {}}
        routinesBadge={{ needsYou: 0, unread: 0 }}
      />,
    );
    await h.flush();
    return h;
  };
  const rows = () => Array.from(h!.container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const rowNamed = (name: string) => {
    const r = rows().find((el) => el.textContent?.includes(name));
    expect(r, `a row named ${name}`).toBeTruthy();
    return r!;
  };
  const toasts = () => useStore.getState().appToasts.map((t) => String(t.message));
  // Nothing selected, no leftovers from the previous test.
  const reset = (over: Parameters<typeof resetStore>[0]) =>
    resetStore({ activeProjectName: null, activeWindowByProject: {}, activeDraftId: null, appToasts: [], windowStatusBySession: {}, ...over });
  const status = (over: object = {}) => ({ running: false, busy: false, startedAt: null, attention: null, subagents: 0, stopped: false, ...over });

  beforeEach(() => {
    localStorage.clear();
    installMockApi();
    reset({ pinnedWindows: [], appToasts: [], projects: [treeProject()] });
  });

  it("renders roots in the box's order with each root's descendants flattened depth-first beneath it", async () => {
    await mountSidebar();
    const texts = rows().map((r) => r.textContent ?? "");
    const order = ["orch", "subagent", "jobwin", "term", "driver"].map((n) => texts.findIndex((t) => t.includes(n)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The two descendants sit in the child band; the roots do not.
    expect(rowNamed("subagent").getAttribute("aria-level")).toBe("2");
    expect(rowNamed("jobwin").getAttribute("aria-level")).toBe("2");
    expect(rowNamed("orch").getAttribute("aria-level")).toBeNull();
    expect(rowNamed("driver").getAttribute("aria-level")).toBeNull();
  });

  it("a terminal window row renders as an ordinary window row (pin button, no virtual marker)", async () => {
    await mountSidebar();
    const term = rowNamed("term");
    expect(term.querySelector('button[aria-label="Pin"]')).not.toBeNull();
    expect(term.title).not.toContain("Not open in a window");
  });

  it("a root with no window and no parent carries the 'started outside Manta' mark; other virtual rows do not", async () => {
    await mountSidebar();
    expect(rowNamed("driver").querySelector('[aria-label="started outside Manta"]')).not.toBeNull();
    expect(rowNamed("subagent").querySelector('[aria-label="started outside Manta"]')).toBeNull();
    expect(rowNamed("orch").querySelector('[aria-label="started outside Manta"]')).toBeNull();
  });

  it("a virtual row has no pin / close / rename controls", async () => {
    await mountSidebar();
    const v = rowNamed("subagent");
    expect(v.querySelector("button")).toBeNull();
    act(() => v.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await h!.flush();
    expect(h!.docText()).not.toContain("Close session");
  });

  it("a virtual row shows its status from the window-status map by session id", async () => {
    reset({
      pinnedWindows: [],
      projects: [treeProject()],
      windowStatusBySession: { ses_sub: status({ running: true, subagents: 2 }), ses_out: status({ attention: "question" }) },
    });
    await mountSidebar();
    expect(rowNamed("subagent").querySelector('[title^="Running"]')?.getAttribute("title")).toContain("2 subagents");
    expect(rowNamed("driver").querySelector('[title*="question"]')).not.toBeNull();
  });

  it("a virtual row whose descendants are busy reads as running (the box's busy rollup)", async () => {
    reset({ pinnedWindows: [], projects: [treeProject()], windowStatusBySession: { ses_sub: status({ busy: true }) } });
    await mountSidebar();
    expect(rowNamed("subagent").querySelector('[title^="Running"]')).not.toBeNull();
  });

  describe("opening a virtual row", () => {
    const ok = (windowIndex: number): SessionMaterializeResult => ({ ok: true, project: "proj", windowIndex, sessionId: "ses_sub" });

    it("calls sessions:materialize with the session id, then selects the returned window", async () => {
      const calls: unknown[] = [];
      const { api } = installMockApi({
        sessionsMaterialize: (a: unknown) => (calls.push(a), Promise.resolve(ok(3))),
      });
      // The box already refreshed the list: the new window is in the store when the answer lands.
      reset({ pinnedWindows: [], appToasts: [], projects: [treeProject([...WINDOWS, win(3, "subagent", "ses_sub")])] });
      await mountSidebar();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      expect(calls).toEqual([{ sessionId: "ses_sub" }]);
      expect(useStore.getState().activeProjectName).toBe("proj");
      expect(useStore.getState().activeWindowByProject["proj"]).toBe(3);
      expect(api.calls.tmuxSelectWindow).toBeUndefined(); // project was not active yet: the store view moves, as for any row
      expect(toasts()).toEqual([]);
    });

    it("refetches the project list once when the returned window is not known yet, then selects it", async () => {
      let refreshes = 0;
      installMockApi({ sessionsMaterialize: () => Promise.resolve(ok(3)) });
      reset({
        pinnedWindows: [],
        appToasts: [],
        projects: [treeProject()],
        refresh: async () => {
          refreshes++;
          useStore.setState({ projects: [treeProject([...WINDOWS, win(3, "subagent", "ses_sub")])] });
        },
      });
      await mountSidebar();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      expect(refreshes).toBe(1);
      expect(useStore.getState().activeWindowByProject["proj"]).toBe(3);
      expect(toasts()).toEqual([]);
    });

    it("says so when the window never shows up after the refetch", async () => {
      installMockApi({ sessionsMaterialize: () => Promise.resolve(ok(9)) });
      reset({ pinnedWindows: [], appToasts: [], projects: [treeProject()], refresh: async () => {} });
      await mountSidebar();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      expect(toasts()).toEqual(["Couldn't open this session."]);
      expect(useStore.getState().activeProjectName).toBeNull();
    });

    it("an ok:false answer shows the box's message as an error toast and selects nothing", async () => {
      installMockApi({
        sessionsMaterialize: () =>
          Promise.resolve({ ok: false, reason: "handoff", message: "A handoff of this conversation is in progress — try again in a moment." }),
      });
      await mountSidebar();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      const t = useStore.getState().appToasts;
      expect(t.map((x) => x.message)).toEqual(["A handoff of this conversation is in progress — try again in a moment."]);
      expect(t[0].tone).toBe("error");
      expect(useStore.getState().activeProjectName).toBeNull();
    });

    it("a thrown error shows a generic error toast", async () => {
      installMockApi({ sessionsMaterialize: () => Promise.reject(new Error("HTTP 500")) });
      await mountSidebar();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      const t = useStore.getState().appToasts;
      expect(t.map((x) => x.message)).toEqual(["Couldn't open this session."]);
      expect(t[0].tone).toBe("error");
    });

    it("an empty answer (a box without the channel) also reports instead of doing nothing", async () => {
      installMockApi(); // the mock resolves undefined
      await mountSidebar();
      act(() => rowNamed("driver").click());
      await h!.flush();
      expect(toasts()).toEqual(["Couldn't open this session."]);
    });

    it("the row is disabled while the open is in flight: a second click is ignored; it re-enables afterwards", async () => {
      let calls = 0;
      let release!: (r: SessionMaterializeResult) => void;
      installMockApi({
        sessionsMaterialize: () => (
          calls++,
          new Promise<SessionMaterializeResult>((res) => {
            release = res;
          })
        ),
      });
      await mountSidebar();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      expect(rowNamed("subagent").getAttribute("aria-disabled")).toBe("true");
      act(() => rowNamed("subagent").click());
      await h!.flush();
      expect(calls).toBe(1);
      // Another row is unaffected.
      expect(rowNamed("driver").getAttribute("aria-disabled")).toBeNull();
      await act(async () => {
        release({ ok: false, reason: "failed", message: "Couldn't open this session." });
      });
      await h!.flush();
      expect(rowNamed("subagent").getAttribute("aria-disabled")).toBeNull();
      act(() => rowNamed("subagent").click());
      await h!.flush();
      expect(calls).toBe(2);
    });

    it("Enter on a keyboard-focused virtual row opens it", async () => {
      const calls: unknown[] = [];
      installMockApi({ sessionsMaterialize: (a: unknown) => (calls.push(a), Promise.resolve({ ok: false, reason: "failed", message: "no" })) });
      await mountSidebar();
      const tree = h!.container.querySelector('[role="tree"]') as HTMLElement;
      const press = (key: string) => act(() => void tree.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
      // group header, orch, subagent
      press("ArrowDown");
      press("ArrowDown");
      press("ArrowDown");
      press("Enter");
      await h!.flush();
      expect(calls).toEqual([{ sessionId: "ses_sub" }]);
    });
  });

  it("window rows keep selection, pin and activation behaviour (a window in the tree selects as before)", async () => {
    await mountSidebar();
    act(() => rowNamed("jobwin").click());
    await h!.flush();
    expect(useStore.getState().activeProjectName).toBe("proj");
    expect(useStore.getState().activeWindowByProject["proj"]).toBe(1);
  });

  it("a pinned root leaves the group, but its descendants (virtual rows included) stay visible", async () => {
    reset({ pinnedWindows: ["proj/0"], projects: [treeProject()] });
    await mountSidebar();
    // "orch" appears once (the Pinned section); the subagent and job beneath it are still in the group.
    expect(rows().filter((r) => r.textContent?.includes("orch")).length).toBe(1);
    expect(rowNamed("subagent")).toBeTruthy();
    expect(rowNamed("jobwin")).toBeTruthy();
  });

  it("a window the tree does not mention is still reachable (appended as a root)", async () => {
    reset({ pinnedWindows: [], projects: [treeProject(WINDOWS, [winNode(WINDOWS[0])])] });
    await mountSidebar();
    expect(rowNamed("jobwin").getAttribute("aria-level")).toBeNull();
    expect(rowNamed("term")).toBeTruthy();
  });

  it("without a tree it renders from windows + job.parentWindowIndex, as before", async () => {
    reset({
      pinnedWindows: [],
      projects: [
        {
          tmuxSession: "proj",
          defaultCwd: "~",
          attached: false,
          windows: [
            win(0, "parent", "ses_p"),
            { ...win(1, "jobwin", "ses_j"), job: { id: "j1", status: "running", parentWindowIndex: 0 } },
            win(2, "term", null),
          ],
        },
      ],
    });
    await mountSidebar();
    expect(rowNamed("jobwin").getAttribute("aria-level")).toBe("2");
    expect(rowNamed("parent").getAttribute("aria-level")).toBeNull();
    expect(rowNamed("term").getAttribute("aria-level")).toBeNull();
    expect(h!.container.querySelectorAll('[aria-label="started outside Manta"]').length).toBe(0);
  });
});
