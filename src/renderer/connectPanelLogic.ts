// connectPanel.ts — the single lever that collapses the onboarding step-1
// Connect panel's many render branches into one four-zone descriptor (BET-961).
//
// PairStep shows ONE Connect panel in two modes (BET-962): `ssh` (the host
// picker + install) or `manual` (code entry). Both modes share the same four
// zones — A·target, B·status, C·details, D·actions — and both funnel through
// this one function, which decides what the panel says from a mode-
// discriminated input. There is deliberately no second derive function and no
// mode branch inside ConnectPanel.tsx; the component just renders whatever
// descriptor this module produces.
//
// SshInstallStep feeds the `ssh` branch of `ConnectInput` (its ~15 pieces of
// install state); the manual code-entry mode feeds the `manual` branch.
// Today each combination used to get its own ad-hoc branch, so status
// appeared in five vertical positions and errors in four shapes. This module
// maps that state onto ONE descriptor — status (tone/text/meta/progress/sub),
// details (failures/hint/none), a sibling log pane, actions and the zone-A
// collapse — and
// ConnectPanel.tsx renders that descriptor, so nothing moves between states.
//
// Pure, no JSX, no React. The precedence rules below are the acceptance gate:
// one first-match-wins table per mode, rows evaluated in exactly this order.
//
// Reused, not reimplemented:
//   - stage label / index / total -> currentStageInfo (src/shared/installStages.ts)
//   - elapsed formatting           -> formatElapsed (src/renderer/ProcessPanel.tsx)

import { currentStageInfo, type InstallStageId } from "../shared/installStages";
import { formatElapsed } from "./ProcessPanel";

export type ConnectTone = "idle" | "running" | "attention" | "ok" | "error" | "neutral";

export type ConnectDetails =
  | { kind: "none" }
  | { kind: "failures"; items: Array<{ cause: string; action: string }> }
  | { kind: "hint"; text: string };

/** The sibling log pane below the panel. null = no pane at all. */
export type ConnectLog = { defaultOpen: boolean; showCopyDiagnostics: boolean } | null;

export type ConnectActionId =
  | "install"
  | "cancel"
  | "next"
  | "retry"
  | "editTarget"
  | "pairManually"
  | "connect"
  | "discard";

export type ConnectPanelState = {
  /** null = the status zone is omitted entirely (nothing is happening). */
  status: {
    tone: ConnectTone;
    text: string;
    meta: string | null; // e.g. "3 of 6 · 0:24"
    progress: number | null; // 0..1, null = no bar
    sub: string | null; // second line under the bar
  } | null;
  details: ConnectDetails;
  /** The log pane rendered BELOW the panel, not inside it. */
  log: ConnectLog;
  actions: ConnectActionId[]; // first is primary, rest secondary
  /** Action ids whose button must render disabled. The manual mode's Connect
   *  stays disabled until `canConnectSetup` passes; the ssh mode has its own
   *  inline gate. Absent/undefined = nothing disabled. */
  disabledActions?: ConnectActionId[];
  /** true = zone A shows the one-line target summary instead of the picker. */
  targetCollapsed: boolean;
};

/** The claim outcome — shared by both modes. */
export type SharedConnectFields = {
  claimError: string | null; // the message claimBox / mint returned on failure
  paired: boolean; // claim succeeded — the terminal "Connected" row for both modes
};

/** The SSH-install mode's state (owned by SshInstallStep). */
export type SshConnectFields = {
  hostsLoaded: boolean;
  targetError: string | null;
  running: boolean;
  stage: InstallStageId;
  elapsedSeconds: number;
  logLineCount: number;
  done: { ok: boolean; code: number | null; signal: string | null } | null;
  installError: string | null;
  preflightFailure: { failures: Array<{ cause: string; action: string }> } | null;
  awaitingPrompt: boolean; // fingerprintPrompt !== null || passphrasePrompt !== null
  claimRunning: boolean;
  cancelled: boolean;
};

/** The manual code-entry mode's state (BET-962). */
export type ManualConnectFields = {
  prefillPresent: boolean; // clipboard / deep-link prefill → "Pairing link ready"
  canConnect: boolean; // canConnectSetup result → Connect disabled until true
  submitting: boolean; // claim in flight
};

export type ConnectInput =
  | ({ mode: "ssh" } & SshConnectFields & SharedConnectFields)
  | ({ mode: "manual" } & ManualConnectFields & SharedConnectFields);

/** `<stage meta>` — `${index} of ${total}` plus the elapsed time while the
 *  operation is actively progressing (install running OR claim retrying).
 *  Matches the mockup: running stages and the claim states both show time. */
function stageMeta(input: Extract<ConnectInput, { mode: "ssh" }>): string {
  const { index, total } = currentStageInfo(input.stage);
  const active = input.running || input.claimRunning;
  return active
    ? `${index} of ${total} · ${formatElapsed(input.elapsedSeconds)}`
    : `${index} of ${total}`;
}

/** A log pane, degraded to `null` when there is nothing to show — a pane
 *  must never render over an empty body. */
function logPane(
  defaultOpen: boolean,
  showCopyDiagnostics: boolean,
  logLineCount: number,
): ConnectLog {
  if (logLineCount === 0) return null;
  return { defaultOpen, showCopyDiagnostics };
}

/**
 * Evaluate the mode's precedence table first-match-wins. The table order in
 * each block is load-bearing — never reorder a row. In both modes `paired`
 * beats everything (a completed pair must hand off to the provider step); a
 * user `cancelled` beats `done.ok === false` (a cancel surfaces as a neutral
 * `done` with SIGTERM, and must not read as a failure).
 */
export function deriveConnectPanel(input: ConnectInput): ConnectPanelState {
  // ===== manual mode (rows M1–M5, BET-962) =====
  if (input.mode === "manual") {
    // M5 — claim succeeded → same terminal row as SSH: Connected + Next →.
    if (input.paired) {
      return {
        status: {
          tone: "ok",
          text: "Your server is ready",
          meta: null,
          progress: null,
          sub: null,
        },
        details: { kind: "none" },
        log: null,
        actions: ["next"],
        targetCollapsed: true,
      };
    }
    // M4 — claim failed: surface the exact message claimBox returned.
    if (input.claimError) {
      return {
        status: {
          tone: "error",
          text: input.claimError,
          meta: null,
          progress: null,
          sub: null,
        },
        details: { kind: "none" },
        log: null,
        actions: ["retry"],
        targetCollapsed: false,
      };
    }
    // M3 — submitting.
    if (input.submitting) {
      return {
        status: {
          tone: "running",
          text: "Pairing with this app",
          meta: null,
          progress: null,
          sub: null,
        },
        details: { kind: "none" },
        log: null,
        actions: ["cancel"],
        targetCollapsed: true,
      };
    }
    // M1 — clipboard / deep-link prefill present: Confirm or discard it.
    if (input.prefillPresent) {
      return {
        status: null,
        details: { kind: "none" },
        log: null,
        actions: ["connect", "discard"],
        targetCollapsed: false,
      };
    }
    // M2 — idle manual (default): the code is typed by hand.
    return {
      status: {
        tone: "idle",
        text: "Enter the 6-digit code from the server",
        meta: null,
        progress: null,
        sub: null,
      },
      details: { kind: "hint", text: "Run `manta pair` on the server to get a code." },
      log: null,
      actions: ["connect"],
      disabledActions: input.canConnect ? undefined : ["connect"],
      targetCollapsed: false,
    };
  }

  // ===== SSH install mode (rows 1–11) =====
  const targetCollapsed = input.running || input.claimRunning || input.paired;
  const { index, total, label } = currentStageInfo(input.stage);
  const progress = index / total;

  // 1 — paired.
  if (input.paired) {
    return {
      status: {
        tone: "ok",
        text: "Your server is ready",
        meta: `${total} of ${total} · ${formatElapsed(input.elapsedSeconds)}`,
        progress: 1,
        sub: null,
      },
      details: { kind: "none" },
      log: logPane(false, false, input.logLineCount),
      actions: ["next"],
      targetCollapsed,
    };
  }

  // 2 — preflight failed (nothing written).
  if (input.preflightFailure) {
    return {
      status: {
        tone: "error",
        text: "Couldn't reach the server",
        meta: stageMeta(input),
        progress,
        sub: null,
      },
      details: { kind: "failures", items: input.preflightFailure.failures },
      log: null,
      actions: ["retry", "editTarget"],
      targetCollapsed,
    };
  }

  // 3 — user cancelled (neutral, not a failure).
  if (input.cancelled) {
    return {
      status: {
        tone: "neutral",
        text: "Cancelled",
        meta: `stopped at ${index} of ${total}`,
        progress,
        sub: null,
      },
      details: { kind: "none" },
      log: logPane(false, false, input.logLineCount),
      actions: ["install"],
      targetCollapsed,
    };
  }

  // 4 — installed, but the claim (pairing) failed. Surface the REAL error the
  // claim returned (the actual outcome.message), not a fixed placeholder.
  if (input.claimError) {
    return {
      status: {
        tone: "error",
        text: "Installed, but pairing didn't complete",
        meta: "5 of 6",
        progress,
        sub: null,
      },
      details: { kind: "hint", text: input.claimError },
      log: null,
      actions: ["pairManually", "retry"],
      targetCollapsed,
    };
  }

  // 5 — install failed (hard error, or a non-cancel `done` with !ok).
  if (input.installError || (input.done && !input.done.ok)) {
    const code = input.done?.code ?? null;
    const meta =
      code === null
        ? `${index} of ${total}`
        : `${index} of ${total} · exit ${code}`;
    return {
      status: {
        tone: "error",
        text: `Install failed at “${label}”`,
        meta,
        progress,
        sub: null,
      },
      details: { kind: "none" },
      log: logPane(true, true, input.logLineCount),
      actions: ["retry", "pairManually"],
      targetCollapsed,
    };
  }

  // 6 — paused waiting on the user (fingerprint / passphrase prompt).
  if (input.awaitingPrompt) {
    return {
      status: {
        tone: "attention",
        text: "Waiting for you",
        meta: stageMeta(input),
        progress,
        sub: null,
      },
      details: { kind: "none" }, // the prompt renders as zone-C children
      log: null,
      actions: ["cancel"],
      targetCollapsed,
    };
  }

  // 7 — auto-claim in flight (single attempt — no retry loop behind it).
  if (input.claimRunning) {
    return {
      status: {
        tone: "running",
        text: "Pairing with this app",
        meta: stageMeta(input),
        progress,
        sub: null,
      },
      details: { kind: "none" },
      log: logPane(true, false, input.logLineCount),
      actions: ["cancel"],
      targetCollapsed,
    };
  }

  // 8 — install in flight.
  if (input.running) {
    return {
      status: {
        tone: "running",
        text: label,
        meta: stageMeta(input),
        progress,
        sub: null,
      },
      details: { kind: "none" },
      log: logPane(true, false, input.logLineCount),
      actions: ["cancel"],
      targetCollapsed,
    };
  }

  // 9 — hosts still loading.
  if (!input.hostsLoaded) {
    return {
      status: null,
      details: { kind: "none" },
      log: null,
      actions: ["install"],
      disabledActions: ["install"],
      targetCollapsed,
    };
  }

  // 10 — invalid target.
  if (input.targetError) {
    return {
      status: null,
      details: { kind: "none" },
      log: null,
      actions: ["install"],
      disabledActions: ["install"],
      targetCollapsed,
    };
  }

  // 11 — otherwise: ready to install.
  return {
    status: null,
    details: { kind: "none" },
    log: null,
    actions: ["install"],
    targetCollapsed,
  };
}
