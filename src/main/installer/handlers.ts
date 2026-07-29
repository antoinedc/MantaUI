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
import { IPC } from "../../shared/types.js";
import {
  listSshHosts,
  preflightBox,
  runInstall,
  mintAndClaim,
  DEFAULT_SSH_CONFIG_PATH,
} from "./installer.js";
import { buildDiagnostics, type DiagnosticsInput } from "./diagnostics.js";
import {
  buildStageSnapshot,
  type InstallStageId,
} from "./stageMapper.js";

// ---------------------------------------------------------------------------
// Per-install state (single-active; the renderer can re-mount and recover)
// ---------------------------------------------------------------------------

let activeHandle: { handleId: string; cancel: () => void } | null = null;
let activeStage: InstallStageId = "preflight";
const logTail: string[] = [];
const LOG_TAIL_MAX = 200;
let nextHandleSeq = 0;

function pushTail(line: string): void {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_MAX) logTail.splice(0, logTail.length - LOG_TAIL_MAX);
}

// ---------------------------------------------------------------------------
// registerInstallerHandlers — wire the IPC channels for the installer module.
// `getWindow` resolves the BrowserWindow that should receive push events
// (null → no push, no error — the renderer can re-mount and read state).
// ---------------------------------------------------------------------------

export function registerInstallerHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.installerListHosts, () => listSshHosts(DEFAULT_SSH_CONFIG_PATH));

  ipcMain.handle(IPC.installerPreflight, async (_e, input: { alias: string }) => {
    return preflightBox(input.alias);
  });

  ipcMain.handle(IPC.installerState, () => ({
    active: activeHandle !== null,
    stage: activeStage,
    logTail: [...logTail],
  }));

  ipcMain.handle(IPC.installerStart, async (_e, input: { alias: string }) => {
    if (activeHandle !== null) {
      // Single-active constraint — refuse to start a second install.
      // The renderer should call installCancel first (or wait for done).
      throw new Error("an install is already in progress");
    }
    if (typeof input?.alias !== "string" || input.alias.trim() === "") {
      throw new Error("alias is required");
    }
    const handleId = `install-${++nextHandleSeq}-${Date.now()}`;
    activeStage = "preflight";
    logTail.length = 0;
    const win = getWindow();
    const send = (payload: unknown) => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.installerEvent, payload);
    };
    const handle = runInstall(
      input.alias,
      {
        onLine: (line) => {
          pushTail(line);
          send({ kind: "line", handleId, text: line });
        },
        onStage: (stage) => {
          activeStage = stage;
          send({
            kind: "stage",
            handleId,
            stage,
            snapshot: buildStageSnapshot(stage),
          });
        },
      },
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
      })
      .catch((err: unknown) => {
        send({
          kind: "error",
          handleId,
          message: err instanceof Error ? err.message : String(err),
        });
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
    if (activeHandle?.handleId === input.handleId) {
      activeHandle.cancel();
    }
    // If handleId doesn't match the active handle (already done / cancelled
    // / a stale renderer): no-op. cancel is idempotent by design.
  });

  ipcMain.handle(IPC.installerMintAndClaim, async (
    _e,
    input: { alias: string; claimUrlOverride?: string },
  ) => {
    return mintAndClaim(input.alias, {
      persist: (patch) => {
        // Persist via main's existing config writer — same one the manual
        // claim path uses (BET-355 constraint #4: one config writer).
        const { commit } = require("../index.js");
        commit(patch);
      },
      claimUrlOverride: input.claimUrlOverride,
    });
  });

  ipcMain.handle(IPC.installerGetDiagnostics, (_e, input: DiagnosticsInput) => {
    return buildDiagnostics(input);
  });
}
