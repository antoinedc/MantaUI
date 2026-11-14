// Pure logic for the background-job progress `view` (spec 2026-11-14
// background-job-liveness-and-progress, §B4 / §B6 / §5.3). No React, no store:
// everything here is unit-tested in jobProgress.test.ts.
//
//   - the rev rule (a `view` is applied only when its `rev` is newer);
//   - patching a job in place from a `delegate.updated` event / a list answer;
//   - the client clock (`skew = asOf - localNow`) and the ages derived from it;
//   - the plain-text display model for the parent card, details and sidebar.
//
// The box owns the content; the client only turns anchors into ages and text
// into single plain lines. Nothing here renders markup: model-written text is a
// string handed to a React text node.

import type { DelegateJob, DelegateJobProgressView } from "../shared/types";
import { formatUsdEstimate, formatTimerDuration } from "./chatUtils";
import { formatTokens } from "../shared/formatTokens.mjs";

export type JobView = DelegateJobProgressView;
export type ViewRev = JobView["rev"];

// ===== Rev rule (B4) =====

/** A view is applied only when its epoch is greater, or equal with a greater n. */
export function isNewerRev(prev: ViewRev | null | undefined, next: ViewRev | null | undefined): boolean {
  if (!next) return false;
  if (!prev) return true;
  if (next.epoch !== prev.epoch) return next.epoch > prev.epoch;
  return next.n > prev.n;
}

/** Shape-check a wire view: anything that isn't an object with a finite rev is treated as "no view". */
export function usableView(v: unknown): JobView | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = (v as { rev?: unknown }).rev as { epoch?: unknown; n?: unknown } | undefined;
  if (!r || typeof r.epoch !== "number" || typeof r.n !== "number") return undefined;
  if (!Number.isFinite(r.epoch) || !Number.isFinite(r.n)) return undefined;
  if (typeof (v as { asOf?: unknown }).asOf !== "number") return undefined;
  return v as JobView;
}

// ===== Patch in place (B4, desktop bullet) =====

/** The `delegate.updated` bus payload as the box sends it (spec §5.5). The shared `Api` type predates `view`. */
export type DelegateUpdatedPayload = { id: string; status: string; activity?: string; view?: unknown };

/** The client-only clock offset per job id: `skew = view.asOf - localNow`, taken when that view was accepted. */
export type JobSkews = Record<string, number>;

export type JobsState = { jobs: Record<string, DelegateJob>; skews: JobSkews };

export type PatchResult =
  | { kind: "refetch" } // unknown id, a status change, or an event without a usable view: take the whole list
  | { kind: "same" } // nothing changed (an older / equal rev, same activity)
  | { kind: "patched"; state: JobsState };

/**
 * Apply one `delegate.updated` event to the jobs slice WITHOUT refetching.
 * Refetch only when the id is unknown or its `status` changed (nesting may
 * change), or when the event carries no usable `view` (an older box: today's
 * behaviour, a refetch on every event).
 */
export function patchJobFromEvent(state: JobsState, payload: DelegateUpdatedPayload, localNow: number): PatchResult {
  const view = usableView(payload.view);
  if (!view) return { kind: "refetch" };
  const entry = Object.entries(state.jobs).find(([, j]) => j.id === payload.id);
  if (!entry) return { kind: "refetch" };
  const [childKey, job] = entry;
  if (job.status !== payload.status) return { kind: "refetch" };

  const accept = isNewerRev(job.view?.rev, view.rev);
  const activity = typeof payload.activity === "string" ? payload.activity : undefined;
  const activityChanged = activity !== undefined && activity !== job.activity;
  if (!accept && !activityChanged) return { kind: "same" };

  const next: DelegateJob = {
    ...job,
    ...(activityChanged ? { activity } : {}),
    ...(accept ? { view } : {}),
  };
  return {
    kind: "patched",
    state: {
      jobs: { ...state.jobs, [childKey]: next },
      skews: accept ? { ...state.skews, [job.id]: view.asOf - localNow } : state.skews,
    },
  };
}

/**
 * Merge a list answer into the slice, keyed by child session. A late list
 * response must not roll a job's `view` back: when both sides carry a view the
 * stored one stays unless the incoming rev is newer. A list job without a view
 * (older box) is taken as it is.
 */
export function mergeJobList(prev: JobsState, list: ReadonlyArray<DelegateJob>, localNow: number): JobsState {
  const prevById = new Map<string, DelegateJob>();
  for (const j of Object.values(prev.jobs)) prevById.set(j.id, j);
  const jobs: Record<string, DelegateJob> = {};
  const skews: JobSkews = {};
  for (const incoming of list) {
    if (!incoming.childSessionID || incoming.supersededBy) continue;
    const view = usableView(incoming.view);
    const old = prevById.get(incoming.id);
    let job: DelegateJob = incoming;
    if (!view) {
      if (incoming.view !== undefined) job = withoutView(incoming); // invalid-typed view: treat as absent
    } else if (old?.view && !isNewerRev(old.view.rev, view.rev)) {
      job = { ...incoming, view: old.view };
      if (prev.skews[incoming.id] !== undefined) skews[incoming.id] = prev.skews[incoming.id];
    } else {
      skews[incoming.id] = view.asOf - localNow;
    }
    jobs[incoming.childSessionID] = job;
  }
  return { jobs, skews };
}

function withoutView(job: DelegateJob): DelegateJob {
  const { view: _drop, ...rest } = job;
  void _drop;
  return rest as DelegateJob;
}

// ===== Client clock (§5.3) =====

export function boxNow(localNow: number, skew: number | undefined): number {
  return localNow + (skew ?? 0);
}

/** Elapsed = (endedAt ?? boxNow) - startedAt; null without a start. Never negative. */
export function elapsedMs(view: JobView, box: number): number | null {
  if (view.startedAt == null) return null;
  return Math.max(0, (view.endedAt ?? box) - view.startedAt);
}

/** Running = the view has no end anchor and its state is a live one. */
export function isRunningView(view: JobView): boolean {
  return view.endedAt == null && (view.state === "working" || view.state === "needs-decision");
}

export const QUIET_SHOW_MS = 3 * 60_000;
export const TIME_LEFT_SHOW_MS = 30 * 60_000;
export const PLAN_GREW_WINDOW_MS = 120_000;

/** `boxNow - lastProgressAt`, only while running and at least 3 minutes. */
export function quietMs(view: JobView, box: number): number | null {
  if (!isRunningView(view) || view.lastProgressAt == null) return null;
  const q = box - view.lastProgressAt;
  return q >= QUIET_SHOW_MS ? q : null;
}

/** `max(0, ceilingAt - boxNow)`, only while running and under 30 minutes. */
export function timeLeftMs(view: JobView, box: number): number | null {
  if (!isRunningView(view) || view.ceilingAt == null) return null;
  const left = Math.max(0, view.ceilingAt - box);
  return left < TIME_LEFT_SHOW_MS ? left : null;
}

export function toolAgeMs(view: JobView, box: number): number | null {
  return view.live ? Math.max(0, box - view.live.startedAt) : null;
}

/** "plan grew" shows for 120 s after `steps.grewAt`. */
export function planGrewActive(view: JobView, box: number): boolean {
  const g = view.steps?.grewAt;
  return g != null && box >= g && box - g < PLAN_GREW_WINDOW_MS;
}

// ===== Plain text =====

/** A model-written string as one plain line: first non-empty line, whitespace collapsed, capped. No markup is interpreted. */
export function plainLine(s: string | null | undefined, max = 120): string {
  if (typeof s !== "string") return "";
  const first = s.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const one = first.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ===== Display models =====

export function stepsChip(view: JobView | undefined | null): string | null {
  const s = view?.steps;
  return s && s.total > 0 ? `${s.done}/${s.total}` : null;
}

/** The chip's tooltip: the current step, and "plan grew" while that holds. */
export function stepsChipTitle(view: JobView, box: number): string {
  const s = view.steps;
  if (!s) return "";
  const parts = [`${s.done} of ${s.total} steps done`];
  const cur = plainLine(s.current);
  if (cur) parts.push(`now: ${cur}`);
  if (planGrewActive(view, box)) parts.push("plan grew");
  return parts.join(" · ");
}

/** The bar fill, 0..1: the box's persisted value, else done/total. */
export function barFraction(view: JobView): number | null {
  if (!view.steps) return null;
  const v = view.bar ?? (view.steps.total > 0 ? view.steps.done / view.steps.total : 0);
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

export type RunCardView = {
  /** Row 2 text, without the "Needs a decision:" prefix. "" reserves the row. */
  headline: string;
  needsDecision: boolean;
  chip: string | null;
  chipTitle: string;
  bar: number | null;
  elapsed: string | null;
};

/** What rows 1–3 of the parent card show for a view at box time `box`. */
export function runCardView(view: JobView, box: number): RunCardView {
  const e = elapsedMs(view, box);
  return {
    headline: plainLine(view.headline),
    needsDecision: view.state === "needs-decision",
    chip: stepsChip(view),
    chipTitle: stepsChipTitle(view, box),
    bar: barFraction(view),
    elapsed: e == null ? null : formatTimerDuration(e),
  };
}

/** "time left 12m" / "time left 1h5m" (the compact timer ladder). */
export function timeLeftLabel(ms: number): string {
  return `time left ${formatTimerDuration(ms)}`;
}

export function quietLabel(ms: number): string {
  return `Quiet for ${Math.max(3, Math.floor(ms / 60_000))} min`;
}

export function relativeAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 10_000) return "just now";
  return `${formatTimerDuration(ms)} ago`;
}

export function filesLabel(files: JobView["files"]): string | null {
  if (!files) return null;
  if (files.changed == null) return "Files changed: unknown";
  return `${files.changed} ${files.changed === 1 ? "file" : "files"} changed`;
}

export function usageLabel(usage: JobView["usage"]): string | null {
  if (!usage) return null;
  const parts = [formatTokens(usage.tokens)];
  const usd = formatUsdEstimate(usage.costUsd);
  if (usd) parts.push(usage.costPartial ? `${usd}+` : usd);
  return parts.join(" · ");
}

export type DetailsModel = {
  items: Array<{ text: string; status: "done" | "current" | "pending"; mark: string }>;
  /** `reported` steps carry no items: a one-line summary instead. */
  reportedLine: string | null;
  milestones: Array<{ text: string; ago: string }>;
  tool: { label: string; age: string } | null;
  quiet: string | null;
  files: string | null;
  usage: string | null;
  timeLeft: string | null;
  planGrew: boolean;
};

export const STEP_MARK = { done: "✓", current: "▸", pending: "○" } as const;

/** Everything the "Details" disclosure shows, at box time `box`. Cancelled items never reach a view. */
export function detailsModel(view: JobView, box: number): DetailsModel {
  const steps = view.steps;
  const items = (steps?.items ?? []).map((i) => ({
    text: plainLine(i.text),
    status: i.status,
    mark: STEP_MARK[i.status] ?? STEP_MARK.pending,
  }));
  const age = toolAgeMs(view, box);
  const quiet = quietMs(view, box);
  const left = timeLeftMs(view, box);
  return {
    items,
    reportedLine: steps && steps.source === "reported" && steps.total > 0 ? `${steps.done} of ${steps.total} steps done (reported by the job)` : null,
    milestones: (view.milestones ?? []).map((m) => ({ text: plainLine(m.text, 160), ago: relativeAgo(box - m.at) })),
    tool:
      view.live && age != null
        ? { label: plainLine(`${view.live.tool}${view.live.target ? `: ${view.live.target}` : ""}`, 120), age: formatTimerDuration(age) }
        : null,
    quiet: quiet == null ? null : quietLabel(quiet),
    files: filesLabel(view.files),
    usage: usageLabel(view.usage),
    timeLeft: left == null ? null : timeLeftLabel(left),
    planGrew: planGrewActive(view, box),
  };
}

/** The sidebar row's tooltip piece: the headline when the box sent one, else the legacy activity line. */
export function jobRowHint(job: Pick<DelegateJob, "activity" | "view">): string | null {
  const h = plainLine(job.view?.headline);
  return h || job.activity || null;
}

/** The job with this id in the child-keyed slice (a handful of entries: a scan is fine). */
export function findJobById(jobs: Record<string, DelegateJob>, id: string | null | undefined): DelegateJob | undefined {
  if (!id) return undefined;
  for (const j of Object.values(jobs)) if (j.id === id) return j;
  return undefined;
}
