// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushExplorerPersist,
  getAppState,
  getExplorerSession,
  isEffectivelyExpanded,
  navigateHistory,
  openFile,
  openFileFromTranscript,
  parseLayout,
  reportExplorerWidth,
  resetExplorerStore,
  restoreExplorer,
  setNarrow,
  setRatio,
  setRightPanel,
  setSidebarHidden,
  setTreeOpen,
  setTreeWidth,
  shownRightPanel,
  toggleArtifacts,
  toggleExpanded,
  toggleExplorer,
  toggleTree,
} from "./explorerStore";

const owner = (sessionId: string, cwd = "/home/u/proj") => ({ sessionId, cwd });

beforeEach(() => {
  localStorage.clear();
  resetExplorerStore();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("right slot exclusivity (setRightPanel)", () => {
  it("opening Explorer closes Artifacts, and the reverse", () => {
    setRightPanel("a", "artifacts");
    expect(shownRightPanel("a")).toBe("artifacts");
    expect(localStorage.getItem("manta:artifacts:open")).toBe("1");

    setRightPanel("a", "explorer");
    expect(shownRightPanel("a")).toBe("explorer");
    expect(getAppState().artifactsOpen).toBe(false);
    expect(localStorage.getItem("manta:artifacts:open")).toBe("0");

    setRightPanel("a", "artifacts");
    expect(shownRightPanel("a")).toBe("artifacts");
    expect(getExplorerSession("a").layout.open).toBe(false);
  });

  it("closing the Explorer shows nothing (does not restore Artifacts)", () => {
    setRightPanel("a", "artifacts");
    setRightPanel("a", "explorer");
    setRightPanel("a", "none");
    expect(shownRightPanel("a")).toBe("none");
  });

  it("Artifacts is global: another session shows it, Explorer wins in its own session", () => {
    setRightPanel("a", "explorer");
    setRightPanel("b", "artifacts");
    // b took the global Artifacts slot and closed ITS explorer only.
    expect(shownRightPanel("b")).toBe("artifacts");
    expect(getExplorerSession("a").layout.open).toBe(true);
    expect(shownRightPanel("a")).toBe("explorer");
  });

  it("toggles route through the same writer", () => {
    toggleExplorer("a");
    expect(shownRightPanel("a")).toBe("explorer");
    toggleExplorer("a");
    expect(shownRightPanel("a")).toBe("none");
    toggleArtifacts("a");
    expect(shownRightPanel("a")).toBe("artifacts");
    toggleArtifacts("a");
    expect(shownRightPanel("a")).toBe("none");
  });

  it("the toggle (header icon / ⌘E) opens with the tree; closing leaves the preference", () => {
    expect(getExplorerSession("a").layout.treeOpen).toBe(false);
    toggleExplorer("a");
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
    setTreeOpen("a", false);
    toggleExplorer("a");
    expect(shownRightPanel("a")).toBe("none");
    expect(getExplorerSession("a").layout.treeOpen).toBe(false);
    toggleExplorer("a");
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
  });

  it("closing resets Expanded so the transcript is back next time", () => {
    setRightPanel("a", "explorer");
    toggleExpanded("a");
    expect(getExplorerSession("a").expanded).toBe(true);
    setRightPanel("a", "none");
    expect(getExplorerSession("a").expanded).toBe(false);
  });
});

describe("per-session layout persistence", () => {
  it("two sessions keep different open / ratio / tree state", () => {
    setRightPanel("a", "explorer");
    setRatio("a", 60);
    setTreeOpen("a", true);
    setTreeWidth("a", 200);
    setRatio("b", 35);
    flushExplorerPersist();

    expect(JSON.parse(localStorage.getItem("manta:explorer:a")!)).toEqual({
      open: true,
      ratio: 60,
      treeOpen: true,
      treeWidth: 200,
    });
    expect(JSON.parse(localStorage.getItem("manta:explorer:b")!)).toMatchObject({ open: false, ratio: 35, treeOpen: false });

    resetExplorerStore(); // a "reload"
    expect(getExplorerSession("a").layout).toEqual({ open: true, ratio: 60, treeOpen: true, treeWidth: 200 });
    expect(getExplorerSession("b").layout.ratio).toBe(35);
    expect(getExplorerSession("c").layout).toEqual({ open: false, ratio: 48, treeOpen: false, treeWidth: 176 });
  });

  it("debounces writes by 250 ms", () => {
    vi.useFakeTimers();
    setRatio("a", 55);
    expect(localStorage.getItem("manta:explorer:a")).toBeNull();
    vi.advanceTimersByTime(249);
    expect(localStorage.getItem("manta:explorer:a")).toBeNull();
    vi.advanceTimersByTime(2);
    expect(JSON.parse(localStorage.getItem("manta:explorer:a")!).ratio).toBe(55);
  });

  it("ignores garbage in storage", () => {
    expect(parseLayout("{nope").ratio).toBe(48);
    expect(parseLayout(JSON.stringify({ open: "yes", ratio: 5000, treeWidth: -3 }))).toEqual({
      open: false,
      ratio: 48,
      treeOpen: false,
      treeWidth: 176,
    });
  });

  it("persists the sidebar flag app-wide", () => {
    setSidebarHidden(true);
    expect(localStorage.getItem("manta:sidebarHidden")).toBe("1");
    resetExplorerStore();
    expect(getAppState().sidebarHidden).toBe(true);
  });
});

describe("Expanded / narrow", () => {
  it("narrow forces effective Expanded; restore then closes (nothing to restore to)", () => {
    setRightPanel("a", "explorer");
    setNarrow("a", true);
    expect(isEffectivelyExpanded(getExplorerSession("a"))).toBe(true);
    restoreExplorer("a");
    expect(shownRightPanel("a")).toBe("none");
  });

  it("a user Expanded restores to the split", () => {
    setRightPanel("a", "explorer");
    toggleExpanded("a");
    expect(isEffectivelyExpanded(getExplorerSession("a"))).toBe(true);
    toggleExpanded("a");
    expect(isEffectivelyExpanded(getExplorerSession("a"))).toBe(false);
    expect(shownRightPanel("a")).toBe("explorer");
  });

  it("keeps the stored ratio across Expanded", () => {
    setRightPanel("a", "explorer");
    setRatio("a", 62);
    toggleExpanded("a");
    toggleExpanded("a");
    expect(getExplorerSession("a").layout.ratio).toBe(62);
  });
});

describe("openFile", () => {
  it("opens the Explorer, sets the file with its line range, grows history", () => {
    openFile({ abs: "/home/u/proj/src/a.ts", line: 12, endLine: 30, owner: owner("a") });
    const s = getExplorerSession("a");
    expect(s.layout.open).toBe(true);
    expect(s.file).toEqual({ abs: "/home/u/proj/src/a.ts", line: 12, endLine: 30 });
    expect(s.expanded).toBe(false);
    expect(s.root).toBeNull();
    openFile({ abs: "/home/u/proj/b.md", owner: owner("a") });
    expect(getExplorerSession("a").history.entries).toHaveLength(2);
  });

  it("a file link keeps the stored tree preference", () => {
    openFile({ abs: "/home/u/proj/a.ts", owner: owner("a") });
    expect(getExplorerSession("a").layout.treeOpen).toBe(false);
    setTreeOpen("a", true);
    openFile({ abs: "/home/u/proj/b.ts", owner: owner("a") });
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
  });

  it("a transcript file link opens the Explorer without the tree; an open Explorer keeps it", () => {
    setTreeOpen("a", true);
    openFileFromTranscript({ abs: "/home/u/proj/a.ts", owner: owner("a") });
    expect(shownRightPanel("a")).toBe("explorer");
    expect(getExplorerSession("a").layout.treeOpen).toBe(false);
    setTreeOpen("a", true);
    openFileFromTranscript({ abs: "/home/u/proj/b.ts", owner: owner("a") });
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
  });

  it("a transcript directory link still shows the tree", () => {
    openFileFromTranscript({ abs: "/home/u/proj/src", kind: "dir", owner: owner("a") });
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
  });

  it("⌘-click expands", () => {
    openFile({ abs: "/home/u/proj/a.ts", owner: owner("a"), expand: true });
    expect(getExplorerSession("a").expanded).toBe(true);
  });

  it("closes Artifacts when a link opens the Explorer", () => {
    setRightPanel("a", "artifacts");
    openFile({ abs: "/home/u/proj/a.ts", owner: owner("a") });
    expect(shownRightPanel("a")).toBe("explorer");
    expect(getAppState().artifactsOpen).toBe(false);
  });

  it("a directory forces the tree open at that folder", () => {
    openFile({ abs: "/home/u/proj/src", kind: "dir", owner: owner("a") });
    const s = getExplorerSession("a");
    expect(s.layout.treeOpen).toBe(true);
    expect(s.focusDir).toBe("/home/u/proj/src");
    expect(s.root).toBeNull();
    expect(s.file).toBeNull();
  });

  it("a directory outside the root re-roots there", () => {
    openFile({ abs: "/home/u/notes", kind: "dir", owner: owner("a") });
    expect(getExplorerSession("a").root).toBe("/home/u/notes");
  });

  it("a file outside the root re-roots to its folder; inside keeps the root", () => {
    openFile({ abs: "/home/u/notes/x.md", owner: owner("a") });
    expect(getExplorerSession("a").root).toBe("/home/u/notes");
    openFile({ abs: "/home/u/proj/y.ts", owner: owner("b") });
    expect(getExplorerSession("b").root).toBeNull();
  });

  it("the open never lands in another session", () => {
    openFile({ abs: "/home/u/proj/a.ts", owner: owner("a") });
    expect(getExplorerSession("b").file).toBeNull();
    expect(getExplorerSession("b").layout.open).toBe(false);
  });

  it("history: back / forward, no duplicate of the current target, truncation on a new open", () => {
    openFile({ abs: "/p/1", owner: owner("a", "/p") });
    openFile({ abs: "/p/1", owner: owner("a", "/p") });
    openFile({ abs: "/p/2", owner: owner("a", "/p") });
    openFile({ abs: "/p/3", owner: owner("a", "/p") });
    expect(getExplorerSession("a").history.entries.map((e) => e.abs)).toEqual(["/p/1", "/p/2", "/p/3"]);
    expect(navigateHistory("a", -1)).toBe(true);
    expect(getExplorerSession("a").file?.abs).toBe("/p/2");
    expect(navigateHistory("a", 1)).toBe(true);
    expect(getExplorerSession("a").file?.abs).toBe("/p/3");
    expect(navigateHistory("a", 1)).toBe(false);
    navigateHistory("a", -1);
    openFile({ abs: "/p/4", owner: owner("a", "/p") });
    expect(getExplorerSession("a").history.entries.map((e) => e.abs)).toEqual(["/p/1", "/p/2", "/p/4"]);
    expect(navigateHistory("a", -1)).toBe(true);
    expect(navigateHistory("a", -1)).toBe(true);
    expect(navigateHistory("a", -1)).toBe(false);
  });
});

describe("toggleTree (⌥⌘E)", () => {
  it("flips the tree, and refuses — leaving state alone — when the Explorer is too narrow", () => {
    expect(toggleTree("a")).toBe(true);
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
    expect(toggleTree("a")).toBe(true);
    expect(getExplorerSession("a").layout.treeOpen).toBe(false);

    reportExplorerWidth("a", 300);
    expect(toggleTree("a")).toBe(false);
    expect(getExplorerSession("a").layout.treeOpen).toBe(false);

    reportExplorerWidth("a", 400);
    expect(toggleTree("a")).toBe(true);
    expect(getExplorerSession("a").layout.treeOpen).toBe(true);
  });
});
