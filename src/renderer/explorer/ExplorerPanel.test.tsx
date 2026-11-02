// @vitest-environment jsdom
//
// The Explorer shell: split wrapper, top bar, tree toggle / handle, Expanded
// rail, Esc precedence, ⌘P / history keys. The viewer / tree / quick open are
// the viewer track's components — stubbed here, their props asserted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, type Harness } from "../testHarness";
import { useStore } from "../store";

const viewerProps = vi.fn();
const treeProps = vi.fn();
const quickProps = vi.fn();

vi.mock("./ExplorerViewer", () => ({
  ExplorerViewer: (p: { file: { abs: string } | null; onShowTree: () => void }) => {
    viewerProps(p);
    return (
      <div data-testid="viewer">
        {p.file ? p.file.abs : "empty"}
        <button type="button" data-testid="show-tree" onClick={p.onShowTree}>
          Show tree
        </button>
      </div>
    );
  },
}));
vi.mock("./ExplorerTree", () => ({
  ExplorerTree: (p: { width: number }) => {
    treeProps(p);
    return <div data-testid="tree" style={{ width: p.width }} />;
  },
}));
vi.mock("./ExplorerQuickOpen", () => ({
  ExplorerQuickOpen: (p: { open: boolean }) => {
    quickProps(p);
    return p.open ? <div data-testid="quick-open" /> : null;
  },
}));

const { ExplorerSplit, ExplorerPanel } = await import("./ExplorerPanel");
const store = await import("./explorerStore");

// jsdom has no layout: give elements a width through a controllable
// ResizeObserver + getBoundingClientRect.
let widthOf: (el: Element) => number = () => 0;
const observers = new Set<{ cb: () => void; el: Element }>();
function setWidth(w: number) {
  widthOf = () => w;
  act(() => {
    for (const o of observers) (o.cb as (e: unknown[]) => void)([]);
  });
}

beforeEach(() => {
  localStorage.clear();
  store.resetExplorerStore();
  installMockApi();
  resetStore();
  widthOf = () => 0;
  observers.clear();
  viewerProps.mockClear();
  treeProps.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    private el: Element | null = null;
    constructor(private cb: () => void) {}
    observe(el: Element) {
      this.el = el;
      observers.add({ cb: this.cb, el });
    }
    unobserve() {}
    disconnect() {
      for (const o of observers) if (o.el === this.el) observers.delete(o);
    }
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const w = widthOf(this);
    return { width: w, height: 0, top: 0, left: 0, right: w, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
  vi.restoreAllMocks();
});

function q(sel: string): HTMLElement | null {
  return h!.container.querySelector<HTMLElement>(sel);
}
function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
function key(init: KeyboardEventInit & { key: string }, target: EventTarget = window) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

function split(sessionId = "ses_a", active = true) {
  return (
    <ExplorerSplit sessionId={sessionId} cwd="/home/u/proj" active={active}>
      <div data-testid={`chat-${sessionId}`}>chat</div>
    </ExplorerSplit>
  );
}

describe("ExplorerSplit", () => {
  it("keeps the transcript mounted across open / close (never remounts the chat)", () => {
    h = mount(split());
    const chat = h.container.querySelector('[data-testid="chat-ses_a"]');
    expect(q(".manta-explorer")).toBeNull();
    act(() => store.setRightPanel("ses_a", "explorer"));
    expect(q(".manta-explorer")).not.toBeNull();
    expect(h.container.querySelector('[data-testid="chat-ses_a"]')).toBe(chat);
    act(() => store.setRightPanel("ses_a", "none"));
    expect(q(".manta-explorer")).toBeNull();
    expect(h.container.querySelector('[data-testid="chat-ses_a"]')).toBe(chat);
  });

  it("mounts the Explorer only for the active chat", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split("ses_a", false));
    expect(q(".manta-explorer")).toBeNull();
  });

  it("renders the resize handle in the split and drops it in Expanded", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    expect(q('[aria-label="Resize file explorer"]')).not.toBeNull();
    act(() => store.setExpanded("ses_a", true));
    expect(q('[aria-label="Resize file explorer"]')).toBeNull();
    expect(q(".manta-explorer-rail")).not.toBeNull();
    act(() => store.setExpanded("ses_a", false));
    expect(q('[aria-label="Resize file explorer"]')).not.toBeNull();
    expect(q(".manta-explorer-rail")).toBeNull();
  });

  it("opening in a narrow window shows Expanded; widening returns to the split", () => {
    widthOf = () => 600;
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    expect(q(".manta-explorer-rail")).not.toBeNull();
    expect(store.getExplorerSession("ses_a").narrow).toBe(true);
    // The user never asked for Expanded — it is derived.
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);
    setWidth(900);
    expect(q(".manta-explorer-rail")).toBeNull();
    expect(q('[aria-label="Resize file explorer"]')).not.toBeNull();
    setWidth(640);
    expect(q(".manta-explorer-rail")).not.toBeNull();
  });
});

describe("ExplorerPanel top bar", () => {
  beforeEach(() => {
    widthOf = () => 900;
  });

  it("shows the root folder name and every control", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    const top = q(".manta-explorer-top")!;
    expect(top.textContent).toContain("proj");
    for (const label of ["Show file tree", "Quick open", "Expand", "Close file explorer"]) {
      expect(top.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
  });

  it("tree toggle opens / hides the tree", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    expect(q('[data-testid="tree"]')).toBeNull();
    click(q('[aria-label="Show file tree"]'));
    expect(q('[data-testid="tree"]')).not.toBeNull();
    expect(q('[aria-label="Resize file tree"]')).not.toBeNull();
    click(q('[aria-label="Hide file tree"]'));
    expect(q('[data-testid="tree"]')).toBeNull();
  });

  it("disables the tree toggle (with the reason) when the Explorer is narrower than 340 px", () => {
    widthOf = (el) => (el.classList.contains("manta-explorer-split") ? 900 : 320);
    store.setRightPanel("ses_a", "explorer");
    store.setTreeOpen("ses_a", true);
    h = mount(split());
    const toggle = q('[aria-label="Hide file tree"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Widen the explorer to show the tree");
    // …and the tree itself is not squeezed in beside the viewer.
    expect(q('[data-testid="tree"]')).toBeNull();
  });

  it("the empty state's Show tree opens the tree", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    click(q('[data-testid="show-tree"]'));
    expect(store.getExplorerSession("ses_a").layout.treeOpen).toBe(true);
    expect(q('[data-testid="tree"]')).not.toBeNull();
  });

  it("clamps the tree width and resizes it with the keyboard (16 px)", () => {
    store.setRightPanel("ses_a", "explorer");
    store.setTreeOpen("ses_a", true);
    h = mount(split());
    expect(treeProps.mock.lastCall![0].width).toBe(176);
    const handle = q('[aria-label="Resize file tree"]')!;
    key({ key: "ArrowRight" }, handle);
    expect(store.getExplorerSession("ses_a").layout.treeWidth).toBe(192);
    key({ key: "ArrowLeft" }, handle);
    key({ key: "ArrowLeft" }, handle);
    expect(store.getExplorerSession("ses_a").layout.treeWidth).toBe(160);
  });

  it("expand / restore / close buttons act", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    click(q('[aria-label="Expand"]'));
    expect(store.getExplorerSession("ses_a").expanded).toBe(true);
    click(q('[aria-label="Restore split"]'));
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);
    click(q('[aria-label="Close file explorer"]'));
    expect(store.shownRightPanel("ses_a")).toBe("none");
    expect(q(".manta-explorer")).toBeNull();
  });

  it("quick open: the button and ⌘P (focus inside) open the palette", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    expect(q('[data-testid="quick-open"]')).toBeNull();
    click(q('[aria-label="Quick open"]'));
    expect(q('[data-testid="quick-open"]')).not.toBeNull();
  });

  it("⌘P outside the Explorer does nothing; inside it opens quick open", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    key({ key: "p", metaKey: true });
    expect(q('[data-testid="quick-open"]')).toBeNull();
    const btn = q('[aria-label="Expand"]') as HTMLButtonElement;
    act(() => btn.focus());
    const ev = key({ key: "p", metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(q('[data-testid="quick-open"]')).not.toBeNull();
  });

  it("⌘[ / ⌘] move through history when focus is inside", () => {
    store.openFile({ abs: "/home/u/proj/a.ts", owner: { sessionId: "ses_a", cwd: "/home/u/proj" } });
    store.openFile({ abs: "/home/u/proj/b.ts", owner: { sessionId: "ses_a", cwd: "/home/u/proj" } });
    h = mount(split());
    act(() => (q('[aria-label="Expand"]') as HTMLButtonElement).focus());
    key({ key: "[", metaKey: true });
    expect(viewerProps.mock.lastCall![0].file.abs).toBe("/home/u/proj/a.ts");
    key({ key: "]", metaKey: true });
    expect(viewerProps.mock.lastCall![0].file.abs).toBe("/home/u/proj/b.ts");
  });

  it("passes the owner, root and the open file to the viewer", () => {
    store.openFile({ abs: "/home/u/proj/src/a.ts", line: 3, owner: { sessionId: "ses_a", cwd: "/home/u/proj" } });
    h = mount(split());
    const p = viewerProps.mock.lastCall![0];
    expect(p.owner).toEqual({ sessionId: "ses_a", cwd: "/home/u/proj" });
    expect(p.root).toBe("/home/u/proj");
    expect(p.file).toEqual({ abs: "/home/u/proj/src/a.ts", line: 3, endLine: undefined });
  });
});

describe("Expanded: rail and Esc", () => {
  beforeEach(() => {
    widthOf = () => 900;
  });

  function expandedSession() {
    store.setRightPanel("ses_a", "explorer");
    store.setExpanded("ses_a", true);
    h = mount(split());
  }

  it("Esc restores the split (and is consumed)", () => {
    expandedSession();
    const ev = key({ key: "Escape" });
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Esc already consumed by something else (CodeMirror search, a menu) does NOT leave Expanded", () => {
    expandedSession();
    // A focused control (CodeMirror's search panel, a menu) consumes Esc before
    // it bubbles to the window.
    const inner = document.createElement("input");
    inner.addEventListener("keydown", (e) => e.preventDefault());
    q(".manta-explorer")!.appendChild(inner);
    key({ key: "Escape" }, inner);
    expect(store.getExplorerSession("ses_a").expanded).toBe(true);
  });

  it("Esc while the quick-open palette is open leaves Expanded alone", () => {
    expandedSession();
    click(q('[aria-label="Quick open"]'));
    key({ key: "Escape" });
    expect(store.getExplorerSession("ses_a").expanded).toBe(true);
  });

  it("Esc does nothing outside Expanded", () => {
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    const ev = key({ key: "Escape" });
    expect(ev.defaultPrevented).toBe(false);
    expect(store.shownRightPanel("ses_a")).toBe("explorer");
  });

  it("clicking the rail restores", () => {
    expandedSession();
    click(q(".manta-explorer-rail"));
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);
  });

  it("in a narrow window Esc / the rail go back to the transcript by closing the Explorer", () => {
    widthOf = () => 600;
    store.setRightPanel("ses_a", "explorer");
    h = mount(split());
    expect(q(".manta-explorer-rail")).not.toBeNull();
    expect(q('[aria-label="Back to transcript"]')).not.toBeNull();
    key({ key: "Escape" });
    expect(store.shownRightPanel("ses_a")).toBe("none");
    expect(q(".manta-explorer")).toBeNull();
  });

  it.each([
    ["needs-you beats running", { attentionKind: "question", running: true }, "bg-warn"],
    ["running beats idle", { attentionKind: undefined, running: true }, "bg-accent"],
    ["idle", { attentionKind: undefined, running: false }, "bg-text-quiet"],
  ])("rail status: %s", (_n, w, cls) => {
    act(() => {
      useStore.setState({
        projects: [
          {
            tmuxSession: "p",
            defaultCwd: "/home/u/proj",
            windows: [{ index: 0, name: "w", opencodeSessionId: "ses_a", paneCurrentPath: "/home/u/proj" }],
          },
        ] as never,
        status: { p: { 0: { running: w.running, subagents: 0, attention: !!w.attentionKind, attentionKind: w.attentionKind } } } as never,
      });
    });
    expandedSession();
    const dot = q(".manta-explorer-rail span.rounded-full")!;
    expect(dot.className).toContain(cls);
  });
});

describe("ExplorerPanel standalone", () => {
  it("renders without the split (panel is self-contained)", () => {
    widthOf = () => 900;
    h = mount(<ExplorerPanel sessionId="ses_x" cwd="/home/u/other" />);
    expect(q(".manta-explorer-top")!.textContent).toContain("other");
  });
});
