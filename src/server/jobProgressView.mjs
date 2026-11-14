// jobProgressView.mjs — pure rules for a background job's progress (spec
// 2026-11-14-background-job-liveness-and-progress §B1–B2, §5.3).
//
// `jobProgress` is what the box persists on the job record; `computeJobView` turns the record
// plus the engine's in-memory liveness into the `view` every client renders. Nothing here does
// I/O or reads a clock except through the `now` argument.

export const CHECKLIST_MAX_ITEMS = 30;
export const TEXT_MAX = 120;
export const MILESTONE_MAX = 160;
export const MILESTONES_KEPT = 8;
export const LABEL_FRESH_MS = 30 * 60_000;
export const PLAN_GREW_MS = 120_000;
export const PROGRESS_QUANTUM_MS = 30_000;
export const BAR_CAP = 0.95;
export const DEFAULT_CEILING_MS = 4 * 60 * 60_000;

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

export function defaultJobProgress() {
  return {
    label: "",
    labelAt: null,
    modelState: null,
    checklist: null,
    reported: null,
    planRevision: 0,
    grewAt: null,
    bar: null,
    stepsSource: null,
    stepsTotal: null,
    milestones: [],
    files: null,
    usage: { tokens: 0, costUsd: null, costPartial: false },
  };
}

/** A running record from before this feature gets every new field at first touch. */
export function withLivenessDefaults(job) {
  if (!job || typeof job !== "object") return job;
  const base = job.sweepAllowanceMs != null && Number.isFinite(job.sweepAllowanceMs) && job.sweepAllowanceMs > 0 ? job.sweepAllowanceMs : DEFAULT_CEILING_MS;
  const next = { ...job };
  if (!Number.isFinite(next.baseCeilingMs)) next.baseCeilingMs = base;
  if (!Number.isFinite(next.ceilingMs)) next.ceilingMs = next.baseCeilingMs;
  if (!Array.isArray(next.extensions)) next.extensions = [];
  if (next.ceilingWarnedFor === undefined) next.ceilingWarnedFor = null;
  if (next.endReason === undefined) next.endReason = null;
  if (typeof next.endedBlocked !== "boolean") next.endedBlocked = false;
  if (next.lastProgressAt === undefined) next.lastProgressAt = null;
  if (!next.jobProgress || typeof next.jobProgress !== "object") next.jobProgress = defaultJobProgress();
  return next;
}

/** True when `withLivenessDefaults` would add anything. */
export function lacksLivenessDefaults(job) {
  return (
    !Number.isFinite(job?.baseCeilingMs) ||
    !Number.isFinite(job?.ceilingMs) ||
    !Array.isArray(job?.extensions) ||
    !job?.jobProgress ||
    typeof job.endedBlocked !== "boolean"
  );
}

/** The ceiling a job gets at launch: the CTO's allowance and the caller's maxDurationMinutes (the smaller when both). */
export function initialCeilingMs({ sweepAllowanceMs, maxDurationMinutes } = {}) {
  const allow = Number.isFinite(sweepAllowanceMs) && sweepAllowanceMs > 0 ? sweepAllowanceMs : null;
  const max = Number.isFinite(maxDurationMinutes) ? maxDurationMinutes * 60_000 : null;
  if (allow != null && max != null) return Math.min(allow, max);
  return allow ?? max ?? DEFAULT_CEILING_MS;
}

/** `maxDurationMinutes` must be an integer 10–720 (or absent). Returns an error string or null. */
export function validateMaxDurationMinutes(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 10 || v > 720) return "maxDurationMinutes must be an integer between 10 and 720";
  return null;
}

/** "4 hours", "2 hours 30 minutes", "45 minutes", "1 hour". */
export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m > 0 || h === 0) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** First line, control characters removed, trimmed, capped. Plain text only. */
export function plainLine(text, max = TEXT_MAX) {
  const first = String(text ?? "").split(/\r?\n/, 1)[0] ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = first.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Items of a todo list as `{text,status}`; anything unusable is dropped. */
export function normalizeChecklist(items) {
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const text = typeof it.content === "string" ? it.content : typeof it.text === "string" ? it.text : "";
    if (!text.trim()) continue;
    const status = STATUSES.has(it.status) ? it.status : "pending";
    out.push({ text: text.length > 500 ? text.slice(0, 500) : text, status });
  }
  return out;
}

const live = (jp) => (Array.isArray(jp.checklist) ? jp.checklist.filter((i) => i.status !== "cancelled") : []);

function reportedUsable(r) {
  return !!r && Number.isInteger(r.step) && r.step >= 1 && Number.isInteger(r.total) && r.total >= 1;
}

/** Which steps the job shows now: `{source,total,done,current,items}` or null. */
export function stepsOf(jp) {
  const items = live(jp);
  if (items.length >= 2) {
    const first = items.findIndex((i) => i.status === "in_progress");
    const cur = first >= 0 ? items[first] : null;
    return {
      source: "checklist",
      total: items.length,
      done: items.filter((i) => i.status === "completed").length,
      current: cur ? plainLine(cur.text) : null,
      items: items.slice(0, CHECKLIST_MAX_ITEMS).map((i, idx) => ({
        text: plainLine(i.text),
        status: i.status === "completed" ? "done" : idx === first ? "current" : "pending",
      })),
    };
  }
  if (reportedUsable(jp.reported)) {
    const { step, total } = jp.reported;
    return { source: "reported", total, done: Math.min(Math.max(step - 1, 0), total), current: null, items: [] };
  }
  return null;
}

/**
 * Recompute the persisted plan state (source, revision, bar) after the checklist / report changed or the job
 * ended. Pure: returns a new `jobProgress`.
 */
export function recomputeSteps(jp, { now, terminal = null } = {}) {
  const steps = stepsOf(jp);
  const next = { ...jp };
  if (!steps) {
    next.stepsSource = null;
    next.stepsTotal = null;
  } else {
    const revised = steps.source !== jp.stepsSource || steps.total !== jp.stepsTotal;
    const ratio = steps.done / steps.total;
    if (revised) {
      next.planRevision = (jp.planRevision ?? 0) + 1;
      if (Number.isFinite(jp.stepsTotal) && steps.total > jp.stepsTotal) next.grewAt = now;
      next.bar = ratio;
    } else {
      next.bar = Math.max(jp.bar ?? 0, ratio);
    }
    next.stepsSource = steps.source;
    next.stepsTotal = steps.total;
  }
  if (next.bar != null) {
    next.bar = Math.min(next.bar, BAR_CAP);
  }
  if (terminal?.status === "done" && terminal.endedBlocked !== true) next.bar = 1;
  return next;
}

export function applyChecklist(jp, items, now) {
  const checklist = normalizeChecklist(items);
  const same = JSON.stringify(checklist) === JSON.stringify(jp.checklist ?? null);
  if (same) return jp;
  return recomputeSteps({ ...jp, checklist }, { now });
}

/** Add a milestone: trimmed, ≤160, empty ignored, an exact duplicate of the newest dropped, newest kept (8). */
export function addMilestone(jp, text, now) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return jp;
  const clipped = t.length > MILESTONE_MAX ? t.slice(0, MILESTONE_MAX) : t;
  const list = Array.isArray(jp.milestones) ? jp.milestones : [];
  if (list.length > 0 && list[list.length - 1].text === clipped) return jp;
  return { ...jp, milestones: [...list, { at: now, text: clipped }].slice(-MILESTONES_KEPT) };
}

/** A model's `progress_report` onto the job. `record` is the merged per-session record; `input` what was sent. */
export function applyModelReport(jp, { input, record, now }) {
  let next = { ...jp };
  if (typeof input?.label === "string" && input.label.trim()) {
    next.label = input.label.trim().slice(0, 500);
    next.labelAt = now;
  }
  if (typeof record?.state === "string") next.modelState = record.state;
  next.reported = reportedUsable({ step: record?.step, total: record?.total }) ? { step: record.step, total: record.total } : null;
  next = addMilestone(next, input?.milestone, now);
  return recomputeSteps(next, { now });
}

/** Fold a usage delta (tokens, optional cost, partial flag) into the persisted usage. */
export function mergeUsage(base, delta) {
  const b = base ?? { tokens: 0, costUsd: null, costPartial: false };
  if (!delta) return { ...b };
  const costUsd = b.costUsd == null && delta.costUsd == null ? null : (b.costUsd ?? 0) + (delta.costUsd ?? 0);
  return { tokens: b.tokens + (delta.tokens ?? 0), costUsd, costPartial: b.costPartial || !!delta.partial };
}

/** The model label while it is fresh, else the current checklist item, the running tool, the activity line. */
export function headlineOf(jp, { liveTool = null, activity = null, now } = {}) {
  if (jp.label && jp.labelAt != null && now - jp.labelAt < LABEL_FRESH_MS) {
    return { headline: plainLine(jp.label), headlineSource: "model" };
  }
  const items = live(jp);
  if (items.length > 0) {
    const cur = items.find((i) => i.status === "in_progress");
    if (cur) return { headline: plainLine(cur.text), headlineSource: "checklist" };
  }
  if (liveTool) {
    const t = plainLine(liveTool.target ? `${liveTool.tool}: ${liveTool.target}` : liveTool.tool);
    if (t) return { headline: t, headlineSource: "tool" };
  }
  const act = plainLine(activity);
  if (act) return { headline: act, headlineSource: "activity" };
  return { headline: "", headlineSource: "none" };
}

/** The last headline a record can give without any live state (completion text). */
export function finalHeadline(job) {
  const jp = job?.jobProgress;
  if (jp?.label) return plainLine(jp.label);
  const cur = jp ? live(jp).find((i) => i.status === "in_progress") : null;
  if (cur) return plainLine(cur.text);
  return plainLine(job?.activity);
}

/** `view.state` — the job lifecycle always wins; the model's `blocked` only matters while running. */
export function viewStateOf(job, jp) {
  if (job.status === "running") return jp?.modelState === "blocked" ? "needs-decision" : "working";
  if (job.status === "done" && job.endedBlocked === true) return "needs-decision";
  if (job.status === "done" || job.status === "failed" || job.status === "stopped" || job.status === "paused") return job.status;
  return "working";
}

const quantize = (ms) => Math.floor(ms / PROGRESS_QUANTUM_MS) * PROGRESS_QUANTUM_MS;

/**
 * The wire `view` (§5.3), without `rev` (the engine owns that). `lv` is the engine's live snapshot for the job
 * (`{lastProgressAt, tools: [{name,target,startedAt}], usage: {tokens,costUsd,partial}}`) or null.
 * @param {object} job
 * @param {{lastProgressAt?:number|null, tool?:{tool:string,target:string,startedAt:number}|null, usageDelta?:object|null}|null} lv
 */
export function computeJobView(job, lv, { now, manta }) {
  const jp = job.jobProgress ?? defaultJobProgress();
  const running = job.status === "running";
  const steps = stepsOf(jp);
  const liveTool = running ? (lv?.tool ?? null) : null;
  const { headline, headlineSource } = headlineOf(jp, { liveTool, activity: job.activity, now });
  const lastProgress = lv?.lastProgressAt ?? job.lastProgressAt ?? null;
  let usage = null;
  if (manta) usage = mergeUsage(jp.usage, lv?.usageDelta ?? null);
  let files = null;
  if (manta) {
    if (jp.files) files = { changed: jp.files.changed };
    else if (job.filesChanged != null) files = { changed: job.filesChanged };
  }
  const ended = job.status === "paused" ? (job.pausedAt ?? null) : running ? null : (job.finishedAt ?? null);
  return {
    asOf: now,
    state: viewStateOf(job, jp),
    headline,
    headlineSource,
    steps: steps
      ? {
          done: steps.done,
          total: steps.total,
          current: steps.current,
          items: steps.items,
          source: steps.source,
          planRevision: jp.planRevision ?? 0,
          grewAt: jp.grewAt ?? null,
        }
      : null,
    bar: steps || job.status === "done" ? (jp.bar ?? null) : null,
    live: liveTool,
    startedAt: job.startedAt ?? null,
    endedAt: ended,
    lastProgressAt: running && lastProgress != null ? quantize(lastProgress) : null,
    ceilingAt: running && manta && Number.isFinite(job.ceilingMs) && job.startedAt != null ? job.startedAt + job.ceilingMs : null,
    milestones: [...(jp.milestones ?? [])].reverse().slice(0, MILESTONES_KEPT),
    files,
    usage,
    model: job.model ?? null,
  };
}

/** The semantic signature of a view: everything except `asOf` (the engine bumps `rev.n` when it changes). */
export function viewSignature(view) {
  const { asOf: _a, ...rest } = view;
  return JSON.stringify(rest);
}
