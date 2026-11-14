// jobLiveness.mjs — the engine's in-memory liveness picture of running background jobs
// (spec 2026-11-14-background-job-liveness-and-progress §A1, §A2, §A5).
//
// The stream interpreter's activity tap (streamInterp.onActivity) feeds `observe`; the 60 s sweep reads
// `judgeStall`; the pump's question/permission backstop reads `ownsSession`. Everything here is
// synchronous, in memory and clock-injected: a manta-server restart starts from nothing and the
// sweep rebuilds what it can (`applyReconstruction`), failing open until it has.

export const STALL_WINDOW_MS = 15 * 60_000;
export const TOOL_TIMEOUT_GRACE_MS = 5 * 60_000;
export const TOOL_SILENCE_MS = 60 * 60_000;
export const ENDED_MAX = 500;
export const USAGE_SEEN_MAX = 2000;
export const REJECTIONS_MAX = 100;
const CONTENT_WINDOW_MIN = 15;
const QUANTUM_MS = 30_000;

const bound = (set, cap) => {
  while (set.size > cap) set.delete(set.values().next().value);
};

/**
 * @param {{ now?: () => number,
 *           ownerOf?: (job: object) => "manta"|"opencode",
 *           delegateLaunched?: (job: object) => boolean }} deps
 */
export function createJobLiveness({
  now = () => Date.now(),
  ownerOf = (j) => j?.completionOwner ?? (j?.origin === "subagent" ? "opencode" : "manta"),
  delegateLaunched = (j) => j?.origin !== "command" && !!j?.launch,
} = {}) {
  const jobs = new Map(); // job id -> live
  const index = new Map(); // session id -> job id (a running job's root and every known descendant)
  const rejections = new Map(); // request id -> { kind, requestId, sessionId }
  let generation = 0;

  function create(job) {
    const live = {
      jobId: job.id,
      attempt: job.attempt ?? 1,
      root: job.childSessionID,
      owner: ownerOf(job),
      delegateLaunch: delegateLaunched(job),
      sessions: new Set([job.childSessionID]),
      lastProgressAt: now(),
      tools: new Map(),
      ended: new Set(),
      generation: ++generation,
      reconstructedAt: null,
      todos: null,
      usageDelta: { tokens: 0, costUsd: null, partial: false },
      usageSeen: new Set(),
      buckets: new Map(),
    };
    jobs.set(job.id, live);
    index.set(job.childSessionID, job.id);
    return live;
  }

  function drop(jobId) {
    const live = jobs.get(jobId);
    if (!live) return;
    for (const sid of live.sessions) if (index.get(sid) === jobId) index.delete(sid);
    jobs.delete(jobId);
  }

  /** The live entry for a RUNNING job, created (unreconstructed) when absent or built for another attempt / root. */
  function ensure(job) {
    if (!job?.id || job.status !== "running" || !job.childSessionID) return null;
    const cur = jobs.get(job.id);
    if (cur && cur.root === job.childSessionID && cur.attempt === (job.attempt ?? 1)) return cur;
    if (cur) drop(job.id);
    return create(job);
  }

  function touch(live, at) {
    const prev = live.lastProgressAt;
    if (at > prev) live.lastProgressAt = at;
    return Math.floor(prev / QUANTUM_MS) !== Math.floor(live.lastProgressAt / QUANTUM_MS);
  }

  function bucket(live, at) {
    const k = Math.floor(at / 60_000);
    live.buckets.set(k, (live.buckets.get(k) ?? 0) + 1);
    for (const key of live.buckets.keys()) if (key < k - CONTENT_WINDOW_MIN - 1) live.buckets.delete(key);
  }

  /**
   * One record from the interpreter's activity tap → `{ jobId, notify, todos? } | null` (null: not a job's session).
   * `notify` says the view may have changed (a tool started / ended, a plan changed, the 30 s progress quantum moved).
   */
  function observe(rec) {
    if (!rec || typeof rec !== "object") return null;
    const at = Number.isFinite(rec.at) ? rec.at : now();
    if (rec.type === "child") {
      // processed FIRST and by the PARENT: the child must be known before any of its own records arrive
      const jobId = index.get(rec.parentSessionId);
      const live = jobId ? jobs.get(jobId) : null;
      if (!live || typeof rec.childSessionId !== "string" || !rec.childSessionId) return null;
      live.sessions.add(rec.childSessionId);
      index.set(rec.childSessionId, jobId);
      touch(live, at);
      return { jobId, notify: true };
    }
    const jobId = index.get(rec.sessionId);
    const live = jobId ? jobs.get(jobId) : null;
    if (!live) return null;
    const quantum = touch(live, at);
    const out = { jobId, notify: quantum };
    switch (rec.type) {
      case "content":
        bucket(live, at);
        break;
      case "toolStarted":
        if (typeof rec.callID === "string" && rec.callID && !live.ended.has(rec.callID)) {
          live.tools.set(rec.callID, {
            sessionId: rec.sessionId,
            name: String(rec.name ?? ""),
            target: String(rec.target ?? ""),
            startedAt: at,
            timeoutMs: Number.isFinite(rec.timeoutMs) && rec.timeoutMs > 0 ? rec.timeoutMs : null,
            lastOutputAt: null,
            observed: true,
          });
          out.notify = true;
        }
        break;
      case "toolOutput": {
        const tool = live.tools.get(rec.callID);
        if (tool && rec.bytes > 0) tool.lastOutputAt = at;
        break;
      }
      case "toolEnded":
        if (live.tools.delete(rec.callID)) out.notify = true;
        live.ended.add(rec.callID);
        bound(live.ended, ENDED_MAX);
        break;
      case "todos":
        if (rec.sessionId === live.root && Array.isArray(rec.items)) {
          live.todos = rec.items;
          out.todos = rec.items;
          out.notify = true;
        }
        break;
      case "step": {
        if (live.owner !== "manta") break;
        if (typeof rec.eventId === "string" && rec.eventId) {
          if (live.usageSeen.has(rec.eventId)) break;
          live.usageSeen.add(rec.eventId);
          bound(live.usageSeen, USAGE_SEEN_MAX);
        }
        const t = rec.tokens ?? {};
        const n = (v) => (Number.isFinite(v) ? v : 0);
        live.usageDelta.tokens += n(t.input) + n(t.output) + n(t.reasoning) + n(t.cacheRead) + n(t.cacheWrite);
        if (Number.isFinite(rec.cost)) live.usageDelta.costUsd = (live.usageDelta.costUsd ?? 0) + rec.cost;
        else live.usageDelta.partial = true;
        break;
      }
      default:
        break;
    }
    return out;
  }

  function allowanceEnd(t) {
    if (t.timeoutMs != null) return t.startedAt + t.timeoutMs + TOOL_TIMEOUT_GRACE_MS;
    if (t.observed) return (t.lastOutputAt ?? t.startedAt) + TOOL_SILENCE_MS;
    return Infinity;
  }

  /** The A2 stall rule. Fails open: a job whose live state was never rebuilt is never judged. */
  function judgeStall(jobId, nowMs = now()) {
    const live = jobs.get(jobId);
    if (!live || live.reconstructedAt == null) return { stalled: false, reason: "unreconstructed" };
    if (nowMs - live.lastProgressAt <= STALL_WINDOW_MS) return { stalled: false, reason: "recent" };
    let expired = null;
    for (const t of live.tools.values()) {
      if (nowMs <= allowanceEnd(t)) return { stalled: false, reason: "tool" };
      if (!expired || t.startedAt < expired.startedAt) expired = t;
    }
    return {
      stalled: true,
      lastProgressAt: live.lastProgressAt,
      tool: expired ? { name: expired.name, target: expired.target, ranPastTimeout: expired.timeoutMs != null } : null,
    };
  }

  /**
   * Merge a reconstruction read (descendant tree + tools found running). The tap always wins over the snapshot:
   * a tool it saw end is never resurrected, and a result read for a `live` that was since recreated is discarded.
   * @returns {boolean} applied
   */
  function applyReconstruction(jobId, gen, { nodes = [], running = [] } = {}) {
    const live = jobs.get(jobId);
    if (!live || live.generation !== gen) return false;
    for (const n of nodes) {
      if (!n?.id) continue;
      live.sessions.add(n.id);
      index.set(n.id, jobId);
    }
    for (const t of running) {
      if (!t?.callID || live.tools.has(t.callID) || live.ended.has(t.callID)) continue;
      live.tools.set(t.callID, {
        sessionId: t.sessionId,
        name: String(t.name ?? ""),
        target: String(t.target ?? ""),
        startedAt: Number.isFinite(t.startedAt) ? t.startedAt : now(),
        timeoutMs: Number.isFinite(t.timeoutMs) && t.timeoutMs > 0 ? t.timeoutMs : null,
        lastOutputAt: null,
        observed: false,
      });
    }
    live.reconstructedAt = now();
    return true;
  }

  function snapshot(jobId) {
    const live = jobs.get(jobId);
    if (!live) return null;
    let longest = null;
    for (const t of live.tools.values()) if (!longest || t.startedAt < longest.startedAt) longest = t;
    return {
      lastProgressAt: live.lastProgressAt,
      tool: longest ? { tool: longest.name, target: longest.target, startedAt: longest.startedAt } : null,
      usageDelta: { ...live.usageDelta },
      todos: live.todos,
    };
  }

  /** The usage seen since the last take (and reset); null when there is nothing to fold. */
  function takeUsageDelta(jobId) {
    const live = jobs.get(jobId);
    if (!live) return null;
    const d = live.usageDelta;
    if (d.tokens === 0 && d.costUsd == null && !d.partial) return null;
    live.usageDelta = { tokens: 0, costUsd: null, partial: false };
    return d;
  }

  /** What the evidence log records about the segment, read at the moment of the decision. */
  function evidence(jobId, nowMs = now()) {
    const live = jobs.get(jobId);
    if (!live) return null;
    const minKey = Math.floor(nowMs / 60_000) - CONTENT_WINDOW_MIN;
    let content = 0;
    for (const [k, c] of live.buckets) if (k >= minKey) content += c;
    return {
      lastProgressAt: live.lastProgressAt,
      contentRecordsLast15m: content,
      toolsAtEnd: [...live.tools.values()].map((t) => ({ name: t.name, runningForMs: Math.max(0, nowMs - t.startedAt), timeoutMs: t.timeoutMs })),
    };
  }

  return {
    ensure,
    rootChanged(job) {
      drop(job.id);
      return ensure(job);
    },
    drop,
    /** Drop and recreate every running job's live state (an opencode stream reconnect). */
    resetAll(running) {
      for (const id of [...jobs.keys()]) drop(id);
      for (const j of running ?? []) ensure(j);
    },
    /** Align with the store: a live entry for every running job, none for anything else. */
    syncRoots(list) {
      const running = new Set();
      for (const j of Array.isArray(list) ? list : []) {
        if (j?.status === "running" && j.childSessionID && ensure(j)) running.add(j.id);
      }
      for (const id of [...jobs.keys()]) if (!running.has(id)) drop(id);
    },
    observe,
    judgeStall,
    applyReconstruction,
    snapshot,
    takeUsageDelta,
    evidence,
    get: (jobId) => jobs.get(jobId) ?? null,
    jobIdOf: (sessionId) => index.get(sessionId) ?? null,
    /** A running, Manta-owned, `delegate`-launched job's own session or one below it (the A5 backstop's question). */
    ownsSession(sessionId) {
      const jobId = index.get(sessionId);
      const live = jobId ? jobs.get(jobId) : null;
      return !!live && live.owner === "manta" && live.delegateLaunch;
    },
    queueRejection(entry) {
      if (!entry?.requestId || !entry.sessionId) return;
      rejections.delete(entry.requestId);
      rejections.set(entry.requestId, { kind: entry.kind, requestId: entry.requestId, sessionId: entry.sessionId });
      while (rejections.size > REJECTIONS_MAX) rejections.delete(rejections.keys().next().value);
    },
    pendingRejections: () => [...rejections.values()],
    dropRejection: (requestId) => rejections.delete(requestId),
    size: () => jobs.size,
  };
}
