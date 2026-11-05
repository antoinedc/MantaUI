import { describe, it, expect } from "vitest";
import { buildRailGroups, flattenDescendants, projectTreeRoots, virtualRowStatus, windowsInRailOrder } from "./sessionTree";
import { flatSessions } from "./store";
import type { Project, SessionTreeNode, TmuxWindow } from "../shared/types";

const win = (index: number, name: string, sid: string | null = null, extra: Partial<TmuxWindow> = {}): TmuxWindow => ({
  index,
  name,
  active: false,
  paneCurrentPath: "/x",
  opencodeSessionId: sid,
  ...extra,
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
const wn = (index: number, children: SessionTreeNode[] = []) => node({ key: `w${index}`, windowIndex: index, children });
const vn = (key: string, children: SessionTreeNode[] = []) => node({ key, kind: "virtual", sessionId: key, children });

const project = (windows: TmuxWindow[], tree?: SessionTreeNode[], name = "proj"): Project => ({
  tmuxSession: name,
  defaultCwd: "~",
  attached: false,
  windows,
  tree,
});

describe("flattenDescendants", () => {
  it("is depth-first pre-order, root excluded", () => {
    const root = wn(0, [vn("a", [vn("a1", [vn("a1x")]), vn("a2")]), vn("b")]);
    expect(flattenDescendants(root).map((n) => n.key)).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });
});

describe("buildRailGroups", () => {
  const none = () => false;

  it("falls back to windows + job.parentWindowIndex when there is no tree (older box)", () => {
    const p = project([
      win(0, "parent"),
      win(2, "late", null, { job: { id: "j2", status: "running", parentWindowIndex: 0 } }),
      win(1, "early", null, { job: { id: "j1", status: "running", parentWindowIndex: 0 } }),
      win(3, "other"),
    ]);
    const g = buildRailGroups(p, none);
    expect(g.map((x) => x.root?.windowIndex)).toEqual([0, 3]);
    expect(g[0].kids.map((k) => k.windowIndex)).toEqual([1, 2]);
    expect(g[1].kids).toEqual([]);
  });

  it("an empty tree beside windows is treated as no tree", () => {
    const p = project([win(0, "a"), win(1, "b")], []);
    expect(projectTreeRoots(p)).toBeNull();
    expect(buildRailGroups(p, none).map((x) => x.root?.windowIndex)).toEqual([0, 1]);
  });

  it("without a tree a pinned root leaves with everything beneath it (as before)", () => {
    const p = project([win(0, "parent"), win(1, "kid", null, { job: { id: "j", status: "running", parentWindowIndex: 0 } })]);
    expect(buildRailGroups(p, (i) => i === 0)).toEqual([]);
  });

  it("with a tree: roots in the box's order, descendants flattened under each", () => {
    const p = project([win(0, "a"), win(1, "b"), win(2, "c")], [wn(2), wn(0, [vn("v", [wn(1)])])]);
    const g = buildRailGroups(p, none);
    expect(g.map((x) => x.root?.key)).toEqual(["w2", "w0"]);
    expect(g[1].kids.map((k) => k.key)).toEqual(["v", "w1"]);
  });

  it("with a tree: a pinned root's descendants stay; a pinned root with none disappears", () => {
    const p = project([win(0, "a"), win(1, "b"), win(2, "c")], [wn(0, [vn("v", [wn(1)])]), wn(2)]);
    const g = buildRailGroups(p, (i) => i === 0 || i === 2);
    expect(g).toHaveLength(1);
    expect(g[0].root).toBeNull();
    expect(g[0].kids.map((k) => k.key)).toEqual(["v", "w1"]);
  });

  it("with a tree: a window it does not mention is appended as a root", () => {
    const p = project([win(0, "a"), win(1, "b")], [wn(0)]);
    expect(buildRailGroups(p, none).map((x) => x.root?.windowIndex)).toEqual([0, 1]);
  });
});

describe("windowsInRailOrder / flatSessions (⌘1..9, ⌥⌘↑/↓)", () => {
  it("without a tree: the windows, as before", () => {
    const p = project([win(2, "c"), win(0, "a")]);
    expect(windowsInRailOrder(p).map((w) => w.index)).toEqual([2, 0]);
    expect(flatSessions([p]).map((f) => f.window.index)).toEqual([2, 0]);
  });

  it("with a tree: window rows only, in tree order; virtual rows are skipped", () => {
    const p = project(
      [win(0, "a"), win(1, "b"), win(2, "c"), win(3, "d")],
      [vn("outside", [wn(3)]), wn(2, [vn("sub", [wn(0)])]), wn(1)],
    );
    expect(windowsInRailOrder(p).map((w) => w.index)).toEqual([3, 2, 0, 1]);
    expect(flatSessions([p]).map((f) => f.window.index)).toEqual([3, 2, 0, 1]);
  });

  it("spans projects in project order; a window missing from the tree still gets a slot at the end", () => {
    const a = project([win(0, "a"), win(1, "b")], [wn(1)], "pa");
    const b = project([win(0, "c")], [wn(0)], "pb");
    expect(flatSessions([a, b]).map((f) => `${f.project.tmuxSession}/${f.window.index}`)).toEqual(["pa/1", "pa/0", "pb/0"]);
  });

  it("a duplicate window is listed once", () => {
    const p = project([win(0, "a")], [wn(0, [wn(0)])]);
    expect(windowsInRailOrder(p).map((w) => w.index)).toEqual([0]);
  });
});

describe("virtualRowStatus", () => {
  const payload = { running: false, busy: false, startedAt: null, attention: null, subagents: 0, stopped: false } as const;

  it("is undefined without a payload", () => {
    expect(virtualRowStatus(undefined)).toBeUndefined();
  });
  it("own turn or busy beneath reads as running; the subagent count and attention carry over", () => {
    expect(virtualRowStatus({ ...payload, busy: true, subagents: 2 })).toMatchObject({ running: true, subagents: 2, attention: false });
    expect(virtualRowStatus({ ...payload, running: true })?.running).toBe(true);
    expect(virtualRowStatus({ ...payload, attention: "permission" })).toMatchObject({ attention: true, attentionKind: "permission" });
    expect(virtualRowStatus(payload)).toMatchObject({ running: false, attention: false, attentionKind: undefined });
  });
});
