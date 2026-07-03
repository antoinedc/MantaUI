import type { DesktopNotifyPayload } from "../shared/types.js";

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
export interface BuiPreload {
  onScreenshotDetected(
    cb: (ev: { source: "clipboard" | "file"; path?: string }) => void,
  ): () => void;
  clipboardWriteText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealInFolder(localPath: string): Promise<void>;
  getPathForFile(file: File): string;
  onDesktopNotify(
    cb: (payload: DesktopNotifyPayload) => void,
  ): () => void;
}

/**
 * Typed accessor for `window.__buiPreload`.
 *
 * `main.tsx` always initializes `window.__buiPreload`:
 *   - Electron http-mode: the real preload (set in chooseDesktopTransport).
 *   - Electron preload-mode: the real preload (aliased from window.api).
 *   - Mobile/web: null (no preload ran).
 *
 * Callers should treat the return value as `BuiPreload | null` and no-op
 * when null — never assume it's non-null.
 */
export function getBuiPreload(): BuiPreload | null {
  return window.__buiPreload;
}
