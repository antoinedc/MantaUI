// @vitest-environment jsdom
//
// Terminal ↔ explorer seams: an absolute-path click opens the preview overlay
// (the dead `peekRemoteFile` control), and ⌘B reaches the window handler.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, mount, resetStore, type Harness } from "./testHarness";

installCanvasStub();

type LinkProvider = { provideLinks: (line: number, cb: (links?: Array<{ text: string; activate: () => void }>) => void) => void };
const captured: { provider: LinkProvider | null; keyHandler: ((ev: KeyboardEvent) => boolean) | null; lines: string[] } = {
  provider: null,
  keyHandler: null,
  lines: [],
};

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { getLine: (i: number) => (captured.lines[i] === undefined ? undefined : { translateToString: () => captured.lines[i] }) } };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    unicode = { activeVersion: "" };
    loadAddon() {}
    registerLinkProvider(p: LinkProvider) {
      captured.provider = p;
    }
    attachCustomKeyEventHandler(fn: (ev: KeyboardEvent) => boolean) {
      captured.keyHandler = fn;
    }
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    focus() {}
    dispose() {}
    clear() {}
    getSelection() {
      return "";
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), IS_MAC: true }));

const { Terminal } = await import("./Terminal");
const { PREVIEW_PATH_EVENT } = await import("./explorer/types");

let h: Harness | null = null;
beforeEach(() => {
  captured.provider = null;
  captured.keyHandler = null;
  captured.lines = [];
  installMockApi({ ptySpawn: () => new Promise(() => {}) });
  resetStore();
});
afterEach(() => {
  h?.unmount();
  h = null;
});

function mountTerminal() {
  h = mount(<Terminal sessionKey="p:w:terminal" cwd="/home/u" active />);
}

describe("terminal absolute-path click", () => {
  it("activating a path link dispatches PREVIEW_PATH_EVENT with that path", () => {
    mountTerminal();
    captured.lines = ["see /home/u/proj/src/a.ts for details"];
    let links: Array<{ text: string; activate: () => void }> | undefined;
    captured.provider!.provideLinks(1, (l) => {
      links = l;
    });
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("/home/u/proj/src/a.ts");

    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(PREVIEW_PATH_EVENT, on);
    try {
      act(() => links![0].activate());
    } finally {
      window.removeEventListener(PREVIEW_PATH_EVENT, on);
    }
    expect(seen).toEqual(["/home/u/proj/src/a.ts"]);
  });

  it("home paths work too", () => {
    mountTerminal();
    captured.lines = ["cat ~/notes/todo.md"];
    let links: Array<{ text: string; activate: () => void }> | undefined;
    captured.provider!.provideLinks(1, (l) => {
      links = l;
    });
    expect(links![0].text).toBe("~/notes/todo.md");
  });
});

describe("terminal ⌘B", () => {
  const ev = (init: Partial<KeyboardEvent>) => ({ type: "keydown", key: "b", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as unknown as KeyboardEvent;

  it("xterm lets ⌘B through to the window (its key handler returns false)", () => {
    mountTerminal();
    expect(captured.keyHandler!(ev({}))).toBe(false);
  });

  it("other keys still reach xterm", () => {
    mountTerminal();
    expect(captured.keyHandler!(ev({ key: "x" }))).toBe(true);
    expect(captured.keyHandler!(ev({ shiftKey: true }))).toBe(true);
  });
});
