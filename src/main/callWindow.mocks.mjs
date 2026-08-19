// callWindow.mocks.mjs — node:test stand-in for the `electron` bare specifier
// (see callWindow.test.mjs). A bare `electron` import cannot resolve under
// `node --test`, so this module is registered as a Node module hook whose
// `resolve` redirects `electron` → this very file. The fake BrowserWindow
// drives the bounds/move/park/hangup lifecycle with a controllable "real"
// position (`currentBounds`) and an event bus so the controller's
// `on("move")` / `on("close")` handlers can be exercised synchronously.
//
// This is test-only support. It is never imported by the app.

// The controller is authored against Electron's CommonJS build and references
// the free `__dirname` identifier inside its constructor path (the preload
// path + call.html load). Under `node --test` the module loads as ESM, where
// `__dirname` is undefined — but an undeclared identifier still resolves
// through the global scope, so this global falls back cleanly. The fake web
// contents ignore the path entirely; this just keeps construction from
// throwing.
globalThis.__dirname = process.cwd();

export class BrowserWindow {
  // Every constructed instance, in construction order, for test assertions.
  static instances = [];

  constructor(opts) {
    this.opts = opts;
    this.listeners = new Map();
    this.destroyed = false;
    this.visible = false;
    // Stands in for the OS window position: tests mutate this to simulate a
    // drag, then emit `move` to trigger the controller's persistence hook.
    this.currentBounds = {
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
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

  getBounds() {
    return { ...this.currentBounds };
  }

  loadURL() {}

  loadFile() {}

  on(event, fn) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  emit(event) {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  get webContents() {
    return { setWindowOpenHandler() {}, loadURL() {}, loadFile() {} };
  }
}

export const shell = { openExternal() {} };

export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "electron") return nextResolve(specifier, context);
  return {
    url: new URL("./callWindow.mocks.mjs", import.meta.url).href,
    shortCircuit: true,
    format: "module",
  };
}
