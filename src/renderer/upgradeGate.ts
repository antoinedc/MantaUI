// upgradeGate.ts — the pure half of the blocking box-upgrade screen
// (OpenCode V2 cutover, slice C4; contracts K3 + K4 in
// docs/superpowers/specs/2026-10-16-opencode-v2-cutover.md).
//
// Everything that DECIDES what the gate shows lives here, with no React and no
// network: the defensive K3 parser, the state reducer, the view selector and
// the number formatting. `hooks/useUpgradeGate.ts` feeds it (frames, polls,
// 503s, button outcomes) and `UpgradeGate.tsx` only paints the result.
//
// Why a reducer and not a pile of useState: the gate has several independent
// producers (an /events frame, a 1 Hz poll, a 503 from some unrelated call, the
// outcome of a Retry press) racing each other across a manta-server restart.
// One reducer with one ordering rule is the only way their interleavings stay
// testable.

import { DEFAULT_COMPATIBILITY_MATRIX, majorOf } from "../shared/compatibility.mjs";
import type {
  UpgradeActionResult,
  UpgradeState,
  UpgradeStatus,
  UpgradeStep,
  UpgradeStepId,
  UpgradeStepStatus,
} from "../shared/api";
import { formatBytes } from "./chatUtils";

/** Poll cadence while the /events stream is down (the box is restarting). */
export const UPGRADE_POLL_MS = 1000;

/**
 * Where the user gets the previous desktop build after a roll-back. This is the
 * SAME URL the app already uses for "update failed → download manually"
 * (App.tsx, the danger-tone update banner); it is not a new link.
 */
export const DESKTOP_DOWNLOAD_URL = "https://mantaui.com/downloads/Manta-latest.dmg";

const STATES: readonly UpgradeState[] = ["idle", "running", "failed", "completed", "rolled_back"];
const STEP_IDS: readonly UpgradeStepId[] = ["preflight", "stop", "copy", "migrate", "verify", "cutover"];
const STEP_STATUSES: readonly UpgradeStepStatus[] = ["pending", "running", "done", "failed"];

// ---------------------------------------------------------------------------
// K3 parsing
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Parse an untrusted K3 object (an HTTP body or an /events payload). Returns
 * null when it is not an upgrade status at all (wrong `state`), so a garbage
 * frame can never flip the gate. Anything merely malformed INSIDE a valid
 * status is repaired rather than rejected — a gate that vanished because one
 * step had an odd field would be worse than one that renders it plainly.
 */
export function normalizeUpgradeStatus(raw: unknown): UpgradeStatus | null {
  if (!isObj(raw)) return null;
  const state = raw.state;
  if (typeof state !== "string" || !STATES.includes(state as UpgradeState)) return null;

  const steps: UpgradeStep[] = [];
  if (Array.isArray(raw.steps)) {
    for (const s of raw.steps) {
      if (!isObj(s) || typeof s.id !== "string") continue;
      const id = s.id as UpgradeStepId;
      const status = STEP_STATUSES.includes(s.status as UpgradeStepStatus)
        ? (s.status as UpgradeStepStatus)
        : "pending";
      let progress: UpgradeStep["progress"] = null;
      if (isObj(s.progress)) {
        progress = {};
        if (typeof s.progress.label === "string" && s.progress.label !== "") progress.label = s.progress.label;
        if (finite(s.progress.numerator)) progress.numerator = s.progress.numerator;
        if (finite(s.progress.denominator)) progress.denominator = s.progress.denominator;
      }
      steps.push({
        id,
        label: typeof s.label === "string" && s.label !== "" ? s.label : defaultStepLabel(id),
        status,
        progress,
        ...(typeof s.error === "string" && s.error !== "" ? { error: s.error } : {}),
      });
    }
  }

  let error: UpgradeStatus["error"] = null;
  if (isObj(raw.error)) {
    const e = raw.error;
    const step = STEP_IDS.includes(e.step as UpgradeStepId) ? (e.step as UpgradeStepId) : "preflight";
    error = {
      step,
      message: typeof e.message === "string" && e.message !== "" ? e.message : "The upgrade failed.",
      // Only an explicit `false` withholds Retry: a box that forgets the flag
      // must not strand the user with no way forward.
      retryable: e.retryable !== false,
      ...(finite(e.needBytes) ? { needBytes: e.needBytes } : {}),
      ...(finite(e.haveBytes) ? { haveBytes: e.haveBytes } : {}),
    };
  }

  return {
    state: state as UpgradeState,
    steps,
    overall: finite(raw.overall) ? Math.min(1, Math.max(0, raw.overall)) : 0,
    etaSeconds: finite(raw.etaSeconds) && raw.etaSeconds >= 0 ? raw.etaSeconds : null,
    error,
  };
}

function defaultStepLabel(id: string): string {
  switch (id) {
    case "preflight": return "Check disk space";
    case "stop": return "Stop running agents";
    case "copy": return "Copy history";
    case "migrate": return "Migrate conversations";
    case "verify": return "Verify";
    case "cutover": return "Switch over";
    default: return id;
  }
}

// ---------------------------------------------------------------------------
// K4 — does this box need the user to run the existing box update?
// ---------------------------------------------------------------------------

/**
 * True when the desktop speaks the supported wire major and the BOX is on an
 * older one. That is the only skew an in-app "Upgrade box" can fix (the plan:
 * "box is older than R2 → full-screen gate"). A desktop that is itself on the
 * wrong major, or a box that is merely a patch behind on the right major, stays
 * with the existing banners — blocking the whole app for patch skew would turn
 * every box release into an outage.
 */
export function boxNeedsMajorUpgrade(input: {
  clientVersion: string | null | undefined;
  boxVersion: string | null | undefined;
  matrix?: { readonly supportedMajor: number };
}): boolean {
  const { clientVersion, boxVersion } = input;
  if (!clientVersion || !boxVersion) return false; // unknown never blocks
  const supported = (input.matrix ?? DEFAULT_COMPATIBILITY_MATRIX).supportedMajor;
  return majorOf(clientVersion) === supported && majorOf(boxVersion) < supported;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** What happened the last time the user pressed Retry / Roll back. */
export type ActionOutcome =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "ok" }
  | { phase: "error"; message: string };

export type GateState = {
  /** Latest K3 object from a frame or a poll; null = none yet / old box. */
  status: UpgradeStatus | null;
  /**
   * Some data call was refused `503 {upgrade:true}`. Cleared the moment the box
   * reports it is not (or no longer) upgrading.
   */
  upgradeModeSeen: boolean;
  retry: ActionOutcome;
  rollback: ActionOutcome;
};

export type GateAction =
  /** A frame/poll result. `null` = the box has no upgrade API (old box → idle). */
  | { type: "status"; status: UpgradeStatus | null }
  | { type: "upgradeModeSeen" }
  | { type: "actionStarted"; action: "retry" | "rollback" }
  | { type: "actionFinished"; action: "retry" | "rollback"; result: UpgradeActionResult };

const IDLE: ActionOutcome = { phase: "idle" };

export const initialGateState: GateState = {
  status: null,
  upgradeModeSeen: false,
  retry: IDLE,
  rollback: IDLE,
};

export function gateReducer(state: GateState, action: GateAction): GateState {
  switch (action.type) {
    case "status": {
      const next = action.status;
      const stateChanged = (state.status?.state ?? null) !== (next?.state ?? null);
      const notUpgrading = next === null || next.state === "idle" || next.state === "completed";
      return {
        status: next,
        // An old box (null) cannot be in upgrade mode; idle/completed means the
        // 503s that raised the flag are over. running/failed keep it (harmless:
        // the status itself drives the view).
        upgradeModeSeen: notUpgrading ? false : state.upgradeModeSeen,
        // A press's outcome describes the state it was pressed in; once the box
        // moves on (failed → running after a retry) it is stale.
        retry: stateChanged ? IDLE : state.retry,
        rollback: stateChanged ? IDLE : state.rollback,
      };
    }
    case "upgradeModeSeen":
      return state.upgradeModeSeen ? state : { ...state, upgradeModeSeen: true };
    case "actionStarted":
      return { ...state, [action.action]: { phase: "pending" } as ActionOutcome };
    case "actionFinished": {
      const outcome: ActionOutcome = action.result.ok
        ? { phase: "ok" }
        : { phase: "error", message: action.result.error || "The box refused the request." };
      return { ...state, [action.action]: outcome };
    }
  }
}

// ---------------------------------------------------------------------------
// View selection
// ---------------------------------------------------------------------------

export type GateInputs = {
  /** K4: the box is on an older wire major than this desktop. */
  boxNeedsUpgrade: boolean;
  /** The existing box-update flow (applyServerUpdate) is in flight. */
  boxUpdating: boolean;
  /** The existing flow's failure text (updateError), if it failed. */
  boxUpdateError: string | null;
  /** The existing flow's step progress (serverUpdateProgress). */
  boxUpdateProgress: { step: number; total: number; label: string } | null;
  /** The /events stream is live. */
  connected: boolean;
};

export type GateView =
  | { kind: "hidden" }
  | {
      kind: "upgrade-box";
      /** True from the confirm until the box comes back on the new major. */
      updating: boolean;
      /** The box dropped the connection mid-update (it is restarting). */
      restarting: boolean;
      progress: { step: number; total: number; label: string } | null;
      error: string | null;
    }
  | { kind: "waiting" }
  | {
      kind: "running";
      steps: UpgradeStep[];
      overall: number;
      etaSeconds: number | null;
      current: UpgradeStep | null;
      /** 0..1 for the current step, null → indeterminate. */
      currentFraction: number | null;
    }
  | {
      kind: "failed";
      steps: UpgradeStep[];
      overall: number;
      message: string;
      /** "needs 31 GB free, has 3 GB" when the failure carries disk numbers. */
      disk: string | null;
      failedStep: UpgradeStepId;
      retryLabel: "Retry" | "Check again";
      /** false → render Retry disabled with `retryDisabledReason`. */
      canRetry: boolean;
      retryDisabledReason: string | null;
      canRollback: boolean;
      retry: ActionOutcome;
      rollback: ActionOutcome;
    }
  | { kind: "rolled_back"; steps: UpgradeStep[] };

/**
 * Failures where rolling back is meaningless or wrong, per the plan's failure
 * table: pre-flight stops before anything is touched ("Nothing was stopped"),
 * and a verification failure (e.g. a Claude login) is fixed in place — "no
 * rollback; shows the specific fix and Check again".
 */
const NO_ROLLBACK_STEPS: ReadonlySet<UpgradeStepId> = new Set(["preflight", "verify"]);
const CHECK_AGAIN_STEPS: ReadonlySet<UpgradeStepId> = new Set(["preflight", "verify"]);

export function currentStep(status: UpgradeStatus): UpgradeStep | null {
  return (
    status.steps.find((s) => s.status === "running") ??
    status.steps.find((s) => s.status === "failed") ??
    null
  );
}

/** numerator/denominator → 0..1, or null (indeterminate) when not measurable. */
export function stepFraction(step: UpgradeStep | null): number | null {
  const p = step?.progress;
  if (!p || !finite(p.numerator) || !finite(p.denominator) || p.denominator <= 0) return null;
  return Math.min(1, Math.max(0, p.numerator / p.denominator));
}

/** "needs 31 GB free, has 3 GB" — null unless the failure carries disk numbers. */
export function describeDiskShortfall(error: UpgradeStatus["error"]): string | null {
  if (!error || !finite(error.needBytes) || error.needBytes <= 0) return null;
  const need = `needs ${formatBytes(error.needBytes)} free`;
  if (!finite(error.haveBytes) || error.haveBytes < 0) return need;
  return `${need}, has ${error.haveBytes === 0 ? "0 B" : formatBytes(error.haveBytes)}`;
}

/** "needs 31 GB free, has 3 GB" → "Needs 31 GB free, has 3 GB." (a sentence on its own line). */
export function diskSentence(disk: string): string {
  return disk === "" ? "" : `${disk[0].toUpperCase()}${disk.slice(1)}.`;
}

/** "about 4 min left"; null when the box gave no estimate. */
export function formatEtaSeconds(seconds: number | null): string | null {
  if (seconds === null || !finite(seconds) || seconds < 0) return null;
  if (seconds < 45) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h left` : `about ${h} h ${m} min left`;
}

export function selectGateView(state: GateState, inputs: GateInputs): GateView {
  const s = state.status;
  if (s) {
    if (s.state === "running") {
      const current = currentStep(s);
      return {
        kind: "running",
        steps: s.steps,
        overall: s.overall,
        etaSeconds: s.etaSeconds,
        current,
        currentFraction: stepFraction(current),
      };
    }
    if (s.state === "failed") {
      const failedStep = s.error?.step ?? currentStep(s)?.id ?? "preflight";
      const retryable = s.error?.retryable !== false;
      return {
        kind: "failed",
        steps: s.steps,
        overall: s.overall,
        message: s.error?.message ?? s.steps.find((x) => x.status === "failed")?.error ?? "The upgrade failed.",
        disk: describeDiskShortfall(s.error),
        failedStep,
        retryLabel: CHECK_AGAIN_STEPS.has(failedStep) ? "Check again" : "Retry",
        canRetry: retryable,
        retryDisabledReason: retryable ? null : "This failure can't be retried — roll back instead.",
        canRollback: !NO_ROLLBACK_STEPS.has(failedStep),
        retry: state.retry,
        rollback: state.rollback,
      };
    }
    if (s.state === "rolled_back") return { kind: "rolled_back", steps: s.steps };
    // The box itself says the migration finished. That outranks the K4 version
    // read, which may still hold the pre-upgrade number for a moment — without
    // this the gate would flash "Upgrade box" between "completed" and the
    // version refetch.
    if (s.state === "completed") return { kind: "hidden" };
  }
  // Some call was refused 503 "box upgrading" but we hold no K3 object yet (or
  // the box is between states): say so instead of showing a broken app.
  if (state.upgradeModeSeen) return { kind: "waiting" };
  if (inputs.boxNeedsUpgrade) {
    return {
      kind: "upgrade-box",
      updating: inputs.boxUpdating,
      restarting: inputs.boxUpdating && !inputs.connected,
      progress: inputs.boxUpdateProgress,
      error: inputs.boxUpdating ? null : inputs.boxUpdateError,
    };
  }
  return { kind: "hidden" };
}

/** Whether the gate is covering the app. */
export const isGateVisible = (view: GateView): boolean => view.kind !== "hidden";

/**
 * Plain-text snapshot of what the gate is showing, for "Copy details" — the one
 * thing a stuck user can hand to whoever is helping them. Steps with their
 * status and measured progress, then the failure (with the disk numbers).
 */
export function describeGateDetails(view: GateView): string {
  if (view.kind !== "running" && view.kind !== "failed" && view.kind !== "rolled_back") {
    return "";
  }
  const lines: string[] = [`Manta box upgrade — ${view.kind.replace("_", " ")}`];
  for (const s of view.steps) {
    const p = s.progress;
    const measured =
      p && finite(p.numerator) && finite(p.denominator) ? ` (${p.numerator}/${p.denominator})` : "";
    const caption = p?.label ? ` — ${p.label}` : "";
    const err = s.error ? ` — ${s.error}` : "";
    lines.push(`${s.id}: ${s.status}${measured}${caption}${err}`);
  }
  if (view.kind === "failed") {
    lines.push(`error (${view.failedStep}): ${view.message}`);
    if (view.disk) lines.push(`disk: ${view.disk}`);
  }
  return lines.join("\n");
}
