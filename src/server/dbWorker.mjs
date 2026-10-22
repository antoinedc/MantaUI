// dbWorker.mjs — the worker_thread side of dbOffload.mjs. Owns its OWN read-only
// DatabaseSync, so a multi-second synchronous query blocks only this thread.
// Protocol: parent → {id, task, path, args}; worker → {id, ok, result} | {id, ok:false, error}.
// Read-only is a hard invariant: the handle is opened { readOnly: true } and no
// task here writes.

import { parentPort } from "node:worker_threads";
import { TASKS } from "./dbTasks.mjs";

let handle = null;
let handlePath = null;
let sqlite = null;

async function openFor(path) {
  if (handle && handlePath === path && handle.isOpen !== false) return handle;
  if (handle) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
    handle = null;
  }
  sqlite ??= await import("node:sqlite");
  handle = new sqlite.DatabaseSync(path, { readOnly: true });
  handlePath = path;
  try {
    handle.exec("PRAGMA busy_timeout = 5000");
  } catch {
    /* non-fatal, same as opencodeDb */
  }
  return handle;
}

parentPort.on("message", async (msg) => {
  const { id, task, path, args } = msg ?? {};
  try {
    const fn = TASKS[task];
    if (typeof fn !== "function") throw new Error(`unknown db task: ${task}`);
    const db = await openFor(path);
    parentPort.postMessage({ id, ok: true, result: fn(db, args ?? {}) });
  } catch (e) {
    // A failed query may leave the handle in a bad state; reopen next time.
    try {
      handle?.close();
    } catch {
      /* ignore */
    }
    handle = null;
    parentPort.postMessage({ id, ok: false, error: { message: String(e?.message ?? e), code: e?.code ?? null } });
  }
});
