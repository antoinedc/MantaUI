// Capability job queue for the MantaUI server — the generic spine that lets any
// MantaUI plugin register an AI-invokable capability and have a connected
// device (the Mac, or the box itself) execute it. First plugin: `ios.build`
// (compiled on the Mac to avoid burning Codemagic minutes), but the queue /
// REST surface / SSE envelopes here speak the GENERIC `{capability, input,
// host}` envelope — adding capability #2 is a new tool file + a new HANDLERS
// entry, NOT a queue change. See docs/mantaui-plugins.md for the full design.
//
// Shape mirrors src/server/schedule.mjs: dependency-injected
// ({load, save, publish, notifySession}) pure-logic-with-injected-I/O, plus a
// startCapSweeper() wrapper with inFlight guard + timer.unref() that clones
// startSchedulePoller exactly. The atomic-write helper is shared via
// src/server/storeUtils.mjs (one source of truth across the on-disk stores).
//
// Server-owned so queued jobs survive Mac-app-close, Mac sleep, and box
// reboot — the SSE+catch-up plumbing on the executor side picks them up when
// the Mac comes back.

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { STATE_DIRNAME } from "../shared/paths.mjs";
import { atomicWrite } from "./storeUtils.mjs";

// ---------------------------------------------------------------------------
// Constants (single source of truth — see docs/mantaui-plugins.md §Constants)
// ---------------------------------------------------------------------------

const STORE_PATH = join(homedir(), STATE_DIRNAME, "cap-jobs.json");

// Ring-buffer cap on a job's stored log. A runaway xcodebuild cannot fill the
// disk or blow the AI's context — chunks are dropped oldest-first.
const LOG_CAP_BYTES = 256 * 1024;
// Max log bytes returned by getJob. Joined then tail-trimmed so callers see
// recent output without paying the cost of the full buffer.
const LOG_TAIL_BYTES = 16 * 1024;
// Stale-job sweep cadence.
const SWEEP_INTERVAL_MS = 60_000;
// `running` jobs older than this → `failed "timed out after 30 minutes…"`.
const RUNNING_TIMEOUT_MS = 30 * 60_000;
// `queued` jobs older than this → `failed "expired: no executor picked…"`.
const QUEUED_EXPIRY_MS = 24 * 60 * 60_000;
// Terminal jobs older than this are pruned (silent retention).
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Hard cap on terminal-job count (oldest dropped first).
const MAX_TERMINAL_JOBS = 50;

// ---------------------------------------------------------------------------
// Store (atomic, same pattern as schedule.mjs)
// ---------------------------------------------------------------------------

export async function loadJobs(path = STORE_PATH) {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return []; // corrupt/unreadable → start empty rather than crash the server
  }
}

export async function saveJobs(jobs, path = STORE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify({ jobs }, null, 2));
}

function genId() {
  return randomBytes(4).toString("hex"); // 8-char hex, matches schedule/genId
}

// ---------------------------------------------------------------------------
// Job mutations (all injected-I/O; no live filesystem / bus access in tests)
// ---------------------------------------------------------------------------

/**
 * Validate the inputs the queue OWNS — generic envelope fields only. The
 * `input` shape is capability-defined; the tool (which calls this) validates it
 * before posting so the queue stays capability-agnostic.
 */
function validateCreate({ capability, host, sessionID }) {
  if (typeof capability !== "string" || !capability.trim()) {
    return "capability is required";
  }
  if (host !== "mac" && host !== "box") {
    return "host must be \"mac\" or \"box\"";
  }
  if (typeof sessionID !== "string" || !sessionID.trim()) {
    return "sessionID is required";
  }
  return null;
}

export async function createCapJob(
  { capability, input = {}, host, sessionID, directory = "", now = () => Date.now() },
  { load = loadJobs, save = saveJobs, publish } = {},
) {
  const err = validateCreate({ capability, host, sessionID });
  if (err) return { ok: false, error: err };

  const jobs = await load();
  const job = {
    id: genId(),
    capability,
    input: input ?? {},
    host,
    sessionID,
    directory: typeof directory === "string" ? directory : "",
    status: "queued",
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    log: [],
    result: null,
    error: null,
  };
  jobs.push(job);
  await save(jobs);
  publish?.({ kind: "capJob", payload: { id: job.id, capability, input: job.input, host } });
  return { ok: true, job };
}

/**
 * Get a single job with its log TAILED to LOG_TAIL_BYTES. The stored job is
 * never mutated — the returned object is a shallow copy with `log` replaced
 * by a single-element array containing the tailed string, plus a `logBytes`
 * total so callers can tell truncation happened.
 *
 * Returns null when the job doesn't exist.
 */
export async function getJob(id, { load = loadJobs } = {}) {
  const jobs = await load();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  const joined = (job.log ?? []).join("");
  const tailed =
    joined.length > LOG_TAIL_BYTES ? joined.slice(-LOG_TAIL_BYTES) : joined;
  return {
    ...job,
    log: [tailed],
    logBytes: joined.length,
  };
}

/**
 * List jobs with optional AND-combined filters. Results carry `logBytes`
 * instead of `log` — this one signature serves the AI, the executor catch-up,
 * and any future UI card (one code path). Returns a copy of the stored jobs.
 */
export async function listJobs(
  { sessionID, host, status } = {},
  { load = loadJobs } = {},
) {
  const jobs = await load();
  return jobs
    .filter(
      (j) =>
        (sessionID === undefined || j.sessionID === sessionID) &&
        (host === undefined || j.host === host) &&
        (status === undefined || j.status === status),
    )
    .map((j) => {
      const { log, ...rest } = j;
      return { ...rest, logBytes: (log ?? []).join("").length };
    });
}

/**
 * Append a log chunk to a `running` job. Ring-buffers: while the joined log
 * exceeds LOG_CAP_BYTES the OLDEST chunks are dropped (`log.shift()`). Late
 * flushes from a timed-out job are rejected — `{ok:false}` with no save — so
 * a timed-out job cannot be resurrected by a late log POST.
 */
export async function appendLog(id, chunk, { load = loadJobs, save = saveJobs } = {}) {
  const jobs = await load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: false, error: "not found" };
  const job = jobs[idx];
  if (job.status !== "running") {
    return { ok: false, error: "job not running", status: job.status };
  }
  const text = String(chunk ?? "");
  if (!text) return { ok: true }; // empty chunk is a no-op
  job.log = [...(job.log ?? []), text];
  while (job.log.length > 1 && job.log.join("").length > LOG_CAP_BYTES) {
    job.log.shift();
  }
  await save(jobs);
  return { ok: true };
}

/**
 * GUARDED claim: only a `queued` job transitions to `running` (stamps
 * startedAt). Missing job → `{ok:false, error:"not found"}`. Wrong status →
 * `{ok:false, error:"not queued", status}`. This is the executor's cross-
 * delivery dedup: a job delivered twice (SSE + catch-up list) is claimed once.
 */
export async function startJob(
  id,
  { load = loadJobs, save = saveJobs, now = () => Date.now() } = {},
) {
  const jobs = await load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: false, error: "not found" };
  const job = jobs[idx];
  if (job.status !== "queued") {
    return { ok: false, error: "not queued", status: job.status };
  }
  job.status = "running";
  job.startedAt = now();
  jobs[idx] = job;
  await save(jobs);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Terminal transition — ONE shared helper for completeJob and the sweep.
//
// Both `completeJob(id, {status, result, error})` and `sweepCapJobs` need to
// flip a job to done/failed, stamp finishedAt, publish the `cap.updated` bus
// event, and notify the originating session. They differ only in HOW they
// decide to do so, and how persistence is batched (completeJob saves once per
// transition; sweep saves once total). `markTerminal` owns the business logic
// (mutate + publish + notify) and the caller owns persistence — that's the
// spec's "one terminal-transition code path" rule.
// ---------------------------------------------------------------------------

async function markTerminal(
  job,
  { status, error = null, result = null, nowMs },
  { publish, notifySession },
) {
  job.status = status;
  job.error = error ?? null;
  job.result = result ?? null;
  job.finishedAt = nowMs;
  publish?.({ kind: "cap.updated", payload: { id: job.id, status, sessionID: job.sessionID } });
  // completionText includes its own status check; await + swallow so a dead
  // session never fails the REST call. Mirrors the scheduler's fire path.
  if (notifySession && job.sessionID) {
    try {
      await notifySession({ sessionID: job.sessionID, text: completionText(job) });
    } catch (e) {
      console.warn(`[cap] notifySession failed for ${job.id}:`, e?.message ?? e);
    }
  }
}

/**
 * Complete a job. `status` must be "done" or "failed" (else `{ok:false}`).
 * IDEMPOTENT: if the job is already terminal, returns
 * `{ok:true, alreadyTerminal:true}` WITHOUT saving, publishing, or notifying —
 * a duplicate "done" POST from the executor must not double-notify the
 * originating session. Otherwise stamps finishedAt, persists, publishes
 * `cap.updated`, and notifies the originating session with `completionText`.
 */
export async function completeJob(
  id,
  { status, result = null, error = null },
  { load = loadJobs, save = saveJobs, publish, notifySession, now = () => Date.now() } = {},
) {
  if (status !== "done" && status !== "failed") {
    return { ok: false, error: "status must be \"done\" or \"failed\"" };
  }
  const jobs = await load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return { ok: false, error: "not found" };
  const job = jobs[idx];
  if (job.status === "done" || job.status === "failed") {
    return { ok: true, alreadyTerminal: true };
  }
  // Allow completeJob only from `running` or `queued` — guards against a typo
  // status string making its way in by a non-executor caller.
  if (job.status !== "running" && job.status !== "queued") {
    return { ok: false, error: "cannot complete from status", status: job.status };
  }
  jobs[idx] = job;
  await markTerminal(
    job,
    { status, result, error, nowMs: now() },
    { publish, notifySession },
  );
  await save(jobs);
  return { ok: true };
}

/**
 * Pure: the text injected into the originating opencode session when a job
 * finishes. Tells the AI what happened and points it at ios_build_status (the
 * example) to inspect the log without busy-polling. Exported so tests can pin
 * the wording — the AI relies on this format to act on completions.
 */
export function completionText(job) {
  const base = `[MantaUI capability job] ${job.capability} job ${job.id} finished with status "${job.status}".`;
  const errSuffix = job.status === "failed" && job.error ? ` Error: ${job.error}.` : "";
  const tail = ` Check the job's status tool (e.g. ios_build_status("${job.id}")) for the log tail, then report the outcome to the user.`;
  return base + errSuffix + tail;
}

// ---------------------------------------------------------------------------
// Sweep — stale jobs, expired jobs, retention.
// ---------------------------------------------------------------------------

/**
 * One pass, one save. For each job:
 *   - running > RUNNING_TIMEOUT_MS   → failed "timed out…"
 *   - queued  > QUEUED_EXPIRY_MS     → failed "expired…"
 *   - retention: drop terminal older than TERMINAL_RETENTION_MS; cap
 *     MAX_TERMINAL_JOBS (drop oldest first). Silent.
 * Save only when something changed.
 */
export async function sweepCapJobs({
  load = loadJobs,
  save = saveJobs,
  publish,
  notifySession,
  now = () => Date.now(),
} = {}) {
  try {
    const jobs = await load();
    if (jobs.length === 0) return;
    const nowMs = now();
    const transitioned = [];

    for (const job of jobs) {
      if (
        job.status === "running" &&
        job.startedAt != null &&
        nowMs - job.startedAt > RUNNING_TIMEOUT_MS
      ) {
        job._pendingTerminal = {
          status: "failed",
          error: "timed out after 30 minutes (Mac executor lost?)",
        };
        transitioned.push(job);
      } else if (
        job.status === "queued" &&
        nowMs - job.createdAt > QUEUED_EXPIRY_MS
      ) {
        job._pendingTerminal = {
          status: "failed",
          error:
            "expired: no executor picked this job up within 24h " +
            "(is the Mac app running with the capability executor enabled?)",
        };
        transitioned.push(job);
      }
    }

    if (transitioned.length === 0) {
      // No timeouts/expiries — check retention only, and skip the save when
      // nothing was pruned.
      const retained = applyRetention(jobs, nowMs);
      if (retained.length !== jobs.length) {
        await save(retained);
      }
      return;
    }

    // Apply transitions via the shared markTerminal helper so the notify +
    // publish + finishedAt-stamp logic stays in one place. markTerminal does
    // NOT save — we save once below (sweep = one pass, one save).
    for (const job of transitioned) {
      const t = job._pendingTerminal;
      delete job._pendingTerminal;
      await markTerminal(
        job,
        { status: t.status, error: t.error, result: null, nowMs },
        { publish, notifySession },
      );
    }
    const retained = applyRetention(jobs, nowMs);
    await save(retained);
  } catch (e) {
    console.warn("[cap] sweep failed:", e?.message ?? e);
  }
}

// Drop terminal jobs older than TERMINAL_RETENTION_MS, then trim down to
// MAX_TERMINAL_JOBS (oldest first). Returns the (possibly shorter) array.
// Silent — dropped jobs do NOT publish (per spec).
function applyRetention(jobs, nowMs) {
  const cutoff = nowMs - TERMINAL_RETENTION_MS;
  let out = jobs.filter(
    (j) =>
      !(
        (j.status === "done" || j.status === "failed") &&
        j.finishedAt != null &&
        j.finishedAt < cutoff
      ),
  );
  const terminal = out.filter((j) => j.status === "done" || j.status === "failed");
  if (terminal.length > MAX_TERMINAL_JOBS) {
    // Sort terminal oldest-first, drop the surplus.
    const sorted = [...terminal].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const dropped = new Set(sorted.slice(0, terminal.length - MAX_TERMINAL_JOBS).map((j) => j.id));
    out = out.filter((j) => !dropped.has(j.id));
  }
  return out;
}

/**
 * Start the capability sweeper. Clones startSchedulePoller's shape EXACTLY:
 * build the deps with path-bound load/save, run once immediately,
 * setInterval + timer.unref(), inFlight re-entrancy guard, returns {stop}.
 */
export function startCapSweeper(
  { publish, notifySession } = {},
  { intervalMs = SWEEP_INTERVAL_MS, storePath } = {},
) {
  const path = storePath ?? STORE_PATH;
  const deps = {
    load: () => loadJobs(path),
    save: (jobs) => saveJobs(jobs, path),
    publish,
    notifySession,
  };

  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sweepCapJobs(deps);
    } catch (e) {
      console.warn("[cap] sweep tick failed:", e?.message ?? e);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
