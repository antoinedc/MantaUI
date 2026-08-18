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
