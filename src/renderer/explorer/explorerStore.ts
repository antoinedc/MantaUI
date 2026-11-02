// Explorer shell state (spec §Layout, contract E0). Per-session layout is
// persisted to localStorage (`manta:explorer:<sessionId>`, debounced); the open
// file, tree root, history and Expanded flag live in memory per session. The
// app-wide bits are the sidebar-hidden flag, the Markdown view preference and
// the (global) Artifacts open flag.
//
// `setRightPanel` is the ONLY writer of the right-slot state (Explorer vs
// Artifacts are mutually exclusive): every opener — toggles, ⌘E / ⌘I, path
// clicks, `manta-open-review` — goes through it.

import { useSyncExternalStore } from "react";
import type { FileTarget, MdView, OpenFileRequest } from "./types";
import {
  ARTIFACTS_OPEN_KEY,
  EXPLORER_DEFAULT_RATIO,
  LAYOUT_PERSIST_DEBOUNCE_MS,
  MD_VIEW_KEY,
  SIDEBAR_HIDDEN_KEY,
  TREE_DEFAULT_PX,
  dirname,
  explorerLayoutKey,
  isInsideRoot,
  treeToggleDisabled,
} from "./layout";

export type RightPanel = "explorer" | "artifacts" | "none";

export type SessionLayout = {
  open: boolean;
  /** Explorer share of the split, in percent. */
  ratio: number;
  treeOpen: boolean;
  treeWidth: number;
};

export type ExplorerSession = {
  layout: SessionLayout;
  /** The user (or a ⌘-click) asked for Expanded. */
  expanded: boolean;
  /** The window is too narrow for the split — the shell sets this. */
  narrow: boolean;
  /** Tree root; null = the session folder. */
  root: string | null;
  file: FileTarget | null;
  /** A folder a path click asked the tree to reveal. */
  focusDir: string | null;
  history: { entries: FileTarget[]; index: number };
};

type AppState = { sidebarHidden: boolean; mdView: MdView; artifactsOpen: boolean };

const HISTORY_LIMIT = 100;

const DEFAULT_LAYOUT: SessionLayout = {
  open: false,
  ratio: EXPLORER_DEFAULT_RATIO,
  treeOpen: false,
  treeWidth: TREE_DEFAULT_PX,
};

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* localStorage can throw in embedded contexts; the state still holds in memory */
  }
}

export function parseLayout(raw: string | null): SessionLayout {
  if (!raw) return DEFAULT_LAYOUT;
  try {
    const v = JSON.parse(raw) as Partial<SessionLayout> | null;
    if (!v || typeof v !== "object") return DEFAULT_LAYOUT;
    const ratio = typeof v.ratio === "number" && v.ratio >= 5 && v.ratio <= 95 ? v.ratio : DEFAULT_LAYOUT.ratio;
    const treeWidth = typeof v.treeWidth === "number" && v.treeWidth > 0 ? v.treeWidth : DEFAULT_LAYOUT.treeWidth;
    return { open: v.open === true, ratio, treeOpen: v.treeOpen === true, treeWidth };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const sessions = new Map<string, ExplorerSession>();
const listeners = new Set<() => void>();
let app: AppState | null = null;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function loadApp(): AppState {
  if (app) return app;
  app = {
    sidebarHidden: readStorage(SIDEBAR_HIDDEN_KEY) === "1",
    mdView: readStorage(MD_VIEW_KEY) === "source" ? "source" : "rendered",
    artifactsOpen: readStorage(ARTIFACTS_OPEN_KEY) === "1",
  };
  return app;
}

function loadSession(sessionId: string): ExplorerSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      layout: parseLayout(readStorage(explorerLayoutKey(sessionId))),
      expanded: false,
      narrow: false,
      root: null,
      file: null,
      focusDir: null,
      history: { entries: [], index: -1 },
    };
    sessions.set(sessionId, s);
  }
  return s;
}

function persist(sessionId: string): void {
  const prev = persistTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  persistTimers.set(
    sessionId,
    setTimeout(() => {
      persistTimers.delete(sessionId);
      const s = sessions.get(sessionId);
      if (s) writeStorage(explorerLayoutKey(sessionId), JSON.stringify(s.layout));
    }, LAYOUT_PERSIST_DEBOUNCE_MS),
  );
}

/** Write any pending layout now (tests; also safe before unload). */
export function flushExplorerPersist(): void {
  for (const [sessionId, t] of persistTimers) {
    clearTimeout(t);
    const s = sessions.get(sessionId);
    if (s) writeStorage(explorerLayoutKey(sessionId), JSON.stringify(s.layout));
  }
  persistTimers.clear();
}

function patchSession(sessionId: string, patch: Partial<ExplorerSession>, persistLayout = false): void {
  const cur = loadSession(sessionId);
  sessions.set(sessionId, { ...cur, ...patch });
  if (persistLayout) persist(sessionId);
  emit();
}

function patchLayout(sessionId: string, patch: Partial<SessionLayout>): void {
  const cur = loadSession(sessionId);
  patchSession(sessionId, { layout: { ...cur.layout, ...patch } }, true);
}

function patchApp(patch: Partial<AppState>): void {
  app = { ...loadApp(), ...patch };
  emit();
}

// --- reads ------------------------------------------------------------------

export function getExplorerSession(sessionId: string): ExplorerSession {
  return loadSession(sessionId);
}

export function getAppState(): AppState {
  return loadApp();
}

export function useExplorerSession(sessionId: string): ExplorerSession {
  return useSyncExternalStore(subscribe, () => loadSession(sessionId));
}

/** Whether this session's Explorer toggle reads "open" (false for no session). */
export function useExplorerOpen(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (sessionId ? loadSession(sessionId).layout.open : false));
}

/**
 * Whether this exact target (file + line range) is what the session's Explorer
 * is showing right now. The snapshot is a boolean, so a transcript full of path
 * links re-renders only the ones whose answer flips.
 */
export function useFileTargetActive(sessionId: string, abs: string, line?: number, endLine?: number): boolean {
  return useSyncExternalStore(subscribe, () => {
    const s = loadSession(sessionId);
    return s.layout.open && sameTarget(s.file, { abs, line, endLine });
  });
}

export function useSidebarHidden(): boolean {
  return useSyncExternalStore(subscribe, () => loadApp().sidebarHidden);
}

export function useMdView(): MdView {
  return useSyncExternalStore(subscribe, () => loadApp().mdView);
}

export function useArtifactsOpen(): boolean {
  return useSyncExternalStore(subscribe, () => loadApp().artifactsOpen);
}

/** Explorer if this session's Explorer is open; else Artifacts if open; else nothing. */
export function shownRightPanel(sessionId: string | null): RightPanel {
  if (sessionId && loadSession(sessionId).layout.open) return "explorer";
  return loadApp().artifactsOpen ? "artifacts" : "none";
}

export function useShownRightPanel(sessionId: string | null): RightPanel {
  return useSyncExternalStore(subscribe, () => shownRightPanel(sessionId));
}

/** The Explorer fills the content (user choice, or the window is too narrow). */
export function isEffectivelyExpanded(s: ExplorerSession): boolean {
  return s.expanded || s.narrow;
}

// --- right slot ---------------------------------------------------------------

export function setRightPanel(sessionId: string | null, which: RightPanel): void {
  const nextArtifacts = which === "artifacts";
  if (loadApp().artifactsOpen !== nextArtifacts) {
    writeStorage(ARTIFACTS_OPEN_KEY, nextArtifacts ? "1" : "0");
    patchApp({ artifactsOpen: nextArtifacts });
  }
  if (!sessionId) return;
  const cur = loadSession(sessionId);
  const open = which === "explorer";
  if (cur.layout.open === open && (open || !cur.expanded)) return;
  patchSession(
    sessionId,
    { layout: { ...cur.layout, open }, expanded: open ? cur.expanded : false },
    true,
  );
}

export function toggleExplorer(sessionId: string): void {
  setRightPanel(sessionId, shownRightPanel(sessionId) === "explorer" ? "none" : "explorer");
}

export function toggleArtifacts(sessionId: string | null): void {
  setRightPanel(sessionId, shownRightPanel(sessionId) === "artifacts" ? "none" : "artifacts");
}

// --- sidebar / markdown preference -------------------------------------------------

export function setSidebarHidden(hidden: boolean): void {
  if (loadApp().sidebarHidden === hidden) return;
  writeStorage(SIDEBAR_HIDDEN_KEY, hidden ? "1" : "0");
  patchApp({ sidebarHidden: hidden });
}

export function toggleSidebarHidden(): void {
  setSidebarHidden(!loadApp().sidebarHidden);
}

export function setMdView(v: MdView): void {
  if (loadApp().mdView === v) return;
  writeStorage(MD_VIEW_KEY, v);
  patchApp({ mdView: v });
}

// --- layout -------------------------------------------------------------------

export function setRatio(sessionId: string, ratio: number): void {
  if (!Number.isFinite(ratio)) return;
  const r = Math.min(95, Math.max(5, ratio));
  if (loadSession(sessionId).layout.ratio === r) return;
  patchLayout(sessionId, { ratio: r });
}

export function setTreeOpen(sessionId: string, open: boolean): void {
  if (loadSession(sessionId).layout.treeOpen === open) return;
  patchLayout(sessionId, { treeOpen: open });
}

/** Measured width of a session's Explorer column; the shell reports it so a key
 *  handler outside the panel can tell whether the tree has room. In memory only. */
const explorerWidths = new Map<string, number>();

export function reportExplorerWidth(sessionId: string, width: number | null): void {
  if (width == null) explorerWidths.delete(sessionId);
  else explorerWidths.set(sessionId, width);
}

/**
 * ⌥⌘E. Flips the tree, unless the Explorer is too narrow to show one — then
 * nothing changes and the caller shows the reason (returns false).
 */
export function toggleTree(sessionId: string): boolean {
  if (treeToggleDisabled(explorerWidths.get(sessionId) ?? 0)) return false;
  setTreeOpen(sessionId, !loadSession(sessionId).layout.treeOpen);
  return true;
}

export function setTreeWidth(sessionId: string, width: number): void {
  if (!Number.isFinite(width)) return;
  const w = Math.round(width);
  if (loadSession(sessionId).layout.treeWidth === w) return;
  patchLayout(sessionId, { treeWidth: w });
}

export function setExpanded(sessionId: string, expanded: boolean): void {
  if (loadSession(sessionId).expanded === expanded) return;
  patchSession(sessionId, { expanded });
}

export function setNarrow(sessionId: string, narrow: boolean): void {
  if (loadSession(sessionId).narrow === narrow) return;
  patchSession(sessionId, { narrow });
}

/**
 * Back from Expanded to the transcript. A user-chosen Expanded returns to the
 * split; when the window is too narrow for the split there is nothing to
 * restore to, so the Explorer closes and the transcript takes the window.
 */
export function restoreExplorer(sessionId: string): void {
  const s = loadSession(sessionId);
  if (s.narrow) {
    setRightPanel(sessionId, "none");
    return;
  }
  setExpanded(sessionId, false);
}

/** ⇧⌘E and the top-bar button. */
export function toggleExpanded(sessionId: string): void {
  const s = loadSession(sessionId);
  if (isEffectivelyExpanded(s)) restoreExplorer(sessionId);
  else setExpanded(sessionId, true);
}

export function setRoot(sessionId: string, root: string | null): void {
  if (loadSession(sessionId).root === root) return;
  patchSession(sessionId, { root, focusDir: null });
}

// --- opening files / history ---------------------------------------------------------

function sameTarget(a: FileTarget | null, b: FileTarget): boolean {
  return !!a && a.abs === b.abs && a.line === b.line && a.endLine === b.endLine;
}

/**
 * Open a path in its owner session's Explorer (the handler for
 * EXPLORER_OPEN_EVENT, and for navigation from inside the Explorer). Opens the
 * Explorer, closes Artifacts; a file becomes the open file (history grows), a
 * directory opens the tree at that folder.
 */
export function openFile(req: OpenFileRequest): void {
  const sessionId = req.owner.sessionId;
  setRightPanel(sessionId, "explorer");
  const cur = loadSession(sessionId);
  const root = cur.root ?? req.owner.cwd;
  const expanded = req.expand ? true : cur.expanded;

  if (req.kind === "dir") {
    const inside = isInsideRoot(root, req.abs);
    patchSession(
      sessionId,
      {
        expanded,
        root: inside ? cur.root : req.abs,
        focusDir: req.abs,
        layout: { ...cur.layout, open: true, treeOpen: true },
      },
      true,
    );
    return;
  }

  const target: FileTarget = { abs: req.abs, line: req.line, endLine: req.endLine };
  let history = cur.history;
  if (!sameTarget(cur.file, target)) {
    const kept = history.entries.slice(0, history.index + 1);
    kept.push(target);
    const entries = kept.length > HISTORY_LIMIT ? kept.slice(kept.length - HISTORY_LIMIT) : kept;
    history = { entries, index: entries.length - 1 };
  }
  patchSession(sessionId, {
    expanded,
    file: target,
    focusDir: null,
    root: isInsideRoot(root, req.abs) ? cur.root : dirname(req.abs),
    history,
  });
}

/** ⌘[ (−1) / ⌘] (+1). False when there is nowhere to go. */
export function navigateHistory(sessionId: string, delta: -1 | 1): boolean {
  const cur = loadSession(sessionId);
  const next = cur.history.index + delta;
  if (next < 0 || next >= cur.history.entries.length) return false;
  patchSession(sessionId, {
    file: cur.history.entries[next],
    focusDir: null,
    history: { entries: cur.history.entries, index: next },
  });
  return true;
}

/** Test seam: forget everything in memory and drop pending writes. */
export function resetExplorerStore(): void {
  for (const t of persistTimers.values()) clearTimeout(t);
  persistTimers.clear();
  sessions.clear();
  explorerWidths.clear();
  app = null;
  emit();
}
