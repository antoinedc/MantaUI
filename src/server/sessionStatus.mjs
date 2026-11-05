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
//
// The session tree (stage (b), same spec §2/§3/§10): `Project.tree` is the rows the sidebar renders — every window
// exactly once, plus VIRTUAL rows for shown sessions that have no window (a running subagent, a job child, an idle
// ancestor that still holds shown descendants). Which sessions are shown, which project's tree they sit in and in
// which order is decided here and nowhere else; `windowStatus` frames cover every shown node with a session.
// Reads (a session's parent / title / directory, the inline-`task` classification) happen in background passes
// that call `recompute()`; `annotateProjects` itself stays synchronous.

import { completionOwnerOf, DRIVER_WINDOW_MS } from "./delegate.mjs";
import { isMarkedInternal } from "./internalSessionMarker.mjs";

/** A windowless session that just ended its turn stays a row this long (spec §2). */
export const LINGER_MS = 30_000;

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
 *   session AND (when the edges do not already name one) its `parentSessionID`. `displayParentID` is not read.
 */
export function sessionsWithActiveWork(running, parents, jobs) {
  const links = new Map(Object.entries(parents ?? {}));
  const seeds = [...running];
  for (const job of Array.isArray(jobs) ? jobs : Object.values(jobs ?? {})) {
    if (job.status !== "running" || job.supersededBy) continue;
    if (job.childSessionID) {
      seeds.push(job.childSessionID);
      if (job.parentSessionID && !links.has(job.childSessionID)) links.set(job.childSessionID, job.parentSessionID);
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
 * Descendants at ANY depth (by the parent edges, shown or collapsed) that are running or wait on a question /
 * permission, counted per ancestor: a job started by a collapsed subagent counts toward the root it is shown under.
 * A descendant counts once per ancestor; a cycle ends the walk. `displayParentID` is not read.
 * @param {{ running: Set<string>, parentOf: Map<string,string>, jobs?: object[], own?: Map<string,{attention?: string|null}>, pendingAsk?: Iterable<string> }} m
 */
export function runningChildCounts(m) {
  const links = new Map(m.parentOf);
  for (const job of m.jobs ?? []) {
    if (!job.childSessionID || job.supersededBy || !job.parentSessionID || job.parentSessionID === job.childSessionID) continue;
    if (!links.has(job.childSessionID) || completionOwnerOf(job) === "manta") links.set(job.childSessionID, job.parentSessionID);
  }
  const active = new Set(m.running);
  for (const [sid, st] of m.own ?? []) if (st?.attention === "question" || st?.attention === "permission") active.add(sid);
  for (const sid of m.pendingAsk ?? []) active.add(sid);
  const counts = new Map();
  for (const a of active) {
    const seen = new Set([a]);
    let cur = links.get(a);
    while (cur && !seen.has(cur)) {
      counts.set(cur, (counts.get(cur) ?? 0) + 1);
      seen.add(cur);
      cur = links.get(cur);
    }
  }
  return counts;
}

/**
 * One session's `windowStatus` payload from the maps. Pure.
 * @param {{ running: Set<string>, parentOf: Map<string,string>, jobs: object[], own: Map<string,{since?: number|null, attention?: string|null}>,
 *           stopped: Set<string>, pendingAsk?: Iterable<string>, activeWork?: Set<string>, childCounts?: Map<string, number> }} m  `activeWork` / `childCounts` may be passed to avoid recomputing them per session
 */
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

/** What a client renders: the old nesting AND the tree (structure, titles, job status). A change re-reads the list. */
const treeSignature = (projects) => `${nestingSignature(projects)}§${JSON.stringify((projects ?? []).map((p) => p.tree ?? null))}`;

const jobsSignature = (list) =>
  (list ?? [])
    .map((j) => `${j.id}:${j.status}:${j.childSessionID ?? ""}:${j.parentSessionID ?? ""}:${j.supersededBy ?? ""}:${j.tmuxSession ?? ""}:${j.origin ?? ""}:${j.completionDelivery ?? ""}:${j.launchState ?? ""}`)
    .sort()
    .join("|");

const trimSlashes = (p) => (typeof p === "string" && p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * The tmux project that owns a directory: an exact match on a project's cwd or a window's path wins; otherwise the most
 * specific project path that contains the directory; last, a window inside it. "/" owns nothing. (The same direction
 * delegate.mjs's `ownerByDirectory` matches; kept here so the tree needs nothing from delegate's internals.)
 */
export function ownerByDirectory(projects, directory) {
  const dir = trimSlashes(directory);
  if (typeof dir !== "string" || !dir.startsWith("/")) return null;
  let best = null;
  for (const p of Array.isArray(projects) ? projects : []) {
    const paths = [p.defaultCwd, ...(p.windows || []).map((w) => w?.paneCurrentPath)].map(trimSlashes);
    for (const pp of paths) {
      if (typeof pp !== "string" || !pp.startsWith("/") || pp === "/") continue;
      let score = 0;
      if (pp === dir) score = 1_000_000 + pp.length;
      else if (dir.startsWith(pp + "/")) score = pp.length;
      else if (pp.startsWith(dir + "/")) score = 1;
      if (score > 0 && (!best || score > best.score)) best = { score, tmuxSession: p.tmuxSession };
    }
  }
  return best ? best.tmuxSession : null;
}

/**
 * How a parent's assistant timeline records its `task` children: childId → "fg" (an inline foreground child: part of
 * the parent's turn, never a row) | "bg" (a background subagent). The FIRST block naming a child wins, exactly the
 * reconciler's rule (delegate.mjs `toolBlockFor` + the `background` test in `consider`).
 */
export function taskBlocksOf(assistantRecords) {
  const out = new Map();
  for (const rec of Array.isArray(assistantRecords) ? assistantRecords : []) {
    for (const block of Array.isArray(rec?.content) ? rec.content : []) {
      if (block?.type !== "tool") continue;
      const md = block.state?.metadata;
      const id = md?.sessionID ?? md?.sessionId;
      if (typeof id !== "string" || !id || out.has(id)) continue;
      out.set(id, block.state?.input?.background === true || md?.background === true ? "bg" : "fg");
    }
  }
  return out;
}

export const DEFAULT_STATUS = Object.freeze({ running: false, busy: false, startedAt: null, attention: null, subagents: 0, stopped: false });
const MAX_EDGES = 5000;
const MAX_DEPTH = 32;
const RETRY_MS = [1000, 2000, 5000, 10000];
const INFER_MIN_INTERVAL_MS = 60_000; // per root, between transcript lookups
const UNKNOWN_READ_MIN_INTERVAL_MS = 5_000; // per session, between background parent reads
const MAX_INFER_STATE = 2000;
const MAX_TREE_STATE = 5000;
const MAX_GATES_PER_PASS = 40; // background reads per pass; the rest wait for the next recompute
const GATE_RETRY_MS = [1000, 2000, 5000, 10000];
const NO_BLOCK_READS = 3; // reads of the parent's timeline that must all miss before a child is judged "not an inline task child"
const TIMELINE_CACHE_MS = 1500;
const INFO_REFRESH_MIN_MS = 10_000;
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
 * @param {(id: string) => Promise<{state:"found", session: object}|{state:"missing"}|{state:"unknown"}>} [d.readSession]
 *   one session record (parentID, title, directory, metadata). When given it REPLACES getSessionParent for every read, and
 *   the title / directory / internal marker are cached with the parent edge (the tree needs them for virtual rows)
 * @param {(id: string, opts: {type: string}) => Promise<object[]>} [d.listRawTimeline]  a session's raw timeline (the inline-`task`
 *   classification reads the PARENT's assistant records; absent → every parented windowless session is treated as inline)
 * @param {(sid: string) => boolean} [d.isHandoffSuccessor]  an uncommitted handoff successor is never a row
 * @param {(sid: string) => ({parent: string|null}|undefined)} [d.linkOf]  rule 3: the explicit link entry of a session
 *   (`undefined` = none; `{parent: null}` = a suppression: no explicit edge AND no inference for that child)
 * @param {() => Iterable<string>} [d.linkEndpoints]  every session a link names (hydration candidates)
 * @param {() => Iterable<string>} [d.pendingAskSessionIds]  sessions with a pending question / permission right now
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
  // ---- the tree's own state (all keyed by session id or conversation key; bounded) ----
  const info = new Map(); // sid -> { title, directory, internal } from the one session read per candidate
  const special = new Map(); // sid -> boolean: the CTO conversation or a provenance-internal session (decided once)
  const inlineState = new Map(); // sid -> { state: "inline"|"no"|"unsure", reads }: is it an inline foreground `task` child?
  const gateAt = new Map(); // sid -> when its last background gate evaluation started
  const gateAttempts = new Map(); // sid -> consecutive evaluations that could not conclude
  const timelineCache = new Map(); // parent sid -> { at, blocks } (the parent's `task` blocks)
  const infoRefreshAt = new Map(); // sid -> when a refresh read last started
  const lingerUntil = new Map(); // sid -> epoch ms until which an ended session stays a row
  const lingerTimers = new Set(); // sids with a pending linger timer
  const seqOfKey = new Map(); // conversation / window key -> process-monotonic order
  const winSeq = new Map(); // `${project}\0${index}\0${sid}` -> order the window was first seen (root project choice)
  let seqCounter = 0;
  const rootProject = new Map(); // conversation key -> the project its root row was decided to sit in (retained)
  let treeParents = new Map(); // `${project}\0${key}` -> last confidently placed parent key (or null)
  let lastLayout = null; // the last tree layout (placementOf reads it)
  let gateRunning = false;
  let gateRetryPending = false;
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
  let learning = null; // the sessions this hydration has (re)read so far
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

  /** A list holding just the windowed sessions, for a pass before the first session list has arrived. */
  function syntheticProjects() {
    const windows = [...d.windowedSessionIds()].map((sid, index) => ({ index, name: "", opencodeSessionId: sid, paneCurrentPath: "" }));
    return [{ tmuxSession: "", windows }];
  }

  /**
   * The payload of every shown node that has a session (window rows AND virtual rows, spec §3), keyed by the node's
   * canonical session AND by every window stamped with any member of its conversation. Computed over the graph:
   * `busy` = own turn, or anything running beneath it at any depth (shown or collapsed), or a running job below;
   * `subagents` = running descendants at any depth plus those waiting on a question / permission.
   */
  function allPayloads() {
    const { statusGraph: graph, layout } = computeAnnotated(lastProjects ?? syntheticProjects());
    const targets = new Map(layout.statusNodes);
    for (const sid of d.windowedSessionIds()) {
      const n = graph.canon(sid);
      const aliases = targets.get(n) ?? [n];
      if (!aliases.includes(sid)) aliases.push(sid);
      targets.set(n, aliases);
    }
    const runningNodes = new Set();
    for (const sid of running) runningNodes.add(graph.canon(sid));
    const askNodes = new Set();
    const ownNodes = new Map();
    for (const [sid, st] of own) {
      const n = graph.canon(sid);
      const e = ownNodes.get(n) ?? { since: null, attention: null };
      if (st.attention && !e.attention) e.attention = st.attention;
      if (running.has(sid) && st.since != null) e.since = st.since;
      ownNodes.set(n, e);
    }
    for (const sid of pendingAskIds()) askNodes.add(graph.canon(sid));
    const stoppedNodes = new Set();
    for (const sid of stopped) stoppedNodes.add(graph.canon(sid));
    // Running jobs, on nodes: a running job is work in its child AND (when the edges name no parent) its caller.
    const jobsCanon = [];
    const seeds = new Set([...runningNodes, ...askNodes]);
    for (const j of jobs) {
      if (j?.status !== "running" || j.supersededBy) continue;
      const child = j.childSessionID ? graph.canon(j.childSessionID) : undefined;
      const parent = j.parentSessionID ? graph.canon(j.parentSessionID) : undefined;
      jobsCanon.push({ status: "running", childSessionID: child, parentSessionID: parent });
      if (child) seeds.add(child);
      else if (parent) seeds.add(parent);
    }
    // The edges above every seed (rules 1–4 on conversation nodes); nothing else is needed to roll status up.
    const nodeParent = new Map();
    for (const seed of seeds) {
      let cur = seed;
      for (let depth = 0; depth < MAX_DEPTH && cur && !nodeParent.has(cur); depth++) {
        const p = graph.edgeParent(cur);
        if (!p) break;
        nodeParent.set(cur, p);
        cur = p;
      }
    }
    const m = { running: runningNodes, parentOf: nodeParent, jobs: [], own: ownNodes, stopped: stoppedNodes, pendingAsk: askNodes };
    m.activeWork = sessionsWithActiveWork(runningNodes, Object.fromEntries(nodeParent), jobsCanon);
    m.childCounts = runningChildCounts(m);
    const out = new Map();
    for (const [node, aliases] of targets) {
      const payload = deriveWindowStatus(m, node);
      for (const sid of new Set([node, ...aliases])) out.set(sid, payload);
    }
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
    const jobByChild = new Map(); // child -> the record shown on its row (last non-superseded one, as annotateJobs does)
    for (const j of jobs) {
      if (!j?.childSessionID || j.supersededBy) continue;
      annotated.add(j.childSessionID);
      jobByChild.set(j.childSessionID, j);
      if (isLiveJob(j)) liveChildren.add(j.childSessionID);
      if (completionOwnerOf(j) === "opencode") adopted.add(j.childSessionID);
      else if (j.parentSessionID && j.parentSessionID !== j.childSessionID) ruleOne.set(j.childSessionID, j.parentSessionID);
    }
    return { annotated, adopted, ruleOne, liveChildren, jobByChild };
  }

  /** The explicit link entry of a session, defended against a throwing store. */
  function linkEntry(sid) {
    try {
      return d.linkOf?.(sid);
    } catch {
      return undefined;
    }
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
      const entry = { members, oldest, canon };
      for (const m of members) chains.set(m, entry);
      return entry;
    };
    const canon = (sid) => chainInfo(sid).canon;
    const keyOf = (sid) => chainInfo(sid).oldest;

    const windowsByNode = new Map(); // canonical node -> windows of any member
    for (const [sid, list] of windowsBySid) {
      const node = canon(sid);
      windowsByNode.set(node, [...(windowsByNode.get(node) ?? []), ...list]);
    }

    // A link written after a handoff replaces an older member's link/suppression too.
    const nodeLink = (node) => chainInfo(node).members.map(linkEntry).filter(Boolean).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
    /** A `session_unlink` suppression: no inference for this child. */
    function isSuppressed(node) {
      return nodeLink(node)?.parent === null;
    }

    /**
     * child node -> parent node: rule 1 (Manta-owned record), rule 2 (opencode's parentID), rule 3 (explicit link; a
     * suppression entry ends the walk here: it is not an edge AND it disables rule 4), rule 4 (cached inference).
     */
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
      const linked = nodeLink(node)?.parent;
      if (typeof linked === "string" && linked && canon(linked) !== node) return canon(linked);
      if (isSuppressed(node)) return null;
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

    return { rec, windowsBySid, windowsByNode, canon, keyOf, chainInfo, edgeParent, isSuppressed, walkUp, projectWindow, byIndex };
  }

  // ---- the tree (spec §2, §3, §10) ----------------------------------------------------------------------------
  //
  // Pure over (projects, graph, held state). The only side effects are idempotent memo writes: a conversation's
  // order `seq`, a root row's retained project. Whatever a pass cannot decide without a read is returned in `need`.

  const winSeqOf = (project, w) => {
    const k = `${project}\0${w.index}\0${w.sid}`;
    let s = winSeq.get(k);
    if (s === undefined) {
      s = ++seqCounter;
      winSeq.set(k, s);
      boundMap(winSeq, MAX_TREE_STATE);
    }
    return s;
  };
  const seqOf = (key) => {
    let s = seqOfKey.get(key);
    if (s === undefined) {
      s = ++seqCounter;
      seqOfKey.set(key, s);
      boundMap(seqOfKey, MAX_TREE_STATE);
    }
    return s;
  };

  /** Sessions with a pending question / permission: the interpreter's latch plus the injected live set. */
  function pendingAskIds() {
    const out = new Set();
    for (const [sid, st] of own) if (st.attention === "question" || st.attention === "permission") out.add(sid);
    try {
      for (const sid of d.pendingAskSessionIds?.() ?? []) out.add(sid);
    } catch {
      /* the latch alone */
    }
    return out;
  }

  /**
   * Is a WINDOWLESS node eligible to be a row? "ok" | "excluded" | "unknown". Exclusions (spec §2): marked internal, the CTO
   * conversation, a provenance-internal session, an uncommitted handoff successor, an inline foreground `task` child. A
   * child of a live job record is exempt (the record is the row). `need` collects the sessions a background read would resolve.
   */
  function gateOf(node, graph, need) {
    const { members } = graph.chainInfo(node);
    for (const m of members) {
      try {
        if (d.isHandoffSuccessor?.(m)) return "excluded";
      } catch {
        return "excluded";
      }
    }
    const inf = info.get(node);
    // A record can place an unread job child, but cannot override a known exclusion.
    const liveJob = members.some((m) => graph.rec.liveChildren.has(m));
    if (!inf) {
      need.add(node);
      return liveJob ? "ok" : "unknown";
    }
    if (inf.internal) return "excluded";
    if (d.isCtoConversationSession || d.isInternalSession) {
      const s = special.get(node);
      if (s === undefined) {
        need.add(node);
        return "unknown";
      }
      if (s) return "excluded";
    }
    if (liveJob) return "ok";
    if (parentOf.get(node)) {
      const st = inlineState.get(node)?.state;
      if (st === "inline") return "excluded";
      if (st !== "no") {
        need.add(node);
        return "unknown";
      }
    }
    return "ok";
  }

  /** The row for one window of the project, as the client sees it. */
  const windowRowKey = (project, index) => `window:${project}:${index}`;

  /**
   * Before the first hydration: exactly today's rows. Every window is a row; a job window nests under the window
   * `parentWindowIndex` names (the annotated list), siblings in window-index order.
   */
  function coldLayout(annotated, graph) {
    const trees = new Map();
    const statusNodes = new Map();
    const primary = new Map(); // canonical node -> "project\0index" of its primary window
    for (const [node, wins] of graph.windowsByNode) {
      const w = [...wins].sort(graph.byIndex)[0];
      primary.set(node, `${w.project}\0${w.index}`);
    }
    for (const p of annotated ?? []) {
      const rows = new Map();
      const order = [];
      for (const w of p.windows ?? []) {
        const sid = w.opencodeSessionId;
        let row;
        if (!sid) {
          row = { key: windowRowKey(p.tmuxSession, w.index), sessionId: null, kind: "window", windowIndex: w.index, title: w.name ?? "", job: null, outside: false, children: [] };
        } else {
          const n = graph.canon(sid);
          const aliases = statusNodes.get(n) ?? [];
          if (!aliases.includes(sid)) aliases.push(sid);
          statusNodes.set(n, aliases);
          if (primary.get(n) === `${p.tmuxSession}\0${w.index}`) {
            row = {
              key: graph.keyOf(n),
              sessionId: n,
              kind: "window",
              windowIndex: w.index,
              title: w.name ?? "",
              job: w.job ? { id: w.job.id, status: w.job.status, origin: graph.rec.jobByChild.get(sid)?.origin ?? "" } : null,
              outside: false,
              children: [],
            };
          } else {
            row = { key: windowRowKey(p.tmuxSession, w.index), sessionId: sid, kind: "window", windowIndex: w.index, title: w.name ?? "", job: null, outside: false, children: [] };
            row.extra = true;
          }
        }
        rows.set(w.index, row);
        order.push({ w, row });
      }
      const roots = [];
      for (const { w, row } of order) {
        const parent = w.job?.parentWindowIndex != null ? rows.get(w.job.parentWindowIndex) : null;
        if (parent && !parent.extra && parent !== row) parent.children.push(row);
        else roots.push(row);
      }
      const byWin = (a, b) => a.windowIndex - b.windowIndex;
      for (const { row } of order) row.children.sort(byWin);
      for (const { row } of order) delete row.extra;
      roots.sort(byWin);
      trees.set(p.tmuxSession, roots);
    }
    return { trees, statusNodes, placeIdx: new Map(), need: new Set(), parentKeys: new Map(), unknown: new Set() };
  }

  /** The hydrated tree: shown sessions, nesting, root placement, order. `annotated` is the list after `job` annotation. */
  function layoutTree(projects, graph) {
    const t = now();
    const need = new Set();
    const projectByName = new Map();
    for (const p of projects ?? []) projectByName.set(p.tmuxSession, p);

    // -- window-bearing nodes (a window is always a row), order seq assigned in (project, index) order
    const nodes = new Map(); // canonical sid -> node
    const terminal = [];
    for (const p of projects ?? []) {
      for (const w of p.windows ?? []) {
        const sid = w?.opencodeSessionId;
        if (!sid) {
          terminal.push({ project: p.tmuxSession, w });
          seqOf(windowRowKey(p.tmuxSession, w.index));
          continue;
        }
        const n = graph.canon(sid);
        let node = nodes.get(n);
        if (!node) {
          node = { sid: n, key: graph.keyOf(n), members: graph.chainInfo(n).members, windows: [], virtual: false };
          nodes.set(n, node);
          seqOf(node.key);
        }
        const win = { project: p.tmuxSession, index: w.index, name: w.name ?? "", path: w.paneCurrentPath ?? "", sid };
        winSeqOf(p.tmuxSession, win);
        node.windows.push(win);
      }
    }
    const gone = (n) => graph.chainInfo(n).members.some((m) => missing.has(m));
    const virtualNode = (n) => ({ sid: n, key: graph.keyOf(n), members: graph.chainInfo(n).members, windows: [], virtual: true });
    // A conversation's directory / title: the canonical member's read, else any member's.
    const infoOfNode = (N) => info.get(N.sid) ?? N.members.map((m) => info.get(m)).find(Boolean);
    const recordFor = (N) => {
      for (const m of N.members) {
        const j = graph.rec.jobByChild.get(m);
        if (j) return j;
      }
      return null;
    };

    // -- which windowless sessions are shown: running, pending ask, ended < LINGER_MS ago, or a live job's child
    const shown = new Map(nodes);
    const lingering = [];
    for (const [sid, until] of lingerUntil) if (until > t) lingering.push(sid);
    const candidates = [...running, ...pendingAskIds(), ...lingering, ...graph.rec.liveChildren];
    for (const sid of candidates) {
      const n = graph.canon(sid);
      if (shown.has(n) || gone(n)) continue;
      if (gateOf(n, graph, need) === "ok") shown.set(n, virtualNode(n));
    }
    // -- structural retention: an ancestor (by the edges) of a shown session stays while the descendant is shown
    for (const N of [...shown.values()]) {
      const walk = graph.walkUp(N.sid);
      if (walk.end === "cycle") continue;
      for (const a of walk.path) {
        if (shown.has(a) || gone(a)) continue;
        if (gateOf(a, graph, need) === "ok") shown.set(a, virtualNode(a));
      }
    }

    // -- nesting + root placement; a windowless node that cannot be placed (or whose ancestry is unread) is not shown
    const dropped = new Set();
    const keyToSid = new Map();
    for (const [sid, N] of shown) keyToSid.set(N.key, sid);
    let parents = new Map();
    let placed = new Map();
    const unknown = new Set();
    const parentKeys = new Map();
    const authProjects = (N) => {
      const s = new Set();
      for (const w of N.windows) if (projectByName.has(w.project)) s.add(w.project);
      if (N.windows.length === 0) {
        const j = recordFor(N);
        if (j?.tmuxSession && projectByName.has(j.tmuxSession)) s.add(j.tmuxSession);
      }
      return s;
    };
    const chooseProject = (N) => {
      const byProject = new Map();
      for (const w of N.windows) {
        if (!projectByName.has(w.project)) continue;
        const s = winSeqOf(w.project, w);
        if (!byProject.has(w.project) || s < byProject.get(w.project)) byProject.set(w.project, s);
      }
      const cands = [...byProject].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
      const j = recordFor(N);
      if (j?.tmuxSession && projectByName.has(j.tmuxSession)) cands.push(j.tmuxSession);
      const dir = infoOfNode(N)?.directory;
      const owner = dir ? ownerByDirectory(projects, dir) : null;
      if (owner && projectByName.has(owner)) cands.push(owner);
      if (cands.length === 0) return null;
      const prev = rootProject.get(N.key);
      const pick = prev && cands.includes(prev) ? prev : cands[0];
      rootProject.set(N.key, pick);
      boundMap(rootProject, MAX_TREE_STATE);
      return pick;
    };

    for (let iter = 0; iter < 8; iter++) {
      parents = new Map();
      placed = new Map();
      unknown.clear();
      parentKeys.clear();
      const newDrops = new Set();
      for (const [sid, N] of shown) {
        if (dropped.has(sid)) continue;
        const walk = graph.walkUp(sid);
        let parent = null;
        if (walk.end !== "cycle") {
          for (const a of walk.path) {
            if (shown.has(a) && !dropped.has(a)) {
              parent = a;
              break;
            }
          }
        }
        let certain = true;
        if (!parent && walk.end === "unknown") {
          certain = false;
          for (const m of graph.chainInfo(walk.at).members) unknown.add(m);
          // The last confidently placed nesting stands while the ancestry is unread.
          const last = treeParents.get(N.key);
          const lastSid = last ? keyToSid.get(last) : null;
          if (lastSid && lastSid !== sid && shown.has(lastSid) && !dropped.has(lastSid) && !graph.walkUp(lastSid).path.includes(sid)) parent = lastSid;
          else if (N.virtual && !N.members.some((m) => graph.rec.liveChildren.has(m))) {
            newDrops.add(sid); // unknown is not root: not shown until its ancestry has been read
            continue;
          }
        }
        if (certain) parentKeys.set(N.key, parent ? shown.get(parent).key : null);
        parents.set(sid, parent);
      }
      // A cycle through last-known parents (never through certain edges) breaks at the first repeat.
      for (const start of parents.keys()) {
        const seen = new Set([start]);
        let cur = parents.get(start);
        while (cur) {
          if (seen.has(cur)) {
            parents.set(start, null);
            break;
          }
          seen.add(cur);
          cur = parents.get(cur);
        }
      }
      const memo = new Map();
      const resolve = (sid) => {
        if (memo.has(sid)) return memo.get(sid);
        memo.set(sid, null);
        const N = shown.get(sid);
        const P = parents.get(sid);
        let res = null;
        if (P && !dropped.has(P) && shown.has(P)) {
          const r = resolve(P);
          if (r) {
            const a = authProjects(N);
            if (a.size === 0 || a.has(r.project)) res = { root: r.root, project: r.project, parent: P };
          }
        }
        if (!res) {
          const project = chooseProject(N);
          if (project) res = { root: sid, project, parent: null };
        }
        memo.set(sid, res);
        return res;
      };
      for (const sid of parents.keys()) {
        const res = resolve(sid);
        if (!res) newDrops.add(sid);
        else placed.set(sid, res);
      }
      if (newDrops.size === 0) break;
      for (const x of newDrops) dropped.add(x);
    }

    // -- build rows
    const seqOfNode = new Map();
    const built = new Map();
    const lowestWindow = (N, project) => N.windows.filter((w) => w.project === project).sort((a, b) => a.index - b.index)[0] ?? null;
    for (const [sid, res] of placed) {
      const N = shown.get(sid);
      const w = lowestWindow(N, res.project);
      const j = recordFor(N);
      const inf = infoOfNode(N);
      const node = {
        key: N.key,
        sessionId: sid,
        kind: w ? "window" : "virtual",
        windowIndex: w ? w.index : null,
        title: w ? w.name : (inf?.title?.trim() || (typeof j?.name === "string" && j.name.trim()) || "Session"),
        job: j ? { id: j.id, status: j.status, origin: typeof j.origin === "string" ? j.origin : "" } : null,
        outside: !w && !res.parent,
        children: [],
      };
      built.set(sid, { node, w, N, res });
      seqOfNode.set(node, seqOf(N.key));
    }
    const bySeq = (a, b) => seqOfNode.get(a) - seqOfNode.get(b);
    for (const { node, res } of built.values()) if (res.parent) built.get(res.parent).node.children.push(node);
    for (const { node } of built.values()) node.children.sort(bySeq);

    const buckets = new Map(); // project -> [{ node, group, order }]
    const push = (project, node, group, order) => {
      const list = buckets.get(project) ?? [];
      list.push({ node, group, order });
      buckets.set(project, list);
    };
    const statusNodes = new Map();
    const placeIdx = new Map();
    for (const [sid, { node, w, N, res }] of built) {
      if (!res.parent) {
        if (node.kind === "window") push(res.project, node, 0, node.windowIndex);
        else push(res.project, node, 1, seqOfNode.get(node));
      }
      // Every other window of the node (duplicates, or windows in another project) is its own childless row.
      for (const x of N.windows) {
        if (w && x.project === w.project && x.index === w.index) continue;
        push(x.project, { key: windowRowKey(x.project, x.index), sessionId: x.sid, kind: "window", windowIndex: x.index, title: x.name, job: null, outside: false, children: [] }, 0, x.index);
      }
      const aliases = new Set([sid, ...N.windows.map((x) => x.sid)]);
      statusNodes.set(sid, [...aliases]);
      const rootEntry = built.get(res.root);
      const proj = projectByName.get(res.project);
      const directory = infoOfNode(N)?.directory ?? null;
      for (const m of N.members) placeIdx.set(m, { project: res.project, canonicalSessionId: sid, directory, rootPath: rootEntry?.w?.path || null, defaultCwd: proj?.defaultCwd ?? null });
    }
    for (const { project, w } of terminal) {
      push(project, { key: windowRowKey(project, w.index), sessionId: null, kind: "window", windowIndex: w.index, title: w.name ?? "", job: null, outside: false, children: [] }, 0, w.index);
    }
    const trees = new Map();
    for (const p of projects ?? []) {
      const list = buckets.get(p.tmuxSession) ?? [];
      list.sort((a, b) => a.group - b.group || a.order - b.order);
      trees.set(p.tmuxSession, list.map((x) => x.node));
    }
    return { trees, statusNodes, placeIdx, need, parentKeys, unknown };
  }

  /** The session list with each job window's `parentWindowIndex` taken from the graph (today's output until hydrated), and `tree`. */
  function computeAnnotated(projects) {
    const base = annotateJobs(projects, jobs);
    const graph = buildGraph(projects);
    const attach = (list, layout) => list.map((p) => ({ ...p, tree: layout.trees.get(p.tmuxSession) ?? [] }));
    if (!hydratedOnce) {
      const layout = coldLayout(base, graph);
      return { out: attach(base, layout), placement: placement, unknown: new Set(), graph: null, statusGraph: graph, layout };
    }
    const nextPlacement = new Map();
    const unknown = new Set();
    const annotated = base.map((p) => ({
      ...p,
      windows: p.windows.map((w) => {
        const sid = w.opencodeSessionId;
        if (sid && !parentOf.has(sid) && !rootIds.has(sid) && !missing.has(sid)) unknown.add(sid);
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
    const layout = layoutTree(projects, graph);
    for (const sid of layout.unknown) unknown.add(sid);
    return { out: attach(annotated, layout), placement: nextPlacement, unknown, graph, statusGraph: graph, layout };
  }

  /** Re-derive the projection and, only when it differs from the list last served, refresh the session list. */
  function recompute() {
    if (recomputePending) return;
    recomputePending = true;
    Promise.resolve()
      .then(() => {
        recomputePending = false;
        if (!lastProjects) return undefined;
        const res = computeAnnotated(lastProjects);
        if (res.graph) {
          triggerGates(res.layout.need);
          resolveUnknown(res.unknown);
        }
        return d.onJobsChanged && treeSignature(res.out) !== nestingSig ? d.onJobsChanged() : undefined;
      })
      .catch(() => {
        recomputePending = false;
      });
  }

  /** One linger timer per lingering session: when it fires and the linger is over, the tree is recomputed. */
  function startLinger(sid) {
    lingerUntil.set(sid, now() + LINGER_MS);
    boundMap(lingerUntil, MAX_TREE_STATE);
    if (lingerTimers.has(sid)) return;
    lingerTimers.add(sid);
    const arm = (ms) =>
      setTimer(() => {
        const left = (lingerUntil.get(sid) ?? 0) - now();
        if (left > 0) return arm(left + 5);
        lingerTimers.delete(sid);
        lingerUntil.delete(sid);
        recompute();
        return undefined;
      }, ms);
    arm(LINGER_MS + 5);
  }

  /** The one place a session's own turn flips; an ended turn lingers (spec §2). */
  function setRunning(sid, on) {
    const was = running.has(sid);
    if (on) running.add(sid);
    else running.delete(sid);
    if (was && !on) startLinger(sid);
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
    const virtualSeeds = new Set([...running, ...pendingAskIds(), ...graph.rec.liveChildren]);
    for (const p of projects ?? []) {
      const candidates = [...(p.windows ?? [])];
      for (const sid of virtualSeeds) {
        if (graph.windowsBySid.has(sid)) continue;
        const job = graph.rec.jobByChild.get(sid);
        const owner = job?.tmuxSession ?? ownerByDirectory(projects, info.get(sid)?.directory);
        if (owner === p.tmuxSession) candidates.push({ opencodeSessionId: sid });
      }
      for (const w of candidates) {
        const sid = w?.opencodeSessionId;
        if (!sid) continue;
        const walk = graph.walkUp(graph.canon(sid));
        if (walk.end !== "root" || walk.path.some((n) => graph.windowsByNode.has(n))) continue; // placed by a windowed ancestor, or not certain
        const root = walk.at;
        if (graph.isSuppressed(root)) continue; // a `session_unlink` suppression: no inference for this child, ever
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
          if (fresh.edgeParent(fresh.canon(s.root)) || fresh.isSuppressed(fresh.canon(s.root))) break; // an authoritative parent / a suppression appeared meanwhile: nothing to infer
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
        setRunning(sid, on);
        ownState(sid).since = on ? (p?.since ?? null) : null;
        liveDuringHydration?.set(sid, { running: on, since: ownState(sid).since });
        dirty();
        recompute();
      } else if (evt.sub === "attention" && sid) {
        ownState(sid).attention = p?.kind ?? null;
        dirty();
        recompute();
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
      if (evt.payload?.state === "committed") {
        dirty();
        recompute();
      }
      return;
    }
    if (evt.kind === "runningSet" && Array.isArray(evt.payload?.sessions)) {
      const next = new Set(evt.payload.sessions.map((r) => r?.sessionId).filter(Boolean));
      for (const sid of [...running]) if (!next.has(sid)) setRunning(sid, false);
      for (const r of evt.payload.sessions) {
        if (!r?.sessionId) continue;
        running.add(r.sessionId);
        ownState(r.sessionId).since = r.since ?? null;
      }
      dirty();
      recompute();
      return;
    }
    if (evt.kind === "opencode") {
      observeRaw(evt.payload);
      return;
    }
    if (evt.kind === "delegate.updated") {
      // Activity updates fire every ~10 s per job: only a change in WHICH jobs exist / their status / their windows
      // re-reads the session list.
      const before = jobsSignature(jobs);
      pendingJobs = refreshJobs()
        .then(async () => {
          dirty();
          if (jobsSignature(jobs) !== before) {
            // With a served baseline, only a rendered-tree change refreshes the list.
            if (lastProjects) recompute();
            else await d.onJobsChanged?.();
          }
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

  /**
   * One session read: its parent (the edge) and — when `readSession` is wired — its title, directory and internal marker,
   * cached with it. `getSessionParent` alone (older wiring, tests) caches no info.
   * @returns {Promise<{status:"ok", parentID:string|null}|{status:"not-found"}|{status:"error"}>}
   */
  async function readNode(id) {
    if (typeof d.readSession !== "function") return d.getSessionParent(id);
    let rs;
    try {
      rs = await d.readSession(id);
    } catch {
      return { status: "error" };
    }
    if (!rs || rs.state === "unknown") return { status: "error" };
    if (rs.state === "missing") return { status: "not-found" };
    const s = rs.session ?? {};
    info.set(id, {
      title: typeof s.title === "string" ? s.title : "",
      directory: typeof s.directory === "string" && s.directory ? s.directory : null,
      internal: isMarkedInternal(s),
    });
    boundMap(info, MAX_TREE_STATE);
    return { status: "ok", parentID: typeof s.parentID === "string" && s.parentID ? s.parentID : null };
  }

  /** Walk one session's ancestry from opencode's own records. Returns false when any read could not be answered. */
  async function resolveChain(id, visited) {
    let cur = id;
    let complete = true;
    for (let depth = 0; depth < MAX_DEPTH && cur; depth++) {
      if (visited.has(cur)) break;
      visited.add(cur);
      const r = await readNode(cur);
      if (r.status === "error") return false;
      if (r.status === "not-found") {
        parentOf.delete(cur); // the session was deleted: that edge is gone
        missing.add(cur);
        learning?.add(cur);
        break;
      }
      if (!r.parentID) {
        parentOf.delete(cur);
        rootIds.add(cur);
        learning?.add(cur);
        missing.delete(cur);
        break;
      }
      missing.delete(cur);
      touchEdge(cur, r.parentID);
      learning?.add(cur);
      // Stop once the parent is already known (its own chain was resolved earlier).
      if (rootIds.has(r.parentID) || parentOf.has(r.parentID)) break;
      cur = r.parentID;
    }
    return complete;
  }

  // ---- background reads for the tree: which windowless sessions may be rows --------------------------------------

  /** The `task` blocks of a parent's assistant timeline (cached briefly: many children share one parent). */
  async function taskBlocks(parent) {
    const hit = timelineCache.get(parent);
    if (hit && now() - hit.at < TIMELINE_CACHE_MS) return hit.blocks;
    const blocks = taskBlocksOf((await d.listRawTimeline(parent, { type: "assistant" })) ?? []);
    timelineCache.set(parent, { at: now(), blocks });
    boundMap(timelineCache, 200);
    return blocks;
  }

  /** Decide, once each, everything the exclusions need for one windowless session. Returns false when it could not conclude. */
  async function evaluateGate(sid) {
    if (!info.has(sid) || (!parentOf.has(sid) && !rootIds.has(sid))) {
      const r = await readNode(sid);
      if (r.status === "error") return false;
      if (r.status === "not-found") {
        missing.add(sid);
        return true;
      }
      if (r.parentID) touchEdge(sid, r.parentID);
      else {
        parentOf.delete(sid);
        rootIds.add(sid);
      }
      if (!info.has(sid)) return false; // no session reader wired: a windowless session can never be proven eligible
    }
    if ((d.isCtoConversationSession || d.isInternalSession) && !special.has(sid)) {
      try {
        const v = (await d.isCtoConversationSession?.(sid)) || (await d.isInternalSession?.(sid));
        special.set(sid, !!v);
        boundMap(special, MAX_TREE_STATE);
      } catch {
        return false; // a provenance store that cannot answer fails closed: not shown, retried
      }
    }
    const parent = parentOf.get(sid);
    const hasRecord = jobs.some((j) => j?.childSessionID === sid && !j.supersededBy);
    if (parent && !hasRecord && inlineState.get(sid)?.state !== "inline" && inlineState.get(sid)?.state !== "no") {
      if (typeof d.listRawTimeline !== "function") {
        inlineState.set(sid, { state: "inline", reads: 0 }); // cannot prove it is not inline: never a row
        return true;
      }
      let blocks;
      try {
        blocks = await taskBlocks(parent);
      } catch {
        return false; // an unreadable timeline keeps the session excluded
      }
      const kind = blocks.get(sid);
      if (kind) {
        inlineState.set(sid, { state: kind === "fg" ? "inline" : "no", reads: 0 });
      } else {
        // The block is stamped on the parent a moment after the child exists: several misses before "not a task child".
        const reads = (inlineState.get(sid)?.reads ?? 0) + 1;
        inlineState.set(sid, { state: reads >= NO_BLOCK_READS ? "no" : "unsure", reads });
        timelineCache.delete(parent);
        if (reads < NO_BLOCK_READS) return false;
      }
      boundMap(inlineState, MAX_TREE_STATE);
    }
    return true;
  }

  /** Run the background gate evaluations the tree asked for (throttled per session, bounded per pass), then recompute. */
  function retryGates(ms) {
    if (gateRetryPending) return;
    gateRetryPending = true;
    setTimer(() => {
      gateRetryPending = false;
      recompute();
    }, ms);
  }

  function triggerGates(need) {
    if (gateRunning || hydrating || !hydratedOnce || !need || need.size === 0) return;
    const t = now();
    const want = [];
    let retryIn = Infinity;
    for (const sid of need) {
      const last = gateAt.get(sid);
      const attempts = gateAttempts.get(sid) ?? 0;
      const gap = attempts === 0 ? 1000 : GATE_RETRY_MS[Math.min(attempts, GATE_RETRY_MS.length - 1)];
      if (last != null && t - last < gap) {
        retryIn = Math.min(retryIn, gap - (t - last) + 5);
        continue;
      }
      gateAt.set(sid, t);
      want.push(sid);
      if (want.length >= MAX_GATES_PER_PASS) break;
    }
    boundMap(gateAt, MAX_TREE_STATE);
    if (want.length === 0) {
      if (Number.isFinite(retryIn)) retryGates(retryIn);
      return;
    }
    gateRunning = true;
    void queueBackground(async () => {
      let unresolved = false;
      try {
        for (const sid of want) {
          let ok = false;
          try {
            ok = await evaluateGate(sid);
          } catch {
            ok = false;
          }
          if (ok) gateAttempts.delete(sid);
          else {
            gateAttempts.set(sid, (gateAttempts.get(sid) ?? 0) + 1);
            unresolved = true;
          }
        }
      } finally {
        gateRunning = false;
      }
      recompute();
      if (unresolved) retryGates(GATE_RETRY_MS[1] + 100);
    });
  }

  /** A raw opencode event that may carry a directory move (or a retitle) for a session the tree has read. */
  function observeRaw(raw) {
    const type = raw?.type;
    if (type !== "session.updated" && type !== "session.moved") return;
    const sid = raw.data?.sessionID ?? raw.data?.session?.id ?? raw.properties?.sessionID ?? raw.properties?.info?.id ?? raw.sessionID;
    const cur = typeof sid === "string" ? info.get(sid) : null;
    if (!cur) return;
    const dir = raw.data?.location?.directory ?? raw.data?.directory ?? raw.data?.session?.directory ?? raw.location?.directory ?? raw.properties?.info?.directory ?? null;
    if (typeof dir === "string" && dir) {
      if (dir !== cur.directory) {
        info.set(sid, { ...cur, directory: dir });
        recompute();
      }
      return;
    }
    const t = now();
    const last = infoRefreshAt.get(sid);
    if (last != null && t - last < INFO_REFRESH_MIN_MS) return;
    infoRefreshAt.set(sid, t);
    boundMap(infoRefreshAt, 1000);
    void queueBackground(async () => {
      const before = JSON.stringify(info.get(sid));
      await readNode(sid);
      if (JSON.stringify(info.get(sid)) !== before) recompute();
    });
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
      // The old root / missing knowledge stays in force WHILE the walk runs (a pass in the middle must not read every
      // windowless row as "ancestry unknown" and drop it); what the walk did not re-learn is cleared once it is done.
      const stale = { roots: new Set(rootIds), missing: new Set(missing) };
      learning = new Set();
      try {
        const ids = await d.listActiveSessionIds();
        const next = new Set(ids);
        for (const sid of [...running]) if (!next.has(sid)) setRunning(sid, false);
        for (const id of ids) {
          running.add(id);
          // The interpreter knows when a turn started even if no frame has been seen since this process began.
          const since = d.runningSince?.(id);
          if (since != null && ownState(id).since == null) ownState(id).since = since;
        }
        // A turn that started or ended while the read was in flight is newer than the list.
        for (const [id, v] of live) {
          if (v.running) running.add(id);
          else setRunning(id, false);
          ownState(id).since = v.running ? (v.since ?? ownState(id).since) : null;
        }
      } catch {
        complete = false;
      }
      if (!(await refreshJobs())) complete = false;
      await refreshStopped();
      try { await d.pruneLinks?.(); } catch { complete = false; }
      // Candidates: the running set, every windowed session, every job child that still has a place in the tree,
      // every session with a pending ask, every session a link names.
      const seeds = new Set(running);
      for (const sid of d.windowedSessionIds()) seeds.add(sid);
      for (const j of jobs) if (j.childSessionID && !j.supersededBy && isLiveJob(j)) seeds.add(j.childSessionID);
      for (const sid of pendingAskIds()) seeds.add(sid);
      try {
        for (const sid of d.linkEndpoints?.() ?? []) seeds.add(sid);
      } catch {
        /* no link store yet */
      }
      const visited = new Set();
      for (const id of seeds) {
        if (!(await resolveChain(id, visited))) complete = false;
      }
      if (complete) {
        for (const sid of stale.roots) if (!learning.has(sid)) rootIds.delete(sid);
        for (const sid of stale.missing) if (!learning.has(sid)) missing.delete(sid);
      }
      learning = null;
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
      learning = null;
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
      lastLayout = res.layout;
      if (res.graph) {
        // The nesting the tree decided with certainty is what an uncertain pass falls back to.
        for (const [key, parentKey] of res.layout.parentKeys) treeParents.set(key, parentKey);
        boundMap(treeParents, MAX_TREE_STATE);
      }
      const sig = treeSignature(res.out);
      if (nestingSig !== null && sig !== nestingSig) nestingPending = true;
      nestingSig = sig;
      if (res.graph) {
        resolveUnknown(res.unknown);
        triggerGates(res.layout.need);
        inferDrivers(projects, res.graph);
      }
      return res.out;
    },
    /**
     * Seam for `sessions:materialize` (stage (b) second pass): where the row of `sessionId` — ANY member of its handoff
     * conversation — is placed in the last tree: the project its root sits in, the node's canonical session, and a directory a
     * holder window can start in (the session's own directory when opencode reported one, else the root window's pane path, else
     * the project's `defaultCwd`; the caller verifies it exists on disk). `null` when the session is not a shown row.
     * @param {string} sessionId
     * @returns {{ project: string, canonicalSessionId: string, cwd: string | null, rootPath: string | null, defaultCwd: string | null } | null}
     */
    placementOf(sessionId) {
      const hit = lastLayout?.placeIdx.get(sessionId);
      if (!hit) return null;
      const dir = hit.directory ?? null;
      return { project: hit.project, canonicalSessionId: hit.canonicalSessionId, cwd: dir ?? hit.rootPath ?? hit.defaultCwd ?? null, rootPath: hit.rootPath, defaultCwd: hit.defaultCwd };
    },
    async resolveAncestry(sid) {
      const visited = new Set();
      const pending = [sid];
      while (pending.length) {
        const current = pending.pop();
        const graph = buildGraph(lastProjects);
        for (const member of graph.chainInfo(current).members) {
          if (!await resolveChain(member, visited)) return false;
        }
        // Natural ancestry alone is insufficient for a cycle check: a persisted explicit edge
        // or a job caller may lead into an ancestor this process has not read yet.
        const fresh = buildGraph(lastProjects);
        for (const ancestor of fresh.walkUp(fresh.canon(current)).path) {
          if (!visited.has(ancestor)) pending.push(ancestor);
        }
      }
      return true;
    },
    canonicalSessionOf: (sid) => buildGraph(lastProjects).canon(sid),
    authoritativeParentOf(sid) {
      const graph = buildGraph(lastProjects);
      const node = graph.canon(sid);
      for (const m of graph.chainInfo(node).members) {
        for (const parent of [graph.rec.ruleOne.get(m), parentOf.get(m)]) {
          if (parent && graph.canon(parent) !== node) return graph.canon(parent);
        }
      }
      return null;
    },
    ancestorsOf(sid) {
      const graph = buildGraph(lastProjects);
      return graph.walkUp(graph.canon(sid)).path;
    },
    /** Seam for the link store: a link was written / removed — re-derive the tree and re-send the statuses. */
    linksChanged() {
      dirty();
      recompute();
    },
    /** Resolves when background work (parent reads, the inference lookup) queued so far has finished. */
    settleBackground: () => background,
    refreshJobs,
    /** Resolves once a job change in flight has reached the session list — so `tmux:list` read right after a
     *  `delegate.updated` frame already carries the new `job` fields. */
    settled: () => pendingJobs,
    // Test seams.
    _state: { running, parentOf, rootIds, missing, inferred, eligibility, info, lingerUntil, inlineState, get hydratedOnce() { return hydratedOnce; }, own, get jobs() { return jobs; }, set jobs(v) { jobs = v; }, get stopped() { return stopped; }, set stopped(v) { stopped = new Set(v); }, get retryScheduled() { return retryPending; } },
  };
}
