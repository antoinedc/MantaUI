// Routines — THE wire contract (docs/superpowers/specs/2026-10-30-routines-design.md §3).
// The server returns exactly these shapes; the desktop renderer consumes them.

export type RoutineIcon = "calendar-clock" | "chart" | "bug" | "alert" | "package" | "book" | "tag" | "shield";
export type RoutineAccess = "read" | "edit";
export type RoutineNotify = "findings" | "always" | "failures" | "never";
export type RoutineDestination =
  | { type: "new-session" }
  | { type: "session"; sessionID: string; followupId: string; enabledBeforeMove: boolean }; // moved into a chat (§8.2)

export interface Routine {
  id: string; // 8 hex
  name: string; // 1..80 chars
  prompt: string; // instructions, 1..8000 chars
  icon: RoutineIcon; // default "calendar-clock"
  directory: string; // absolute (tilde expanded server-side), must exist
  projectName: string | null; // resolved server-side on read; null if none (UI falls back to basename(directory))
  cron: string; // 5-field, box-local time; validated with croner
  access: RoutineAccess; // default "read"
  model: { providerID: string; modelID: string; variant?: string } | null; // null = opencode default
  notify: RoutineNotify; // default "findings"
  enabled: boolean;
  destination: RoutineDestination; // default {type:"new-session"}
  catchUpHours: number; // default 6, 0..24
  createdAt: number;
  updatedAt: number; // epoch ms
  createdFrom: { sessionID: string } | null; // chat it was created in (for §8.2 default)
  nextRunAt: number | null; // null when disabled or destination is a session
  memoryUpdatedByRunId: string | null;
}

export type RunStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "timed_out" | "cancelled" | "skipped";
export type RunTrigger = "scheduled" | "catch_up" | "manual" | "ai";
export type RunOutcome = "findings" | "nothing";

export interface RoutineReport {
  outcome: RunOutcome;
  title: string; // ≤ 160 chars
  summary: string; // ≤ 400 chars
  body: string; // markdown, ≤ 8000 chars, may be ""
}

export interface RoutineRun {
  id: string; // 10 hex
  routineName: string; // denormalised for lists
  projectName: string | null; // denormalised for lists (same rule as Routine.projectName)
  routineId: string;
  seq: number; // 1-based per routine
  trigger: RunTrigger;
  status: RunStatus;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  sessionID: string | null; // pre-minted and persisted at dispatch, before the session exists
  worktree: { path: string; branch: string; baseSha: string } | null; // access:"edit" only
  report: RoutineReport | null;
  error: string | null; // human sentence, e.g. "PostHog returned 401"
  notes: string[]; // human sentences shown under the title
  readAt: number | null; // unread ⇔ null (see §6.4)
  notifiedAt: number | null;
  keptInSidebar: boolean; // true after "Keep in sidebar" → never pruned
  memoryDiff: { added: string[] } | null; // lines present in the new memory but not the old one
  tokens: number | null; // input+output+cache over the session, when known
  question: string | null; // first pending question/permission text while needs_input
  reprompted: boolean; // the one missing-report re-prompt has been used
  reportCount: number; // routine_report calls accepted for this run (max 3)
  memoryAtStart: string; // the memory text injected into this run's prompt
}

export interface FollowupRow {
  // a schedule.mjs job projected for the Routines page
  id: string;
  prompt: string;
  label: string;
  cron: string;
  recurring: boolean;
  sessionID: string;
  sessionName: string | null;
  nextFireAt: number | null;
  routineId: string | null; // set when this follow-up is a moved routine (§8.2)
}

export interface RoutinesSummary {
  needsYou: number; // runs in needs_input
  unread: number; // unread runs (see §6.4)
  concurrency: number; // configured slots
  routines: Routine[]; // all, sorted by name
  lastRuns: Record<string, RoutineRun | null>; // routineId → most recent run (any status)
  needs: RoutineRun[]; // needs_input runs, newest first
  findings: RoutineRun[]; // the unread runs (§6.4), newest first, max 20
  running: RoutineRun[]; // status running, oldest first
  waiting: RoutineRun[]; // status queued, FIFO order
  followups: FollowupRow[]; // every schedule.mjs job with kind "prompt", soonest first
  orphaned: Routine[]; // moved routines whose follow-up vanished (§8.2)
  tz: string; // box IANA time zone
  now: number; // server clock, for relative times
}

export interface RoutineDetail {
  routine: Routine;
  memory: string;
  runs: RoutineRun[]; // newest first, page of 30
  hasMore: boolean;
  stats: { runCount: number; firstRunAt: number | null; avgTokens: number | null };
}

export interface RoutineInput {
  name: string;
  prompt: string;
  icon?: RoutineIcon;
  directory: string;
  cron: string;
  access?: RoutineAccess;
  model?: Routine["model"];
  notify?: RoutineNotify;
  catchUpHours?: number;
  memory?: string;
  createdFrom?: { sessionID: string } | null;
  enabled?: boolean; // default true
}

export type RoutineMoveTarget = { type: "origin" } | { type: "new" } | { type: "session"; sessionID: string };

/** Bus hint published after every routines store change (`{kind:"routines.updated"}`). */
export interface RoutinesUpdatedPayload {
  routineId?: string;
  runId?: string;
}
