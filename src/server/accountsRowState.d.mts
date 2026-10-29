import type { AccountsRowStates } from "../shared/types";
export function buildAccountRowStates(input: {
  statuses?: unknown[];
  providers?: unknown[];
  snapshots?: unknown[];
  health?: unknown;
  nowMs: number;
}): AccountsRowStates;
