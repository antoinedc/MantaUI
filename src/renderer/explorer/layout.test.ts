import { describe, expect, it } from "vitest";
import {
  AUTO_EXPAND_BELOW_PX,
  basename,
  clampTreeWidth,
  cornerInsetVars,
  dirname,
  isInsideRoot,
  railTone,
  shouldAutoExpand,
  terminalPassesSidebarKey,
  treeToggleDisabled,
} from "./layout";

describe("explorer layout helpers", () => {
  it("auto-expands below 680 px and ignores an unknown (0) width", () => {
    expect(shouldAutoExpand(AUTO_EXPAND_BELOW_PX - 1)).toBe(true);
    expect(shouldAutoExpand(AUTO_EXPAND_BELOW_PX)).toBe(false);
    expect(shouldAutoExpand(0)).toBe(false);
  });

  it("disables the tree toggle below 340 px", () => {
    expect(treeToggleDisabled(339)).toBe(true);
    expect(treeToggleDisabled(340)).toBe(false);
    expect(treeToggleDisabled(0)).toBe(false);
  });

  it("clamps the tree width to [140, explorer − 200]", () => {
    expect(clampTreeWidth(176, 800)).toBe(176);
    expect(clampTreeWidth(100, 800)).toBe(140);
    expect(clampTreeWidth(700, 800)).toBe(600);
    // The lower bound wins on a tiny Explorer.
    expect(clampTreeWidth(176, 300)).toBe(140);
  });

  it("ranks the rail status needs-you > running > idle", () => {
    expect(railTone({ attentionKind: "question", running: true })).toBe("warn");
    expect(railTone({ attentionKind: "permission", running: false })).toBe("warn");
    expect(railTone({ attentionKind: "idle", running: true })).toBe("running");
    expect(railTone({ attentionKind: undefined, running: true })).toBe("running");
    expect(railTone({ attentionKind: "idle", running: false })).toBe("idle");
  });

  describe("cornerInsetVars — one owner for the top-left corner", () => {
    const mac76 = "max(76px, var(--titlebar-inset-left, 0px))";

    it("sidebar visible: nothing to clear, banner or not", () => {
      for (const isMac of [true, false]) {
        for (const bannerShown of [true, false]) {
          expect(cornerInsetVars({ isMac, sidebarHidden: false, bannerShown })).toEqual({
            "--tl-inset-x": "0px",
            "--banner-inset-x": bannerShown ? "var(--tl-inset-x)" : "0px",
            "--pane-inset-x": bannerShown ? "0px" : "var(--tl-inset-x)",
            "--pane-inset-top": "0px",
          });
        }
      }
    });

    it("macOS, sidebar hidden, no banner: the pane header and the rail clear the traffic lights", () => {
      expect(cornerInsetVars({ isMac: true, sidebarHidden: true, bannerShown: false })).toEqual({
        "--tl-inset-x": mac76,
        "--banner-inset-x": "0px",
        "--pane-inset-x": "var(--tl-inset-x)",
        "--pane-inset-top": "40px",
      });
    });

    it("macOS, sidebar hidden, banner showing: the banner owns the clearance, the panes below do not repeat it", () => {
      expect(cornerInsetVars({ isMac: true, sidebarHidden: true, bannerShown: true })).toEqual({
        "--tl-inset-x": mac76,
        "--banner-inset-x": "var(--tl-inset-x)",
        "--pane-inset-x": "0px",
        "--pane-inset-top": "0px",
      });
    });

    it("other OSes, sidebar hidden: only the RTL caption-button width, never the traffic-light inset", () => {
      const v = cornerInsetVars({ isMac: false, sidebarHidden: true, bannerShown: false });
      expect(v["--tl-inset-x"]).toBe("var(--titlebar-inset-left, 0px)");
      expect(v["--pane-inset-top"]).toBe("0px");
    });
  });

  it("path helpers", () => {
    expect(isInsideRoot("/a/b", "/a/b")).toBe(true);
    expect(isInsideRoot("/a/b", "/a/b/c.ts")).toBe(true);
    expect(isInsideRoot("/a/b", "/a/bc/c.ts")).toBe(false);
    expect(isInsideRoot("/a/b/", "/a/b/c")).toBe(true);
    expect(isInsideRoot("/", "/x")).toBe(true);
    expect(dirname("/a/b/c.ts")).toBe("/a/b");
    expect(dirname("/c.ts")).toBe("/");
    expect(basename("/a/b/")).toBe("b");
    expect(basename("/")).toBe("/");
  });

  it("xterm lets ⌘B through on macOS only (plain Ctrl+B is tmux's prefix)", () => {
    const ev = { key: "b", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
    expect(terminalPassesSidebarKey(ev, true)).toBe(true);
    expect(terminalPassesSidebarKey({ ...ev, key: "B" }, true)).toBe(true);
    expect(terminalPassesSidebarKey({ ...ev, shiftKey: true }, true)).toBe(false);
    expect(terminalPassesSidebarKey({ ...ev, key: "c" }, true)).toBe(false);
    expect(terminalPassesSidebarKey({ ...ev, metaKey: false, ctrlKey: true }, false)).toBe(false);
  });
});
