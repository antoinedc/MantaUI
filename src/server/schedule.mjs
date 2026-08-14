// Scheduled-prompt engine for the mobile server (the always-on, systemd-managed
// process on the Linux box). The remote AI calls the global opencode `schedule`
// tool (docs/opencode-tools/schedule.ts), which POSTs to manta-server's
// /api/schedule. Jobs are stored here durably and fired by a periodic tick that
// re-submits the prompt into the SAME opencode session — the scheduled work
// then streams back into the user's open ChatPanel as a new turn.
//
// The injected `sendPrompt` is wired in src/server/index.mjs to the shared
// prompt-delivery engine (src/server/promptDelivery.mjs), so a firing that
// lands while the target session is mid-turn is DEFERRED until idle rather
// than aborting the user's in-flight model turn (BET-375). This module stays
// ignorant of busy state — the single injected delivery function handles it.
//
// Server-owned (NOT duplicated in desktop main) so jobs survive Mac-app-close,
// session navigation, and box reboot. This is strictly more durable than Claude
// Code's session-scoped /loop. See docs/manta-tools-scheduler.md for the full
// design + scope cuts (no jitter / no 7-day expiry / no catch-up in v1).
//
// Shape mirrors src/server/outbox.mjs: a dependency-injected createScheduler()
// (testable without timers or live opencode) + a startSchedulePoller() wrapper
// with an inFlight guard and timer.unref().

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { startPoller } from "./startPoller.mjs";

const STORE_PATH = statePath("schedule.json");

// Render a 5-field cron expression ("M H D MO *") that fires ONCE at a given
// absolute instant, interpreted in the box's LOCAL time. The DOW is "*" so the
// job fires on whatever weekday that date falls on.
//
// This conversion runs on the box — in the same timezone `cronMatches`
// interprets — which is why callers hand it an absolute instant rather than a
// pre-rendered cron: an epoch-ms instant carries no timezone, so rendering it
// here yields precisely the wall-clock moment the caller meant, no matter what
// timezone the caller was in.
//
// Pure. Watch the month off-by-one: JS getMonth() is 0-11, cron months are
// 1-12, so a December job (getMonth() === 11) must render month "12".
export function cronForInstant(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getMinutes())} ${p(date.getHours())} ${p(date.getDate())} ${date.getMonth() + 1} *`;
}

// minute-granularity cron only needs sub-minute polling. 30s guarantees every
// minute is observed at least once; the lastFiredMinute guard makes a second
// observation within the same minute a no-op.
const POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Cron matcher — pure
// ---------------------------------------------------------------------------

// Parse one cron field ("min" 0-59, "hour" 0-23, etc.) into a Set of allowed
// integers, or null for "*" (matches anything). Supports: "*", "*/step",
// "a-b" range, single value, and comma lists composed of those. Returns
// undefined on invalid syntax so the caller can reject.
function parseField(field, min, max) {
  if (field === "*") return null; // wildcard
  const allowed = new Set();
  for (const part of field.split(",")) {
    let step = 1;
    let body = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      body = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return undefined;
    }
    let lo;
    let hi;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(body);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

// Validate a 5-field cron expression. Returns { valid, error? }.
export function validateCron(expr) {
  if (typeof expr !== "string") return { valid: false, error: "cron must be a string" };
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    return { valid: false, error: "cron must have exactly 5 fields (min hour dom month dow)" };
  const bounds = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day-of-month
    [1, 12], // month
    [0, 7], // day-of-week (0 and 7 = Sunday)
  ];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(fields[i], bounds[i][0], bounds[i][1]);
    if (parsed === undefined)
      return { valid: false, error: `invalid cron field "${fields[i]}"` };
  }
  return { valid: true };
}

// Does `expr` fire at the given Date (interpreted in the host's LOCAL time —
// cron "0 9 * * *" means 9am wherever the box is, matching Claude Code).
// Vixie-cron semantics: when BOTH day-of-month and day-of-week are restricted
// (neither is "*"), a date matches if EITHER field matches.
export function cronMatches(expr, date) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const min = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  let dow = parseField(fields[4], 0, 7);
  if (min === undefined || hour === undefined || dom === undefined || month === undefined || dow === undefined)
    return false;

  // Normalize dow 7 → 0 (Sunday) for comparison against getDay() (0-6).
  if (dow && dow.has(7)) dow = new Set([...dow].map((d) => (d === 7 ? 0 : d)));

  const m = date.getMinutes();
  const h = date.getHours();
  const dmonth = date.getDate();
  const mon = date.getMonth() + 1;
  const wday = date.getDay(); // 0-6, Sun=0

  if (min && !min.has(m)) return false;
  if (hour && !hour.has(h)) return false;
  if (month && !month.has(mon)) return false;

  const domRestricted = dom !== null;
  const dowRestricted = dow !== null;
  if (domRestricted && dowRestricted) {
    // either matches
    return dom.has(dmonth) || dow.has(wday);
  }
  if (domRestricted) return dom.has(dmonth);
  if (dowRestricted) return dow.has(wday);
  return true; // both wildcard
}

// The first instant at or after `from` (minute resolution) at which `cron`
// fires, or null if there is none within `maxDays`. Pure.
//
// The day-level pre-test reuses cronMatches with the minute+hour fields
// replaced by "*", so a non-matching day costs ONE call instead of 1440.
// That keeps the worst case (a cron whose date never occurs, e.g. 31 Feb)
// at ~400 calls rather than ~576,000 — and this runs once per job creation,
// never in the tick.
export function firstCronMatchAtOrAfter(cron, from, { maxDays = 400 } = {}) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const dayExpr = `* * ${fields[2]} ${fields[3]} ${fields[4]}`;

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);

  for (let day = 0; day <= maxDays; day++) {
    const dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    if (cronMatches(dayExpr, dayStart)) {
      // Walk the minutes of this day, starting at `cursor` on the first day.
      const probe = new Date(cursor.getTime());
      while (probe.getDate() === dayStart.getDate() && probe.getMonth() === dayStart.getMonth()) {
        if (cronMatches(cron, probe)) return probe;
        probe.setMinutes(probe.getMinutes() + 1);
      }
    }
    // Advance to the start of the next day.
    cursor.setFullYear(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

// Stable minute key in LOCAL time: "YYYY-MM-DDTHH:mm". Used as the dedup guard
// so a job fires at most once per minute even though the poller ticks twice.
export function minuteKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(
    date.getHours(),
  )}:${p(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Job fireability — pure decision helper
// ---------------------------------------------------------------------------

/**
 * Decide whether a job can be fired right now. Pure (no I/O): the caller
 * injects the directory-existence check so this can be unit-tested without
 * touching the filesystem.
 *
 * Returns { ok: true } when the job should be fired, or { ok: false, reason }
 * with a stable string reason so the caller can log consistently.
 *
 * Reasons:
 *   "disabled"      — the job was previously marked disabled (by us or the user)
 *   "directory gone" — the job's cwd no longer exists on disk
 */
export function isJobFireable(job, { directoryExists } = {}) {
  if (job.disabled) return { ok: false, reason: "disabled" };
  if (job.directory && !directoryExists(job.directory)) {
    return { ok: false, reason: "directory gone" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Store (atomic, same pattern as local.mjs)
// ---------------------------------------------------------------------------

export async function loadJobs(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

export async function saveJobs(jobs, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify({ jobs }, null, 2));
}

function genId() {
  return randomBytes(4).toString("hex"); // 8-char, like Claude Code's CronCreate
}

// Create + persist a job. Returns { ok, job?, error? }. Pure-ish (I/O via
// injected load/save) so callers/tests control persistence.
//
// `kind` — "prompt" (default; fires sendPrompt into the session) or "notify"
// (fires a push via fireNotify instead). The job's `prompt` field carries the
// text in BOTH cases; there is deliberately no second text field. Defaulting
// to "prompt" keeps every existing job and caller (the AI `schedule` tool)
// unaffected.
export async function createJob(
  {
    cron,
    prompt,
    recurring = true,
    label = "",
    sessionID,
    directory = "",
    kind = "prompt",
    fireAt,
    now = () => new Date(),
  },
  { load = loadJobs, save = saveJobs, publish } = {},
) {
  // A caller that knows the absolute instant (the renderer's usage reset
  // actions) sends `fireAt` instead of `cron`; rendering it here — on the box —
  // is what keeps it in the timezone cronMatches interprets. `fireAt` is never
  // stored: it collapses into the normal `cron` field and every downstream path
  // is unchanged.
  if (fireAt !== undefined) {
    if (typeof fireAt !== "number" || !Number.isFinite(fireAt))
      return { ok: false, error: "fireAt must be a finite epoch-ms number" };
    cron = cronForInstant(new Date(fireAt));
  }
  const v = validateCron(cron);
  if (!v.valid) return { ok: false, error: v.error };
  if (typeof prompt !== "string" || !prompt.trim())
    return { ok: false, error: "prompt is required" };
  if (typeof sessionID !== "string" || !sessionID)
    return { ok: false, error: "sessionID is required" };
  if (kind !== "prompt" && kind !== "notify")
    return { ok: false, error: `invalid kind "${kind}"` };

  const jobs = await load();
  const createdAt = now().getTime();
  // A one-shot has exactly one due instant. Stamping it at creation is what
  // lets the tick drop a job whose moment has passed instead of leaving a
  // yearless cron to re-match next year. Recurring jobs have no due instant.
  const dueAt = recurring
    ? null
    : (firstCronMatchAtOrAfter(cron.trim(), new Date(createdAt))?.getTime() ?? null);
  const job = {
    id: genId(),
    cron: cron.trim(),
    prompt: prompt.trim(),
    recurring: !!recurring,
    label: typeof label === "string" ? label : "",
    kind,
    sessionID,
    directory: directory || "",
    createdAt,
    dueAt,
    lastFiredMinute: null,
  };
  jobs.push(job);
  await save(jobs);
  publish?.({ kind: "schedule.updated", payload: { sessionID } });
  return { ok: true, job };
}

export async function deleteJob(id, { load = loadJobs, save = saveJobs, publish } = {}) {
  const jobs = await load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: true, deleted: false };
  const [removed] = jobs.splice(idx, 1);
  await save(jobs);
  publish?.({ kind: "schedule.updated", payload: { sessionID: removed?.sessionID } });
  return { ok: true, deleted: true };
}

export async function listJobs(sessionID, { load = loadJobs } = {}) {
  const jobs = await load();
  return sessionID ? jobs.filter((j) => j.sessionID === sessionID) : jobs;
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

/**
 * Build a single scheduler tick (testable without timers). On each tick it
 * scans all jobs, fires any whose cron matches the current minute (and that
 * hasn't already fired this minute), stamps lastFiredMinute, deletes fired
 * one-shots, and persists. Re-entrancy guarded.
 *
 * Jobs whose `directory` no longer exists on disk are auto-disabled on first
 * detection (a single log line, then they stop retrying forever). Disabled
 * jobs are never re-evaluated for firing. This breaks the dead-cwd retry loop
 * where a deleted worktree caused opencode errors on every tick indefinitely.
 *
 * @param {object} deps
 * @param {() => Promise<object[]>} deps.load
 * @param {(jobs: object[]) => Promise<void>} deps.save
 * @param {(args: {sessionId: string, text: string}) => Promise<any>} deps.sendPrompt
 * @param {(args: {message: string, title?: string, urgent?: boolean, sessionID?: string}) => Promise<any>} [deps.fireNotify] — required for `kind: "notify"` jobs; injected so the tick stays testable with no push stack
 * @param {() => Date} [deps.now]
 * @param {(evt: object) => void} [deps.publish]
 * @param {(path: string) => boolean} [deps.directoryExists] — defaults to node:fs/existsSync
 * @returns {{ tick: () => Promise<void> }}
 */
export function createScheduler({
  load,
  save,
  sendPrompt,
  fireNotify,
  now = () => new Date(),
  publish,
  directoryExists = existsSync,
} = {}) {
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const when = now();
      const key = minuteKey(when);
      const jobs = await load();
      let mutated = false;
      const survivors = [];
      const firedSessions = new Set();

      for (let job of jobs) {
        // Disabled jobs never fire — they were auto-disabled (dead cwd) or
        // manually disabled by the user. Just persist them as-is.
        if (job.disabled) {
          survivors.push(job);
          continue;
        }

        const fireable = isJobFireable(job, { directoryExists });
        if (!fireable.ok) {
          console.warn(
            `[schedule] skip ${job.id}: ${fireable.reason}${job.directory ? " " + job.directory : ""}`,
          );
          if (fireable.reason === "directory gone") {
            // Auto-disable: persist with disabled flag + reason so the user
            // can see it in the UI and re-enable if they restore the dir.
            survivors.push({
              ...job,
              disabled: true,
              disabledReason: "directory gone",
            });
            mutated = true;
          } else {
            survivors.push(job);
          }
          continue;
        }

        const due = job.lastFiredMinute !== key && cronMatches(job.cron, when);
        if (!due) {
          // A one-shot whose due instant has passed never fires (there is no
          // catch-up). Dropping it here is what stops a yearless cron re-matching
          // 12 months later, and is what keeps the store from accumulating
          // never-fired jobs. `dueAt == null` covers jobs created before this
          // field existed AND crons with no match in range — those keep the old
          // behaviour rather than being silently deleted.
          if (!job.recurring && job.dueAt === undefined) {
            // Legacy job created before `dueAt` existed: derive it once from the
            // fields every job already has, stamp it, and let the rule below apply
            // on this same tick. This is why no migration script is needed.
            job = { ...job, dueAt: firstCronMatchAtOrAfter(job.cron, new Date(job.createdAt))?.getTime() ?? null };
            mutated = true;
          }
          if (!job.recurring && typeof job.dueAt === "number" && when.getTime() > job.dueAt) {
            console.warn(`[schedule] drop one-shot ${job.id}: due instant passed without firing`);
            mutated = true;
            continue; // not pushed to survivors
          }
          survivors.push(job);
          continue;
        }
        // Fire. Failures are swallowed (logged) so one bad job can't wedge the
        // loop or block other due jobs; lastFiredMinute is stamped regardless
        // to avoid hammering a persistently-failing send every tick.
        try {
          if (job.kind === "notify") {
            if (typeof fireNotify === "function") {
              await fireNotify({
                message: job.prompt, // the job's `prompt` carries the notify text
                urgent: true, // draw attention on every device — that's what "remind me" means
                sessionID: job.sessionID,
              });
            } else {
              console.warn(`[schedule] fire job ${job.id}: kind "notify" but fireNotify was not injected`);
            }
          } else {
            await sendPrompt({ sessionId: job.sessionID, text: job.prompt });
          }
        } catch (e) {
          console.warn(`[schedule] fire job ${job.id} failed:`, e?.message ?? e);
        }
        firedSessions.add(job.sessionID);
        mutated = true;
        if (job.recurring) {
          survivors.push({ ...job, lastFiredMinute: key });
        }
        // one-shot: dropped (not pushed to survivors)
      }

      if (mutated) {
        await save(survivors);
        for (const sid of firedSessions) {
          publish?.({ kind: "schedule.updated", payload: { sessionID: sid } });
        }
      }
    } catch (e) {
      console.warn("[schedule] tick failed:", e?.message ?? e);
    } finally {
      inFlight = false;
    }
  }

  return { tick };
}

/**
 * Start the schedule poller. Fires once immediately then every intervalMs.
 *
 * @param {object} deps
 * @param {(args: {sessionId: string, text: string}) => Promise<any>} deps.sendPrompt
 * @param {(args: {message: string, title?: string, urgent?: boolean, sessionID?: string}) => Promise<any>} [deps.fireNotify] — for `kind: "notify"` jobs
 * @param {(evt: object) => void} [deps.publish]  - bus.publish
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=30000]
 * @param {string} [opts.storePath]
 * @returns {{ stop: () => void }}
 */
export function startSchedulePoller({ sendPrompt, fireNotify, publish } = {}, { intervalMs = POLL_MS, storePath } = {}) {
  const path = storePath ?? STORE_PATH;
  const { tick } = createScheduler({
    load: () => loadJobs(path),
    save: (jobs) => saveJobs(jobs, path),
    sendPrompt,
    fireNotify,
    publish,
  });

  return startPoller(tick, { intervalMs, label: "schedule" });
}
