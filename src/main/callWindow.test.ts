// callWindow.test.ts — vitest for `createCallWindowController`
// (src/main/callWindow.ts), the BET-1166 floating on-call CTO window.
//
// The controller persists its window position through injected `getBounds` /
// `saveBounds` callbacks (wired to the app config in src/main/index.ts). This
// test pins that persistence contract without constructing a real window:
//
//   1. Window move → the current bounds are saved via `saveBounds`.
//   2. First run with no saved bounds → the default/frameless placement is
//      used, and nothing is persisted.
//   3. A destroy + re-show → the previously saved bounds are restored into the
//      new window's constructor.
//   4. Park (hide) → the window is hidden but kept alive; saved bounds survive.
//   5. Hang-up → the window is torn down but the saved placement is retained
//      (intended retention — a fresh call shows at the last known position).
//
// This is a vitest `.test.ts` (not a `node --test` `.mjs`) on purpose: it is
// the established main-process controller convention (windowChrome.test.ts and
// co.), and vitest transpiles the `.ts` import so it runs on CI's Node 20. The
// `electron` bare specifier is mocked via `vi.mock` (see below).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Bounds = { x?: number; y?: number; width: number; height: number };

// Fake BrowserWindow, hoisted so the `vi.mock` factory can close over it. Each
// instance records its constructor options and holds a controllable "real"
// position (`currentBounds`) plus an event bus, so the controller's
// `on("move")` / `on("close")` handlers can be exercised synchronously.
const bwState = vi.hoisted(() => {
  class BrowserWindow {
    static instances: BrowserWindow[] = [];
    opts: Record<string, unknown>;
    destroyed = false;
    visible = false;
    currentBounds: Bounds;
    private listeners = new Map<string, Array<() => void>>();

    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      const b = opts as Bounds;
      this.currentBounds = {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
      };
      BrowserWindow.instances.push(this);
    }

    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
    }
    focus() {}
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
    }
    getBounds(): Bounds {
      return { ...this.currentBounds };
    }
    loadURL() {}
    loadFile() {}
    on(event: string, fn: () => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    }
    emit(event: string) {
      for (const fn of this.listeners.get(event) ?? []) fn();
    }
    get webContents() {
      return { on() {}, setWindowOpenHandler() {}, loadURL() {}, loadFile() {} };
    }
  }
  return { BrowserWindow };
});

vi.mock("electron", () => ({
  BrowserWindow: bwState.BrowserWindow,
  shell: { openExternal: vi.fn() },
}));

// callWindow.ts references CommonJS `__dirname` for its preload path + the
// call.html load. Vitest serves the module as ESM where `__dirname` is
// undefined, but an undeclared identifier still resolves through the global
// scope, so a global falls back cleanly. The fake window ignores the path
// entirely; this just keeps construction from throwing.
(globalThis as unknown as { __dirname: string }).__dirname = process.cwd();

import { createCallWindowController } from "./callWindow";

const { BrowserWindow } = bwState;

beforeEach(() => {
  BrowserWindow.instances.length = 0;
});

// A fresh controller wired to an in-memory bounds store, so a test can read
// what got persisted (`getStore()`) and which callbacks fired (`saved`).
function fresh(startBounds?: Bounds) {
  let store = startBounds;
  const saved: Bounds[] = [];
  const controller = createCallWindowController({
    getBounds: () => store,
    saveBounds: (b) => {
      store = b;
      saved.push(b);
    },
  });
  return { controller, saved, getStore: () => store };
}

describe("createCallWindowController bounds persistence", () => {
  it("first run with no saved bounds falls back to default placement without error", () => {
    const { controller, saved } = fresh(undefined);

    controller.show();

    expect(BrowserWindow.instances).toHaveLength(1);
    const win = BrowserWindow.instances[0];
    // Frameless, always-on-top shell like the production window.
    expect(win.opts.frame).toBe(false);
    expect(win.opts.resizable).toBe(false);
    expect(win.opts.alwaysOnTop).toBe(true);
    // Default opening size, no persisted position.
    expect(win.opts.width).toBe(380);
    expect(win.opts.height).toBe(560);
    expect(win.opts.x).toBeUndefined();
    expect(win.opts.y).toBeUndefined();
    // Nothing was persisted just by opening.
    expect(saved).toHaveLength(0);
  });

  it("window move persists the current bounds via saveBounds", () => {
    const { controller, saved, getStore } = fresh(undefined);

    controller.show();
    const win = BrowserWindow.instances[0];
    expect(saved).toHaveLength(0);

    // Simulate the user dragging the window, then the OS firing `move`.
    win.currentBounds = { x: 40, y: 50, width: 380, height: 560 };
    win.emit("move");

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ x: 40, y: 50, width: 380, height: 560 });
    expect(getStore()).toEqual({ x: 40, y: 50, width: 380, height: 560 });
  });

  it("destroy + re-show restores the previously saved bounds", () => {
    const { controller, getStore } = fresh(undefined);

    controller.show();
    const first = BrowserWindow.instances[0];
    first.currentBounds = { x: 40, y: 50, width: 380, height: 560 };
    first.emit("move");
    expect(getStore()).toEqual({ x: 40, y: 50, width: 380, height: 560 });

    // Tear the window down (e.g. hang-up), then show a fresh one.
    controller.hangup();
    expect(first.destroyed).toBe(true);
    controller.show();

    const second = BrowserWindow.instances[1];
    expect(second.opts).toMatchObject({
      x: 40,
      y: 50,
      width: 380,
      height: 560,
    });
  });

  it("park hides the window but keeps it alive and keeps the saved bounds", () => {
    const { controller, getStore } = fresh(undefined);

    controller.show();
    const win = BrowserWindow.instances[0];
    win.currentBounds = { x: 12, y: 34, width: 380, height: 560 };
    win.emit("move");

    controller.park();

    // Hidden but not destroyed — a subsequent show reuses the same window.
    expect(win.visible).toBe(false);
    expect(win.destroyed).toBe(false);
    expect(getStore()).toEqual({ x: 12, y: 34, width: 380, height: 560 });
  });

  it("hang-up tears down the window but retains the saved placement (intended retention)", () => {
    const { controller, getStore } = fresh(undefined);

    controller.show();
    const win = BrowserWindow.instances[0];
    win.currentBounds = { x: 7, y: 8, width: 380, height: 560 };
    win.emit("move");
    expect(getStore()).toEqual({ x: 7, y: 8, width: 380, height: 560 });

    controller.hangup();
    expect(win.destroyed).toBe(true);

    // The persisted placement is deliberately NOT cleared on hang-up: a fresh
    // call reopens at the last known position rather than the default spot.
    expect(getStore()).toEqual({ x: 7, y: 8, width: 380, height: 560 });

    controller.show();
    const reopened = BrowserWindow.instances[1];
    expect(reopened.opts).toMatchObject({
      x: 7,
      y: 8,
      width: 380,
      height: 560,
    });
  });
});
