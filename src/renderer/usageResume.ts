// ===== Resume after limit reset — row markers + selection rule =====
//
// Everything the resume SCREEN shows (grouping, "new", snippets, reset windows,
// the warm/cold cost, header text, the arm/disarm plan) is computed by the box
// (`usage-stopped:view` / `usage-stopped:apply`, src/server/usageResumeView.mjs,
// WS09 SF-M14/M15). What stays here is the sidebar's row-marker logic (master
// D29: row markers and the capsule keep reading `usage-stopped:list`) and the
// view-state rule that keeps the user's checkboxes sane while the box's list
// changes under an open modal.

import type { StoppedRecord } from "../shared/types";

/** The conversation currently being asked to decide (not yet armed). */
export function unarmedStoppedCount(records: StoppedRecord[]): number {
  return records.filter((r) => r.armed !== true).length;
}

/**
 * Marker precedence on the sidebar row: a stopped conversation that ALSO
 * holds a pending question or permission request shows the question/permission
 * state (it blocks on the user right now), NOT the stopped marker (that waits
 * on a clock). So the stopped marker renders only when the conversation is
 * stopped AND has no higher-urgency pending block.
 */
export function shouldShowStoppedMarker(
  isStopped: boolean,
  hasPendingQuestionOrPermission: boolean,
): boolean {
  return isStopped && !hasPendingQuestionOrPermission;
}

/**
 * Selection reconciliation for an open resume modal when a new view arrives
 * (same rule as iOS `UsageResumeSelection.reconcile`): while the user has not
 * touched anything (`pristine`) the selection tracks the armed rows; after that
 * it is `selected ∩ rows-in-the-view` — vanished rows leave the selection, the
 * user's other choices stay, and new rows are not auto-selected.
 */
export function reconcileResumeSelection({
  selected,
  pristine,
  viewIds,
  armedIds,
}: {
  selected: ReadonlySet<string>;
  pristine: boolean;
  viewIds: ReadonlySet<string>;
  armedIds: ReadonlySet<string>;
}): Set<string> {
  if (pristine) return new Set(armedIds);
  const next = new Set<string>();
  for (const id of selected) if (viewIds.has(id)) next.add(id);
  return next;
}
