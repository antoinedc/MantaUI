// callWindow.test.mjs — node:test for `createCallWindowController`
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
// `node --test` has no `electron` module, so the bare specifier is redirected
// to ./callWindow.mocks.mjs via `module.register` before the controller is
// imported (see that file).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { BrowserWindow } from "./callWindow.mocks.mjs";

register(new URL("./callWindow.mocks.mjs", import.meta.url));

const { createCallWindowController } = await import("./callWindow.ts");

afterEach(() => {
  BrowserWindow.instances.length = 0;
});

// A fresh controller wired to an in-memory bounds store, so a test can read
// what got persisted (`getStore()`) and which callbacks fired (`saved`).
function fresh(startBounds) {
  let store = startBounds;
  const saved = [];
  const controller = createCallWindowController({
    getBounds: () => store,
    saveBounds: (b) => {
      store = b;
      saved.push(b);
    },
  });
  return { controller, saved, getStore: () => store };
}

test("first run with no saved bounds falls back to default placement without error", () => {
  const { controller, saved } = fresh(undefined);

  controller.show();

  assert.equal(BrowserWindow.instances.length, 1);
  const win = BrowserWindow.instances[0];
  // Frameless, always-on-top shell like the production window.
  assert.equal(win.opts.frame, false);
  assert.equal(win.opts.resizable, false);
  assert.equal(win.opts.alwaysOnTop, true);
  // Default opening size, no persisted position.
  assert.equal(win.opts.width, 380);
  assert.equal(win.opts.height, 560);
  assert.equal(win.opts.x, undefined);
  assert.equal(win.opts.y, undefined);
  // Nothing was persisted just by opening.
  assert.equal(saved.length, 0);
});

test("window move persists the current bounds via saveBounds", () => {
  const { controller, saved, getStore } = fresh(undefined);

  controller.show();
  const win = BrowserWindow.instances[0];
  assert.equal(saved.length, 0);

  // Simulate the user dragging the window, then the OS firing `move`.
  win.currentBounds = { x: 40, y: 50, width: 380, height: 560 };
  win.emit("move");

  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { x: 40, y: 50, width: 380, height: 560 });
  assert.deepEqual(getStore(), { x: 40, y: 50, width: 380, height: 560 });
});

test("destroy + re-show restores the previously saved bounds", () => {
  const { controller, getStore } = fresh(undefined);

  controller.show();
  const first = BrowserWindow.instances[0];
  first.currentBounds = { x: 40, y: 50, width: 380, height: 560 };
  first.emit("move");
  assert.deepEqual(getStore(), { x: 40, y: 50, width: 380, height: 560 });

  // Tear the window down (e.g. hang-up), then show a fresh one.
  controller.hangup();
  assert.equal(first.destroyed, true);
  const count = BrowserWindow.instances.length;
  controller.show();

  const second = BrowserWindow.instances[count];
  assert.deepEqual(
    {
      x: second.opts.x,
      y: second.opts.y,
      width: second.opts.width,
      height: second.opts.height,
    },
    { x: 40, y: 50, width: 380, height: 560 },
  );
});

test("park hides the window but keeps it alive and keeps the saved bounds", () => {
  const { controller, getStore } = fresh(undefined);

  controller.show();
  const win = BrowserWindow.instances[0];
  win.currentBounds = { x: 12, y: 34, width: 380, height: 560 };
  win.emit("move");

  controller.park();

  // Hidden but not destroyed — a subsequent show reuses the same window.
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, false);
  assert.deepEqual(getStore(), { x: 12, y: 34, width: 380, height: 560 });
});

test("hang-up tears down the window but retains the saved placement (intended retention)", () => {
  const { controller, getStore } = fresh(undefined);

  controller.show();
  const win = BrowserWindow.instances[0];
  win.currentBounds = { x: 7, y: 8, width: 380, height: 560 };
  win.emit("move");
  assert.deepEqual(getStore(), { x: 7, y: 8, width: 380, height: 560 });

  controller.hangup();
  assert.equal(win.destroyed, true);

  // The persisted placement is deliberately NOT cleared on hang-up: a fresh
  // call reopens at the last known position rather than the default spot.
  assert.deepEqual(getStore(), { x: 7, y: 8, width: 380, height: 560 });

  const count = BrowserWindow.instances.length;
  controller.show();
  const reopened = BrowserWindow.instances[count];
  assert.deepEqual(
    {
      x: reopened.opts.x,
      y: reopened.opts.y,
      width: reopened.opts.width,
      height: reopened.opts.height,
    },
    { x: 7, y: 8, width: 380, height: 560 },
  );
});
