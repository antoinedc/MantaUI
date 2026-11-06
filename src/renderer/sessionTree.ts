// The session tree, client side (docs/superpowers/specs/2026-11-05-session-tree.md §3, §10). Pure helpers: the box
// decides what the rows are (`Project.tree`); the client flattens each root's descendants depth-first (pre-order)
// into one indentation band and falls back to `windows` + `job.parentWindowIndex` when the box sends no tree.

import type { Project, SessionTreeNode, TmuxWindow, WindowStatusPayload } from "../shared/types";
import type { WindowStatusUI } from "./store";

/** A root row and the rows indented beneath it. `root` is null when the root window is pinned (it renders in the
 *  Pinned section) but its descendants still need a place in the workspace group. */
export type RailGroup = { key: string; root: SessionTreeNode | null; kids: SessionTreeNode[] };

function windowNode(w: TmuxWindow, project: string): SessionTreeNode {
  return {
    key: `window:${project}:${w.index}`,
    sessionId: w.opencodeSessionId,
    kind: "window",
    windowIndex: w.index,
    title: w.name,
    job: null,
    outside: false,
    children: [],
  };
}

/** A node's descendants, depth-first pre-order (the root itself excluded). */
export function flattenDescendants(node: SessionTreeNode): SessionTreeNode[] {
  const out: SessionTreeNode[] = [];
  const walk = (n: SessionTreeNode) => {
    for (const c of n.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** The box's roots for a project, or null when it sent no (usable) tree — an older box, or an empty tree beside
 *  windows, which the box never means. The client then renders from `windows`. */
export function projectTreeRoots(p: Project): SessionTreeNode[] | null {
  return p.tree && p.tree.length > 0 ? p.tree : null;
}

/**
 * Rail layout for one project: root rows in display order, each with its flattened descendants.
 * Without a tree this is exactly the pre-tree rail: windows the box nested (`job.parentWindowIndex`) sit under that
 * window, sorted by index; a pinned root leaves the group with everything beneath it.
 * With a tree, a window the tree does not mention is appended as a root so it is never unreachable, and a pinned
 * root's descendants stay in the group (running work — virtual rows especially — is never hidden).
 */
export function buildRailGroups(p: Project, isPinned: (windowIndex: number) => boolean): RailGroup[] {
  const roots = projectTreeRoots(p);
  if (!roots) {
    const hidden = new Set<number>();
    const children = new Map<number, number[]>();
    for (const w of p.windows) {
      const parent = w.job?.parentWindowIndex;
      if (parent == null) continue;
      hidden.add(w.index);
      const arr = children.get(parent) ?? [];
      arr.push(w.index);
      children.set(parent, arr);
    }
    for (const arr of children.values()) arr.sort((x, y) => x - y);
    const groups: RailGroup[] = [];
    for (const w of p.windows) {
      if (isPinned(w.index) || hidden.has(w.index)) continue;
      const kids: SessionTreeNode[] = [];
      for (const idx of children.get(w.index) ?? []) {
        const cw = p.windows.find((x) => x.index === idx);
        if (cw) kids.push(windowNode(cw, p.tmuxSession));
      }
      groups.push({ key: `w${w.index}`, root: windowNode(w, p.tmuxSession), kids });
    }
    return groups;
  }

  const seen = new Set<number>();
  const mark = (n: SessionTreeNode) => {
    if (n.kind === "window" && n.windowIndex != null) seen.add(n.windowIndex);
  };
  for (const r of roots) {
    mark(r);
    for (const d of flattenDescendants(r)) mark(d);
  }
  const all = [...roots];
  for (const w of p.windows) if (!seen.has(w.index)) all.push(windowNode(w, p.tmuxSession));

  const groups: RailGroup[] = [];
  for (const r of all) {
    const pinnedRoot = r.kind === "window" && r.windowIndex != null && isPinned(r.windowIndex);
    groups.push({ key: r.key, root: pinnedRoot ? null : r, kids: flattenDescendants(r) });
  }
  return groups.filter((g) => g.root !== null || g.kids.length > 0);
}

/** Window rows in the order the sidebar shows them (tree order when the box sent one) — ⌘1..9 and ⌥⌘↑/↓ walk
 *  these; virtual rows have no window and are reached by click. */
export function windowsInRailOrder(p: Project): TmuxWindow[] {
  const roots = projectTreeRoots(p);
  if (!roots) return p.windows;
  const byIndex = new Map(p.windows.map((w) => [w.index, w]));
  const out: TmuxWindow[] = [];
  const taken = new Set<number>();
  const take = (n: SessionTreeNode) => {
    if (n.kind !== "window" || n.windowIndex == null || taken.has(n.windowIndex)) return;
    const w = byIndex.get(n.windowIndex);
    if (!w) return;
    taken.add(n.windowIndex);
    out.push(w);
  };
  for (const r of roots) {
    take(r);
    for (const d of flattenDescendants(r)) take(d);
  }
  for (const w of p.windows) if (!taken.has(w.index)) out.push(w);
  return out;
}

/** The rail dot / tooltip inputs for a window-less row, from the box's per-session rollup. */
export function virtualRowStatus(payload: WindowStatusPayload | undefined): WindowStatusUI | undefined {
  if (!payload) return undefined;
  return {
    running: payload.running || payload.busy,
    subagents: payload.subagents,
    attention: payload.attention != null,
    attentionKind: payload.attention ?? undefined,
  };
}
