// handlers.ts — IPC handler wiring for the installer module.
//
// This file is the BRIDGE between src/main/installer/ (pure logic + I/O) and
// the Electron IPC channels. The renderer talks to these channels; these
// handlers delegate to the installer functions and stream per-install events
// back to the renderer via webContents.send(IPC.installerEvent, ...).
//
// Architectural rule (BET-355): SSH is installer-only. Every ssh-spawning
// function lives in src/main/installer/. This file adds NO ssh calls of its
// own — it only routes IPC traffic into the installer module's existing API.
//
// State: the installer is single-active per desktop process. The renderer
// can ask for the current state (recovering after a page refresh), and the
// main process keeps the current install's identity so a stale `cancel`
// from an earlier renderer (e.g. after a refresh) can no-op cleanly.

import { ipcMain, type BrowserWindow } from "electron";
import { IPC, type AppConfig } from "../../shared/types.js";
import {
  listSshHosts,
  preflightBox,
  runInstall,
  mintAndClaim,
  DEFAULT_SSH_CONFIG_PATH,
} from "./installer.js";
import { buildDiagnostics, type DiagnosticsInput } from "./diagnostics.js";
import { trustHost } from "./knownHosts.js";
import { createAskpassSession, type AskpassSession } from "./askpass.js";
import type { InstallStageId } from "./stageMapper.js";
import type { PreflightResult } from "./preflight.js";
import type { HostFingerprint } from "./fingerprint.js";
import { isEmptySshTarget, type SshTarget } from "../../shared/sshTarget.js";

// ---------------------------------------------------------------------------
// Per-install state (single-active; the renderer can re-mount and recover)
// ---------------------------------------------------------------------------

let activeHandle: { handleId: string; cancel: () => void } | null = null;
let activeStage: InstallStageId = "preflight";
const logTail: string[] = [];
const LOG_TAIL_MAX = 200;
let nextHandleSeq = 0;
// Most recent preflight verdict, read back by IPC.installerState.
let activePreflight: PreflightResult | null = null;
// BET-705 b: the SshTarget the most recent installerStart was asked to
// install. It's the SINGLE source of truth for the auto-claim after `done` —
// the claim must go against the same host the install used, even after a
// renderer remount reset the host picker. Overwritten on each new install
// start; NOT cleared on completion (the claim runs after `done`).
let lastInstallTarget: SshTarget | null = null;

// BET-361: when preflight hits a never-seen host, the install PAUSES here
// waiting for the renderer's "Trust this host" answer. The deferred is
// resolved by the installerTrustHost handler (trust=true/false) or rejected
// by installerCancel / a timeout. `waitingForTrust` is mirrored into
// installerState so a renderer remount re-shows the prompt.
let waitingForTrust: {
  handleId: string;
  fingerprint: HostFingerprint;
  target: SshTarget;
} | null = null;
let trustDeferred: {
  resolve: (decision: { trust: boolean }) => void;
  reject: (err: Error) => void;
} | null = null;
// How long the install waits for a trust answer before giving up. Long
// enough that a user reading the fingerprint isn't rushed; short enough
// that a forgotten tab doesn't hold the single-active slot forever.
const TRUST_WAIT_TIMEOUT_MS = 5 * 60_000;

// BET-360: when preflight (BatchMode=yes) returns auth-failed because the
// key is passphrase-protected and not in ssh-agent, the install PAUSES here
// waiting for the renderer's passphrase input. The deferred is resolved by
// the installerAskpassRespond handler (passphrase string) or rejected by
// installerCancel / a timeout (both → null = cancelled). `waitingForPassphrase`
// is mirrored into installerState so a renderer remount re-shows the prompt.
let waitingForPassphrase: { handleId: string; prompt: string } | null = null;
let passphraseDeferred: {
  resolve: (passphrase: string | null) => void;
} | null = null;
const PASSPHRASE_WAIT_TIMEOUT_MS = 5 * 60_000;

// The active askpass session (temp dir + helper script + passphrase file).
// Created when the user enters a passphrase; persists through the preflight
// retry + install + claim so every ssh invocation reuses the cached
// passphrase without re-prompting. Cleaned up on claim success, install
// failure, cancel, or a new install start.
let activeAskpass: AskpassSession | null = null;

function cleanupAskpass(): void {
  if (activeAskpass) {
    activeAskpass.cleanup();
    activeAskpass = null;
  }
}

function pushTail(line: string): void {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_MAX) logTail.splice(0, logTail.length - LOG_TAIL_MAX);
}

// awaitTrustDecision — pause the install while the renderer shows the host
// fingerprint and a Trust button. Resolves with the user's answer
// ({ trust: true|false }); a cancel or a timeout both resolve to
// { trust: false } so the caller has a single, rejection-free path. The
// module-level `waitingForTrust` is set for the duration so installerState
// can recover the prompt after a renderer remount, and cleared on settle.
async function awaitTrustDecision(
  handleId: string,
  fingerprint: HostFingerprint,
  target: SshTarget,
  send: (payload: unknown) => void,
): Promise<{ trust: boolean }> {
  waitingForTrust = { handleId, fingerprint, target };
  send({ kind: "fingerprint", handleId, fingerprint });
  return new Promise<{ trust: boolean }>((resolve) => {
    let settled = false;
    const finish = (decision: { trust: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waitingForTrust = null;
      trustDeferred = null;
      resolve(decision);
    };
    const timer = setTimeout(() => finish({ trust: false }), TRUST_WAIT_TIMEOUT_MS);
    trustDeferred = {
      resolve: (d) => finish(d),
      reject: () => finish({ trust: false }),
    };
  });
}

// awaitPassphrase — pause the install while the renderer shows a passphrase
// input. Resolves with the passphrase string, or null if the user cancelled
// / the wait timed out. A null resolution is rejection-free so the caller
// has a single path: null → abort with the original auth-failed guidance.
async function awaitPassphrase(
  handleId: string,
  prompt: string,
  send: (payload: unknown) => void,
): Promise<string | null> {
  waitingForPassphrase = { handleId, prompt };
  send({ kind: "passphrase", handleId, prompt });
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (passphrase: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waitingForPassphrase = null;
      passphraseDeferred = null;
      resolve(passphrase);
    };
    const timer = setTimeout(() => finish(null), PASSPHRASE_WAIT_TIMEOUT_MS);
    passphraseDeferred = {
      resolve: (p) => finish(p),
    };
  });
}

// ---------------------------------------------------------------------------
// registerInstallerHandlers — wire the IPC channels for the installer module.
// `getWindow` resolves the BrowserWindow that should receive push events
// (null → no push, no error — the renderer can re-mount and read state).
// `persist` is the SAME config writer main uses for the manual claim path
// (see src/main/index.ts `commit`). Injected here so the installer module
// stays out of the main module's require graph — same constraint that
// keeps the manual pairing path from accidentally inventing a second
// writer (BET-355 constraint #4: one config writer).
// ---------------------------------------------------------------------------

export function registerInstallerHandlers(
  getWindow: () => BrowserWindow | null,
  persist: (patch: Partial<AppConfig>) => void,
): void {
  ipcMain.handle(IPC.installerListHosts, () => listSshHosts(DEFAULT_SSH_CONFIG_PATH));

  ipcMain.handle(IPC.installerState, () => ({
    active: activeHandle !== null,
    stage: activeStage,
    logTail: [...logTail],
    preflight: activePreflight,
    // BET-705 b: expose the active handle id so a renderer remount can
    // restore it (needed for Cancel), and the stored install target so the
    // auto-claim is always against the host that was actually installed.
    activeHandleId: activeHandle?.handleId ?? null,
    target: lastInstallTarget,
    // BET-361: mirror the trust-pause so a renderer remount re-shows the
    // fingerprint prompt and routes its answer to the right handle.
    waitingForTrust: waitingForTrust !== null,
    trustHandleId: waitingForTrust?.handleId ?? null,
    pendingFingerprint: waitingForTrust?.fingerprint ?? null,
    // BET-360: mirror the passphrase-pause so a renderer remount re-shows
    // the passphrase prompt.
    waitingForPassphrase: waitingForPassphrase !== null,
    passphraseHandleId: waitingForPassphrase?.handleId ?? null,
  }));

  ipcMain.handle(IPC.installerStart, async (_e, input: { alias: SshTarget }) => {
    if (activeHandle !== null || waitingForTrust !== null || waitingForPassphrase !== null) {
      // Single-active constraint — refuse to start a second install. The
      // trust-pause and passphrase-pause both count as "in progress": a
      // paused install holds the slot until the user answers (BET-361/360).
      throw new Error("an install is already in progress");
    }
    if (input?.alias === undefined || isEmptySshTarget(input.alias)) {
      throw new Error("alias is required");
    }
    // Clear any stale askpass session from a previous (failed/cancelled)
    // install — the passphrase temp file must not survive across installs.
    cleanupAskpass();
    // Alias branch stays a trimmed string (unchanged); a custom target
    // (BET-384) is already normalized by resolveInstallTarget on the
    // renderer side, so there's nothing further to trim on an object.
    const alias = typeof input.alias === "string" ? input.alias.trim() : input.alias;
    // BET-705 b: record the target this install is actually installing —
    // the auto-claim that follows `done` must go against THIS host.
    lastInstallTarget = alias;
    const handleId = `install-${++nextHandleSeq}-${Date.now()}`;
    activeStage = "preflight";
    logTail.length = 0;
    activePreflight = null;
    const win = getWindow();
    const send = (payload: unknown) => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.installerEvent, payload);
    };

    // Phase 1 — preflight, run here in main. On a never-seen host ssh
    // offers a fingerprint and bails (BatchMode=yes); preflight surfaces
    // that as `unknownHost`. We PAUSE for a trust decision, write the host
    // key to ~/.ssh/known_hosts, then re-run preflight exactly once. A
    // second failure after trust (different problem, or a key that
    // changed) is reported as a normal preflight-failed — no retry loop.
    let preflight = await preflightBox(alias);
    activePreflight = preflight;
    if (!preflight.ok && preflight.unknownHost) {
      const decision = await awaitTrustDecision(
        handleId,
        preflight.unknownHost,
        alias,
        send,
      );
      if (!decision.trust) {
        // User declined, cancelled, or the trust wait timed out. Nothing
        // was written to the box — the standard preflight-failed guidance
        // (which already says "pick a different host") is the right call.
        send({ kind: "preflight-failed", handleId, failures: preflight.failures });
        return { handleId };
      }
      const trusted = await trustHost({
        target: alias,
        fingerprint: preflight.unknownHost,
      });
      if (!trusted.ok) {
        send({
          kind: "preflight-failed",
          handleId,
          failures: [
            {
              cause: "Could not trust this host.",
              action: trusted.message,
            },
          ],
        });
        return { handleId };
      }
      // Host key is now in known_hosts — re-run preflight over the now-
      // trusted connection.
      preflight = await preflightBox(alias);
      activePreflight = preflight;
    }

    // BET-360: auth-failed on a reachable, trusted host means the key is
    // passphrase-protected and not in ssh-agent. Pause for a passphrase,
    // then re-run preflight with SSH_ASKPASS enabled. A cancel / timeout
    // (null passphrase) aborts with the original auth-failed guidance —
    // nothing was written to the box. We do NOT loop: a second auth-failed
    // after askpass (wrong passphrase) is a normal preflight-failed.
    if (!preflight.ok && preflight.probes.reachability === "auth-failed") {
      const passphrase = await awaitPassphrase(
        handleId,
        "Enter the passphrase for your SSH key:",
        send,
      );
      if (passphrase === null) {
        send({ kind: "preflight-failed", handleId, failures: preflight.failures });
        return { handleId };
      }
      const session = createAskpassSession(passphrase);
      activeAskpass = session;
      try {
        preflight = await preflightBox(alias, { askpassEnv: session.env });
        activePreflight = preflight;
      } catch {
        session.cleanup();
        activeAskpass = null;
        send({ kind: "preflight-failed", handleId, failures: preflight.failures });
        return { handleId };
      }
      if (!preflight.ok) {
        session.cleanup();
        activeAskpass = null;
        send({ kind: "preflight-failed", handleId, failures: preflight.failures });
        return { handleId };
      }
    }

    if (!preflight.ok) {
      send({ kind: "preflight-failed", handleId, failures: preflight.failures });
      return { handleId };
    }

    const handle = runInstall(
      alias,
      {
        onLine: (line) => {
          pushTail(line);
          send({ kind: "line", handleId, text: line });
        },
        onStage: (stage) => {
          activeStage = stage;
          send({ kind: "stage", handleId, stage });
        },
      },
      { askpassEnv: activeAskpass?.env },
    );
    activeHandle = { handleId, cancel: handle.cancel };
    // Fire-and-forget the done promise — we push the done event ourselves
    // so the renderer learns the exit code/signal. Errors during the install
    // are reported as { kind: "error", message } events.
    handle.done
      .then((r) => {
        send({
          kind: "done",
          handleId,
          code: r.code,
          signal: r.signal,
          ok: r.code === 0,
        });
        // On a FAILED install, the SSH connection is no longer needed —
        // clean up the askpass session immediately. On success, keep it
        // alive for the mint+claim phase (installerMintAndClaim cleans up
        // after a successful claim).
        if (r.code !== 0) cleanupAskpass();
      })
      .catch((err: unknown) => {
        send({
          kind: "error",
          handleId,
          message: err instanceof Error ? err.message : String(err),
        });
        cleanupAskpass();
      })
      .finally(() => {
        // Only clear if THIS handle is still the active one — a cancel-then-
        // start sequence must not let an older done finally erase the new
        // handle's state.
        if (activeHandle?.handleId === handleId) {
          activeHandle = null;
          activeStage = "done";
        }
      });
    return { handleId };
  });

  ipcMain.handle(IPC.installerCancel, (_e, input: { handleId: string }) => {
    if (typeof input?.handleId !== "string" || input.handleId === "") return;
    // BET-360: cancel during the passphrase-pause aborts the wait (treated
    // as "cancelled" → null passphrase → the install aborts with the
    // original auth-failed guidance). No child to SIGTERM yet.
    if (waitingForPassphrase?.handleId === input.handleId && passphraseDeferred) {
      passphraseDeferred.resolve(null);
      return;
    }
    // BET-361: cancel during the trust-pause aborts the wait (treated as
    // "not trusted" — the install never started, so there's no child to
    // SIGTERM).
    if (waitingForTrust?.handleId === input.handleId && trustDeferred) {
      trustDeferred.reject(new Error("cancelled"));
      return;
    }
    if (activeHandle?.handleId === input.handleId) {
      activeHandle.cancel();
      cleanupAskpass();
    }
    // If handleId doesn't match the active handle (already done / cancelled
    // / a stale renderer): no-op. cancel is idempotent by design.
  });

  ipcMain.handle(IPC.installerTrustHost, (_e, input: { handleId: string; trust: boolean }) => {
    if (typeof input?.handleId !== "string" || input.handleId === "") return;
    // No paused trust prompt, or a stale renderer answering an old prompt:
    // no-op. The active install (if any) is unaffected.
    if (!waitingForTrust || !trustDeferred) return;
    if (waitingForTrust.handleId !== input.handleId) return;
    trustDeferred.resolve({ trust: input.trust });
  });

  ipcMain.handle(
    IPC.installerAskpassRespond,
    (_e, input: { handleId: string; passphrase: string | null }) => {
      if (typeof input?.handleId !== "string" || input.handleId === "") return;
      // No paused passphrase prompt, or a stale renderer: no-op.
      if (!waitingForPassphrase || !passphraseDeferred) return;
      if (waitingForPassphrase.handleId !== input.handleId) return;
      // null or empty string → user cancelled. A non-empty string → the
      // passphrase to decrypt the SSH key.
      const pw = input.passphrase;
      passphraseDeferred.resolve(pw && pw.length > 0 ? pw : null);
    },
  );

  ipcMain.handle(IPC.installerMintAndClaim, async (
    _e,
    input: { alias?: SshTarget; claimUrlOverride?: string },
  ) => {
    // BET-705 b: prefer the stored install target (the single source of
    // truth — survives renderer remounts/host-picker resets); fall back to
    // the renderer-passed alias only when no install target is stored (e.g.
    // the app restarted between install and claim).
    const target = lastInstallTarget ?? input?.alias;
    if (target == null) {
      throw new Error("no install target to claim");
    }
    const result = await mintAndClaim(target, {
      persist,
      claimUrlOverride: input.claimUrlOverride,
      askpassEnv: activeAskpass?.env,
    });
    // After a successful claim the SSH connection is no longer needed —
    // the app switches to HTTP. Clean up the askpass session (temp dir +
    // passphrase file). On failure, keep it so the user can retry the
    // claim without re-entering the passphrase.
    if (result.ok) cleanupAskpass();
    return result;
  });

  ipcMain.handle(IPC.installerGetDiagnostics, (_e, input: DiagnosticsInput) => {
    return buildDiagnostics(input);
  });
}
