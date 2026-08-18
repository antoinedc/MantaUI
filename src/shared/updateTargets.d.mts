// Hand-written type declarations for updateTargets.mjs. Implementation is plain
// JS so both the renderer and the server import it natively. Keep in sync with
// src/shared/updateTargets.mjs.
import type {
  UpdateTarget,
  DesktopUpdateCheck,
  ServerUpdateCheck,
} from "./types";

export interface UpdateTargetSummary {
  count: number;
  names: string[];
  disruptions: string[];
}

/**
 * Build the canonical UpdateTarget[] from the two update-check results, in a
 * fixed display order: desktop, server, opencode, then the remaining CLIs
 * alphabetically by label.
 */
export function buildUpdateTargets(args: {
  desktopCheck?: DesktopUpdateCheck | null;
  serverCheck?: ServerUpdateCheck | null;
  clientVersion?: string | null;
  serverVersion?: string | null;
}): UpdateTarget[];

/**
 * Summarize an update list: `count` of targets actually updatable, their
 * `names` in display order, and the deduped set of their `disruptions`.
 * `manual` targets never count.
 */
export function summarizeUpdates(targets: UpdateTarget[]): UpdateTargetSummary;

export interface UpdateBanner {
  text: string;
  actionLabel: string;
  tone: "accent" | "danger";
  dismissible: boolean;
}

/**
 * Decide what the ONE unified update banner says: the copy for the `updates`
 * banner, or `null` when there is nothing to show. Precedence: failure set →
 * mandatory → exactly-one available → 2+ available → null.
 */
export function describeUpdateBanner(
  targets: UpdateTarget[],
  opts: { mandatory: boolean; failure: string | null },
): UpdateBanner | null;

export interface UpdateAllPlan {
  desktopDownload: boolean; // desktop target available
  box: boolean; // ANY box-side target available (server, opencode, or a CLI)
  desktopInstall: boolean; // same as desktopDownload; runs last
  needsConfirm: boolean; // true iff any available target's disruption !== "none"
  confirmBody: string[]; // sentences, in order
}

/**
 * Plan a single "Update all" run over the target list.
 */
export function planUpdateAll(targets: UpdateTarget[]): UpdateAllPlan;

export type RowUpdateState =
  | { kind: "updating" }
  | { kind: "busy" }
  | { kind: "idle" };

/**
 * Decide a per-target update row's in-flight presentation (BET-1160):
 * `updating` = THIS target is mid-update (spinner + its own label), `busy` =
 * some OTHER update is in flight (this row's button disabled), `idle` =
 * nothing in flight (normal presentation).
 */
export function rowUpdateState(
  id: string,
  state?: { updatingTargetId?: string | null; busy?: boolean },
): RowUpdateState;

/**
 * Discriminate a target into "a box-side CLI" vs the two special targets.
 * A CLI row runs just that CLI's upgrade; the server row keeps the full
 * self-update; the desktop row keeps the download. Keyed off id, never off
 * label or disruption (BET-1159).
 */
export function isCliTarget(t: UpdateTarget | null | undefined): boolean;

/**
 * Decide whether to re-run `refreshUpdateTargets()` after a CLI-update RPC
 * resolves (BET-1161). Refreshes only on an explicit `ok:true` — a failed or
 * absent result is left intact so the row keeps the Update button for retry.
 */
export function shouldRefreshAfterCliUpdate(
  res: { ok: boolean; error?: string } | null | undefined,
): boolean;
