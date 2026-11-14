// jobViews.mjs — computes the wire `view` of a job record (spec 2026-11-14 §B4, §5.3) and publishes it.
//
// `viewFor` does no I/O: it reads the record it is given and the engine's in-memory liveness. `rev.n` is bumped when the
// view's semantic content (everything but `asOf`) differs from the last one this process computed for the job, so a
// read of an unchanged view never bumps it and events and list reads always agree. `notify` coalesces progress
// publishes to at most one per job every `throttleMs`, trailing (the last state is always sent); terminal and paused
// transitions go out at once through `publishNow`.

import { computeJobView, headlineOf, viewSignature } from "./jobProgressView.mjs";

export const VIEW_PUBLISH_THROTTLE_MS = 5_000;

/**
 * @param {{ now?: () => number, epoch?: number, liveness?: ReturnType<typeof import("./jobLiveness.mjs").createJobLiveness>,
 *           ownerOf?: (job: object) => string, publish?: (evt: object) => void, load?: () => Promise<object[]>,
 *           setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (h: unknown) => void, throttleMs?: number }} deps
 */
export function createJobViews({
  now = () => Date.now(),
  epoch = Math.round(Date.now() - process.uptime() * 1000),
  liveness = null,
  ownerOf = (j) => j?.completionOwner ?? (j?.origin === "subagent" ? "opencode" : "manta"),
  publish = null,
  load = async () => [],
  setTimer = (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimer = (h) => clearTimeout(h),
  throttleMs = VIEW_PUBLISH_THROTTLE_MS,
} = {}) {
  const revs = new Map(); // job id -> { n, sig }
  const published = new Map(); // job id -> signature last published
  const pending = new Map(); // job id -> { timer, lastAt }
  const lastAt = new Map(); // job id -> epoch ms of the last throttled publish

  function body(job) {
    const running = job.status === "running";
    const lv = running ? liveness?.snapshot(job.id) ?? null : null;
    return computeJobView(job, lv, { now: now(), manta: ownerOf(job) === "manta" });
  }

  function viewFor(job) {
    const b = body(job);
    const sig = viewSignature(b);
    let r = revs.get(job.id);
    if (!r) {
      r = { n: 0, sig: null };
      revs.set(job.id, r);
    }
    if (r.sig !== sig) {
      r.n += 1;
      r.sig = sig;
    }
    return { rev: { epoch, n: r.n }, ...b };
  }

  function emit(job, base) {
    const view = viewFor(job);
    published.set(job.id, revs.get(job.id).sig);
    publish?.({
      kind: "delegate.updated",
      payload: { id: job.id, status: job.status, activity: job.activity, ...base, view },
    });
    return view;
  }

  return {
    viewFor,
    /** Publish now (a terminal / paused transition, an extension, the activity poller): not throttled. */
    publishNow(job, base = {}) {
      return emit(job, base);
    },
    /** The job's view changed (a tool started, a plan moved, …): publish it, coalesced per job. */
    notify(jobId) {
      if (pending.has(jobId) || !publish) return;
      const delay = Math.max(0, (lastAt.get(jobId) ?? 0) + throttleMs - now());
      const entry = { timer: null };
      entry.timer = setTimer(async () => {
        pending.delete(jobId);
        lastAt.set(jobId, now());
        try {
          const job = ((await load()) ?? []).find((j) => j.id === jobId);
          if (!job) return;
          const sig = viewSignature(body(job));
          if (published.get(jobId) === sig) return;
          emit(job, {});
        } catch (e) {
          console.warn(`[delegate] publishing the progress view of ${jobId} failed:`, e?.message ?? e);
        }
      }, delay);
      pending.set(jobId, entry);
    },
    /** The headline a job would show right now (for a stall's error text). */
    headlineFor(job) {
      const lv = liveness?.snapshot(job.id) ?? null;
      return headlineOf(job.jobProgress ?? {}, { liveTool: lv?.tool ?? null, activity: job.activity, now: now() }).headline;
    },
    /** Forget every job not in `ids` (the record is gone). Revisions of jobs still in the store are kept. */
    prune(ids) {
      const keep = new Set(ids);
      for (const map of [revs, published, lastAt]) for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
      for (const [id, e] of pending) {
        if (keep.has(id)) continue;
        clearTimer(e.timer);
        pending.delete(id);
      }
    },
    dispose() {
      for (const e of pending.values()) clearTimer(e.timer);
      pending.clear();
    },
    _revs: revs,
  };
}
