// connectPanel.ts — the single lever that collapses SshInstallStep's many
// render branches into one four-zone Connect panel (BET-961).
//
// SshInstallStep holds ~15 pieces of state (hosts, targetError, running,
// stage, elapsed, done, installError, preflightFailure, the two prompts, the
// claim trio, cancelled, paired). Today each combination gets its own ad-hoc
// branch, so status appears in five vertical positions and errors come in four
// shapes. This module maps that state onto ONE descriptor — status (tone/text/
// meta/progress/sub), details (log/failures/hint/none), actions, hint and an
// A-zone lock — and ConnectPanel.tsx renders that descriptor, so nothing moves
// between states.
//
// Pure, no JSX, no React. The precedence rules below are the acceptance gate:
// one first-match-wins table, eleven rows, evaluated in exactly this order.
//
// Reused, not reimplemented:
//   - stage label / index / total -> currentStageInfo (src/shared/installStages.ts)
//   - elapsed formatting           -> formatElapsed (src/renderer/ProcessPanel.tsx)

import { currentStageInfo, type InstallStageId } from "../shared/installStages";
import { formatElapsed } from "./ProcessPanel";

export type ConnectTone = "idle" | "running" | "attention" | "ok" | "error" | "neutral";

export type ConnectDetails =
  | { kind: "none" }
  | { kind: "log"; defaultOpen: boolean; showCopyDiagnostics: boolean }
  | { kind: "failures"; items: Array<{ cause: string; action: string }> }
  | { kind: "hint"; text: string };

export type ConnectActionId =
  | "install"
  | "cancel"
  | "next"
  | "retry"
  | "editTarget"
  | "pairManually";

export type ConnectPanelState = {
  status: {
    tone: ConnectTone;
    text: string;
    meta: string | null; // e.g. "3 of 6 · 0:24"
    progress: number | null; // 0..1, null = no bar
    sub: string | null; // second line under the bar
  };
  details: ConnectDetails;
  actions: ConnectActionId[]; // first is primary, rest secondary
  hint: string | null; // right-aligned text in zone D
  targetLocked: boolean;
};

/** The row-4 pairing-failed hint. `manta pair` is rendered as <code> by
 *  ConnectPanel by splitting the backticks — keep the backticks here. */
const CLAIM_FAILED_HINT =
  "The box is running. Run `manta pair` on it for a fresh 6-digit code, then enter it here.";

/**
 * Build the thing ConnectPanel renders. `targetLocked` locks zone A (the
 * host picker) — true while an install or claim is in flight, or after
 * pairing succeeded.
 */
function computeTargetLocked(input: ConnectInput): boolean {
  return input.running || input.claimRunning || input.paired;
}

/** `<stage meta>` — `${index} of ${total}` plus the elapsed time while the
 *  operation is actively progressing (install running OR claim retrying).
 *  Matches the mockup: running stages and the claim states both show time. */
function stageMeta(input: ConnectInput): string {
  const { index, total } = currentStageInfo(input.stage);
  const active = input.running || input.claimRunning;
  return active
    ? `${index} of ${total} · ${formatElapsed(input.elapsedSeconds)}`
    : `${index} of ${total}`;
}

/** A log details kind, degraded to `none` when there are no lines to show —
 *  an action must never offer a log button over an empty pane. */
function logDetails(
  defaultOpen: boolean,
  showCopyDiagnostics: boolean,
  logLineCount: number,
): ConnectDetails {
  if (logLineCount === 0) return { kind: "none" };
  return { kind: "log", defaultOpen, showCopyDiagnostics };
}

export type ConnectInput = {
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
  claimElapsed: number | null;
  claimError: string | null;
  cancelled: boolean;
  paired: boolean;
};

/**
 * Evaluate the precedence table first-match-wins. The table order in the
 * switch below is load-bearing — never reorder a row. `paired` beats
 * everything (a completed pair must hand off to the provider step); a user
 * `cancelled` beats `done.ok === false` (a cancel surfaces as a neutral
 * `done` with SIGTERM, and must not read as a failure).
 */
export function deriveConnectPanel(input: ConnectInput): ConnectPanelState {
  const targetLocked = computeTargetLocked(input);
  const { index, total, label } = currentStageInfo(input.stage);
  const progress = index / total;

  // 1 — paired.
  if (input.paired) {
    return {
      status: {
        tone: "ok",
        text: "Connected — your box is ready",
        meta: `${total} of ${total} · ${formatElapsed(input.elapsedSeconds)}`,
        progress: 1,
        sub: null,
      },
      details: logDetails(false, false, input.logLineCount),
      actions: ["next"],
      hint: "next: connect a provider",
      targetLocked,
    };
  }

  // 2 — preflight failed (nothing written).
  if (input.preflightFailure) {
    return {
      status: {
        tone: "error",
        text: "Couldn't reach the box",
        meta: stageMeta(input),
        progress,
        sub: null,
      },
      details: { kind: "failures", items: input.preflightFailure.failures },
      actions: ["retry", "editTarget"],
      hint: null,
      targetLocked,
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
      details: logDetails(false, false, input.logLineCount),
      actions: ["install"],
      hint: null,
      targetLocked,
    };
  }

  // 4 — installed, but the claim (pairing) failed.
  if (input.claimError) {
    return {
      status: {
        tone: "error",
        text: "Installed, but pairing didn't complete",
        meta: "5 of 6",
        progress,
        sub: null,
      },
      details: { kind: "hint", text: CLAIM_FAILED_HINT },
      actions: ["pairManually", "retry"],
      hint: null,
      targetLocked,
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
      details: logDetails(true, true, input.logLineCount),
      actions: ["retry", "pairManually"],
      hint: null,
      targetLocked,
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
      actions: ["cancel"],
      hint: null,
      targetLocked,
    };
  }

  // 7 — auto-claim retrying (the box is still booting).
  if (input.claimRunning) {
    const booting = input.claimElapsed !== null && input.claimElapsed > 0;
    return {
      status: {
        tone: "running",
        text: booting ? "Pairing — the box is still starting" : "Pairing with this app",
        meta: stageMeta(input),
        progress,
        sub: booting ? "retrying every 2s · this is normal on a fresh install" : null,
      },
      details: logDetails(false, false, input.logLineCount),
      actions: ["cancel"],
      hint: null,
      targetLocked,
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
      details: logDetails(false, false, input.logLineCount),
      actions: ["cancel"],
      hint: null,
      targetLocked,
    };
  }

  // 9 — hosts still loading.
  if (!input.hostsLoaded) {
    return {
      status: {
        tone: "idle",
        text: "Reading ~/.ssh/config…",
        meta: null,
        progress: null,
        sub: null,
      },
      details: { kind: "none" },
      actions: ["install"],
      hint: null,
      targetLocked,
    };
  }

  // 10 — invalid target.
  if (input.targetError) {
    return {
      status: {
        tone: "attention",
        text: "Check the highlighted field",
        meta: null,
        progress: null,
        sub: null,
      },
      details: { kind: "none" },
      actions: ["install"],
      hint: null,
      targetLocked,
    };
  }

  // 11 — otherwise: ready to install.
  return {
    status: {
      tone: "idle",
      text: "Ready to install",
      meta: null,
      progress: null,
      sub: null,
    },
    details: { kind: "none" },
    actions: ["install"],
    hint: "takes about a minute",
    targetLocked,
  };
}
