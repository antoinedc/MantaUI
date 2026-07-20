import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AppConfig,
  type AuthClaimInput,
  type DesktopNotifyPayload,
} from "../shared/types.js";
import type { ClaimOutcome } from "../shared/claim.mjs";

// This is the OS-bridge + pairing SUBSET of the full `Api` contract
// (`src/shared/api.ts`) — the methods the desktop preload runtime actually
// implements. Everything else in `Api` (tmux/opencode/config/schedule/
// secrets/webhook/voice/git/fs/pty/...) is httpApi-only now (BET-82: "SSH
// main path gone" — `window.api` is always httpApi on desktop, never this
// object). See `src/renderer/preloadAccess.ts` for the typed accessor most
// callers should use (`getBuiPreload()`), and BET-127 for the extraction
// history.
const api = {
  // Read ONLY by main.tsx's boot sequence (`chooseDesktopTransport`), before
  // httpApi is installed as `window.api` — used to seed httpApi's
  // localStorage credentials from the desktop's local config.json (pairing
  // triple). This is the one "data" method that must stay: it is called
  // directly on `window.__buiPreload`, never through `window.api`.
  configGet: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),

  // Onboarding pairing (BET-49): exchange a 6-digit code for the box's tokens
  // via POST <serverUrl>/auth/claim. On success main persists
  // { serverUrl, boxId, boxToken } to config (flipping transport to "http").
  // Resolves to a classified ClaimOutcome — a wrong/expired code is a normal
  // { ok:false } result, NOT a rejected promise.
  authClaim: (input: AuthClaimInput): Promise<ClaimOutcome> =>
    ipcRenderer.invoke(IPC.authClaim, input),

  clipboardWriteText: (text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.clipboardWriteText, text),
  clipboardReadImage: (): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke(IPC.clipboardReadImage),
  readLocalFile: (path: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke(IPC.readLocalFile, path),

  onScreenshotDetected: (
    cb: (ev: { source: "clipboard" | "file"; path?: string }) => void,
  ): (() => void) => {
    const listener = (_: unknown, ev: { source: "clipboard" | "file"; path?: string }) => cb(ev);
    ipcRenderer.on(IPC.screenshotDetected, listener);
    return () => ipcRenderer.removeListener(IPC.screenshotDetected, listener);
  },

  // bui-server's notification router decided the desktop should show an OS
  // notification (relayed over the -L 18787 forward). The renderer shows it
  // via the Notification API after a local "am I viewing this?" check.
  onDesktopNotify: (cb: (payload: DesktopNotifyPayload) => void): (() => void) => {
    const listener = (_: unknown, payload: DesktopNotifyPayload) => cb(payload);
    ipcRenderer.on(IPC.desktopNotify, listener);
    return () => ipcRenderer.removeListener(IPC.desktopNotify, listener);
  },

  uploadFiles: (input: { projectName: string; localPaths: string[] }): Promise<string[]> =>
    ipcRenderer.invoke(IPC.uploadFiles, input),
  uploadBuffer: (input: { projectName: string; filename: string; buffer: ArrayBuffer }): Promise<string> =>
    ipcRenderer.invoke(IPC.uploadBuffer, input),
  // Electron 31+ removed File.path; webUtils.getPathForFile is the replacement.
  // Returns "" for files that don't have an OS path (e.g. dragged from a webpage).
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  peekRemoteFile: (remotePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.peekRemoteFile, remotePath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),

  revealInFolder: (localPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.revealInFolder, localPath),

  // BET-207: `pluginsEnabled` is a Mac-machine-local toggle — read/write
  // goes through main's local handlers (commit() → Mac-local config) so
  // it doesn't round-trip through httpApi/the box. Renderer reads the
  // current value on Settings mount to seed the toggle, and writes the
  // new value on Save. Same pattern as configGet (a local-only channel
  // that's never part of window.api).
  pluginsGetEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.pluginsGetEnabled),
  pluginsSetEnabled: (value: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.pluginsSetEnabled, value),
};

// Expose the real preload bridge under a STABLE, dedicated name — NOT "api".
// contextBridge.exposeInMainWorld makes the property read-only + non-
// configurable, so whatever name it's given can never be reassigned. The
// renderer entry (main.tsx) needs to install `window.api` itself and, in
// http/paired mode, SWAP it for the httpApi client — a swap that throws
// "Cannot assign to read only property 'api'" if `api` is the contextBridge
// property. So we bridge under `__buiPreload` (immutable, always the genuine
// Electron preload) and let main.tsx define a writable `window.api` from it.
contextBridge.exposeInMainWorld("__buiPreload", api);
