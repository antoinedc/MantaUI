// dbOffload.mjs — run a heavy READ-ONLY opencode.db task (dbTasks.mjs) OFF the
// main thread, in a worker_thread with its own read-only DatabaseSync.
//
// The contract callers rely on:
//   • the event loop never waits on the query (the worker owns the synchronous
//     node:sqlite call);
//   • a hard wall-clock timeout per job: past it the caller is released with a
//     DbOffloadError("timeout") and that worker is abandoned (a native call can't
//     be interrupted; the thread dies when it returns) and replaced — so one
//     pathological query can't wedge every later job;
//   • at most MAX_WORKERS live workers + a cap on abandoned ones, so a stuck
//     query can't turn into unbounded threads (new jobs then fail fast with
//     "busy" and the caller degrades).
// Tasks also carry their own cooperative `budgetMs`, so the normal path is a
// partial-but-prompt answer; the timeout here is only the backstop.
//
// Modes: "worker" (default) or "inline" (run the task on the main thread — for
// tests and `MANTA_DB_OFFLOAD=inline`; never for production).

import { Worker } from "node:worker_threads";
import { getDb, currentDbPath, isSharedHandle } from "./opencodeDb.mjs";
import { TASKS } from "./dbTasks.mjs";

export class DbOffloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DbOffloadError";
    this.code = code;
  }
}

const MAX_WORKERS = 2;
const MAX_ABANDONED = 3;
const GRACE_MS = 10_000; // on top of a task's own budget

let mode = process.env.MANTA_DB_OFFLOAD === "inline" ? "inline" : "worker";
let workerFactory = () => new Worker(new URL("./dbWorker.mjs", import.meta.url));
let nextId = 1;
const pool = []; // { worker, busy: job|null }
const queue = []; // pending jobs
let abandoned = 0;

export function _setOffloadMode(m) {
  mode = m === "inline" ? "inline" : "worker";
}
/** Test seam: a worker factory (e.g. one that never answers). */
export function _setWorkerFactory(f) {
  workerFactory = f ?? (() => new Worker(new URL("./dbWorker.mjs", import.meta.url)));
}
export function _stats() {
  return { workers: pool.length, queued: queue.length, abandoned };
}
/** Test/shutdown: drop every worker. */
export async function _shutdownOffload() {
  const all = pool.splice(0);
  queue.splice(0).forEach((j) => j.reject(new DbOffloadError("closed", "offload shut down")));
  await Promise.all(all.map((s) => s.worker.terminate().catch(() => {})));
}

function spawn() {
  const worker = workerFactory();
  const slot = { worker, busy: null };
  worker.on("message", (m) => {
    const job = slot.busy;
    if (!job || m?.id !== job.id) return; // a late answer from an abandoned job
    finish(slot, job);
    if (m.ok) job.resolve(m.result);
    else job.reject(new DbOffloadError("task_failed", m.error?.message ?? "db task failed"));
  });
  const onDead = (err) => {
    const i = pool.indexOf(slot);
    if (i >= 0) pool.splice(i, 1);
    const job = slot.busy;
    if (job) {
      finish(slot, job);
      job.reject(new DbOffloadError("worker_failed", `db worker exited: ${err?.message ?? "exit"}`));
    }
    pump();
  };
  worker.on("error", onDead);
  worker.on("exit", () => {
    if (slot.abandoned) abandoned = Math.max(0, abandoned - 1);
    onDead();
  });
  // After the listeners: adding a 'message' listener re-refs the port, and an idle
  // db worker must never keep the process (a test run, a clean shutdown) alive.
  worker.unref?.();
  pool.push(slot);
  return slot;
}

function finish(slot, job) {
  clearTimeout(job.timer);
  if (slot.busy === job) {
    slot.busy = null;
    slot.worker.unref?.(); // idle workers never keep the process alive
  }
  pump();
}

function pump() {
  while (queue.length) {
    let slot = pool.find((s) => !s.busy && !s.abandoned);
    if (!slot && pool.filter((s) => !s.abandoned).length < MAX_WORKERS) slot = spawn();
    if (!slot) return;
    const job = queue.shift();
    slot.busy = job;
    slot.worker.ref?.(); // an in-flight job keeps the process alive until it answers or times out
    job.timer = setTimeout(() => {
      // Abandon: the caller is released NOW; the thread is replaced.
      slot.abandoned = true;
      abandoned++;
      slot.busy = null;
      const i = pool.indexOf(slot);
      if (i >= 0) pool.splice(i, 1);
      slot.worker.terminate().catch(() => {});
      job.reject(new DbOffloadError("timeout", `db task ${job.task} exceeded ${job.timeoutMs} ms`));
      pump();
    }, job.timeoutMs);
    job.timer.unref?.();
    slot.worker.postMessage({ id: job.id, task: job.task, path: job.path, args: job.args });
  }
}

/**
 * Run `task` (a key of TASKS) with `args` against the CURRENT opencode.db.
 * Resolves the task's result; rejects with DbOffloadError (code: "no_db" |
 * "busy" | "timeout" | "worker_failed" | "task_failed"). Callers degrade on any
 * rejection — never throw it to a client.
 */
export async function runDbTask(task, args = {}, { timeoutMs } = {}) {
  if (typeof TASKS[task] !== "function") throw new DbOffloadError("task_failed", `unknown db task: ${task}`);
  // getDb() applies the V2-schema guard and tracks the current path; the worker
  // opens the same file by path.
  const db = await getDb();
  if (!db) throw new DbOffloadError("no_db", "no readable opencode.db");
  if (mode === "inline") return TASKS[task](db, args);
  const path = currentDbPath();
  if (!path) throw new DbOffloadError("no_db", "no readable opencode.db");
  if (abandoned >= MAX_ABANDONED) throw new DbOffloadError("busy", "too many abandoned db workers; refusing new jobs");
  const budget = Number.isFinite(args.budgetMs) ? args.budgetMs : 15_000;
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, task, path, args, resolve, reject, timeoutMs: timeoutMs ?? budget + GRACE_MS, timer: null });
    pump();
  });
}

/**
 * Like runDbTask, for a caller that was HANDED a handle. The shared handle →
 * the worker (same file, off-thread); any other handle (a test fixture, an
 * in-memory DB) → the task runs inline against it, since a worker can't open it.
 */
export async function runOnHandle(db, task, args = {}, opts = {}) {
  if (isSharedHandle(db)) return runDbTask(task, args, opts);
  if (typeof TASKS[task] !== "function") throw new DbOffloadError("task_failed", `unknown db task: ${task}`);
  return TASKS[task](db, args);
}
