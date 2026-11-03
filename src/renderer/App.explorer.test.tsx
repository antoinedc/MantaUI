// @vitest-environment jsdom
//
// App-level wiring of the file explorer shell: ⌘B sidebar + the pinned toggle on
// every pane, the Explorer ↔ Artifacts right slot, per-session state, the
// EXPLORER_OPEN_EVENT handler, narrow-window Expanded, and the terminal
// path-click → preview overlay.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import { SidebarRevealButton } from "./SidebarToggle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";
installCanvasStub();

// Heavy / unrelated panes are stubs: this file is about the shell around them.
// Each stubbed pane renders <SidebarRevealButton/> where its real header does (the
// first child); the real headers' wiring is asserted in their own tests.
vi.mock("./ChatPanel", () => ({
  ChatPanel: (p: { sessionId: string; artifactsOpen?: boolean; onToggleArtifacts?: () => void }) => (
    <div data-testid={`chat-${p.sessionId}`} data-artifacts={String(p.artifactsOpen)}>
      <SidebarRevealButton />
      <button type="button" data-testid={`chat-artifacts-${p.sessionId}`} onClick={p.onToggleArtifacts}>
        artifacts
      </button>
    </div>
  ),
}));
vi.mock("./Terminal", () => ({ Terminal: () => <div data-testid="terminal" /> }));
vi.mock("./CtoPanel", () => ({
  CtoPanel: () => (
    <div data-testid="cto">
      <SidebarRevealButton />
    </div>
  ),
}));
vi.mock("./RoutinesRoot", () => ({
  RoutinesRoot: () => (
    <div data-testid="routines">
      <SidebarRevealButton />
    </div>
  ),
}));
vi.mock("./ArtifactsPanel", () => ({
  ArtifactsPanel: (p: { open: boolean }) => <aside data-testid="artifacts" data-open={String(p.open)} />,
}));
vi.mock("./explorer/ExplorerViewer", () => ({
  ExplorerViewer: (p: { file: { abs: string; line?: number } | null }) => (
    <div data-testid="viewer">{p.file ? `${p.file.abs}:${p.file.line ?? ""}` : "empty"}</div>
  ),
}));
vi.mock("./explorer/ExplorerTree", () => ({
  ExplorerTree: (p: { selected: string | null }) => <div data-testid="tree">{p.selected}</div>,
}));
vi.mock("./explorer/ExplorerQuickOpen", () => ({ ExplorerQuickOpen: () => null }));

const { App } = await import("./App");
const store = await import("./explorer/explorerStore");
const { EXPLORER_OPEN_EVENT, PREVIEW_PATH_EVENT } = await import("./explorer/types");

const VALID_BOX = "7f3a9c1e0b8d4a62f1c9e5b7d0a4f8c2";

function windowOf(index: number, sid: string | null, cwd: string) {
  return { index, name: `w${index}`, active: index === 0, paneCurrentPath: cwd, opencodeSessionId: sid };
}

function pair(projects: unknown, active: { name: string; windowIndex: number }) {
  act(() => {
    useStore.setState({
      loaded: true,
      onboardingForced: false,
      serverUrl: `https://${VALID_BOX}.boxes.mantaui.com`,
      boxId: VALID_BOX,
      boxToken: VALID_BOX,
      projects: projects as never,
      activeProjectName: active.name,
      activeWindowByProject: { [active.name]: active.windowIndex },
      status: {},
      liveRunning: {},
    });
  });
}

const PROJECTS = [
  {
    tmuxSession: "p",
    defaultCwd: "/home/u/proj",
    attached: false,
    windows: [windowOf(0, "ses_a", "/home/u/proj"), windowOf(1, "ses_b", "/home/u/proj"), windowOf(2, null, "/home/u/proj")],
  },
];

let widthOf: (el: Element) => number = () => 0;
const observers = new Set<{ cb: (e: unknown[]) => void; el: Element }>();
function setWidth(w: number) {
  widthOf = () => w;
  act(() => {
    for (const o of observers) o.cb([]);
  });
}

let h: Harness | null = null;
beforeEach(() => {
  localStorage.clear();
  store.resetExplorerStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__mantaPreload = null;
  installMockApi();
  resetStore();
  widthOf = () => 1000;
  observers.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    private el: Element | null = null;
    constructor(private cb: (e: unknown[]) => void) {}
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
afterEach(() => {
  h?.unmount();
  h = null;
  vi.restoreAllMocks();
});

const q = (sel: string) => h!.container.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...h!.container.querySelectorAll<HTMLElement>(sel)];
function key(init: KeyboardEventInit & { key: string }) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}
/** The one match of `sel` that is not inside the (inert while hidden) sidebar. */
const outsideInert = (sel: string) => qa(sel).find((el) => !el.closest("[inert]")) ?? null;
function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
async function mountApp(active = { name: "p", windowIndex: 0 }) {
  pair(PROJECTS, active);
  h = mount(<App />);
  await h.flush();
}
const mod = { metaKey: true };

describe("⌘B sidebar + the pinned toggle", () => {
  it("⌘B hides / shows the sidebar, persists it, and the toggle restores it", async () => {
    await mountApp();
    const aside = q("aside")!;
    expect(aside.hasAttribute("inert")).toBe(false);
    key({ key: "b", ...mod });
    expect(localStorage.getItem("manta:sidebarHidden")).toBe("1");
    expect(q("aside")!.hasAttribute("inert")).toBe(true);
    expect(q("aside")!.getAttribute("aria-hidden")).toBe("true");
    // The hidden sidebar stays mounted (same node), just slid away.
    expect(q("aside")).toBe(aside);
    expect(aside.style.marginLeft).toBe("-256px");
    // While hidden the pane header owns the corner clearance (nothing off macOS
    // beyond the RTL caption inset); visible, there is none to give.
    const root = () => q('[data-screen="session"]')!;
    expect(root().style.getPropertyValue("--pane-inset-x")).toBe("var(--tl-inset-x)");
    expect(root().style.getPropertyValue("--tl-inset-x")).not.toBe("0px");

    click(outsideInert(".manta-sidebar-toggle"));
    expect(localStorage.getItem("manta:sidebarHidden")).toBe("0");
    expect(q("aside")!.hasAttribute("inert")).toBe(false);
    expect(root().style.getPropertyValue("--tl-inset-x")).toBe("0px");
  });

  it("starts hidden when it was left hidden", async () => {
    localStorage.setItem("manta:sidebarHidden", "1");
    await mountApp();
    expect(q("aside")!.hasAttribute("inert")).toBe(true);
  });

  it("a restore control exists exactly once on a chat pane, a terminal pane (the App titlebar), the CTO pane and Routines — outside the inert sidebar", async () => {
    act(() => store.setSidebarHidden(true)); // hidden is the case that needs a restore control
    await mountApp();
    const check = (where: string) => {
      // Inactive panes stay mounted under display:none; only the visible pane counts.
      const toggles = qa(".manta-sidebar-toggle").filter((t) => !t.closest('[inert], [style*="display: none"]'));
      expect(toggles, where).toHaveLength(1);
      expect(toggles[0].getAttribute("aria-label"), where).toBe("Show sidebar");
    };
    check("chat");

    // Terminal pane: an adopted window without a chat session.
    act(() => store.setSidebarHidden(true));
    await act(async () => {
      await useStore.getState().setActive("p", 2);
    });
    await h!.flush();
    expect(q('[data-testid="terminal"]')).not.toBeNull();
    check("terminal");

    // CTO and Routines panes are opened from the (inert while hidden) sidebar,
    // so reveal it, click through, and hide it again. (From a chat window: over
    // a terminal window the App titlebar stays up above the CTO pane's own header.)
    await act(async () => {
      await useStore.getState().setActive("p", 0);
    });
    act(() => store.setSidebarHidden(false));
    click(q('[aria-label="Open the CTO overview"]'));
    act(() => store.setSidebarHidden(true));
    check("cto");
    act(() => store.setSidebarHidden(false));
    click(q('[aria-label="Open Routines"]'));
    act(() => store.setSidebarHidden(true));
    check("routines");
  });

  it("⌘B works on every pane: not swallowed while a modal Settings is open", async () => {
    await mountApp();
    key({ key: "b", ...mod });
    expect(store.getAppState().sidebarHidden).toBe(true);
    key({ key: "B", ...mod });
    expect(store.getAppState().sidebarHidden).toBe(false);
  });
});

describe("right slot: Explorer vs Artifacts", () => {
  it("⌘E toggles this session's Explorer; ⌘I toggles Artifacts and they exclude each other", async () => {
    await mountApp();
    expect(q(".manta-explorer")).toBeNull();
    key({ key: "e", ...mod });
    expect(q(".manta-explorer")).not.toBeNull();
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("false");

    key({ key: "i", ...mod });
    expect(q(".manta-explorer")).toBeNull();
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("true");
    expect(q('[data-testid="chat-ses_a"]')!.dataset.artifacts).toBe("true");

    key({ key: "e", ...mod });
    expect(q(".manta-explorer")).not.toBeNull();
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("false");
    expect(localStorage.getItem("manta:artifacts:open")).toBe("0");

    key({ key: "e", ...mod });
    expect(q(".manta-explorer")).toBeNull();
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("false");
  });

  it("manta-open-review opens Artifacts and closes this session's Explorer", async () => {
    await mountApp();
    key({ key: "e", ...mod });
    expect(q(".manta-explorer")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent("manta-open-review"));
    });
    expect(q(".manta-explorer")).toBeNull();
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("true");
  });

  it("the header's Artifacts toggle (ChatPanel prop) goes through the same writer", async () => {
    await mountApp();
    key({ key: "e", ...mod });
    click(q('[data-testid="chat-artifacts-ses_a"]'));
    expect(q(".manta-explorer")).toBeNull();
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("true");
    click(q('[data-testid="chat-artifacts-ses_a"]'));
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("false");
  });

  it("the Explorer is per session; Artifacts stays global", async () => {
    await mountApp();
    key({ key: "e", ...mod });
    expect(q(".manta-explorer")).not.toBeNull();
    // Another session: no Explorer there.
    await act(async () => {
      await useStore.getState().setActive("p", 1);
    });
    await h!.flush();
    expect(q(".manta-explorer")).toBeNull();
    expect(store.getExplorerSession("ses_a").layout.open).toBe(true);
    expect(store.getExplorerSession("ses_b").layout.open).toBe(false);
    // Back: A's Explorer is still open.
    await act(async () => {
      await useStore.getState().setActive("p", 0);
    });
    await h!.flush();
    expect(q(".manta-explorer")).not.toBeNull();
  });

  it("⌘E does nothing on a terminal pane (no Explorer outside chat sessions)", async () => {
    await mountApp({ name: "p", windowIndex: 2 });
    key({ key: "e", ...mod });
    expect(q(".manta-explorer")).toBeNull();
    expect(store.getExplorerSession("ses_a").layout.open).toBe(false);
  });

  it("⇧⌘E expands / restores and ⌥⌘E toggles the tree — only while the Explorer is open", async () => {
    await mountApp();
    key({ key: "E", ...mod, shiftKey: true });
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);
    key({ key: "e", ...mod });
    key({ key: "E", ...mod, shiftKey: true });
    expect(store.getExplorerSession("ses_a").expanded).toBe(true);
    expect(q(".manta-explorer-rail")).not.toBeNull();
    key({ key: "E", ...mod, shiftKey: true });
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);

    expect(q('[data-testid="tree"]')).toBeNull();
    // ⌥E types a dead key on macOS, so the handler matches on `code`.
    key({ key: "´", code: "KeyE", ...mod, altKey: true });
    expect(q('[data-testid="tree"]')).not.toBeNull();
    key({ key: "´", code: "KeyE", ...mod, altKey: true });
    expect(q('[data-testid="tree"]')).toBeNull();
  });

  it("⌥⌘E on a too-narrow Explorer changes nothing and says why", async () => {
    await mountApp();
    key({ key: "e", ...mod });
    store.reportExplorerWidth("ses_a", 300);
    key({ key: "´", code: "KeyE", ...mod, altKey: true });
    expect(store.getExplorerSession("ses_a").layout.treeOpen).toBe(false);
    expect(useStore.getState().appToasts.map((t) => t.message)).toContain("Widen the explorer to show the tree");
  });

  it("⌘F conversation search returns early when something already consumed the key", async () => {
    await mountApp();
    const inner = document.createElement("div");
    inner.addEventListener("keydown", (e) => e.preventDefault());
    h!.container.appendChild(inner);
    const ev = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      inner.dispatchEvent(ev);
    });
    // SearchPalette would render its input; nothing did.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Unconsumed, the same key opens the conversation search palette.
    const ev2 = key({ key: "f", ...mod });
    expect(ev2.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("EXPLORER_OPEN_EVENT", () => {
  const owner = { sessionId: "ses_a", cwd: "/home/u/proj" };
  const open = (detail: unknown) =>
    act(() => {
      window.dispatchEvent(new CustomEvent(EXPLORER_OPEN_EVENT, { detail }));
    });

  it("opens the owner's Explorer on the file and line", async () => {
    await mountApp();
    open({ abs: "/home/u/proj/src/a.ts", line: 28, owner });
    expect(q(".manta-explorer")).not.toBeNull();
    expect(q('[data-testid="viewer"]')!.textContent).toBe("/home/u/proj/src/a.ts:28");
    expect(store.getExplorerSession("ses_a").expanded).toBe(false);
    expect(q('[data-testid="tree"]')).toBeNull(); // a link never forces the tree
  });

  it("⌘-click (expand) opens Expanded", async () => {
    await mountApp();
    open({ abs: "/home/u/proj/a.ts", owner, expand: true });
    expect(q(".manta-explorer-rail")).not.toBeNull();
  });

  it("a directory forces the tree open at that folder", async () => {
    await mountApp();
    open({ abs: "/home/u/proj/src", kind: "dir", owner });
    expect(q('[data-testid="tree"]')!.textContent).toBe("/home/u/proj/src");
  });

  it("closes Artifacts when a path opens the Explorer", async () => {
    await mountApp();
    key({ key: "i", ...mod });
    open({ abs: "/home/u/proj/a.ts", owner });
    expect(q('[data-testid="artifacts"]')!.dataset.open).toBe("false");
    expect(q(".manta-explorer")).not.toBeNull();
  });

  it("opens for the OWNER, never whichever session is active", async () => {
    await mountApp({ name: "p", windowIndex: 1 }); // B is active
    open({ abs: "/home/u/proj/a.ts", owner }); // link rendered in A
    expect(store.getExplorerSession("ses_a").file?.abs).toBe("/home/u/proj/a.ts");
    expect(store.getExplorerSession("ses_b").file).toBeNull();
    expect(q(".manta-explorer")).toBeNull(); // B's view is untouched
  });

  it("ignores a malformed request", async () => {
    await mountApp();
    open({ abs: "" });
    open(null);
    expect(q(".manta-explorer")).toBeNull();
  });
});

describe("narrow window", () => {
  it("opening the Explorer under 680 px shows Expanded; widening returns to the split", async () => {
    widthOf = () => 640;
    await mountApp();
    key({ key: "e", ...mod });
    expect(q(".manta-explorer-rail")).not.toBeNull();
    expect(q('[aria-label="Resize file explorer"]')).toBeNull();
    setWidth(900);
    expect(q(".manta-explorer-rail")).toBeNull();
    expect(q('[aria-label="Resize file explorer"]')).not.toBeNull();
  });
});

describe("terminal path click → preview overlay", () => {
  it("PREVIEW_PATH_EVENT opens the existing artifact preview for that path (its own error state when unreadable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await mountApp({ name: "p", windowIndex: 2 });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(PREVIEW_PATH_EVENT, { detail: { path: "/home/u/proj/notes/todo.md" } }));
    });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-label")).toBe("Preview todo.md");
    await h!.flush();
    expect(dialog.textContent).toContain("todo.md");
    expect(dialog.textContent).toContain("Couldn’t load this file to preview.");
    // Close works.
    click(dialog.querySelector('[aria-label="Close preview"]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    vi.unstubAllGlobals();
  });

  it("httpApi.peekRemoteFile dispatches the same event instead of the old RPC no-op", async () => {
    const { httpApi } = await import("./api/httpApi");
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(PREVIEW_PATH_EVENT, on);
    try {
      await httpApi.peekRemoteFile("~/notes/x.md");
    } finally {
      window.removeEventListener(PREVIEW_PATH_EVENT, on);
    }
    expect(seen).toEqual(["~/notes/x.md"]);
  });
});
