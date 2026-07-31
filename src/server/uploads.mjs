// Upload cleanup poller for the box server (BET-427).
//
// Dragged-in uploads land at `~/.manta-uploads/<session>/<batch>/<file>`
// (see src/server/index.mjs `handleUpload`; `batch` is a numeric timestamp,
// `Date.now()` or an X-Batch-Id matching /^[0-9]{6,20}$/). Without a sweeper
// those batch dirs accumulate on the user's VPS forever — a real disk-growth
// bug. This module restores the cleanup that was lost in the SSH→direct
// migration: an hourly poller deletes batch dirs older than
// `uploadCleanupHours` (box config, default 24, `0` disables) and prunes
// session dirs left empty by the deletion.
//
// The poller runs BOX-SERVER-SIDE (the box is a persistent systemd service;
// the desktop is often offline), reading box config via `configGet()` — the
// same channel `worktreePerSession` / `chatAutoAllow` ride. Mirrors
// `startOutboxPoller`'s shape (one tick on construction, then `setInterval`).
//
// Only `<ts>` batch dirs matching the timestamp shape are swept; stray files
// and unexpected layout are left alone. ENOENT on the root is a no-op (the
// steady state until the user drags in their first file).

import { readdir, stat, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { uploadRoot as defaultUploadRoot } from "../shared/paths.mjs";

const POLL_MS = 60 * 60 * 1000; // hourly
const HOUR_MS = 3600_000;
// Batch dir names are numeric timestamps (Date.now() or an X-Batch-Id),
// matching src/server/index.mjs BATCH_RE = /^[0-9]{6,20}$/.
const BATCH_RE = /^[0-9]{6,20}$/;

/**
 * Pure sweep decision: given a list of batch entries (each with an mtimeMs)
 * and a threshold, return the entries whose age is >= the threshold (i.e.
 * the batch should be deleted). `thresholdMs <= 0` (cleanup disabled) → [].
 *
 * Exported for unit testing without touching the filesystem.
 *
 * @param {{ session: string, name: string, path: string, mtimeMs: number }[]} batches
 * @param {number} now          - current time in ms
 * @param {number} thresholdMs  - delete batches older than this many ms
 * @returns {{ session: string, name: string, path: string, mtimeMs: number }[]}
 */
export function selectExpiredBatches(batches, now, thresholdMs) {
  if (!(thresholdMs > 0)) return []; // <=0 disabled, or NaN → no-op
  return batches.filter((b) => now - b.mtimeMs >= thresholdMs);
}

/**
 * List every batch dir under the upload root as
 * `{ session, name, path, mtimeMs }`. Only session/<batch> dirs whose name
 * matches the timestamp shape are returned; stray files and deeper layout
 * are ignored. Returns [] when the root doesn't exist yet (ENOENT-safe).
 *
 * @param {string} root
 * @returns {Promise<{ session: string, name: string, path: string, mtimeMs: number }[]>}
 */
export async function listUploadBatches(root = defaultUploadRoot()) {
  const out = [];
  let sessions;
  try {
    sessions = await readdir(root, { withFileTypes: true });
  } catch {
    return out; // ENOENT etc. — uploads not created yet.
  }
  for (const s of sessions) {
    if (!s.isDirectory()) continue;
    const sessionDir = join(root, s.name);
    let batches;
    try {
      batches = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const b of batches) {
      if (!b.isDirectory()) continue;
      if (!BATCH_RE.test(b.name)) continue;
      const batchPath = join(sessionDir, b.name);
      try {
        const st = await stat(batchPath);
        out.push({ session: s.name, name: b.name, path: batchPath, mtimeMs: st.mtimeMs });
      } catch {
        continue; // vanished between readdir and stat.
      }
    }
  }
  return out;
}

/**
 * One sweep step: list batches, delete the expired ones, then prune session
 * dirs that are now empty. Returns the paths of the batch dirs deleted.
 * No-throw: fs errors are swallowed and logged (a transient EBUSY on one
 * batch must not kill the poller).
 *
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {number} [opts.now]          - defaults to Date.now()
 * @param {number} [opts.thresholdMs]  - ms; <=0 disables (no-op, returns [])
 * @returns {Promise<string[]>}        - deleted batch dir paths
 */
export async function sweepUploads({ root = defaultUploadRoot(), now = Date.now(), thresholdMs } = {}) {
  if (!(thresholdMs > 0)) return []; // <=0 disabled, or NaN → no-op
  const batches = await listUploadBatches(root);
  const expired = selectExpiredBatches(batches, now, thresholdMs);
  const deleted = [];
  const prunedSessions = new Set();
  for (const b of expired) {
    try {
      await rm(b.path, { recursive: true, force: true });
      deleted.push(b.path);
      prunedSessions.add(b.session);
    } catch (e) {
      console.warn("[uploads] failed to delete batch:", b.path, e?.message ?? e);
    }
  }
  // Prune session dirs that lost their only batch — best-effort rmdir
  // (fails harmlessly if the dir still holds other batches/files).
  for (const session of prunedSessions) {
    try {
      await rmdir(join(root, session));
    } catch {
      // not empty (other batches remain) or already gone — either is fine.
    }
  }
  return deleted;
}

/**
 * Start the upload cleanup poller. Returns a stop() function. Mirrors
 * `startOutboxPoller`: kicks one tick on construction, then `setInterval`.
 * Each tick reads `uploadCleanupHours` from box config (default 24, 0
 * disables) and sweeps `~/.manta-uploads/`.
 *
 * @param {object} opts
 * @param {() => Promise<Record<string, unknown>>} opts.configGet  - box config getter
 * @param {string} [opts.uploadRoot]                              - override (tests)
 * @param {number} [opts.intervalMs]                              - default 1h
 * @returns {{ stop: () => void }}
 */
export function startUploadCleanupPoller({ configGet, uploadRoot, intervalMs = POLL_MS } = {}) {
  if (typeof configGet !== "function") {
    throw new Error("startUploadCleanupPoller: configGet is required");
  }
  const root = uploadRoot ?? defaultUploadRoot();

  async function tick() {
    try {
      const cfg = await configGet();
      const hours = Number(cfg?.uploadCleanupHours ?? 24);
      const thresholdMs = hours > 0 ? hours * HOUR_MS : 0;
      await sweepUploads({ root, thresholdMs });
    } catch (e) {
      console.warn("[uploads] cleanup tick failed:", e?.message ?? e);
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
