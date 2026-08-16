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
// details (log/failures/hint/none), actions, hint and the zone-A lock — and
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
  | { kind: "log"; defaultOpen: boolean; showCopyDiagnostics: boolean }
  | { kind: "failures"; items: Array<{ cause: string; action: string }> }
  | { kind: "hint"; text: string };

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
  status: {
    tone: ConnectTone;
    text: string;
    meta: string | null; // e.g. "3 of 6 · 0:24"
    progress: number | null; // 0..1, null = no bar
    sub: string | null; // second line under the bar
  };
  details: ConnectDetails;
  actions: ConnectActionId[]; // first is primary, rest secondary
  /** Action ids whose button must render disabled. The manual mode's Connect
   *  stays disabled until `canConnectSetup` passes; the ssh mode has its own
   *  inline gate. Absent/undefined = nothing disabled beyond the panel's own
   *  install gate. */
  disabledActions?: ConnectActionId[];
  hint: string | null; // right-aligned text in zone D
  targetLocked: boolean;
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
          text: "Connected — your box is ready",
          meta: null,
          progress: null,
          sub: null,
        },
        details: { kind: "none" },
        actions: ["next"],
        hint: null,
        targetLocked: true,
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
        actions: ["retry"],
        hint: null,
        targetLocked: false,
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
        actions: ["cancel"],
        hint: null,
        targetLocked: true,
      };
    }
    // M1 — clipboard / deep-link prefill present: Confirm or discard it.
    if (input.prefillPresent) {
      return {
        status: {
          tone: "idle",
          text: "Pairing link ready",
          meta: null,
          progress: null,
          sub: null,
        },
        details: { kind: "none" },
        actions: ["connect", "discard"],
        hint: null,
        targetLocked: false,
      };
    }
    // M2 — idle manual (default): the code is typed by hand.
    return {
      status: {
        tone: "idle",
        text: "Enter the 6-digit code from the box",
        meta: null,
        progress: null,
        sub: null,
      },
      details: { kind: "hint", text: "Run `manta pair` on the box to get a code." },
      actions: ["connect"],
      disabledActions: input.canConnect ? undefined : ["connect"],
      hint: null,
      targetLocked: false,
    };
  }

  // ===== SSH install mode (rows 1–11) =====
  const targetLocked = input.running || input.claimRunning || input.paired;
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
