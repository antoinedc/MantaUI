import type {
  DesktopNotifyPayload,
  ServerUpdateAvailablePayload,
  AutoUpdateInfo,
  AutoUpdateErrorInfo,
  DesktopUpdateCheck,
  OpenFileResult,
} from "../shared/types.js";
import type { InstallerEvent, InstallerState } from "../shared/types.js";
import type { PreflightResult, PreflightFailure } from "../main/installer/preflight.js";
import type { SshHostEntry } from "../main/installer/sshConfig.js";
import type { InstallerStageSnapshotRow } from "../shared/types.js";
import type { UnpairOutcome } from "../shared/unpair.mjs";
import type { SshTarget } from "../shared/sshTarget.js";
import type { ClaimOutcome } from "../shared/claim.mjs";

// Re-export so the renderer can use the type names from the same accessor
// module that exposes the preload methods — same pattern as the existing
// `MantaPreload` consumers below. The types live in src/shared/types.ts so
// they can be imported by both preload AND renderer (two tsconfigs) without
// crossing the process boundary.
export type { InstallerEvent, InstallerState, InstallerStageSnapshotRow, PreflightFailure };

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
    cb: (ev: { source: "clipboard" | "file" | "unavailable"; path?: string; reason?: string }) => void,
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
  // Read the current clipboard TEXT (BET-704: onboarding pair-link
  // clipboard prefill). PairStep calls this on mount + window focus and
  // runs the result through `detectPairClipboard` — a hit offers a
  // one-tap "Use it" prefill of the manual pairing form. Never polled,
  // never auto-claims; the user still clicks Connect.
  readClipboardText(): Promise<string>;
  // Read an arbitrary local (Mac) file's bytes — e.g. a Desktop screenshot
  // detected by main's fs.watch. Only main can touch the OS filesystem.
  readLocalFile(path: string): Promise<ArrayBuffer>;
  openExternal(url: string): Promise<void>;
  revealInFolder(localPath: string): Promise<void>;
  // BET-1156: the one desktop download-to-downloads path. Main fetches
  // `/api/download?path=<remotePath>` with the box token and writes the bytes
  // to `downloadsDir` (default `~/Downloads`), deduping a name collision.
  // Returns the saved local absolute path on success, "" on failure. Only the
  // desktop preload exposes this; mobile/web callers see null and fall back to
  // a browser blob download.
  downloadFileToDownloads(remotePath: string, filename: string): Promise<string>;
  // BET-387: native file picker (single file, defaults to ~/.ssh/). Used by
  // the custom-host SSH installer panel's "Identity file" Browse button.
  // Returns { canceled:true } on a cancel / no-selection close; absent on
  // mobile/web (no preload) — callers check the accessor and no-op.
  dialogShowOpenFile(): Promise<OpenFileResult>;
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

  // BET-357 §2: "Remove this box from the device that holds the current
  // box_token". Main reads the live { serverUrl, boxToken } from config
  // (never trusting a renderer-supplied copy — those would be stale the
  // instant the config changes), DELETEs <serverUrl>/auth/revoke, and
  // ALWAYS clears the local config entry as a single transactional step.
  // The unreachable-box path therefore still succeeds locally; the
  // UnpairOutcome is the structured note the Settings panel renders
  // ("removed locally — remote revocation didn't reach the box").
  authUnpair(): Promise<UnpairOutcome>;
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
  // Desktop auto-update. These live here rather than on window.api because a
  // paired desktop's window.api is httpApi, whose auto-update entries are
  // no-op stubs written for mobile/web. Desktop has been permanently in http
  // mode since the SSH transport was removed, so routing auto-update through
  // window.api meant every event was delivered to a stub — the updater
  // downloaded fine and the UI never heard about it. httpApi delegates here
  // when the preload is present (same pattern as peekRemoteFile).
  autoUpdateDownload(): Promise<void>;
  autoUpdateInstall(): Promise<void>;
  // On-demand check that resolves with the verdict, for the "Check for updates"
  // button. The event subscriptions below cannot answer a button press: they
  // only ever report the positive case, so "up to date" has to come from here.
  autoUpdateCheck(): Promise<DesktopUpdateCheck>;
  onAutoUpdateAvailable(cb: (info: AutoUpdateInfo) => void): () => void;
  onAutoUpdateDownloaded(cb: (info: AutoUpdateInfo) => void): () => void;
  onAutoUpdateError(cb: (info: AutoUpdateErrorInfo) => void): () => void;
  onAutoUpdateProgress(cb: (p: { percent: number }) => void): () => void;

  // ---- SSH installer (BET-355 — Stage 4) ----
  // Preload bridge for the renderer's "install a new box via SSH" flow.
  // All installer channels live here (NOT on window.api / httpApi) because
  // the architectural rule is SSH-is-installer-only — there's no HTTP path
  // to fall through on, and the channels only exist when the preload ran
  // (i.e. the desktop is in Electron). Mobile/web callers see `null` from
  // getMantaPreload and must not render this UI at all.

  // Read ~/.ssh/config and return the pickable Host aliases (Host * is
  // skipped). The renderer's host picker reads this on mount.
  installerListHosts(): Promise<SshHostEntry[]>;

  // Kick off the install. Preflight (silent reachability, OS/arch,
  // passwordless sudo, tailscale, clock skew, already-installed) runs as
  // phase 1 of this call, in main (BET-383) — there is no separate
  // preflight channel. Returns the handle id the renderer uses to match
  // incoming installerEvent pushes; a failed preflight is reported via a
  // `preflight-failed` installerEvent, not a rejection.
  installerStart(input: { alias: SshTarget }): Promise<{ handleId: string }>;

  // SIGTERM the in-flight install. Idempotent: safe on a stale handle id
  // (one from a previous renderer mount) or on an already-done handle.
  installerCancel(input: { handleId: string }): Promise<void>;

  // BET-361: answer a paused `fingerprint` event. trust=true writes the
  // host key to ~/.ssh/known_hosts and resumes; trust=false aborts.
  installerTrustHost(input: { handleId: string; trust: boolean }): Promise<void>;

  // BET-360/979: answer a paused `secret` event (an SSH key passphrase OR
  // the box's sudo password — the kind tells main which). secret=non-empty
  // → main acts on it (creates an SSH_ASKPASS session + re-runs preflight
  // for a passphrase; stages ~/.manta-sudo-pass for a sudo password);
  // secret=null → the user cancelled → the install aborts.
  installerAskpassRespond(input: {
    handleId: string;
    secret: string | null;
  }): Promise<void>;

  // Mint a fresh pairing code over the existing SSH connection + claim it
  // via the box's public URL. Returns the SAME ClaimOutcome shape as the
  // manual PairStep claim — the renderer treats success and failure the
  // same way regardless of which entry point produced them. Persists
  // credentials through main's existing claim path (single config writer).
  installerMintAndClaim(input: {
    alias?: SshTarget;
    claimUrlOverride?: string;
  }): Promise<ClaimOutcome>;

  // Returns the current install's { active, stage, logTail } — the renderer
  // calls this on mount to recover the install state after a page refresh
  // (the install survives the renderer's remount; only the display needs
  // rehydrating).
  installerState(): Promise<InstallerState>;

  // Build a redacted diagnostics blob for the "Copy diagnostics" button.
  // Redacts 32-hex tokens, 6-digit codes, ssh-key paths, host fingerprints,
  // and Authorization: Bearer values (per BET-355 §6). Pure — the renderer
  // hands back whatever the user copied.
  installerGetDiagnostics(input: {
    preflight: PreflightResult;
    stage: InstallerStageSnapshotRow["id"];
    logTail: string[];
    alias?: string;
  }): Promise<string>;

  // Push events from main while an install is in flight. Returns an
  // unsubscribe function (same pattern as onAutoUpdateAvailable above).
  onInstallerEvent(cb: (event: InstallerEvent) => void): () => void;
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
