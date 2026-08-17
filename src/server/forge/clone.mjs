// clone.mjs — server-side clone JOB registry (BET-796 §3).
//
// A clone runs on the box with real progress streamed to the determinate bar
// (§4.3: git reports byte counts against a known total — the ONE place a
// determinate bar is correct). This registry keeps each clone's progress
// server-side, keyed by an opaque id, so the renderer polls cheap status
// snapshots over RPC instead of holding a stream open across requests. The
// clone hands off to the existing batch workspace creation (zero-state issue)
// once it lands on disk — cloning only produces a directory; creating the
// session is the caller's job, reusing the SAME code path as the repo probe.

import { gitClone } from "../local.mjs";

// Finished jobs linger for status polls, then drop off so a leaking tab can't
// accumulate clones forever.
const DONE_TTL_MS = 5 * 60_000;

/**
 * A factory of isolated clone-job registries — the test seam. Production calls
 * `getCloneStore()`; a test calls `createCloneStore()` with an injected
 * `gitCloneFn` (no live git, no real clone).
 *
 * @param {{ gitCloneFn?: typeof gitClone, now?: () => number }} [opts]
 */
export function createCloneStore({ gitCloneFn = gitClone, now = Date.now } = {}) {
  const jobs = new Map(); // id -> job (includes an internal _controller, never surfaced)
  let seq = 0;

  const prune = () => {
    const t = now();
    for (const [id, j] of jobs) {
      if (j.done && j.doneAt != null && t - j.doneAt > DONE_TTL_MS) jobs.delete(id);
    }
  };

  // The renderer-visible status shape. Never includes the token, the spawn
  // handle, or the internal controller.
  const statusOf = (j) => ({
    id: j.id,
    name: j.name,
    url: j.url,
    dest: j.dest,
    percent: j.percent,
    bytes: j.bytes,
    done: j.done,
    ok: j.ok,
    error: j.error,
    cancelled: j.cancelled,
  });

  return {
    /**
     * Start a clone. Returns an opaque job id immediately; the clone runs in
     * the background, updating the registry's progress until done/failed.
     *
     * @param {{ url: string, dest: string, name: string, token?: string }} input
     * @returns {string}
     */
    start({ url, dest, name, token }) {
      prune();
      const id = `clone-${now().toString(36)}-${seq++}`;
      const controller = new AbortController();
      const job = {
        id, url, dest, name, token,
        percent: 0, bytes: 0,
        done: false, ok: false, error: null, cancelled: false,
        doneAt: null,
      };
      jobs.set(id, job);
      (async () => {
        try {
          await gitCloneFn({
            url,
            dest,
            token,
            signal: controller.signal,
            onProgress: (p) => {
              if (job.done) return;
              job.percent = p.percent;
              job.bytes = p.bytes;
            },
          });
          job.done = true;
          job.ok = true;
          job.doneAt = now();
        } catch (e) {
          job.cancelled = Boolean(e?.cancelled);
          job.done = true;
          job.ok = false;
          // Surface the message WITHOUT any token that may have ridden on it.
          job.error = (e instanceof Error && e.message ? e.message : String(e)).replace(/\bbearer\s+\S+\b/gi, "bearer ***");
          job.doneAt = now();
        }
      })();
      job._controller = controller;
      return id;
    },

    /**
     * Status snapshot for a job, or null when the id is unknown/expired.
     * @param {string} id
     */
    status(id) {
      const j = jobs.get(id);
      return j ? statusOf(j) : null;
    },

    /**
     * Cancel an in-flight clone (the [S7] Cancel button).
     * @param {string} id
     * @returns {{ cancelled: boolean }}
     */
    cancel(id) {
      const j = jobs.get(id);
      if (!j || j.done) return { cancelled: false };
      try { j._controller.abort(); } catch { /* already aborting */ }
      return { cancelled: true };
    },
  };
}

const defaultStore = createCloneStore();

/**
 * The production clone-job registry.
 * @type {ReturnType<typeof createCloneStore>}
 */
export function getCloneStore() {
  return defaultStore;
}
