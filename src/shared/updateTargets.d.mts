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
