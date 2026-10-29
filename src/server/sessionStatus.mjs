// sessionStatus.mjs — per-window status and background-job nesting, decided on the box (WS11 D7 / audit S13, S14).
//
// What a session row shows (running dot, "N subagents", attention, nesting under its parent) used to be derived on
// each client from whatever it happened to hold (an open chat's transcript, a jobs poll, a children map). It is now
// one read: `windows[].job` on the session list, and one `windowStatus` stream frame per session.
//
// Sources are AUTHORITATIVE ONLY: each session's own execution state (the interpreter's `running` / `turnComplete`
// frames for ANY session id, and the connect-time running set), parent edges (`childSession` frames + delegate
// records + opencode's own session records) and delegate jobs. A relationship is NEVER inferred from tool status, so
// a task tool that completed after launching background work leaves `subagents` / `busy` up while its child runs.
//
// `createSessionStatus` is dependency-injected (no I/O of its own); the pure derivations are exported for tests.

// ----------------------------------------------------------------------------------------------------------------
// Pure: nesting (moved verbatim from the desktop's computeJobNesting)

/**
 * Background-job nesting for one project. A job's child window (the window whose opencodeSessionId ===
 * job.childSessionID) nests under its parent window (job.displayParentID ?? job.parentSessionID) whenever both
 * windows exist. Rows whose parent is itself nested are lifted to the nearest top-level ancestor (cycle-safe: a cycle
 * leaves its members top-level).
 * @returns {{ hidden: Set<number>, children: Map<number, number[]> }}
 */
export function computeJobNesting(project, jobs) {
  const hidden = new Set();
  const children = new Map();
  const byOpencodeId = new Map();
  for (const w of project.windows ?? []) {
    if (w.opencodeSessionId) byOpencodeId.set(w.opencodeSessionId, w);
  }
  const parentOf = new Map();
  for (const job of Object.values(jobs ?? {})) {
    if (!job.childSessionID || job.supersededBy) continue;
    const childWin = byOpencodeId.get(job.childSessionID);
    if (!childWin) continue;
    const nestUnder = job.displayParentID ?? job.parentSessionID;
    const parentWin = nestUnder ? byOpencodeId.get(nestUnder) : undefined;
    if (!parentWin || parentWin.index === childWin.index) continue;
    parentOf.set(childWin.index, parentWin.index);
  }
  for (const [child] of parentOf) {
    const seen = new Set([child]);
    let top = parentOf.get(child);
    while (parentOf.has(top) && !seen.has(top)) {
      seen.add(top);
      top = parentOf.get(top);
    }
    if (seen.has(top)) continue;
    hidden.add(child);
    const arr = children.get(top) ?? [];
    arr.push(child);
    children.set(top, arr);
  }
  for (const arr of children.values()) arr.sort((a, b) => a - b);
  return { hidden, children };
}

/**
 * The session list with each window's `job`: `{ id, status, parentWindowIndex }` for a window that IS a background
 * job's child (`parentWindowIndex` = the top-level window it nests under, or null when it stays top-level), else
 * null. `jobs` is the delegate records (array or object).
 */
export function annotateJobs(projects, jobs) {
  const list = (Array.isArray(jobs) ? jobs : Object.values(jobs ?? {})).filter((j) => j && j.childSessionID && !j.supersededBy);
  const byChild = new Map(list.map((j) => [j.childSessionID, j]));
  const record = Object.fromEntries(list.map((j) => [j.id, j]));
  return (projects ?? []).map((p) => {
    const nesting = computeJobNesting(p, record);
    const parentOfChild = new Map();
    for (const [parent, kids] of nesting.children) for (const k of kids) parentOfChild.set(k, parent);
    return {
      ...p,
      windows: (p.windows ?? []).map((w) => {
        const job = w.opencodeSessionId ? byChild.get(w.opencodeSessionId) : undefined;
        return {
          ...w,
          job: job ? { id: job.id, status: job.status, parentWindowIndex: parentOfChild.get(w.index) ?? null } : null,
        };
      }),
    };
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Pure: busy beneath (moved verbatim from the desktop's sessionsWithActiveWork)

/**
 * Which sessions have work in flight ANYWHERE beneath them — their own turn, a subagent child (inline or
 * backgrounded, any depth), or a background job they started. Returns every running session plus all of its
 * ancestors. Cycle-safe.
 * @param {Iterable<string>} running  session ids currently running a turn (incl. windowless ones)
 * @param {Record<string,string>} parents  child session id → parent session id
 * @param {Record<string,object>|object[]} jobs  background-job records; a `running` job counts as work in its child
 *   session AND (via displayParentID ?? parentSessionID) its parent
 */
export function sessionsWithActiveWork(running, parents, jobs) {
  const links = new Map(Object.entries(parents ?? {}));
  const seeds = [...running];
  for (const job of Array.isArray(jobs) ? jobs : Object.values(jobs ?? {})) {
    if (job.status !== "running" || job.supersededBy) continue;
    if (job.childSessionID) {
      seeds.push(job.childSessionID);
      if (job.displayParentID) {
        links.set(job.childSessionID, job.displayParentID);
      } else if (job.parentSessionID && !links.has(job.childSessionID)) {
        links.set(job.childSessionID, job.parentSessionID);
      }
    } else if (job.parentSessionID) {
      seeds.push(job.parentSessionID);
    }
  }
  const out = new Set();
  for (const seed of seeds) {
    let cur = seed;
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = links.get(cur);
    }
  }
  return out;
}

/**
 * One session's `windowStatus` payload from the three maps. Pure.
 * @param {{ running: Set<string>, parentOf: Map<string,string>, jobs: object[], own: Map<string,{since?: number|null, attention?: string|null}>,
 *           stopped: Set<string>, activeWork?: Set<string>, childCounts?: Map<string, number> }} m  `activeWork` / `childCounts` may be passed to avoid recomputing them per session
 */
export function runningChildCounts(m) {
  // DIRECT children (by the parent edges, and by delegate records' display parent) whose OWN session is running.
  const links = new Map(m.parentOf);
  for (const job of m.jobs ?? []) {
    if (!job.childSessionID || job.supersededBy) continue;
    const via = job.displayParentID ?? job.parentSessionID;
    if (via) links.set(job.childSessionID, via);
  }
  const counts = new Map();
  for (const [child, parent] of links) if (m.running.has(child)) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  return counts;
}

export function deriveWindowStatus(m, sessionId) {
  const activeWork = m.activeWork ?? sessionsWithActiveWork(m.running, Object.fromEntries(m.parentOf), m.jobs);
  const subagents = (m.childCounts ?? runningChildCounts(m)).get(sessionId) ?? 0;
  const own = m.own.get(sessionId);
  return {
    running: m.running.has(sessionId),
    busy: activeWork.has(sessionId),
    startedAt: m.running.has(sessionId) ? (own?.since ?? null) : null,
    attention: own?.attention === "question" || own?.attention === "permission" ? own.attention : null,
    subagents,
    stopped: m.stopped.has(sessionId),
  };
}

const nestingSignature = (projects) =>
  (projects ?? [])
    .map((p) => `${p.tmuxSession}:${(p.windows ?? []).filter((w) => w.job).map((w) => `${w.index}=${w.job.id}/${w.job.status}/${w.job.parentWindowIndex ?? "-"}`).join(",")}`)
    .join("|");

const jobsSignature = (list) =>
  (list ?? []).map((j) => `${j.id}:${j.status}:${j.childSessionID ?? ""}:${j.supersededBy ?? ""}:${j.displayParentID ?? ""}`).sort().join("|");

export const DEFAULT_STATUS = Object.freeze({ running: false, busy: false, startedAt: null, attention: null, subagents: 0, stopped: false });
const MAX_EDGES = 5000;
const MAX_DEPTH = 32;
const RETRY_MS = [1000, 2000, 5000, 10000];

/**
 * @param {object} d
 * @param {(evt: object) => void} d.publish  the bus's publish
 * @param {() => Iterable<string>} d.windowedSessionIds  opencode session ids that have a tmux window right now
 * @param {() => Promise<object[]>} d.loadJobs  the delegate records
 * @param {() => Promise<Iterable<string>>} [d.loadStopped]  conversation ids stopped by a usage limit
 * @param {() => Promise<string[]>} d.listActiveSessionIds  oc.listActiveSessionIds
 * @param {(id: string) => number|null|undefined} [d.runningSince]  the interpreter's start time of a running turn
 * @param {(id: string) => Promise<{status:"ok", parentID:string|null}|{status:"not-found"}|{status:"error"}>} d.getSessionParent
 * @param {() => unknown} [d.onJobsChanged]  a job record changed (the session list's `job` fields must be re-read)
 * @param {(fn: () => void) => void} [d.schedule]  coalescing tick (default: setTimeout 0)
 * @param {(fn: () => void, ms: number) => unknown} [d.setTimer]  hydration retry timer
 */
export function createSessionStatus(d) {
  const schedule = d.schedule ?? ((fn) => setTimeout(fn, 0));
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)?.unref?.());
  const running = new Set();
  const own = new Map(); // sid -> { since, attention }
  const parentOf = new Map(); // child -> parent (insertion order = LRU order for eviction)
  const rootIds = new Set(); // sessions an authoritative read said have NO parent
  let jobs = [];
  let stopped = new Set();
  const lastEmitted = new Map(); // sid -> JSON of the last payload sent
  let tickScheduled = false;
  let attempt = 0;
  let retryPending = false;
  let hydrating = null;
  // Running edges seen on live frames WHILE a hydration read is in flight: the (older) read must not wipe them.
  let liveDuringHydration = null;
  let nestingSig = null;
  let nestingPending = false;
  let pendingJobs = Promise.resolve();

  const ownState = (sid) => {
    if (!own.has(sid)) own.set(sid, { since: null, attention: null });
    return own.get(sid);
  };

  function touchEdge(child, parent) {
    parentOf.delete(child); // re-insert → most recent
    parentOf.set(child, parent);
    rootIds.delete(child);
  }

  function evictIfNeeded() {
    if (parentOf.size <= MAX_EDGES) return;
    const keep = new Set(running);
    for (const sid of d.windowedSessionIds()) keep.add(sid);
    for (const seed of [...keep]) {
      let cur = parentOf.get(seed);
      let guard = 0;
      while (cur && !keep.has(cur) && guard++ < MAX_DEPTH) {
        keep.add(cur);
        cur = parentOf.get(cur);
      }
    }
    for (const child of [...parentOf.keys()]) {
      if (parentOf.size <= MAX_EDGES) break;
      if (!keep.has(child)) parentOf.delete(child);
    }
  }

  function dirty() {
    if (tickScheduled) return;
    tickScheduled = true;
    schedule(() => {
      tickScheduled = false;
      flush();
    });
  }

  function currentMaps() {
    return { running, parentOf, jobs, own, stopped };
  }

  function allPayloads() {
    const maps = currentMaps();
    const activeWork = sessionsWithActiveWork(running, Object.fromEntries(parentOf), jobs);
    // Once per flush, not once per windowed session (O(windows × edges) otherwise).
    const childCounts = runningChildCounts(maps);
    const out = new Map();
    for (const sid of d.windowedSessionIds()) out.set(sid, deriveWindowStatus({ ...maps, activeWork, childCounts }, sid));
    return out;
  }

  /** Emit one `windowStatus` frame per windowed session whose payload CHANGED (ancestors included). */
  function flush() {
    const next = allPayloads();
    for (const [sid, payload] of next) {
      const json = JSON.stringify(payload);
      if (lastEmitted.get(sid) === json) continue;
      lastEmitted.set(sid, json);
      d.publish({ kind: "stream", sub: "windowStatus", sessionId: sid, payload });
    }
    for (const sid of [...lastEmitted.keys()]) if (!next.has(sid)) lastEmitted.delete(sid);
  }

  async function refreshJobs() {
    try {
      jobs = (await d.loadJobs()) ?? [];
    } catch {
      return false;
    }
    return true;
  }

  async function refreshStopped() {
    if (!d.loadStopped) return;
    try {
      stopped = new Set(await d.loadStopped());
    } catch {
      /* keep the last known set */
    }
  }

  function observe(evt) {
    if (!evt || typeof evt !== "object") return;
    if (evt.kind === "stream") {
      const sid = evt.sessionId;
      const p = evt.payload;
      if ((evt.sub === "running" || evt.sub === "turnComplete") && sid) {
        const on = p?.running === true;
        if (on) running.add(sid);
        else running.delete(sid);
        ownState(sid).since = on ? (p?.since ?? null) : null;
        liveDuringHydration?.set(sid, { running: on, since: ownState(sid).since });
        dirty();
      } else if (evt.sub === "attention" && sid) {
        ownState(sid).attention = p?.kind ?? null;
        dirty();
      } else if (evt.sub === "childSession" && typeof p?.childSessionId === "string" && typeof p?.parentSessionId === "string") {
        if (p.childSessionId !== p.parentSessionId) touchEdge(p.childSessionId, p.parentSessionId);
        evictIfNeeded();
        dirty();
      }
      return;
    }
    if (evt.kind === "runningSet" && Array.isArray(evt.payload?.sessions)) {
      running.clear();
      for (const r of evt.payload.sessions) {
        if (!r?.sessionId) continue;
        running.add(r.sessionId);
        ownState(r.sessionId).since = r.since ?? null;
      }
      dirty();
      return;
    }
    if (evt.kind === "delegate.updated") {
      // Activity updates fire every ~10 s per job: only a change in WHICH jobs exist / their status / their windows
      // re-reads the session list.
      const before = jobsSignature(jobs);
      pendingJobs = refreshJobs()
        .then(async () => {
          dirty();
          if (jobsSignature(jobs) !== before) await d.onJobsChanged?.();
        })
        .catch(() => {});
      return;
    }
    if (evt.kind === "usage-stopped.updated") {
      void refreshStopped().then(dirty);
      return;
    }
    if (evt.kind === "sync" && evt.payload?.changed?.projects) {
      dirty();
      if (nestingPending) {
        nestingPending = false;
        d.publish({ kind: "sessions.nesting", payload: {} });
      }
    }
  }

  /** Walk one session's ancestry from opencode's own records. Returns false when any read could not be answered. */
  async function resolveChain(id, visited) {
    let cur = id;
    let complete = true;
    for (let depth = 0; depth < MAX_DEPTH && cur; depth++) {
      if (visited.has(cur)) break;
      visited.add(cur);
      const r = await d.getSessionParent(cur);
      if (r.status === "error") return false;
      if (r.status === "not-found") {
        parentOf.delete(cur); // the session was deleted: that edge is gone
        break;
      }
      if (!r.parentID) {
        parentOf.delete(cur);
        rootIds.add(cur);
        break;
      }
      touchEdge(cur, r.parentID);
      // Stop once the parent is already known (its own chain was resolved earlier).
      if (rootIds.has(r.parentID) || parentOf.has(r.parentID)) break;
      cur = r.parentID;
    }
    return complete;
  }

  /**
   * Rebuild what the events alone cannot say after a start or an opencode reconnect: which sessions are running
   * (a complete set — replaced, not merged) and the ancestry of every active session and every running job's child.
   * A read that fails keeps what is held, marks the hydration incomplete and retries on the 1/2/5/10 s backoff.
   */
  function hydrate() {
    if (hydrating) return hydrating;
    hydrating = (async () => {
      let complete = true;
      const live = (liveDuringHydration = new Map());
      rootIds.clear(); // re-learned by the walk below; keeps the set bounded
      try {
        const ids = await d.listActiveSessionIds();
        running.clear();
        for (const id of ids) {
          running.add(id);
          // The interpreter knows when a turn started even if no frame has been seen since this process began.
          const since = d.runningSince?.(id);
          if (since != null && ownState(id).since == null) ownState(id).since = since;
        }
        // A turn that started or ended while the read was in flight is newer than the list.
        for (const [id, v] of live) {
          if (v.running) running.add(id);
          else running.delete(id);
          ownState(id).since = v.running ? (v.since ?? ownState(id).since) : null;
        }
      } catch {
        complete = false;
      }
      if (!(await refreshJobs())) complete = false;
      await refreshStopped();
      const seeds = new Set(running);
      for (const j of jobs) if (j.status === "running" && j.childSessionID && !j.supersededBy) seeds.add(j.childSessionID);
      const visited = new Set();
      for (const id of seeds) {
        if (!(await resolveChain(id, visited))) complete = false;
      }
      evictIfNeeded();
      dirty();
      if (complete) {
        attempt = 0;
      } else {
        const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
        attempt += 1;
        retryPending = true;
        setTimer(() => {
          retryPending = false;
          void hydrate();
        }, delay);
      }
      return complete;
    })().finally(() => {
      hydrating = null;
      liveDuringHydration = null;
    });
    return hydrating;
  }

  return {
    observe,
    hydrate,
    flush,
    /** The connect snapshot: the CURRENT payload of every windowed session (a full replacement for the client). */
    snapshotFrames() {
      const out = [];
      for (const [sessionId, payload] of allPayloads()) out.push({ kind: "stream", sub: "windowStatus", sessionId, payload });
      return out;
    },
    /** `sessions:window-status`: `{ [sessionId]: payload }` for every windowed session (full-replacement semantics). */
    windowStatusMap() {
      return Object.fromEntries(allPayloads());
    },
    /** The session list with each window's `job`. When the job NESTING it carries changes (a job window appears, nests,
     *  finishes or is superseded) a `sessions.nesting` frame follows the `sync` delta that carries the new list — the one
     *  signal a client that does not follow `sync` deltas refreshes on (activity-only `delegate.updated` frames never
     *  do), published AFTER the list is readable so that refresh sees it. */
    annotateProjects(projects) {
      const out = annotateJobs(projects, jobs);
      const sig = nestingSignature(out);
      if (nestingSig !== null && sig !== nestingSig) nestingPending = true;
      nestingSig = sig;
      return out;
    },
    refreshJobs,
    /** Resolves once a job change in flight has reached the session list — so `tmux:list` read right after a
     *  `delegate.updated` frame already carries the new `job` fields. */
    settled: () => pendingJobs,
    // Test seams.
    _state: { running, parentOf, rootIds, own, get jobs() { return jobs; }, set jobs(v) { jobs = v; }, get stopped() { return stopped; }, set stopped(v) { stopped = new Set(v); }, get retryScheduled() { return retryPending; } },
  };
}
