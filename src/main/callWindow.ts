// callWindow.ts — the floating on-call CTO voice window (BET-1166).
//
// A second, small BrowserWindow distinct from the main app window. Frameless,
// always-on-top, non-resizable, with a drag region in its header. Lifecycle:
//   show    → create (first use) + reveal the window
//   park    → hide the window but KEEP it alive (inbound CTO events still push)
//   hangup  → destroy the window and tear down the call
// Position is persisted via the app config (`callWindowBounds`) so the window
// remembers where the user parked it across runs.
//
// The window itself is a thin shell: it loads `call.html`, whose renderer
// opens the box's /call WebSocket (auth-gated, token via ?token=) and streams
// opus mic audio up while receiving transcript/audio/intent events down. The
// OpenAI key lives on the box and never reaches this window.

import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import {
  shouldAllowNavigation,
  externalUrlOrNull,
} from "./windowSecurity.js";

// A short-lived "opening" size if we have no saved bounds.
const DEFAULT_BOUNDS = { x: undefined, y: undefined, width: 380, height: 560 };

export type CallWindowController = {
  show: () => void;
  park: () => void;
  hangup: () => void;
};

type Bounds = { x?: number; y?: number; width: number; height: number };

type Deps = {
  /** Read the persisted bounds (undefined if none yet). */
  getBounds: () => Bounds | undefined;
  /** Persist the current bounds on move/close. */
  saveBounds: (b: Bounds) => void;
};

export function createCallWindowController(deps: Deps): CallWindowController {
  const { getBounds, saveBounds } = deps;
  let callWindow: BrowserWindow | null = null;

  function ensureWindow(): BrowserWindow {
    if (callWindow && !callWindow.isDestroyed()) return callWindow;
    const saved = getBounds();
    const bounds = {
      x: saved?.x,
      y: saved?.y,
      width: saved?.width ?? DEFAULT_BOUNDS.width,
      height: saved?.height ?? DEFAULT_BOUNDS.height,
    };
    callWindow = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: "#0B1020",
      webPreferences: {
        preload: join(__dirname, "../preload/index.mjs"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // BET-1324: same window-hardening as the main window (see windowSecurity.ts)
    // — deny navigation away from the app's own page and only openExternal http/https.
    callWindow.webContents.on("will-navigate", (event, url) => {
      if (!shouldAllowNavigation(callWindow!.webContents.getURL(), url)) {
        event.preventDefault();
      }
    });
    callWindow.webContents.setWindowOpenHandler(({ url }) => {
      const external = externalUrlOrNull(url);
      if (external) shell.openExternal(external.href);
      return { action: "deny" };
    });

    // The header is the drag region (CSS `-webkit-app-region: drag`).
    if (process.env.ELECTRON_RENDERER_URL) {
      callWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/call.html`);
    } else {
      callWindow.loadFile(join(__dirname, "../renderer/call.html"));
    }

    const remember = () => {
      if (callWindow && !callWindow.isDestroyed()) {
        try {
          saveBounds(callWindow.getBounds());
        } catch {
          /* ignore */
        }
      }
    };
    callWindow.on("move", remember);
    callWindow.on("close", () => {
      remember();
      callWindow = null;
    });

    // Don't let the call window keep the app alive if the main window closes.
    callWindow.on("closed", () => {
      callWindow = null;
    });
    return callWindow;
  }

  function show() {
    // The renderer fetches its connection config itself (via `call:get-config`
    // IPC on mount) — nothing is pushed from here. Handing the box token over
    // IPC to the caller's own window is fine (it already holds it).
    const win = ensureWindow();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  function park() {
    if (callWindow && !callWindow.isDestroyed()) callWindow.hide();
  }

  function hangup() {
    if (callWindow && !callWindow.isDestroyed()) callWindow.destroy();
    callWindow = null;
  }

  return { show, park, hangup };
}
