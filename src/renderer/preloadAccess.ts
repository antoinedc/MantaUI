import type { DesktopNotifyPayload, ServerUpdateAvailablePayload } from "../shared/types.js";

/**
 * OS-integration affordances exposed by the Electron preload bridge.
 *
 * These are the methods that only work inside Electron — they touch the OS
 * clipboard, the shell, the file manager, or OS-level notifications. On
 * mobile/web (no preload) they are unavailable; callers check the accessor
 * return value and no-op.
 *
 * This is a deliberate SUBSET of the full Api type. The full Api (exposed as
 * `window.api`) includes tmux/opencode/config channels that go over SSH or
 * HTTP — those are NOT OS-integration and must not live here.
 */
export interface MantaPreload {
  onScreenshotDetected(
    cb: (ev: { source: "clipboard" | "file"; path?: string }) => void,
  ): () => void;
  // Subscribe to manta:// pair links delivered by the OS protocol handler.
  // The renderer validates the URL with parsePairPayload and routes it into
  // the onboarding PairStep. Buffering lives in the preload so a URL that
  // arrives before React mounts is replayed on subscribe. Absent on
  // mobile/web (no window.__mantaPreload).
  onPairLink(cb: (url: string) => void): () => void;
  clipboardWriteText(text: string): Promise<void>;
  // Read the current clipboard image as PNG bytes (null if no image). Only
  // main can touch the OS clipboard — this must go through the preload, NOT
  // window.api (which is httpApi in HTTP mode and has no OS access).
  clipboardReadImage(): Promise<ArrayBuffer | null>;
  // Read an arbitrary local (Mac) file's bytes — e.g. a Desktop screenshot
  // detected by main's fs.watch. Only main can touch the OS filesystem.
  readLocalFile(path: string): Promise<ArrayBuffer>;
  openExternal(url: string): Promise<void>;
  revealInFolder(localPath: string): Promise<void>;
  getPathForFile(file: File): string;
  onDesktopNotify(
    cb: (payload: DesktopNotifyPayload) => void,
  ): () => void;
  // HTTP-mode peek: triggers the main process to fetch from /api/peek and
  // open the file locally. Only available when the desktop is in "http"
  // transport mode (paired to a manta-server). No-op on mobile/web.
  //
  // NOTE (BET-127): this is the SAME name the preload runtime exposes
  // (`peekRemoteFile` in src/preload/index.ts) — there is no ipcMain.handle
  // registered for IPC.peekRemoteFile in src/main/index.ts today, so calling
  // this currently rejects rather than opening a file. That gap predates this
  // extraction and is out of scope here (flagged for a follow-up); this
  // change only reconciles the name so httpApi's `window.__mantaPreload` probe
  // (httpApi.ts peekRemoteFile) actually finds the method instead of always
  // silently falling through to the (also-stubbed) server RPC no-op.
  peekRemoteFile(remotePath: string): Promise<void>;
  // BET-207: `pluginsEnabled` is a Mac-machine-local toggle — the toggle
  // MUST persist to the Mac-local config (the one capExecutor reads at
  // start time), NOT the box config httpApi.configUpdate writes. Seed the
  // toggle's initial state via pluginsGetEnabled and persist via
  // pluginsSetEnabled; both are no-ops on mobile/web (no preload).
  pluginsGetEnabled(): Promise<boolean>;
  pluginsSetEnabled(value: boolean): Promise<void>;
  // Client version (BET-225 stage 3): returns the running desktop app's own
  // version via main → `app.getVersion()`. Combined with the server's
  // `minClient` (from getServerVersion) by the renderer's isClientTooOld
  // check to decide whether to render the non-dismissible skew banner.
  // httpApi calls this as the desktop-side leg of `getClientVersion()`;
  // mobile/web have no preload and fall back to a build-time `__APP_VERSION__`
  // define in the renderer bundle.
  clientVersion(): Promise<{ version: string }>;
  // Server-update available subscription (BET-225 stage 3): fires when the
  // box's server-update poller (src/server/serverUpdate.mjs) sees a newer
  // manifest version. Mirrors the desktopNotify pattern — main subscribes
  // to manta-server's /events SSE, filters by kind, and forwards the payload
  // via IPC. The renderer's UpdateBar component renders a "Server update
  // available: {version}" bar with a button that calls serverUpdateApply().
  onServerUpdateAvailable(
    cb: (payload: ServerUpdateAvailablePayload) => void,
  ): () => void;
}

/**
 * Typed accessor for `window.__mantaPreload`.
 *
 * `main.tsx` always initializes `window.__mantaPreload`:
 *   - Electron http-mode: the real preload (set in chooseDesktopTransport).
 *   - Electron preload-mode: the real preload (aliased from window.api).
 *   - Mobile/web: null (no preload ran).
 *
 * Callers should treat the return value as `MantaPreload | null` and no-op
 * when null — never assume it's non-null.
 */
export function getMantaPreload(): MantaPreload | null {
  return window.__mantaPreload;
}
