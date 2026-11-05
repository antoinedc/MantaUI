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
//
// Nesting (session-tree stage (a), docs/superpowers/specs/2026-11-05-session-tree.md): `windows[].job.parentWindowIndex`
// is a projection of the SESSION GRAPH, not a lookup of the record's parent among windows. Nodes are conversations (a
// handoff chain is one node); edges are (1) a Manta-owned job record's parent, (2) opencode's own `parentID`, (4) a
// cached transcript-inferred driver for a root nobody opened. A window's root is its nearest windowed ancestor's root,
// walking through windowless sessions, so a subagent's window coming and going never moves the rows below it.

import { completionOwnerOf, DRIVER_WINDOW_MS } from "./delegate.mjs";

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
const INFER_MIN_INTERVAL_MS = 60_000; // per root, between transcript lookups
const UNKNOWN_READ_MIN_INTERVAL_MS = 5_000; // per session, between background parent reads
const MAX_INFER_STATE = 2000;
const CYCLE = Symbol("cycle");

const isTerminalStatus = (j) => j?.status === "done" || j?.status === "failed" || j?.status === "stopped";
/** A job whose child still has a place in the tree: running/paused, or finished with its result not yet delivered. */
const isLiveJob = (j) => !isTerminalStatus(j) || j?.completionDelivery === "pending";
const boundMap = (m, cap) => {
  while (m.size > cap) m.delete(m.keys().next().value);
};

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
 * @param {(sid: string) => string[]} [d.chainOf]  handoff replacement chain of a session (all members; default: just itself)
 * @param {(sid: string) => string|null} [d.successorOf]  the session that replaced `sid`, one step
 * @param {(args: {sessionIds: string[], targets: string[], sinceMs: number}) => Promise<{hits: {target: string, sessionId: string, t: number}[], complete: boolean}|null>} [d.findSessionReferences]
 *   which windowed session's transcript named each target (the inferred edge; absent → no inference)
 * @param {(sid: string) => Promise<boolean>} [d.isCtoConversationSession]  the CTO conversation is never nested by inference
 * @param {(sid: string) => Promise<boolean>} [d.isInternalSession]  neither is a Manta-internal session
 * @param {() => number} [d.now]
 * @param {number} [d.inferMinIntervalMs]
 */
export function createSessionStatus(d) {
  const schedule = d.schedule ?? ((fn) => setTimeout(fn, 0));
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)?.unref?.());
  const running = new Set();
  const own = new Map(); // sid -> { since, attention }
  const parentOf = new Map(); // child -> parent (insertion order = LRU order for eviction)
  const rootIds = new Set(); // sessions an authoritative read said have NO parent
  const missing = new Set(); // sessions an authoritative read said no longer exist (known, not unknown)
  const now = d.now ?? (() => Date.now());
  // Rule 4 (inferred edge), all keyed by the conversation key (a handoff chain's OLDEST member, stable across commits).
  const inferred = new Map(); // child conv key -> parent conv key; decided once, cached for the process, never revised
  const eligibility = new Map(); // conv key -> boolean, decided once: may this root take an inferred parent?
  const inferLookedUpAt = new Map(); // conv key -> when its last transcript lookup started
  const unknownReadAt = new Map(); // session id -> when a background parent read last started
  let placement = new Map(); // `${project}\0${sid}` -> last confidently projected parentWindowIndex
  let lastProjects = null; // the last session list handed to annotateProjects (un-annotated)
  let hydratedOnce = false;
  let recomputePending = false;
  let inferRunning = false;
  let resolveRunning = false;
  let background = Promise.resolve();
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

  // ---- the session graph --------------------------------------------------------------------------------------
  //
  // Built per pass from `projects` (which windows exist now) + the held edges. Nothing here does I/O.

  /** Which job records make a session an annotated row, and which are adopted (opencode-owned). */
  function recordIndex() {
    const annotated = new Set(); // child session ids of non-superseded records (today's set of `job` windows)
    const adopted = new Set(); // ... whose completion owner is opencode (observed / subagent)
    const ruleOne = new Map(); // child -> parent for Manta-owned records (the caller)
    const liveChildren = new Set();
    for (const j of jobs) {
      if (!j?.childSessionID || j.supersededBy) continue;
      annotated.add(j.childSessionID);
      if (isLiveJob(j)) liveChildren.add(j.childSessionID);
      if (completionOwnerOf(j) === "opencode") adopted.add(j.childSessionID);
      else if (j.parentSessionID && j.parentSessionID !== j.childSessionID) ruleOne.set(j.childSessionID, j.parentSessionID);
    }
    return { annotated, adopted, ruleOne, liveChildren };
  }

  function buildGraph(projects) {
    const rec = recordIndex();
    const windowsBySid = new Map(); // sid -> [{ project, index, owner, sid }]
    for (const p of projects ?? []) {
      for (const w of p.windows ?? []) {
        if (!w?.opencodeSessionId) continue;
        const list = windowsBySid.get(w.opencodeSessionId) ?? [];
        // A window nothing stamped is the user's (tmux.resolveOwner maps absent → "user").
        list.push({ project: p.tmuxSession, index: w.index, owner: w.owner ?? "user", sid: w.opencodeSessionId });
        windowsBySid.set(w.opencodeSessionId, list);
      }
    }
    const byIndex = (a, b) => a.index - b.index || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0);

    // Conversation nodes: a handoff chain is one node.
    const chains = new Map(); // sid -> { members, oldest, canon }
    const chainInfo = (sid) => {
      const hit = chains.get(sid);
      if (hit) return hit;
      let members;
      try {
        members = d.chainOf?.(sid);
      } catch {
        members = null;
      }
      if (!Array.isArray(members) || !members.includes(sid)) members = [sid];
      const hasPredecessor = new Set();
      for (const m of members) {
        const next = d.successorOf?.(m);
        if (typeof next === "string" && next !== m && members.includes(next)) hasPredecessor.add(next);
      }
      const oldest = members.find((m) => !hasPredecessor.has(m)) ?? [...members].sort()[0];
      const windowed = members.flatMap((m) => windowsBySid.get(m) ?? []).sort(byIndex);
      let canon;
      if (windowed.length > 0) {
        canon = windowed[0].sid;
      } else {
        canon = oldest;
        const seen = new Set([oldest]);
        for (;;) {
          const next = d.successorOf?.(canon);
          if (typeof next !== "string" || !next || seen.has(next)) break;
          seen.add(next);
          canon = next;
        }
      }
      const info = { members, oldest, canon };
      for (const m of members) chains.set(m, info);
      return info;
    };
    const canon = (sid) => chainInfo(sid).canon;
    const keyOf = (sid) => chainInfo(sid).oldest;

    const windowsByNode = new Map(); // canonical node -> windows of any member
    for (const [sid, list] of windowsBySid) {
      const node = canon(sid);
      windowsByNode.set(node, [...(windowsByNode.get(node) ?? []), ...list]);
    }

    /** child node -> parent node: rule 1 (Manta-owned record), rule 2 (opencode's parentID), rule 4 (cached inference). */
    function edgeParent(node) {
      const { members, oldest } = chainInfo(node);
      for (const m of members) {
        const p = rec.ruleOne.get(m);
        if (p && canon(p) !== node) return canon(p);
      }
      for (const m of members) {
        const p = parentOf.get(m);
        if (p && canon(p) !== node) return canon(p);
      }
      const inf = inferred.get(oldest);
      if (inf && canon(inf) !== node) return canon(inf);
      return null;
    }
    const isKnownRoot = (node) => chainInfo(node).members.some((m) => rootIds.has(m) || missing.has(m));

    /** The ancestors above `start` (nodes), and how the walk ended: a known root, a cycle, or a node nobody has read. */
    function walkUp(start) {
      const path = [];
      const seen = new Set([start]);
      let cur = start;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const next = edgeParent(cur);
        if (next) {
          if (seen.has(next)) return { path, end: "cycle", at: cur };
          seen.add(next);
          path.push(next);
          cur = next;
          continue;
        }
        return { path, end: isKnownRoot(cur) ? "root" : "unknown", at: cur };
      }
      return { path, end: "root", at: cur };
    }

    /**
     * The window `w` (of `projectName`) nests under: the root of its nearest windowed ancestor, walking through
     * windowless sessions and lifting through ancestors that are themselves nested rows. `certain:false` when the
     * walk reached a session nobody has read yet (unknown is not root).
     */
    function projectWindow(projectName, w) {
      let certain = true;
      const unknown = [];
      const visited = new Set();
      const rootOf = (win) => {
        if (visited.has(win.index)) return CYCLE;
        visited.add(win.index);
        const walk = walkUp(canon(win.sid));
        for (const node of walk.path) {
          const wins = windowsByNode.get(node);
          if (!wins) continue;
          const here = wins.filter((x) => x.project === projectName && x.index !== win.index).sort(byIndex)[0];
          if (!here) return win.index; // windowed only in another project: this row is a top-level row here
          return rec.annotated.has(here.sid) ? rootOf(here) : here.index;
        }
        if (walk.end === "unknown") {
          certain = false;
          unknown.push(...chainInfo(walk.at).members);
        }
        return win.index;
      };
      const r = rootOf({ index: w.index, sid: w.opencodeSessionId });
      return { value: r === CYCLE || r === w.index ? null : r, certain, unknown };
    }

    return { rec, windowsBySid, windowsByNode, canon, keyOf, chainInfo, edgeParent, walkUp, projectWindow };
  }

  /** The session list with each job window's `parentWindowIndex` taken from the graph (today's output until hydrated). */
  function computeAnnotated(projects) {
    const base = annotateJobs(projects, jobs);
    if (!hydratedOnce) return { out: base, placement: placement, unknown: new Set(), graph: null };
    const graph = buildGraph(projects);
    const nextPlacement = new Map();
    const unknown = new Set();
    const out = base.map((p) => ({
      ...p,
      windows: p.windows.map((w) => {
        if (!w.job) return w;
        const r = graph.projectWindow(p.tmuxSession, w);
        const key = `${p.tmuxSession}\0${w.opencodeSessionId}`;
        let value;
        if (r.certain) {
          value = r.value;
        } else {
          for (const sid of r.unknown) unknown.add(sid);
          const last = placement.get(key);
          value = last !== undefined && (last === null || p.windows.some((x) => x.index === last)) ? last : w.job.parentWindowIndex;
        }
        nextPlacement.set(key, value);
        return value === w.job.parentWindowIndex ? w : { ...w, job: { ...w.job, parentWindowIndex: value } };
      }),
    }));
    return { out, placement: nextPlacement, unknown, graph };
  }

  /** Re-derive the projection and, only when it differs from the list last served, refresh the session list. */
  function recompute() {
    if (recomputePending || !d.onJobsChanged) return;
    recomputePending = true;
    Promise.resolve()
      .then(() => {
        recomputePending = false;
        if (!lastProjects) return undefined;
        const { out } = computeAnnotated(lastProjects);
        return nestingSignature(out) !== nestingSig ? d.onJobsChanged() : undefined;
      })
      .catch(() => {
        recomputePending = false;
      });
  }

  /** Run `fn` after whatever background work is queued; failures never escape. */
  function queueBackground(fn) {
    background = background.then(fn).catch(() => {});
    return background;
  }

  /** Read the ancestry of sessions the projection could not place because nobody had read them. */
  function resolveUnknown(unknown) {
    if (resolveRunning || hydrating || !hydratedOnce) return;
    const t = now();
    const want = [];
    for (const sid of unknown) {
      const last = unknownReadAt.get(sid);
      if (last != null && t - last < UNKNOWN_READ_MIN_INTERVAL_MS) continue;
      unknownReadAt.set(sid, t);
      want.push(sid);
    }
    boundMap(unknownReadAt, 1000);
    if (want.length === 0) return;
    resolveRunning = true;
    void queueBackground(async () => {
      try {
        const visited = new Set();
        for (const sid of want) await resolveChain(sid, visited);
        evictIfNeeded();
      } finally {
        resolveRunning = false;
      }
      recompute();
    });
  }

  /**
   * Rule 4. For each graph root that is not user-opened, the windowed session of the same project whose transcript most
   * recently named the root OR a collapsed session between it and a row it holds (within DRIVER_WINDOW_MS). One lookup per
   * pass, one per root per minute; the answer, once found, is cached for good. An incomplete / failed lookup caches nothing.
   */
  function inferDrivers(projects, graph) {
    if (inferRunning || hydrating || !hydratedOnce || typeof d.findSessionReferences !== "function" || !graph) return;
    const t = now();
    const minGap = d.inferMinIntervalMs ?? INFER_MIN_INTERVAL_MS;
    const subjects = new Map(); // conv key -> { root, targets:Set, projects:Set, candidates:Set }
    for (const p of projects ?? []) {
      for (const w of p.windows ?? []) {
        const sid = w?.opencodeSessionId;
        if (!sid || !graph.rec.annotated.has(sid)) continue;
        const walk = graph.walkUp(graph.canon(sid));
        if (walk.end !== "root" || walk.path.some((n) => graph.windowsByNode.has(n))) continue; // placed by a windowed ancestor, or not certain
        const root = walk.at;
        const key = graph.keyOf(root);
        if (!eligibility.has(key)) {
          // Decided ONCE, when the root first needs an answer: a window the user opened (or nothing stamped) rules it out.
          eligibility.set(key, !(graph.windowsByNode.get(root) ?? []).some((x) => x.owner === "user"));
          boundMap(eligibility, MAX_INFER_STATE);
        }
        if (!eligibility.get(key)) continue;
        const last = inferLookedUpAt.get(key);
        if (last != null && t - last < minGap) continue;
        let s = subjects.get(key);
        if (!s) subjects.set(key, (s = { root, targets: new Set(), projects: new Set(), candidates: new Set() }));
        s.projects.add(p.tmuxSession);
        for (const m of graph.chainInfo(root).members) s.targets.add(m);
        for (const n of walk.path.slice(0, -1)) for (const m of graph.chainInfo(n).members) s.targets.add(m);
        // An adopted row is named by its driver directly (its own transcript mentions the subagent, not the root).
        if (graph.rec.adopted.has(sid)) s.targets.add(sid);
      }
    }
    if (subjects.size === 0) return;
    const live = new Set([...graph.rec.liveChildren].map((sid) => graph.canon(sid)));
    const candidatesFor = (s, g) => {
      const out = new Set();
      for (const p of projects ?? []) {
        if (!s.projects.has(p.tmuxSession)) continue;
        for (const w of p.windows ?? []) {
          const sid = w?.opencodeSessionId;
          if (!sid) continue;
          const node = g.canon(sid);
          if (node === s.root || live.has(node)) continue;
          const walk = g.walkUp(node);
          if (walk.end === "unknown" || walk.path.includes(s.root)) continue;
          out.add(sid);
        }
      }
      return out;
    };
    for (const [key, s] of subjects) {
      s.candidates = candidatesFor(s, graph);
      s.members = graph.chainInfo(s.root).members;
      if (s.candidates.size === 0) {
        subjects.delete(key);
        continue;
      }
      inferLookedUpAt.set(key, t);
    }
    boundMap(inferLookedUpAt, 500);
    if (subjects.size === 0) return;
    inferRunning = true;
    void queueBackground(async () => {
      let found = null;
      try {
        // Manta's own sessions (the CTO conversation, internal helpers) are never nested by transcript inference.
        // Decided once, like the user-opened rule; a check that cannot answer drops the root for this pass only.
        if (d.isCtoConversationSession || d.isInternalSession) {
          for (const [key, s] of [...subjects]) {
            let excluded = false;
            try {
              for (const m of s.members) {
                if ((await d.isCtoConversationSession?.(m)) || (await d.isInternalSession?.(m))) {
                  excluded = true;
                  break;
                }
              }
            } catch {
              subjects.delete(key); // fail closed, retried after the throttle window
              continue;
            }
            if (excluded) {
              eligibility.set(key, false);
              subjects.delete(key);
            }
          }
        }
        if (subjects.size === 0) return;
        const allTargets = new Set();
        const allCandidates = new Set();
        for (const s of subjects.values()) {
          for (const x of s.targets) allTargets.add(x);
          for (const x of s.candidates) allCandidates.add(x);
        }
        found = await d.findSessionReferences({ sessionIds: [...allCandidates], targets: [...allTargets], sinceMs: t - DRIVER_WINDOW_MS });
      } catch {
        found = null;
      } finally {
        inferRunning = false;
      }
      if (!found || !Array.isArray(found.hits) || found.complete === false || !lastProjects) return;
      const fresh = buildGraph(lastProjects); // state may have moved while the lookup ran
      let changed = false;
      for (const [key, s] of subjects) {
        if (inferred.has(key)) continue;
        const hits = found.hits
          .filter((h) => s.targets.has(h?.target) && s.candidates.has(h?.sessionId))
          .sort((a, b) => (b.t ?? 0) - (a.t ?? 0) || (a.sessionId < b.sessionId ? -1 : 1));
        for (const h of hits) {
          const node = fresh.canon(h.sessionId);
          const walk = fresh.walkUp(node);
          if (node === fresh.canon(s.root) || walk.end === "unknown" || walk.path.includes(fresh.canon(s.root))) continue;
          if (fresh.edgeParent(fresh.canon(s.root))) break; // an authoritative parent appeared meanwhile: nothing to infer
          inferred.set(key, fresh.keyOf(h.sessionId));
          boundMap(inferred, MAX_INFER_STATE);
          changed = true;
          break;
        }
      }
      if (changed) recompute();
    });
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
        const added = p.childSessionId !== p.parentSessionId && parentOf.get(p.childSessionId) !== p.parentSessionId;
        if (p.childSessionId !== p.parentSessionId) touchEdge(p.childSessionId, p.parentSessionId);
        evictIfNeeded();
        dirty();
        if (added) recompute();
      }
      return;
    }
    if (evt.kind === "handoff") {
      // A commit moves records and windows between members of one conversation: the node is the same, so nothing
      // should move — but verify, cheaply, rather than assume.
      if (evt.payload?.state === "committed") recompute();
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
        missing.add(cur);
        break;
      }
      if (!r.parentID) {
        parentOf.delete(cur);
        rootIds.add(cur);
        missing.delete(cur);
        break;
      }
      missing.delete(cur);
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
      missing.clear();
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
      // Candidates: the running set, every windowed session, every job child that still has a place in the tree.
      const seeds = new Set(running);
      for (const sid of d.windowedSessionIds()) seeds.add(sid);
      for (const j of jobs) if (j.childSessionID && !j.supersededBy && isLiveJob(j)) seeds.add(j.childSessionID);
      const visited = new Set();
      for (const id of seeds) {
        if (!(await resolveChain(id, visited))) complete = false;
      }
      evictIfNeeded();
      dirty();
      hydratedOnce = true; // reads that failed leave their sessions unplaced (last-known / today's), never roots
      recompute();
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
      lastProjects = projects;
      const res = computeAnnotated(projects);
      placement = res.placement;
      const sig = nestingSignature(res.out);
      if (nestingSig !== null && sig !== nestingSig) nestingPending = true;
      nestingSig = sig;
      if (res.graph) {
        resolveUnknown(res.unknown);
        inferDrivers(projects, res.graph);
      }
      return res.out;
    },
    /** Resolves when background work (parent reads, the inference lookup) queued so far has finished. */
    settleBackground: () => background,
    refreshJobs,
    /** Resolves once a job change in flight has reached the session list — so `tmux:list` read right after a
     *  `delegate.updated` frame already carries the new `job` fields. */
    settled: () => pendingJobs,
    // Test seams.
    _state: { running, parentOf, rootIds, missing, inferred, eligibility, get hydratedOnce() { return hydratedOnce; }, own, get jobs() { return jobs; }, set jobs(v) { jobs = v; }, get stopped() { return stopped; }, set stopped(v) { stopped = new Set(v); }, get retryScheduled() { return retryPending; } },
  };
}
