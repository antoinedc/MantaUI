import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IPC,
  type AppConfig,
  type AuthClaimInput,
  type DesktopNotifyPayload,
  type ServerUpdateAvailablePayload,
  type AutoUpdateInfo,
  type AutoUpdateErrorInfo,
  type InstallerEvent,
  type InstallerState,
  type InstallerStageSnapshotRow,
} from "../shared/types.js";
import type { ClaimOutcome } from "../shared/claim.mjs";
import type { UnpairOutcome } from "../shared/unpair.mjs";
import type { PreflightResult } from "../main/installer/preflight.js";
import type { SshHostEntry } from "../main/installer/sshConfig.js";
import type { SshTarget } from "../shared/sshTarget.js";

// This is the OS-bridge + pairing SUBSET of the full `Api` contract
// (`src/shared/api.ts`) — the methods the desktop preload runtime actually
// implements. Everything else in `Api` (tmux/opencode/config/schedule/
// secrets/webhook/voice/git/fs/pty/...) is httpApi-only now (BET-82: "SSH
// main path gone" — `window.api` is always httpApi on desktop, never this
// object). See `src/renderer/preloadAccess.ts` for the typed accessor most
// callers should use (`getMantaPreload()`), and BET-127 for the extraction
// history.

// pair-link buffering: main may push the URL (cold start) before React has
// mounted and subscribed. Register the ipc listener immediately at preload
// load; hold the last URL until the renderer attaches its callback.
let bufferedPairUrl: string | null = null;
let pairLinkCb: ((url: string) => void) | null = null;
ipcRenderer.on(IPC.pairLinkReceived, (_event, url: string) => {
  if (pairLinkCb) pairLinkCb(url);
  else bufferedPairUrl = url;
});

const api = {
  // Read ONLY by main.tsx's boot sequence (`chooseDesktopTransport`), before
  // httpApi is installed as `window.api` — used to seed httpApi's
  // localStorage credentials from the desktop's local config.json (pairing
  // triple). This is the one "data" method that must stay: it is called
  // directly on `window.__mantaPreload`, never through `window.api`.
  configGet: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.configGet),

  // Onboarding pairing (BET-49): exchange a 6-digit code for the box's tokens
  // via POST <serverUrl>/auth/claim. On success main persists
  // { serverUrl, boxId, boxToken } to config (flipping transport to "http").
  // Resolves to a classified ClaimOutcome — a wrong/expired code is a normal
  // { ok:false } result, NOT a rejected promise.
  authClaim: (input: AuthClaimInput): Promise<ClaimOutcome> =>
    ipcRenderer.invoke(IPC.authClaim, input),

  // BET-357 §2: "Remove this box from the device that holds the current
  // box_token". Main reads the live { serverUrl, boxToken } from config
  // (never trusting a renderer-supplied copy — those would be stale the
  // instant the config changes), DELETEs <serverUrl>/auth/revoke, and
  // ALWAYS clears the local config entry as a single transactional step.
  // The unreachable-box path therefore still succeeds locally; the
  // UnpairOutcome is the structured note the Settings panel renders
  // ("removed locally — remote revocation didn't reach the box").
  authUnpair: (): Promise<UnpairOutcome> => ipcRenderer.invoke(IPC.authUnpair),

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

  onPairLink: (cb: (url: string) => void): (() => void) => {
    pairLinkCb = cb;
    if (bufferedPairUrl) {
      const url = bufferedPairUrl;
      bufferedPairUrl = null;
      cb(url);
    }
    return () => {
      if (pairLinkCb === cb) pairLinkCb = null;
    };
  },

  // manta-server's notification router decided the desktop should show an OS
  // notification (delivered from manta-server over the /events SSE stream).
  // The renderer shows it via the Notification API after a local "am I
  // viewing this?" check.
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

  // Client version (BET-225 stage 3): returns the running desktop app's own
  // version via main → `app.getVersion()` (the authoritative live source —
  // reads the same package.json the server uses for `server:version`).
  // httpApi calls this as the desktop-side leg of `getClientVersion()`;
  // mobile/web have no preload and fall back to a build-time `__APP_VERSION__`
  // define in the renderer bundle.
  clientVersion: (): Promise<{ version: string }> =>
    ipcRenderer.invoke(IPC.clientVersion),

  // Server-update available subscription (BET-225 stage 3): main subscribes
  // to manta-server's /events SSE stream (src/main/serverUpdateForwarder.ts),
  // filters on kind === "serverUpdateAvailable", and forwards the payload
  // to the renderer via this IPC channel. Mirrors the desktopNotify
  // one-kind-filter pattern; share the same kind/payload envelope.
  onServerUpdateAvailable: (cb: (payload: ServerUpdateAvailablePayload) => void): (() => void) => {
    const listener = (_: unknown, payload: ServerUpdateAvailablePayload) => cb(payload);
    ipcRenderer.on(IPC.serverUpdateAvailable, listener);
    return () => ipcRenderer.removeListener(IPC.serverUpdateAvailable, listener);
  },

  // ---- desktop auto-update (electron-updater) ----
  // These MUST live on the preload bridge, not on window.api. On a paired
  // desktop window.api is httpApi, whose auto-update entries are no-op stubs
  // (correct for mobile/web, which has no updater). Desktop is ALWAYS in http
  // mode since the SSH transport was removed, so before these existed main
  // downloaded updates and pushed autoUpdate:* IPC into a renderer that was
  // subscribed to a stub — the "Restart to update" banner could never appear
  // and autoUpdateInstall() resolved without doing anything. httpApi now
  // routes to these when window.__mantaPreload is present (same delegation
  // pattern as peekRemoteFile).
  autoUpdateDownload: (): Promise<void> => ipcRenderer.invoke(IPC.autoUpdateDownload),
  autoUpdateInstall: (): Promise<void> => ipcRenderer.invoke(IPC.autoUpdateInstall),
  onAutoUpdateAvailable: (cb: (info: AutoUpdateInfo) => void): (() => void) => {
    const listener = (_: unknown, info: AutoUpdateInfo) => cb(info);
    ipcRenderer.on(IPC.autoUpdateAvailable, listener);
    return () => ipcRenderer.removeListener(IPC.autoUpdateAvailable, listener);
  },
  onAutoUpdateDownloaded: (cb: (info: AutoUpdateInfo) => void): (() => void) => {
    const listener = (_: unknown, info: AutoUpdateInfo) => cb(info);
    ipcRenderer.on(IPC.autoUpdateDownloaded, listener);
    return () => ipcRenderer.removeListener(IPC.autoUpdateDownloaded, listener);
  },
  onAutoUpdateError: (cb: (info: AutoUpdateErrorInfo) => void): (() => void) => {
    const listener = (_: unknown, info: AutoUpdateErrorInfo) => cb(info);
    ipcRenderer.on(IPC.autoUpdateError, listener);
    return () => ipcRenderer.removeListener(IPC.autoUpdateError, listener);
  },

  // ---- SSH installer (BET-355 — Stage 4) ----
  // Preload bridge for the renderer's "install a new box via SSH" flow.
  // Every method here is one IPC round-trip; events come back via
  // onInstallerEvent below (same subscribe/unsubscribe pattern as the
  // pairLink / screenshotDetected / autoUpdate* listeners). The renderer
  // holds the only SshHostEntry alias it passes to installStart; the
  // installer module owns the resulting ssh child process.

  // Read ~/.ssh/config and return the pickable aliases (Host * is skipped).
  installerListHosts: (): Promise<SshHostEntry[]> =>
    ipcRenderer.invoke(IPC.installerListHosts),

  // Start the install over SSH. Preflight (silent reachability, OS/arch,
  // passwordless sudo, tailscale, clock skew, already-installed) runs as
  // phase 1 of this call, in main (BET-383) — there is no separate
  // preflight channel. A failed preflight aborts before anything is
  // written to the box and is reported via onInstallerEvent as a
  // `preflight-failed` event, not as a rejection. Returns immediately with
  // a handle id; the actual install streams back via onInstallerEvent
  // (line / stage / preflight-failed / done / error). The renderer matches
  // events to its handle id so an out-of-band cancel doesn't lose events
  // mid-flight.
  installerStart: (input: { alias: SshTarget }): Promise<{ handleId: string }> =>
    ipcRenderer.invoke(IPC.installerStart, input),

  // Cancel the in-flight install. Idempotent: safe to call on a stale
  // handle id, on an already-done handle, or twice in a row.
  installerCancel: (input: { handleId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.installerCancel, input),

  // BET-361: the renderer's answer to a paused `fingerprint` event. trust=true
  // → main writes the host key to ~/.ssh/known_hosts (verifying it matches
  // the shown fingerprint) and re-runs preflight; trust=false → the install
  // aborts with a preflight-failed event. Resolves once main has acted on
  // the decision; the renderer does NOT need to wait for a separate event.
  installerTrustHost: (input: { handleId: string; trust: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC.installerTrustHost, input),

  // Mint a fresh pairing code over the existing SSH connection + claim it
  // via the box's public URL. Persists credentials through main's existing
  // claim path (single config writer, per BET-355 constraint #4). The
  // ClaimOutcome has the same shape as the manual PairStep claim — the
  // renderer treats success and failure the same way regardless of which
  // entry point produced them.
  installerMintAndClaim: (input: {
    alias: SshTarget;
    claimUrlOverride?: string;
  }): Promise<ClaimOutcome> =>
    ipcRenderer.invoke(IPC.installerMintAndClaim, input),

  // Returns { active, stage, logTail } — the renderer calls this on mount
  // to recover the current install state after a page refresh (the install
  // survives the renderer's remount; only its display needs rehydrating).
  installerState: (): Promise<InstallerState> =>
    ipcRenderer.invoke(IPC.installerState),

  // Build a redacted diagnostics blob for the "Copy diagnostics" action.
  // Pure: takes the preflight + stage + log tail, returns the text blob.
  // Redaction (BET-355 §6) strips 32-hex tokens, 6-digit codes, ssh-key
  // paths, host fingerprints, and Authorization: Bearer values.
  installerGetDiagnostics: (input: {
    preflight: PreflightResult;
    stage: InstallerStageSnapshotRow["id"];
    logTail: string[];
    alias?: string;
  }): Promise<string> => ipcRenderer.invoke(IPC.installerGetDiagnostics, input),

  // Push events from main while an install is in flight. Returns an
  // unsubscribe function (same pattern as onAutoUpdateAvailable above).
  // The renderer dispatches on `event.kind`:
  //   "line"  → append to log display
  //   "stage" → update the checklist + which stage is "active"
  //   "done"  → install finished; ok=true → call installerMintAndClaim
  //   "error" → install failed; show failure + offer "Copy diagnostics"
  onInstallerEvent: (cb: (event: InstallerEvent) => void): (() => void) => {
    const listener = (_: unknown, event: InstallerEvent) => cb(event);
    ipcRenderer.on(IPC.installerEvent, listener);
    return () => ipcRenderer.removeListener(IPC.installerEvent, listener);
  },
};

// Expose the real preload bridge under a STABLE, dedicated name — NOT "api".
// contextBridge.exposeInMainWorld makes the property read-only + non-
// configurable, so whatever name it's given can never be reassigned. The
// renderer entry (main.tsx) needs to install `window.api` itself and, in
// http/paired mode, SWAP it for the httpApi client — a swap that throws
// "Cannot assign to read only property 'api'" if `api` is the contextBridge
// property. So we bridge under `__mantaPreload` (immutable, always the genuine
// Electron preload) and let main.tsx define a writable `window.api` from it.
contextBridge.exposeInMainWorld("__mantaPreload", api);
