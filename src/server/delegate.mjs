// delegate.mjs — background job engine for the MantaUI server (BET-378).
//
// The core of "background delegation": a durable record of jobs plus the
// machinery to start one (worktree → V2 child session → window → prompt),
// detect when it finishes, assemble its result, and hand that result back to
// the parent session WITHOUT interrupting the user.
//
// Modelled on src/server/capabilities.mjs (dependency-injected pure-logic +
// injected I/O, an in-flight-guarded sweeper/poller with timer.unref()), but a
// SEPARATE module and a SEPARATE store (~/.manta/delegate-jobs.json). Do NOT
// extend capabilities.mjs: its records are plugin-capability shaped and
// background jobs complete from a different signal (the opencode event stream,
// not an executor POST).
//
// EVERY job is `engine:"v2"` (opencode-v2-next, Stage C): a real V2 child
// session, completing from the child's RAW execution outcome (observeRaw →
// settleV2Job) and reporting exactly ONE result to its parent — as a V2
// synthetic (N7) for an ordinary parent, or through promptDelivery + the CTO
// admission redirect when the parent is the CTO conversation. observeEvent (the
// lifecycle-adapted stream) is kept only to adopt background `task` subagents
// and to find a pausing job's tool-step boundary. There is no other completion
// path: a record with no `engine` can only be a leftover of a pre-C2 box and
// reconcileJobsOnBoot settles it once, at boot.
//
// ONE RUN = ONE RECORD. A record is never brought back from a terminal state: another
// round of a session (`continueJob` for the caller's own finished job, adoptExistingSession
// for one opencode or a script drives) is a NEW record linked to the old one (`continues` /
// `supersededBy`) and sharing its session, window and worktree. Those shared resources are
// guarded by the per-session `sessionResources` lock (OUTER; the jobs-store lock is INNER).
// Sessions Manta merely observes (origin "observed", found by the active-session
// reconciler) are track-only: they never count toward the cap and never get a result posted.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic, createMutex } from "./jsonStore.mjs";
import {
  readProgressRecord as defaultReadProgress,
  clearProgress as defaultClearProgress,
} from "./progress.mjs";
import { startPoller } from "./startPoller.mjs";
import { slugifyProjectName } from "../shared/projectName.mjs";
import {
  parseGitStatus,
  summarizeTranscript,
  describeChatActivity,
} from "./peers.mjs";
import { extractSubagentInfo } from "../shared/streamInterpretation.mjs";
import { fuzzyMatchModel, suggestModels } from "../shared/modelGuide.mjs";
import { chooseModel, describeDecision } from "../shared/modelRouter.mjs";
import { listRoutableModels } from "./opencode.mjs";
import { buildRoutingServices } from "./routingServices.mjs";
import { isMarkedInternal } from "./internalSessionMarker.mjs";

// ---------------------------------------------------------------------------
// Constants (mirrors capabilities.mjs exactly — reuse, do not diverge)
// ---------------------------------------------------------------------------

const STORE_PATH = statePath("delegate-jobs.json");

// Single-writer serialization for the jobs store (BET-770 P2-1/2-2/2-3). Every
// read-modify-write mutation of the jobs array runs inside `jobsLock`, shared by
// ALL writers: startJob (+ the MAX_RUNNING_JOBS check), adoptSubagentJob,
// finishV2Job, stopJob, deleteJob, the activity poller, and the sweeper. Without
// this, a stale activity-poller write could resurrect a terminal job to
// `running`, a just-completed job could be flipped to "timed out", and two
// near-simultaneous `delegate` POSTs could both pass the cap check. Each
// mutation re-reads the store inside the lock, so a writer that lost a race
// observes the winner's state instead of overwriting it.
const jobsLock = createMutex();

// Per-session resource lock. A continued session is shared by several records
// (one per run), so every window / worktree side effect for a session — closing
// the window, removing the worktree, creating a successor run — runs under
// `sessionResources(childSessionID)`. Lock order: sessionResources OUTER,
// jobsLock INNER, never the reverse. NOT re-entrant: only the outermost entry
// points take it, and the functions they call are the "…Locked" variants.
function createKeyedMutex() {
  const tails = new Map();
  return {
    runExclusive(key, fn) {
      if (!key) return Promise.resolve().then(fn);
      const run = (tails.get(key) ?? Promise.resolve()).then(() => fn());
      const tail = run.then(() => {}, () => {});
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },
  };
}
const sessionResources = createKeyedMutex();
const withSessionResources = (childSessionID, fn) => sessionResources.runExclusive(childSessionID, fn);

// Max concurrently `running` jobs, counted box-wide. There is no `queued`
// state — a job either starts immediately or is refused by the cap.
export const MAX_RUNNING_JOBS = 5;
// Cap-refusal copy, spelled exactly for the UI/REST consumer and pinned by
// delegate.test.mjs.
export const CAP_ERROR =
  "too many background jobs running (5). Do not retry — either wait for one to finish, or do this work yourself.";
// `running` jobs older than this → `failed "timed out after 30 minutes"`.
const RUNNING_TIMEOUT_MS = 30 * 60_000;
// `paused` jobs are kept this long before the sweeper stops them (spec §11.6
// "[sweep] paused > 7 days → stopped"). A paused job's worktree persists, so
// the pause window is generous.
const PAUSE_KEEP_MS = 7 * 24 * 60 * 60_000;
// Terminal jobs are retained this long, OR until 50 records, whichever bites
// first. The window + worktree are NEVER removed by the sweeper — only by an
// explicit delete.
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_TERMINAL_JOBS = 50;
// Activity-summary poller cadence (updates `activity` for running jobs only).
const ACTIVITY_INTERVAL_MS = 10_000;
// Sweeper cadence (matches capabilities.mjs SWEEP_INTERVAL_MS).
const SWEEP_INTERVAL_MS = 60_000;
// Active-session reconciler cadence (adopts busy sessions nothing tracks).
const ACTIVE_RECONCILE_INTERVAL_MS = 15_000;
// The display-parent DB lookup (driver rule) re-runs for one record at most this often.
const DRIVER_LOOKUP_MIN_INTERVAL_MS = 60_000;
// BET-418 §A: a `delegate` call requesting approval blocks this long for the
// user's decision before being treated as declined.
const APPROVAL_TIMEOUT_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Store (atomic, same pattern as capabilities.mjs / schedule.mjs)
// ---------------------------------------------------------------------------

export async function loadJobs(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
}

export async function saveJobs(jobs, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify({ jobs }, null, 2));
}

function genId() {
  return randomBytes(4).toString("hex"); // 8-char hex, matches capabilities/genId
}

// ---------------------------------------------------------------------------
// Jobs cache (BET-403 nit 2) — REMOVED (BET-418 §A)
// ---------------------------------------------------------------------------
// The TTL cache existed only to cheaply serve opencode:permissions /
// opencode:questions the job list for BET-380 ownership computation. With
// BET-380's parent-panel routing deleted, nothing reads the job list from
// inside the permission/question RPC handlers, so the cache is dead. The UI
// jobs card (now also deleted, BET-418 §E) used the uncached listJobs; the
// read-only job view + delegate:list still use listJobs directly.

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * The opening prompt injected into the child session. The git paragraph is
 * omitted entirely when `worktree` is null (parent cwd was not a repo). Do not
 * add anything else and do not make it configurable.
 */
export function buildJobPrompt({ prompt, worktree, branch, facts }) {
  const head = String(prompt ?? "").trim();
  const factsSection =
    facts && String(facts).trim().length > 0
      ? "\n\n---\nRelevant project context (from the CTO blackboard):\n" + String(facts).trim() + "\n"
      : "";
  if (!worktree) {
    return (
      head +
      "\n\n---\n" +
      "You are running as a background job. The user is not watching this session and\n" +
      "cannot see your intermediate output — only your final message is reported back.\n\n" +
      "When you are done, end with a short summary of what you changed and why." +
      factsSection
    );
  }
  return (
    head +
    "\n\n---\n" +
    "You are running as a background job. The user is not watching this session and\n" +
    "cannot see your intermediate output — only your final message is reported back.\n\n" +
    `You are working in an isolated git worktree at ${worktree}, on branch ${branch}.\n` +
    "Commit your work to that branch before you finish. You may open a draft pull\n" +
    "request for it (never a non-draft one without a human confirming), but you may\n" +
    "never merge, never force-push, and never touch any other checkout.\n\n" +
    "When you are done, end with a short summary of what you changed and why." +
    factsSection
  );
}

/**
 * The completion message delivered to the parent session. The Branch/Worktree
 * lines are omitted when there is no worktree. On failure `<result>` is
 * replaced by `Error: <error>`. On timeout the status word is `failed` and the
 * error is `timed out after 30 minutes`.
 */
export function buildCompletionText(job) {
  const name = job?.name ?? "";
  const status = job?.status ?? "done";
  const lines = [`[background job "${name}" ${status}]`];
  if (job?.worktree) {
    const changed = job?.filesChanged == null ? "0" : String(job.filesChanged);
    lines.push(`Branch: ${job.branch ?? ""} (${changed} files changed)`);
    lines.push(`Worktree: ${job.worktree}`);
  }
  lines.push("");
  if (status === "failed" || status === "stopped") {
    lines.push(`Error: ${job?.error ?? ""}`);
  } else {
    lines.push(String(job?.result ?? ""));
  }
  return lines.join("\n");
}

// A tool part that has reached `completed` or `error` (the lifecycle adapter
// reports each finished tool in this shape). This is the step boundary at
// which a `pauseRequested` job's session is safely interrupted — the current
// tool has already finished, so no tool's half-written work is lost (spec
// §11.6-1: "aborted ... at its next completed-tool-part boundary"). Pure.
export function isToolStepBoundary(part) {
  if (!part || typeof part !== "object") return false;
  return part.type === "tool" && (part.state?.status === "completed" || part.state?.status === "error");
}

// Derive the job name from the first four whitespace-separated words of the
// prompt, slugified. Pure.
export function deriveName(prompt) {
  const words = String(prompt ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
  return slugifyProjectName(words) || "background";
}

// ---------------------------------------------------------------------------
// Pre-flight permission ruleset (BET-418 §A)
//
// A background job is created with a permission ruleset so it NEVER asks the
// user anything once running (asking would hang the job until the 30-min
// timeout, since BET-380's parent-panel routing is gone). The model declares
// the access it needs via the `delegate` tool's `tools` argument
// (`[{permission, pattern}]`, action defaults to "allow"). This builder
// normalizes the entries and appends the MANDATORY catch-all
// `{permission:"*", pattern:"**", action:"deny"}` — if an unmatched tool
// resolved to `ask`, the job would hang exactly as before. Pure + exported
// for unit tests.
//
// Returns null when the input is empty (no tools requested) — callers decide
// whether to skip the ruleset entirely (trust mode / no tools) or to still
// apply the catch-all deny alone.
// ---------------------------------------------------------------------------
// opencode's permission KEYS are not its tool names. Measured against the
// installed binary (1.18.x): `write`, `edit` and `apply_patch` all ask under
// the single key "edit" — there is no "write" or "apply_patch" key at all — and
// `glob` / `grep` / `lsp` each ask under their own key, not "read". A grant
// spelled by tool name ("write", the example the delegate tool itself gives)
// therefore matched nothing, and the job's every write fell through to the
// catch-all deny. Each grant is expanded to the keys that tool family really
// asks under.
const PERMISSION_ALIASES = {
  write: ["edit"],
  edit: ["edit"],
  apply_patch: ["edit"],
  patch: ["edit"],
  multiedit: ["edit"],
  read: ["read", "glob", "grep", "lsp"],
  list: ["read", "glob"],
  ls: ["read", "glob"],
};

// Grants broad enough that the job is clearly meant to work on files, so it
// also needs to reach files OUTSIDE its worktree. opencode gates every path
// outside the session directory behind `external_directory`, and the
// catch-all deny (which sits AFTER opencode's own defaults) overrides the
// box-level `external_directory: allow`. Jobs routinely read the source repo,
// write scratch files under /tmp/opencode and re-read truncated tool output —
// all outside the worktree — so every such call was refused. Granting bash or
// edit/read with an unscoped pattern already lets the job touch any path
// through the shell; the external_directory check is a path heuristic, not a
// boundary, so it follows the grant instead of contradicting it.
const FILE_FAMILY = new Set(["bash", "edit", "read"]);
const isBroadPattern = (p) => p === "*" || p === "**" || p === "**/*" || p === "/**";

// The real opencode permission keys a declared grant name resolves to.
export function permissionKeysFor(permission) {
  return PERMISSION_ALIASES[permission] ?? [permission];
}

export function buildPermissionRuleset(tools, { home = homedir() } = {}) {
  const input = Array.isArray(tools) ? tools : [];
  const rules = [];
  for (const t of input) {
    if (!t || typeof t !== "object") continue;
    const permission = typeof t.permission === "string" ? t.permission : null;
    const pattern = typeof t.pattern === "string" ? t.pattern : null;
    if (!permission || !pattern) continue;
    const action = t.action === "deny" ? "deny" : "allow";
    const keys = permissionKeysFor(permission);
    for (const key of keys) rules.push({ permission: key, pattern, action });
  }
  // Implied allows, placed BEFORE the declared rules so an explicit deny the
  // model (or the user, editing the approval card) wrote still wins under
  // last-match-wins.
  const implied = [];
  if (rules.length > 0) {
    // Internal bookkeeping, never a side effect outside the session: a job
    // that can't keep a todo list just fails its first planning step.
    implied.push({ permission: "todowrite", pattern: "*", action: "allow" });
    // opencode's own defaults, re-stated because the catch-all deny shadows
    // them: truncated tool output is saved under tool-output/ and the model is
    // told to read it back from there.
    implied.push({ permission: "external_directory", pattern: `${home}/.local/share/opencode/tool-output/*`, action: "allow" });
    implied.push({ permission: "external_directory", pattern: "/tmp/opencode/*", action: "allow" });
  }
  if (rules.some((r) => r.action === "allow" && FILE_FAMILY.has(r.permission) && isBroadPattern(r.pattern))) {
    implied.push({ permission: "external_directory", pattern: "*", action: "allow" });
  }
  if (rules.some((r) => r.action === "allow" && r.permission === "read")) {
    implied.push({ permission: "skill", pattern: "*", action: "allow" });
  }
  rules.unshift(...implied);
  // De-dup identical rules (model may repeat), keeping the LAST occurrence:
  // under last-match-wins a later copy may be what overrides an intervening
  // rule, so dropping it would flip the outcome.
  const lastIndex = new Map();
  rules.forEach((r, i) => lastIndex.set(`${r.permission}\u0000${r.pattern}\u0000${r.action}`, i));
  const deduped = rules.filter((r, i) => lastIndex.get(`${r.permission}\u0000${r.pattern}\u0000${r.action}`) === i);
  // The catch-all deny MUST be FIRST, with the specific allows after it.
  //
  // opencode resolves a tool call against this list LAST-MATCH-WINS, which is
  // the opposite of what this originally assumed. Appending the catch-all last
  // meant `{permission:"*", pattern:"**", action:"deny"}` matched every call
  // and won over every allow that preceded it — so a delegated job could not
  // run a SINGLE tool, whatever it had been granted. The job then burned a
  // worktree, a window and a model session doing nothing but reporting that it
  // was denied.
  //
  // Verified against the running opencode (v1.15.12) rather than reasoned
  // about, because the API accepts either order silently:
  //   [bash ** allow, * ** deny] → bash DENIED ("a rule prevents you…")
  //   [* ** deny, bash ** allow] → bash COMPLETED
  // opencode also prepends its own `{permission:"*", pattern:"*",
  // action:"allow"}` default ahead of whatever we send, which is why an
  // explicit catch-all deny is still required to stop an ungranted tool from
  // resolving to allow/ask — it just has to sit UNDER the grants, not over
  // them.
  return [{ permission: "*", pattern: "**", action: "deny" }, ...deduped];
}

// Find the tmux session that owns a given opencode sessionID. Mirrors the
// renderer's resolveSessionOwner (src/renderer/store.ts) — the server-side
// equivalent the spec calls for. Returns { tmuxSession, windowIndex, cwd } or
// null.
export function resolveOwner(projects, sessionID) {
  if (!Array.isArray(projects) || !sessionID) return null;
  for (const p of projects) {
    const w = (p.windows || []).find((x) => x.opencodeSessionId === sessionID);
    if (w) {
      return {
        tmuxSession: p.tmuxSession,
        windowIndex: w.index,
        cwd: w.paneCurrentPath || p.defaultCwd || "~",
      };
    }
  }
  return null;
}

// Resolve the real parent for a forge-triggered delegate job (BET-844, spec
// §3.4⑥). A forge event has no user session to inherit from, so the job's
// window must land in the tmux project on this box that OWNS the repo checkout
// being branched off. Returns { parentSessionID, tmuxSession, defaultCwd } —
// the opencode session id to place the job window under, the owning project,
// and the project's canonical directory (BET-1426: lets callers store the
// canonical cwd instead of the raw matched path) — or null when no tracked
// project wraps that directory. Pure.
export function resolveForgeOwner(projects, parentDirectory) {
  if (!Array.isArray(projects) || typeof parentDirectory !== "string" || !parentDirectory) return null;
  for (const p of projects) {
    const windows = p.windows || [];
    const ownsDir =
      (typeof p.defaultCwd === "string" && p.defaultCwd === parentDirectory) ||
      windows.some(
        (w) =>
          typeof w?.paneCurrentPath === "string" &&
          (w.paneCurrentPath === parentDirectory || w.paneCurrentPath.startsWith(parentDirectory + "/")),
      );
    if (!ownsDir) continue;
    const win = windows.find((w) => w?.opencodeSessionId) ?? windows[0];
    if (!win?.opencodeSessionId) return null;
    return {
      parentSessionID: win.opencodeSessionId,
      tmuxSession: p.tmuxSession,
      defaultCwd: typeof p.defaultCwd === "string" && p.defaultCwd ? p.defaultCwd : null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listJobs({ sessionID, sessionIDs } = {}, { load = loadJobs, readProgress = defaultReadProgress } = {}) {
  const jobs = await load();
  // `sessionIDs` (auto-handoff §6.3): the whole replacement chain of the asked-for session.
  const wanted = Array.isArray(sessionIDs) ? new Set(sessionIDs) : null;
  const scoped = wanted
    ? jobs.filter((j) => wanted.has(j.parentSessionID))
    : sessionID === undefined
      ? jobs
      : jobs.filter((j) => j.parentSessionID === sessionID);
  // Expose the child's live progress record on the job (BET-790 §5) so the
  // renderer's job card can show a live label instead of "Ruminating…" for
  // thirty minutes. Reads the SAME progress.json store — no second record or
  // event. Null when the job has no child session yet or never reported.
  return Promise.all(
    scoped.map(async (j) => ({
      ...j,
      progress: j.childSessionID ? await readProgress(j.childSessionID) : null,
    })),
  );
}

export async function getJob(id, { load = loadJobs, readProgress = defaultReadProgress } = {}) {
  const jobs = await load();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  return {
    ...job,
    progress: job.childSessionID ? await readProgress(job.childSessionID) : null,
  };
}

// ---------------------------------------------------------------------------
// Owner resolution + adoptExistingSession — turning a session opencode (or a
// script) is already running into a sidebar row.
//
// resolveSessionOwner answers "which workspace hosts the row, and which row does
// it nest under" for a session that may have NO window of its own.
// adoptExistingSession is the ONE place an adopted record is built: the
// reconciler, the background-`task` event path and command candidates all land
// here. One run = one record: a session that already has a terminal record gets
// a NEW record linked to it (`continues` / `supersededBy`), never a revived one.
// ---------------------------------------------------------------------------

const MAX_ANCESTOR_DEPTH = 8;

// Log a condition once per key per process (a repeating event / tick must not repeat the warning).
const warnedOnce = new Set();
function warnOnce(key, ...args) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  while (warnedOnce.size > 500) warnedOnce.delete(warnedOnce.values().next().value);
  console.warn(...args);
}

const trimSlashes = (p) => (typeof p === "string" && p.length > 1 ? p.replace(/\/+$/, "") : p);

async function pathExistsVia(deps, p) {
  if (typeof p !== "string" || !p) return false;
  try {
    return !!(await (deps.pathExists ?? existsSync)(p));
  } catch {
    return false;
  }
}

function findStampedWindow(projects, childSessionID) {
  for (const p of Array.isArray(projects) ? projects : []) {
    const win = (p.windows || []).find((w) => w.opencodeSessionId === childSessionID);
    if (win) return { tmuxSession: p.tmuxSession, windowIndex: win.index };
  }
  return null;
}

// The tmux project that owns a directory: an exact match on a project's cwd or a window's
// path wins; otherwise the most specific project path that contains the directory; last, a
// window inside it (the same direction resolveForgeOwner matches). "/" never owns anything.
function ownerByDirectory(projects, directory) {
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
  return best ? { tmuxSession: best.tmuxSession } : null;
}

/**
 * Which workspace (tmux session) should host the row of `sid`, and which window does it
 * nest under?
 *   1. walk `parentID` upward (max depth 8, cycle-safe): the first ancestor stamped on a
 *      window → that window's workspace, nested under that ancestor (`includeSelf` also
 *      accepts `sid` itself);
 *   2. else the tmux project that owns the session's directory (nested under nothing);
 *   3. else none.
 * Any unreadable read on the way → `unknown`: the caller skips this round without warning.
 *
 * @returns {Promise<{status:"ok", owner:{tmuxSession:string}, displayParentID:string|null, cwd:string|null, sessionParentID:string|null, directory:string|null}|{status:"none"}|{status:"unknown"}>}
 */
export async function resolveSessionOwner(sid, deps = {}, { includeSelf = false, session = null } = {}) {
  const { readSession, listProjects } = deps;
  if (!sid || typeof listProjects !== "function") return { status: "unknown" };
  let projects;
  try {
    projects = await listProjects();
  } catch {
    return { status: "unknown" };
  }
  if (!Array.isArray(projects)) projects = [];
  const windowed = (id) => (id ? resolveOwner(projects, id) : null);
  if (includeSelf) {
    const own = windowed(sid);
    if (own) {
      return { status: "ok", owner: { tmuxSession: own.tmuxSession }, displayParentID: sid, cwd: own.cwd ?? null, sessionParentID: null, directory: null };
    }
  }
  if (typeof readSession !== "function") return { status: "unknown" };

  let cur = sid;
  const seen = new Set([sid]);
  let sessionParentID = null;
  let directory = null;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth++) {
    let rs;
    if (session && cur === sid) {
      rs = { state: "found", session };
    } else {
      try {
        rs = await readSession(cur);
      } catch {
        rs = { state: "unknown" };
      }
    }
    if (rs?.state === "unknown" || !rs) return { status: "unknown" };
    if (rs.state === "missing") {
      if (cur === sid) return { status: "unknown" };
      break; // an ancestor that no longer exists ends the walk
    }
    const s = rs.session ?? {};
    if (cur === sid) {
      directory = typeof s.directory === "string" && s.directory ? s.directory : null;
      sessionParentID = typeof s.parentID === "string" && s.parentID ? s.parentID : null;
    }
    const parent = typeof s.parentID === "string" && s.parentID ? s.parentID : null;
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    const own = windowed(parent);
    if (own) {
      return { status: "ok", owner: { tmuxSession: own.tmuxSession }, displayParentID: parent, cwd: own.cwd ?? null, sessionParentID, directory };
    }
    cur = parent;
  }
  const byDir = ownerByDirectory(projects, directory);
  if (byDir) return { status: "ok", owner: byDir, displayParentID: sessionParentID, cwd: directory, sessionParentID, directory };
  return { status: "none" };
}

/** The newest record for a session: the one nothing supersedes (highest attempt as the tie-break). */
export function newestRecordFor(jobs, childSessionID) {
  const all = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.childSessionID === childSessionID);
  const live = all.filter((j) => !j.supersededBy);
  const pool = live.length > 0 ? live : all;
  return pool.reduce((best, j) => (!best || (j.attempt ?? 1) > (best.attempt ?? 1) || ((j.attempt ?? 1) === (best.attempt ?? 1) && (j.createdAt ?? 0) >= (best.createdAt ?? 0)) ? j : best), null);
}

/**
 * Adopt a session that already exists into the job store + a window.
 *
 * Under `sessionResources(childSessionID)` then `jobsLock`: a session with a non-terminal
 * record is already adopted. Otherwise a NEW record is appended — linked to the session's
 * newest terminal record, which this helper finds ITSELF (`continues` / `supersededBy`, the
 * worktree transferred when it still exists on disk) — and a window stamped with the
 * session is reused or created. opencode (or a script) owns the run and reports its own
 * result: `completionOwner:"opencode"`, so Manta never posts one.
 *
 * @param {{ childSessionID:string, owner:{tmuxSession:string}, displayParentID?:string|null, sessionParentID?:string|null,
 *           cwd?:string, parentDirectory?:string, name:string, prompt?:string, model?:string|null, origin:string, runStartedAt?:number }} input
 * @returns {Promise<{ok:true, job:object}|{ok:true, alreadyAdopted:true}|{ok:false, error:string}>}
 */
export async function adoptExistingSession(input, deps = {}) {
  const out = await adoptExistingSessionLocked(input, deps);
  if (out?.ok && out.job) {
    // The row's DISPLAY parent (rules + rationale: resolveDisplayParents). Outside the locks: it reads sessions and
    // may query opencode's DB; a failure leaves the row nesting by its real parent, exactly as before.
    try {
      const updated = (await refreshDisplayParents(deps, { onlyId: out.job.id })).get(out.job.id);
      if (updated) return { ...out, job: updated };
    } catch (e) {
      console.warn(`[delegate] resolving the display parent of ${out.job.childSessionID} failed:`, e?.message ?? e);
    }
  }
  return out;
}

async function adoptExistingSessionLocked(input, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, newWindow, stampOwner, listProjects, oc, now = () => Date.now() } = deps;
  const { childSessionID, owner, displayParentID = null, sessionParentID = null, name, prompt = "", model = null, origin, runStartedAt } = input ?? {};
  if (!childSessionID || !owner?.tmuxSession) return { ok: false, error: "childSessionID and an owning workspace are required" };

  return withSessionResources(childSessionID, () =>
    jobsLock.runExclusive(async () => {
      const jobs = await load();
      const records = jobs.filter((j) => j.childSessionID === childSessionID);
      // Idempotent — the detecting event / tick fires repeatedly.
      if (records.some((j) => !isTerminal(j))) return { ok: true, alreadyAdopted: true };
      const prev = newestRecordFor(records, childSessionID);
      // A late / replayed signal about a run that has already ended is not a new run.
      if (prev && runStartedAt != null && prev.finishedAt != null && runStartedAt < prev.finishedAt) {
        return { ok: true, alreadyAdopted: true, stale: true };
      }

      // Ownership transfer: the worktree travels with the session while it still exists.
      let worktree = null;
      let branch = null;
      let baseSha = null;
      if (prev?.worktree && (await pathExistsVia(deps, prev.worktree))) {
        worktree = prev.worktree;
        branch = prev.branch ?? null;
        baseSha = prev.baseSha ?? null;
      }

      // The window opens at the session's own directory; a finished delegate job's directory
      // (its removed worktree) may be gone, in which case it falls back to where the job began.
      let cwd = input.cwd || input.parentDirectory;
      if (cwd && !(await pathExistsVia(deps, cwd))) {
        for (const alt of [worktree, prev?.parentDirectory, input.parentDirectory]) {
          if (alt && alt !== cwd && (await pathExistsVia(deps, alt))) {
            cwd = alt;
            break;
          }
        }
      }

      let tmuxSession = owner.tmuxSession;
      let windowIndex = null;
      try {
        const projects = typeof listProjects === "function" ? await listProjects() : [];
        const stamped = findStampedWindow(projects, childSessionID); // by stamp, never by a recorded index
        if (stamped) {
          tmuxSession = stamped.tmuxSession;
          windowIndex = stamped.windowIndex;
        } else {
          const created = await newWindow({
            sessionName: tmuxSession,
            windowName: windowNameFor(name),
            cwd,
            chatMode: true,
            existingSessionId: childSessionID,
            worktreePath: worktree,
            oc,
          });
          windowIndex = created.windowIndex ?? null;
          if (!(created.sessionId ?? childSessionID)) throw new Error("could not read the new window's opencode session id");
        }
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
      // Advisory metadata (@manta-owner): a stamp failure must not fail the adoption.
      if (stampOwner && windowIndex != null) {
        try {
          await stampOwner(tmuxSession, windowIndex, "job");
        } catch {
          /* best-effort */
        }
      }

      const t = now();
      const job = {
        id: genId(),
        name,
        prompt,
        model: model ?? null,
        requestedModel: null,
        parentSessionID: displayParentID ?? null,
        parentDirectory: input.parentDirectory ?? cwd ?? null,
        childSessionID,
        tmuxSession,
        windowIndex,
        worktree,
        branch,
        baseSha,
        origin,
        link: null,
        actor: "user",
        correlation: null,
        sweepAllowanceMs: null,
        permission: null,
        status: "running",
        activity: null,
        createdAt: t,
        startedAt: t,
        finishedAt: null,
        result: null,
        error: null,
        filesChanged: null,
        engine: "v2",
        completionOwner: "opencode",
        attempt: prev ? (prev.attempt ?? 1) + 1 : 1,
        continues: prev?.id ?? null,
        sessionParentID: sessionParentID ?? null,
        runStartedAt: runStartedAt ?? t,
        launchState: "running",
        submittedAt: null,
        completionMessageId: null,
        completionDelivery: null,
      };
      const next = prev ? jobs.map((j) => (j.id === prev.id ? { ...j, supersededBy: job.id } : j)) : jobs;
      await save([...next, job]);
      if (prev) publish?.({ kind: "delegate.updated", payload: { id: prev.id, status: prev.status } });
      publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "running" } });
      return { ok: true, job };
    }),
  );
}

// ---------------------------------------------------------------------------
// Display parent — which session's row an adopted (opencode-owned) row nests under.
//
// `parentSessionID` keeps its meaning (result routing, listJobs, delegate_send ownership) and is NEVER
// touched here. `displayParentID` is a separate, display-only field: when the real parent has no window
// (an old orchestrator the user moved on from), the row would render top-level even though a live,
// windowed session is the one actually running the work. The renderer nests by
// `displayParentID ?? parentSessionID`.
// ---------------------------------------------------------------------------

// A driver is a session that named the child session's id within this long.
export const DRIVER_WINDOW_MS = 24 * 60 * 60_000;
const MAX_SUCCESSOR_HOPS = 8;

/**
 * The display parent of each of `targets` (opencode-owned records only; manta-owned ones are ignored).
 * First match wins; every candidate must have a window, in the SAME tmux workspace as the row (the sidebar
 * cannot nest across workspaces), and must not make the nesting a cycle:
 *   1. the nearest windowed ancestor of the child session (the existing walk);
 *   2. the replacement successor (handoff `replacedBy`, transitive, cycle-safe, max 8 hops) of the
 *      session's parent or of any ancestor — the live end of the chain that has a window;
 *   3. the driver: the windowed session whose own transcript most recently named the child session's id
 *      (tool-call input or output, any message type) within DRIVER_WINDOW_MS. One read-only DB task for
 *      the whole batch (`deps.findSessionReferences`); no DB / budget hit → this rule is skipped;
 *   4. none → null.
 *
 * `opts.projects` skips a second listProjects; `opts.driverFor(job)` (default: always) gates the DB rule per
 * record (the reconciler throttles it). A job whose rule-3 lookup was gated out or failed, and which rules
 * 1-2 did not settle, is ABSENT from the result (unknown — leave it alone), never reported as `null`.
 *
 * @returns {Promise<Map<string, {displayParentID: string|null, rule: 1|2|3|null}>>} keyed by job id
 */
export async function resolveDisplayParents(targets, deps = {}, opts = {}) {
  const out = new Map();
  const list = (Array.isArray(targets) ? targets : []).filter((j) => j?.childSessionID && completionOwnerOf(j) === "opencode");
  if (list.length === 0) return out;
  const now = deps.now ?? (() => Date.now());
  let projects = opts.projects;
  if (!projects) {
    if (typeof deps.listProjects !== "function") return out;
    try {
      projects = await deps.listProjects();
    } catch {
      return out;
    }
  }
  const workspaceOf = new Map(); // windowed session id -> tmux session
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const w of p.windows || []) if (w?.opencodeSessionId && !workspaceOf.has(w.opencodeSessionId)) workspaceOf.set(w.opencodeSessionId, p.tmuxSession);
  }
  let allJobs = [];
  try {
    allJobs = (await (deps.load ?? loadJobs)()) ?? [];
  } catch {
    /* no cycle guard from the store; the walk below still can't loop */
  }
  const recordOf = new Map();
  for (const j of allJobs) if (j?.childSessionID && !j.supersededBy) recordOf.set(j.childSessionID, j);

  const readParent = async (sid) => {
    let rs;
    try {
      rs = await deps.readSession?.(sid);
    } catch {
      return { known: false, parent: null };
    }
    if (rs?.state !== "found") return { known: false, parent: null };
    const parent = rs.session?.parentID;
    return { known: true, parent: typeof parent === "string" && parent ? parent : null };
  };
  const ancestorsOf = async (job) => {
    const chain = [];
    const seen = new Set([job.childSessionID]);
    let cur = job.childSessionID;
    const first = await readParent(cur);
    let parent = first.known ? first.parent : (job.sessionParentID ?? null);
    for (let depth = 0; parent && !seen.has(parent) && depth < MAX_ANCESTOR_DEPTH; depth++) {
      seen.add(parent);
      chain.push(parent);
      cur = parent;
      parent = (await readParent(cur)).parent;
    }
    return chain;
  };
  // Would nesting `job` under `sid` close a loop through the display parents of other rows?
  const loops = (job, sid) => {
    let cur = sid;
    for (let hops = 0; cur && hops <= MAX_ANCESTOR_DEPTH; hops++) {
      if (cur === job.childSessionID) return true;
      const rec = recordOf.get(cur);
      if (!rec) return false;
      cur = rec.displayParentID ?? rec.parentSessionID;
    }
    return false;
  };
  const acceptable = (job, sid) =>
    !!sid && sid !== job.childSessionID && workspaceOf.has(sid) && (!job.tmuxSession || workspaceOf.get(sid) === job.tmuxSession) && !loops(job, sid);
  const successorsOf = (sid) => {
    const chain = [];
    const seen = new Set([sid]);
    let cur = sid;
    for (let hops = 0; hops < MAX_SUCCESSOR_HOPS; hops++) {
      const next = deps.successorOf?.(cur);
      if (typeof next !== "string" || !next || seen.has(next)) break;
      seen.add(next);
      chain.push(next);
      cur = next;
    }
    return chain;
  };

  const pending = []; // rules 1-2 found nothing; rule 3 may
  for (const job of list) {
    const ancestors = await ancestorsOf(job);
    const own = ancestors.find((a) => acceptable(job, a));
    if (own) {
      out.set(job.id, { displayParentID: own, rule: 1 });
      continue;
    }
    let successor = null;
    for (const a of ancestors) {
      const live = successorsOf(a).filter((s) => acceptable(job, s));
      if (live.length > 0) {
        successor = live[live.length - 1];
        break;
      }
    }
    if (successor) {
      out.set(job.id, { displayParentID: successor, rule: 2 });
      continue;
    }
    pending.push(job);
  }

  const wanted = pending.filter((j) => (opts.driverFor ? opts.driverFor(j) : true));
  let found = null;
  if (wanted.length > 0 && workspaceOf.size === 0) {
    found = { hits: [], complete: true }; // no windowed session can be a driver
  } else if (wanted.length > 0 && typeof deps.findSessionReferences === "function") {
    try {
      found = await deps.findSessionReferences({
        sessionIds: [...workspaceOf.keys()],
        targets: wanted.map((j) => j.childSessionID),
        sinceMs: now() - DRIVER_WINDOW_MS,
      });
    } catch {
      found = null; // no DB / budget hit: this rule is skipped, never an error
    }
  }
  if (!found || !Array.isArray(found.hits)) return out;
  const descendsFrom = async (sid, ancestorID) => {
    const seen = new Set([sid]);
    let cur = sid;
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
      const { parent } = await readParent(cur);
      if (!parent || seen.has(parent)) return false;
      if (parent === ancestorID) return true;
      seen.add(parent);
      cur = parent;
    }
    return false;
  };
  const jobRowSessions = new Set(
    ((await (deps.load ?? loadJobs)()) ?? []).filter((j) => !isTerminal(j) && j.childSessionID).map((j) => j.childSessionID),
  );
  for (const job of wanted) {
    const hits = found.hits
      .filter((h) => h?.target === job.childSessionID && typeof h.sessionId === "string")
      .sort((a, b) => (b.t ?? 0) - (a.t ?? 0) || (a.sessionId < b.sessionId ? -1 : 1));
    let driver = null;
    for (const h of hits) {
      if (!acceptable(job, h.sessionId)) continue;
      // Another background row is never a driver: its own row is nested, so a child under it would not render,
      // and a builder that merely mentions a sibling's id is not running it.
      if (jobRowSessions.has(h.sessionId)) continue;
      if (await descendsFrom(h.sessionId, job.childSessionID)) continue;
      driver = h.sessionId;
      break;
    }
    if (driver) out.set(job.id, { displayParentID: driver, rule: 3 });
    else if (found.complete !== false) out.set(job.id, { displayParentID: null, rule: null });
  }
  return out;
}

/** The display parent of one record (see resolveDisplayParents). */
export async function resolveDisplayParent(job, deps = {}, opts = {}) {
  return (await resolveDisplayParents([job], deps, opts)).get(job?.id) ?? null;
}

/**
 * Recompute the display parent of every live opencode-owned record whose CURRENT display parent
 * (`displayParentID ?? parentSessionID`) has no window, and patch the ones that changed (a record whose
 * display parent has a window is left alone: stable rows, no flapping). Never touches `parentSessionID` or a
 * manta-owned record. `onlyId` limits it to one record (adoption); `driverFor` gates the DB rule per record.
 * @returns {Promise<Map<string, object>>} the patched records by id
 */
export async function refreshDisplayParents(deps = {}, { onlyId = null, driverFor } = {}) {
  const patched = new Map();
  if (typeof deps.listProjects !== "function") return patched;
  const jobs = (await (deps.load ?? loadJobs)()) ?? [];
  let projects;
  try {
    projects = await deps.listProjects();
  } catch {
    return patched;
  }
  const windowed = new Set();
  for (const p of Array.isArray(projects) ? projects : []) for (const w of p.windows || []) if (w?.opencodeSessionId) windowed.add(w.opencodeSessionId);
  const targets = jobs.filter(
    (j) =>
      !isTerminal(j) &&
      !j.supersededBy &&
      j.childSessionID &&
      completionOwnerOf(j) === "opencode" &&
      (onlyId == null || j.id === onlyId) &&
      !windowed.has(j.displayParentID ?? j.parentSessionID),
  );
  if (targets.length === 0) return patched;
  const resolved = await resolveDisplayParents(targets, deps, { projects, driverFor });
  for (const job of targets) {
    const r = resolved.get(job.id);
    if (!r) continue;
    const before = job.displayParentID ?? null;
    if (r.displayParentID === before) continue;
    const next = await patchJob(job.id, { displayParentID: r.displayParentID }, deps, {
      onlyIf: (live) => !isTerminal(live) && completionOwnerOf(live) === "opencode" && (live.displayParentID ?? null) === before,
    });
    if (next) patched.set(job.id, next);
  }
  return patched;
}

/**
 * Resolve a caller-NAMED delegate `model` (BET-1275 11b). A named model is the
 * OFF SWITCH for Auto routing — the caller decided, and Auto only ever fills
 * silence — so the caller's choice is honoured verbatim and never routed over.
 *
 * A named model must STILL respect the user's Sub ticks (rule 3): the value is
 * validated against the SUB-ticked (routable) catalogue
 * (`listRoutableModels("sub", …)`), so a model the user unticked / deactivated
 * fails LOUDLY naming the closest candidates rather than silently running on
 * it. An empty catalogue (no routable models available / `listModels`
 * unavailable) has nothing to validate against — a structured `{providerID,
 * modelID}` passes through exactly as it did before the Sub rule existed.
 *
 * A structured `{providerID, modelID, variant?}` value is accepted as-is
 * (skips matching — a caller can send this shape). Free text is matched with
 * the SHARED fuzzy matcher (src/shared/modelGuide.mjs — the same one
 * app-control uses for manta_switch_model; do not write a second matcher).
 *
 * @param {string|{providerID:string, modelID:string, variant?:string}} model
 * @param {Array<object>} catalog  the Sub-ticked routable catalogue
 * @returns {{providerID:string, modelID:string, variant?:string}}
 * @throws {Error} naming the closest candidates when `model` matches nothing
 *   in the routable catalogue.
 */
export function resolveNamedModel(model, catalog) {
  const src = Array.isArray(catalog) ? catalog : [];
  if (model && typeof model === "object" && !Array.isArray(model)) {
    if (
      typeof model.providerID === "string" &&
      model.providerID &&
      typeof model.modelID === "string" &&
      model.modelID
    ) {
      const structured = { providerID: model.providerID, modelID: model.modelID };
      if (typeof model.variant === "string" && model.variant) {
        structured.variant = model.variant;
      }
      if (src.length > 0) {
        const present = src.some(
          (c) => c?.providerID === structured.providerID && c?.id === structured.modelID,
        );
        if (!present) {
          throw new Error(unroutableError(structured, src));
        }
      }
      return structured;
    }
    throw new Error("model must be free text or an object with string providerID and modelID.");
  }
  const query = typeof model === "string" ? model.trim() : "";
  if (!query) throw new Error("model must be free text or an object with string providerID and modelID.");
  const resolved = fuzzyMatchModel(query, src);
  if (!resolved) {
    throw new Error(noMatchError(model, src));
  }
  return { providerID: resolved.providerID, modelID: resolved.id };
}

function candidateHint(query, src) {
  const suggestions = suggestModels(query, src, 3);
  if (!suggestions.length) return "";
  return ` Closest routable models: ${suggestions.map((s) => `${s.providerID}/${s.id}`).join(", ")}.`;
}

function noMatchError(model, src) {
  const suggestions = suggestModels(String(model).trim(), src, 3);
  const hint = suggestions.length
    ? ` Closest models: ${suggestions.map((s) => `${s.providerID}/${s.id}`).join(", ")}.`
    : " No models are currently routable (ticked) on this box.";
  return `No model matched "${model}".${hint}`;
}

function unroutableError(structured, src) {
  const hint = candidateHint(structured.modelID, src);
  return `Model "${structured.providerID}/${structured.modelID}" is not routable on this box (unticked or deactivated).${hint}`;
}

/**
 * THE single routing decision point for a subagent/delegate spawn (BET-1220).
 *
 * This wrapper hands `chooseModel` the subagent intent (agent + tool needs +
 * `incumbent` = whatever model the caller would have used today) and returns
 * the model to actually run on. It shares its `chooseModel` argument builder
 * with the subagent path's other caller so they can never diverge. Note: it is
 * NOT the only module that calls `chooseModel` — rpc.mjs's `routing:choose`
 * calls it directly (it carries a caller-supplied surface + needs). The
 * wrappers share ONE builder; the RPC
 * builds its own intent for its different surface.
 *
 * Provably safe on the off-path: when the policy has no routing directive (no
 * preset — a conversation that has not asked to route), `chooseModel` returns
 * `incumbent` exactly — so a spawn is byte-identical to today's. And any
 * throw inside the routing is swallowed, falling back to `incumbent`, so a
 * routing failure can never fail a spawn.
 *
 * BET-1535 (S3): the ONE exception to never-fail is the router's typed health
 * verdict — when routing was active and every candidate is health-excluded,
 * this wrapper THROWS `Error` with `.code = "no-healthy-endpoint"` and
 * `.excluded` (endpoint keys) so the caller fails its operation instead of
 * dispatching on a model the router knows is dead. startJob refuses the spawn
 * before any window exists; the CTO's defaultResolveModel lets it fail the run.
 *
 * @param {object} [input]
 * @param {object|null} [input.incumbent]  the model the code would have used today
 * @param {Array<object>} [input.catalog]  opencode model list
 * @param {{ preset?: string, perAgent?: Record<string,string> }} [input.policy]
 * @param {string} [input.agent]           subagent type (default "general")
 * @param {number} [input.nowMs]
 * @returns {object|null} the model to run on (incumbent on off-path / failure)
 * @throws {Error} code "no-healthy-endpoint" when the router's verdict fires
 */
// The model deliver()/sendPrompt() accept is the structured shape
// {providerID, modelID} (opencode's sendPrompt reads `model.modelID`). A
// catalog winner carries `.id`, not `.modelID` — so a routed winner has to be
// normalised into the deliver shape or the model override is silently dropped.
// This is a no-op for the requested-model incumbent (which is already
// {providerID, modelID}). Shared by both routing wrappers below so the two
// decision points normalise identically.
export function toDeliverModel(m) {
  if (!m) return null;
  const providerID = m?.providerID ?? "";
  const modelID = m?.modelID ?? m?.id ?? "";
  if (!providerID || !modelID) return null;
  const out = { providerID, modelID };
  if (typeof m?.variant === "string" && m.variant) out.variant = m.variant;
  return out;
}

// A subagent spawn starts with a fresh context — there is no conversation to
// fit into the headroom check yet, so its contextTokens is legitimately 0.
// Named, not a bare literal, so the intent is explicit (BET-1267 3b).
const SUBAGENT_INITIAL_CONTEXT_TOKENS = 0;

// The default routing agent for a delegate spawn (BET-1275 11a). A delegate may
// carry a `subagent_type` — the job's own intent declaration — and routing must
// apply that agent's tier floor; an absent / empty / non-string value falls back
// to this general agent. Named constant, not a bare literal.
const DEFAULT_SUBAGENT_AGENT = "general";

// Resolve a delegate job's requested subagent type for the router (11a). The
// subagent type IS the intent declaration ("the agent already is the intent
// declaration" — the whole argument against a prompt classifier), so any
// non-empty string is passed through verbatim as the routing agent; only an
// absent/blank/non-string value maps to the general agent.
function resolveSubagentAgent(raw) {
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t) return t;
  }
  return DEFAULT_SUBAGENT_AGENT;
}

// The incumbent projected into catalog shape ({providerID, id}) so chooseModel's
// `changed` comparison / modelKey() treat a requested model and a catalog entry
// of the same model as equal. Shared so the builder and the wrappers can never
// project it differently.
function catalogIncumbentOf(incumbent) {
  return incumbent ? { providerID: incumbent.providerID, id: incumbent.modelID ?? incumbent.id } : null;
}

// Shared argument-builder for the subagent routing wrapper (BET-1275 11d).
// chooseSubagentModel hands chooseModel the same intent shape as the main
// path did before the mount-time main route was deleted — this is what kept the
// main-conversation and subagent paths from diverging (they disagreed on
// `needs.tools` in the real-facts issue). routing:choose in rpc.mjs builds its
// own intent because it carries a caller-supplied surface + needs, but this
// subagent wrapper uses this one builder so its own callers cannot diverge again.
function buildChooseModelInput({ kind, agent, needs, contextTokens, incumbent, catalog, policy, nowMs, services }) {
  return {
    intent: { kind, agent, needs, contextTokens, incumbent: catalogIncumbentOf(incumbent) },
    catalog,
    policy,
    nowMs,
    services,
  };
}

export function chooseSubagentModel({
  incumbent = null,
  catalog = [],
  policy = {},
  agent = DEFAULT_SUBAGENT_AGENT,
  nowMs = Date.now(),
  contextTokens = SUBAGENT_INITIAL_CONTEXT_TOKENS,
  services,
} = {}) {
  // The ORIGINAL structured incumbent is preserved and returned on the off-path;
  // its {providerID, id} projection is passed to chooseModel so the `changed`
  // comparison / modelKey() treat a requested model and a catalog entry of the
  // same model as equal.
  let decision;
  try {
    decision = chooseModel(
      buildChooseModelInput({
        kind: "subagent",
        agent,
        needs: { tools: true },
        contextTokens,
        incumbent,
        catalog,
        policy,
        nowMs,
        services,
      }),
    );
  } catch (e) {
    // Routing must never break a spawn — fall back to the incumbent model.
    console.warn("[router] subagent routing failed, using incumbent:", e?.message ?? e);
    return incumbent;
  }
  console.log(describeDecision(decision, { surface: "sub", agent }));
  // BET-1535 (S3): a no-healthy-endpoint verdict is a typed failure, not a
  // model. It must reach the operation — the spawn refuses (before any window
  // exists) and the CTO resolver fails the run — instead of silently
  // substituting the incumbent (possibly the excluded endpoint) or the box
  // default. The never-throw contract covers routing EXCEPTIONS only (caught
  // above, incumbent returned); the verdict propagates as a typed error the
  // callers distinguish by `code`.
  if (decision?.kind === "no-healthy-endpoint") {
    const err = new Error(decision?.reason || "no healthy endpoint available");
    err.code = "no-healthy-endpoint";
    err.excluded = Array.isArray(decision?.excluded) ? decision.excluded : [];
    // W8 self-doubt input (BET-1536): true when EVERY drop was a health drop
    // — health excluded everything the tier had, so the health model itself
    // may be wrong. The caller raises the alarm on the final fail-closed.
    err.healthOnly = decision?.healthOnly === true;
    throw err;
  }
  // On the off-path / no-survivors path chooseModel returns the very
  // catalogIncumbent it was handed; map that back to the original
  // structured incumbent so the deliver call stays byte-identical to today.
  // A real catalog winner is normalised into the {providerID, modelID} shape
  // sendPrompt expects.
  const model =
    decision?.model === catalogIncumbentOf(incumbent)
      ? incumbent
      : toDeliverModel(decision?.model ?? incumbent);
  return model;
}

// The two refusals every launch checks before it creates anything: nesting (no
// background job from inside a background job's session) and the box-wide cap.
// A session Manta merely observes (origin "observed") neither counts toward the cap nor
// makes its session a "background job" for nesting purposes.
function launchRefusal(jobs, parentSessionID) {
  if (jobs.find((j) => j.childSessionID === parentSessionID && countsTowardCap(j))) {
    return { ok: false, error: "a background job cannot start another background job" };
  }
  if (jobs.filter(countsTowardCap).length >= MAX_RUNNING_JOBS) {
    return { ok: false, error: CAP_ERROR };
  }
  return null;
}

// The job name — an explicit `name` (e.g. the work item's objective, so CTO
// workers aren't all "you-are-the-implementation") wins over the first words of
// the prompt.
function jobNameFor(input, prompt) {
  return (typeof input?.name === "string" && slugifyProjectName(input.name.trim().split(/\s+/).slice(0, 6).join(" "))) ||
    deriveName(prompt);
}

// Create the job's worktree + record its baseSha. A worktree failure continues
// with worktree = branch = baseSha = null and cwd = parentDirectory — UNLESS the
// caller demands isolation (§8.1: for implementation work, isolationRequired is
// true and a worktree failure must fail BEFORE prompting, never fall back to the
// original repository directory), which returns `{ refusal }`.
async function prepareWorktree({ input, name, parentDirectory }, deps) {
  const { gitAddWorktree, gitRun } = deps;
  let worktree = null;
  let branch = null;
  let baseSha = null;
  let cwd = parentDirectory;
  try {
    const wt = await gitAddWorktree({ cwd: parentDirectory, name });
    worktree = wt.path;
    branch = wt.branch;
    cwd = wt.path;
  } catch (e) {
    if (input?.isolationRequired) {
      return {
        refusal: {
          ok: false,
          code: "worktree_failed",
          error:
            `worktree creation failed, refusing to fall back to the original repository directory ` +
            `(isolationRequired): ${e?.message ?? e}`,
        },
      };
    }
    worktree = null;
    branch = null;
    baseSha = null;
    cwd = parentDirectory;
  }
  if (worktree) {
    try {
      const { stdout } = await gitRun(["-C", worktree, "rev-parse", "HEAD"]);
      baseSha = String(stdout ?? "").trim() || null;
    } catch {
      baseSha = null;
    }
  }
  return { worktree, branch, baseSha, cwd };
}

/**
 * @param {{prompt:string, model?:string|{providerID:string, modelID:string, variant?:string}, modelHint?:string|{providerID:string, modelID:string, variant?:string}, subagent_type?:string, parentSessionID:string, parentDirectory:string,
 *          link?: {issue?:{repoKey:string,number:number}, pr?:{repoKey:string,number:number}}|null}} input
 *        `model` (BET-947, BET-1275 11b) — optional model for the job's session:
 *        free text resolved via the shared fuzzy matcher, or a structured
 *        {providerID, modelID, variant?} used as-is. A named model is the OFF
 *        SWITCH for Auto routing (never routed over) and must still be in the
 *        user's Sub-ticked (routable) set — an un-ticked / deactivated /
 *        unmatchable value fails the delegation loudly naming candidates.
 *        `modelHint` — optional SUGGESTED model (same forms as `model`). Unlike
 *        `model` it does NOT switch Auto off: it is the router's incumbent, so
 *        usage-aware routing may replace it. Used by the CTO for models it
 *        chose itself (only a user-named model is passed as `model`).
 *        `subagent_type` (BET-1275 11a) — the job's own intent declaration; Auto
 *        routing applies this agent's tier floor instead of a hardcoded
 *        "general". Absent/blank maps to "general".
 *        `link` (BET-844) — the optional session link (at most one issue + one
 *        PR, `{issue?, pr?}` shape) a forge-triggered delegate carries so the
 *        progress sink addresses the linked issue/PR. Stored on the job record.
 * @param {object} deps injected I/O (load/save/publish/listProjects/newWindow/
  *        createChildSession/moveSession/sendChildPrompt/gitAddWorktree/gitRun/
  *        listMessages/listModels/now; routingServices/catalogIndex/
  *        providerHealthState/endpointSummary/pacing for the router;
  *        chooseSubagentModel only as a test seam)
 */
export async function startJob(input, deps = {}) {
  const { listModels, configGet = async () => ({}), listSnapshots = () => [] } = deps;
  // listRoutableModels defaults its `models` argument to the REAL opencode.mjs
  // listModels whenever it is handed `undefined` — so passing an absent reader
  // through would hit a live box (or the wrong reader in a test). Guard it: an
  // absent reader means an EMPTY catalogue (a named structured model then
  // passes through exactly as it did before Sub-validation), never a live call.
  const listModelsSafe = typeof listModels === "function" ? listModels : async () => [];

  const prompt = String(input?.prompt ?? "");
  const parentSessionID = input?.parentSessionID;
  const parentDirectory = input?.parentDirectory;

  if (!parentSessionID) return { ok: false, error: "parentSessionID is required" };
  if (!parentDirectory) return { ok: false, error: "parentDirectory is required" };

  // Gather the routing inputs ONCE, up front. They serve BOTH the named-model
  // path (11b — a named model is validated against the Sub-ticked catalogue,
  // and that must happen BEFORE a window is created so a rejection orphans
  // nothing) and the routing path (11a — the route button only fills silence).
  // Every read is individually guarded so a failure can never break a spawn;
  // an absent value degrades to "no routing config / empty catalogue".
  let cfg = {};
  try {
    cfg = (await configGet()) ?? {};
  } catch {
    cfg = {};
  }
  let policy = {};
  try {
    policy = cfg.modelRouting ?? {};
  } catch {
    policy = {};
  }
  let quota = [];
  try {
    quota = listSnapshots();
    if (!Array.isArray(quota)) quota = [];
  } catch {
    quota = [];
  }
  let catalog = [];
  try {
    catalog = await listRoutableModels("sub", cfg, listModelsSafe);
    if (!Array.isArray(catalog)) catalog = [];
  } catch {
    catalog = [];
  }

  // Resolve the requested model once, up front (11b). A caller-NAMED model is
  // the off switch for Auto routing — Auto only ever fills silence — so it is
  // honoured verbatim and never routed over. It must STILL respect the user's
  // Sub ticks (rule 3), so it is validated against the Sub-filtered catalogue
  // and an un-ticked / deactivated / unmatchable value fails the delegation
  // LOUDLY (naming the closest candidates) rather than silently running on it.
  // A missing model leaves both null — the box default, byte-identical to today.
  let requestedModel = null;
  let deliverModel = null;
  if (input?.model) {
    try {
      deliverModel = resolveNamedModel(input.model, catalog);
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
    requestedModel = `${deliverModel.providerID}/${deliverModel.modelID}`;
  }

  // A model HINT (distinct from a named model): a caller's own suggestion —
  // e.g. the CTO picking a worker model on its own initiative — that Auto
  // routing may override. It is NOT the off switch. It becomes the router's
  // incumbent, so with routing off (or no survivor) the job runs on it exactly
  // as a named model would, and with routing on the usage-aware router decides
  // (a nearly-depleted provider loses to one with headroom). An unmatchable /
  // unticked hint is dropped with a log rather than failing the spawn — it was
  // only ever a suggestion. Ignored when a named `model` is also present.
  let hintModel = null;
  if (!input?.model && input?.modelHint) {
    try {
      hintModel = resolveNamedModel(input.modelHint, catalog);
    } catch (e) {
      console.warn(`[delegate] model hint ignored (${e?.message ?? e}); routing without it`);
      hintModel = null;
    }
  }

  // BET-1535 (S3): the ROUTING decision also happens BEFORE a window is
  // created, so a no-healthy-endpoint verdict refuses the spawn cleanly and
  // orphans nothing (the same principle as the 11b named-model rejection
  // above: a rejection must never leave a created window behind). The inputs
  // are the same gathered-at-the-top routing readers; every read is guarded
  // exactly as before, and any routing exception still degrades to the box
  // default (routing never breaks a spawn — only the typed health verdict does).
  let routedModel = null;
  if (!input?.model) {
    const route = deps?.chooseSubagentModel ?? chooseSubagentModel;
    const resolveRoute = async () => {
      // One injected clock for this decision (rolling-window edge + TTL timestamp
      // in buildRoutingServices, and the router's own ordering) — same instant.
      const nowMs = Date.now();
      // Build the router's RoutingServices context from live box state (BET-1252).
      // `deps.routingServices` (test injection) is used verbatim when present;
      // otherwise the box-side builder assembles catalogue + accounts + health +
      // declared + reliability from the readers in `deps`. Every reader inside
      // buildRoutingServices is individually guarded, and the whole assembly is
      // wrapped so a failure degrades to absent services — but it must NEVER
      // degrade SILENTLY (11e): "no services" reads as "no model passes
      // constraints", so a degraded build logs once with the error message.
      let services = deps?.routingServices;
      if (!services) {
        try {
          services = await buildRoutingServices(cfg, {
            catalogIndex: deps.catalogIndex,
            endpoints: catalog,
            snapshots: quota,
            providerHealthState: deps.providerHealthState,
            endpointHealthSnapshot: deps.endpointHealthSnapshot,
            endpointSummary: deps.endpointSummary,
            pacing: deps.pacing,
          }, nowMs);
        } catch (e) {
          console.error(`[router] routing services degraded, routing on absent context: ${e?.message ?? e}`);
          services = null;
        }
      }
      return route({
        incumbent: hintModel,
        catalog,
        policy,
        agent: resolveSubagentAgent(input?.subagent_type),
        nowMs,
        services,
      });
    };
    let verdictErr = null;
    try {
      routedModel = await resolveRoute();
    } catch (e) {
      // The typed health verdict (BET-1535) is not a routing exception — it
      // FAILS the spawn with that reason instead of delivering on a model the
      // router knows is dead. Any other throw is the belt-and-braces guard so
      // an injected route stub can never break a spawn.
      if (e?.code === "no-healthy-endpoint") verdictErr = e;
      else console.error("[router] subagent routing threw, using default:", e?.message ?? e);
    }
    // W8 anti-brick (BET-1536): before failing closed, ONE bounded
    // last-resort probe runs against the least-recently-failed excluded
    // endpoint (once, subject to that endpoint's own backoff). A pass lifts
    // the exclusion and the spawn proceeds normally; a fail is recorded and
    // the refusal surfaces below.
    if (!routedModel && verdictErr) {
      const engine = deps?.endpointHealth ?? null;
      let recovered = false;
      if (engine && typeof engine.lastResortRecovery === "function") {
        try {
          recovered = await engine.lastResortRecovery(verdictErr.excluded);
        } catch {
          recovered = false; // a probe failure must never break the refusal
        }
      }
      if (recovered) {
        verdictErr = null;
        try {
          routedModel = await resolveRoute(); // one re-route with fresh services
        } catch (e2) {
          if (e2?.code === "no-healthy-endpoint") verdictErr = e2;
          else console.error("[router] subagent routing threw after recovery, using default:", e2?.message ?? e2);
        }
      }
    }
    // A routing exception (not the health verdict) degrades to the hint when
    // one was given — the same "fall back to the incumbent" contract
    // chooseSubagentModel applies internally — rather than the box default.
    if (!routedModel && !verdictErr && hintModel) routedModel = hintModel;
    // Final fail-closed + the W8 self-doubt alarm: a verdict where EVERY drop
    // was a health drop means the health model may simply be wrong — fail
    // closed AND say so (ledger row).
    if (!routedModel && verdictErr) {
      const engine = deps?.endpointHealth ?? null;
      if (verdictErr.healthOnly === true && engine && typeof engine.raiseSelfDoubtAlarm === "function") {
        try {
          await engine.raiseSelfDoubtAlarm({ excluded: verdictErr.excluded, reason: verdictErr.message });
        } catch { /* never break the refusal on the alarm */ }
      }
      const excluded = Array.isArray(verdictErr?.excluded) && verdictErr.excluded.length > 0 ? ` (excluded: ${verdictErr.excluded.join(", ")})` : "";
      return {
        ok: false,
        code: "no-healthy-endpoint",
        error: `[router] ${verdictErr?.message ?? "no healthy endpoint available"}${excluded}`,
      };
    }
  }

  const effectiveModel = input?.model ? deliverModel : routedModel;

  // Every job — the CTO's workers included — is a real V2 child session moved
  // into its worktree, completing from raw execution outcomes.
  return startJobV2({ input, prompt, parentSessionID, parentDirectory, requestedModel, effectiveModel }, deps);
}

// ---------------------------------------------------------------------------
// adoptSubagentJob — promote an opencode background subagent (or a native
// background command) into a job row (BET-721). opencode has ALREADY started the
// child session, so this entry point resolves where its row belongs and adopts the
// session (adoptExistingSession) rather than creating anything. The detecting event
// fires repeatedly as the tool part updates, so adoption is idempotent.
// ---------------------------------------------------------------------------

/**
 * @param {{parentSessionID:string, parentDirectory?:string, childSessionID:string,
 *          name:string, prompt:string, model?:string|null, origin?:string, runStartedAt?:number}} input
 * @param {object} deps injected I/O (load/save/publish/newWindow/listProjects/readSession …)
 * @returns {Promise<{ok:true, job:object}|{ok:true, alreadyAdopted:true}|{ok:false, error:string, none?:true, unknown?:true}>}
 */
export async function adoptSubagentJob(
  { parentSessionID, parentDirectory, childSessionID, name, prompt, model, origin = "subagent", runStartedAt },
  deps = {},
) {
  const { load = loadJobs, now = () => Date.now() } = deps;

  if (!parentSessionID || !childSessionID) {
    return { ok: false, error: "parentSessionID and childSessionID are required" };
  }

  // The detecting event repeats: don't resolve an owner for a child that already has a live row.
  {
    const jobs = await load();
    if (jobs.some((j) => j.childSessionID === childSessionID && !isTerminal(j))) return { ok: true, alreadyAdopted: true };
  }

  // The parent may have no window of its own (a session driven through the API): the row
  // nests under its nearest windowed ancestor, else lands in the workspace owning its directory.
  const res = await resolveSessionOwner(parentSessionID, deps, { includeSelf: true });
  if (res.status === "unknown") return { ok: false, unknown: true, error: "could not read the owning session — will retry" };
  if (res.status === "none") return { ok: false, none: true, error: `could not resolve the tmux session owning ${parentSessionID}` };

  // The child's window opens at the child's own directory (it inherits the parent's, unless it was moved).
  let cwd = res.cwd ?? parentDirectory ?? null;
  if (typeof deps.readSession === "function") {
    try {
      const rs = await deps.readSession(childSessionID);
      if (rs?.state === "found" && typeof rs.session?.directory === "string" && rs.session.directory) cwd = rs.session.directory;
    } catch {
      /* the owner's directory stands */
    }
  }

  // We deliberately do NOT enforce MAX_RUNNING_JOBS and do NOT enforce the no-nesting rule:
  // opencode has already started this session, so refusing to record it would only make it
  // invisible. No worktree is created and no prompt is sent — the session is adopted.
  const adopted = await adoptExistingSession(
    {
      childSessionID,
      owner: res.owner,
      // (a parent with no window of its own still names the row's parent: it renders top-level)
      displayParentID: res.displayParentID ?? parentSessionID,
      sessionParentID: parentSessionID,
      cwd: cwd ?? undefined,
      parentDirectory: parentDirectory ?? res.cwd ?? undefined,
      name,
      prompt,
      model: model ?? null,
      origin,
      runStartedAt: runStartedAt ?? now(),
    },
    deps,
  );

  // No lost lifecycle: a child that finished before it was adopted settles at once, from
  // authoritative reads (current activity + an outcome that belongs to THIS run — a resumed
  // session's previous outcome can no longer finish its new record).
  if (adopted.ok && adopted.job) {
    const seen = typeof deps.lifecycleGet === "function" ? deps.lifecycleGet(childSessionID) : null;
    try {
      await settleV2Job(adopted.job, deps, { hint: seen ? { outcome: seen.outcome, error: seen.error, at: seen.at } : undefined });
    } catch (e) {
      console.warn(`[delegate] settling the adopted session ${childSessionID} failed:`, e?.message ?? e);
    }
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// observeEvent — the lifecycle-adapted opencode stream, called by the pump.
//
// It does NOT complete jobs (that is observeRaw → settleV2Job, from the raw
// execution outcome, which tells an interrupt from success). It does two things:
// adopt a background `task` subagent into the job store, and tell a pausing
// job where its tool-step boundary is.
// ---------------------------------------------------------------------------

/**
 * @param {object} evt an opencode event
 * @param {object} deps { load, listProjects, newWindow, abortSession, … }
 */
// Everything but a part update is a no-op, so it must return BEFORE loading the
// job store — that load is a synchronous read + parse of delegate-jobs.json, and
// doing it per streamed token ran it ~40×/s.
export async function observeEvent(evt, deps = {}) {
  const sid = evt?.properties?.sessionID;
  if (typeof sid !== "string" || !sid) return;
  if (evt?.type !== "message.part.updated") return;
  const { load = loadJobs } = deps;

  // BET-721: passively adopt a background subagent into the job store so it
  // appears as a nested sidebar row. Detection is passive (events never carry
  // `background:true` unless the capability is on) and must never throw into
  // the pump.
  try {
    const info = extractSubagentInfo(evt?.properties?.part);
    // A `task` tool part naming a child CLAIMS it (provisional adoption of a
    // command's child waits for exactly this): foreground → inline only,
    // background → the adoption just below.
    if (info?.childSessionId) deps.onSubagentClaim?.(info.childSessionId, info.background === true);
    if (
      info &&
      info.background === true &&
      (info.status === "running" || info.status === "pending")
    ) {
      const startedAt = Number(evt?.properties?.part?.state?.time?.start);
      const res = await adoptSubagentJob(
        {
          parentSessionID: evt?.properties?.sessionID,
          childSessionID: info.childSessionId,
          name: info.description || info.agent,
          prompt: info.prompt,
          model: info.model ? `${info.model.providerID}/${info.model.modelID}` : null,
          ...(Number.isFinite(startedAt) && startedAt > 0 ? { runStartedAt: startedAt } : {}),
        },
        deps,
      );
      if (res?.none) {
        warnOnce(
          `no-owner:${info.childSessionId}`,
          "[delegate] could not resolve the owning workspace to adopt background subagent:",
          info.childSessionId,
          "parent=", evt?.properties?.sessionID,
        );
      }
      return;
    }
  } catch (e) {
    console.warn("[delegate] background-subagent adoption failed:", e?.message ?? e);
  }

  // A pause was requested and this running job's child just finished a tool: its
  // step boundary. Only the interrupt happens here — the child's raw
  // `interrupted` outcome is what parks the job (finishV2Job).
  const job = (await load()).find((j) => j.childSessionID === sid && j.status === "running");
  if (job?.pauseRequested && isToolStepBoundary(evt?.properties?.part)) {
    await interruptForPause(job, deps);
  }
}

// ---------------------------------------------------------------------------
// Result helpers shared by every terminal transition (finishV2Job).
// ---------------------------------------------------------------------------

async function lastAssistantText(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.info?.role !== "assistant") continue;
    let text = "";
    for (const p of m?.parts || []) {
      if (p?.type === "text" && typeof p.text === "string") text += p.text;
    }
    text = text.trim();
    if (text) return text;
  }
  return "";
}

async function countFilesChanged(job, deps) {
  if (!job.worktree || !job.baseSha) return null;
  const { gitRun } = deps;
  let committed = 0;
  try {
    const { stdout } = await gitRun([
      "-C", job.worktree, "diff", "--name-only", `${job.baseSha}..HEAD`,
    ]);
    committed = (String(stdout ?? "").split("\n").filter((l) => l.length > 0)).length;
  } catch {
    committed = 0;
  }
  let uncommitted = 0;
  try {
    const { stdout } = await gitRun(["-C", job.worktree, "status", "--porcelain"]);
    uncommitted = parseGitStatus(stdout).count;
  } catch {
    uncommitted = 0;
  }
  return committed + uncommitted;
}

// ---------------------------------------------------------------------------
// Terminal cleanup (BET-418 §B)
//
// On terminal status a job's tmux window AND git worktree are removed — the
// artefact is the branch, and a branch lives in git without a worktree. A
// DIRTY worktree is the one exception: uncommitted work is NOT disposable, so
// the worktree removal is attempted with force:false and, on refusal, BOTH
// the window and the worktree are kept (and the job record is kept too, so
// the window stays recognisable as a job instead of silently reappearing as
// an ordinary top-level session). NEVER pass force:true.
//
// Order: try the worktree removal FIRST. Only when it succeeds (or there is
// no worktree) do we kill the window — killing the window first would leave a
// dirty worktree behind with no window to recognise it as a job (the leak).
//
// Returns { cleanedUp: true } when the window + worktree were removed, or
// { cleanedUp: false, reason: "dirty" } when the dirty worktree kept both.
// Pure-ish: all I/O is injected; exported for unit tests.
// ---------------------------------------------------------------------------
export async function cleanupTerminalJob(job, deps = {}) {
  // A continued session's window and worktree belong to its NEWEST run: under the session's
  // resource lock the LIVE record decides, and a superseded one touches nothing.
  return withSessionResources(job?.childSessionID, async () => {
    const live = ((await (deps.load ?? loadJobs)()) ?? []).find((j) => j.id === job?.id);
    if (live?.supersededBy) return { cleanedUp: true, superseded: true };
    return cleanupTerminalJobLocked(job, deps);
  });
}

// The body of cleanupTerminalJob; the caller holds sessionResources(job.childSessionID).
async function cleanupTerminalJobLocked(job, deps = {}) {
  const { gitRemoveWorktree } = deps;
  if (job?.worktree && gitRemoveWorktree) {
    try {
      const res = await gitRemoveWorktree({ path: job.worktree, force: false });
      if (res && res.removed === false && res.reason === "dirty") {
        // Keep both the worktree AND the window; the record stays so the
        // window remains recognisable as a job.
        return { cleanedUp: false, reason: "dirty" };
      }
    } catch (e) {
      console.warn(`[delegate] cleanup gitRemoveWorktree failed for ${job?.id}:`, e?.message ?? e);
      // A failed remove leaves the worktree on disk; keep the window too so
      // the worktree stays reachable/recognisable.
      return { cleanedUp: false, reason: "remove-failed" };
    }
  }
  await closeJobWindowLocked(job, deps);
  return { cleanedUp: true };
}

// ---------------------------------------------------------------------------
// Activity summaries — a 10s poller updates `activity` for running jobs only.
// Reuses summarizeTranscript(messages) then describeChatActivity(summary),
// both from peers.mjs. No model call. No Groq. No new config.
//
// `tickActivity` is exported for unit tests; the poller wrapper
// (startActivityPoller) retains the inFlight re-entrancy guard + timer.unref.
// ---------------------------------------------------------------------------

/**
 * Last message that names a model → "providerID/modelID", else null. The
 * messages are opencode transcript entries whose `info` carries optional
 * providerID/modelID. Guarded for a non-array argument and for messages
 * with no `info`. Used by tickActivity to stamp the effective model on a job
 * record (the model the child actually used, observed from its own messages).
 */
export function effectiveModelFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (
      info &&
      typeof info.providerID === "string" &&
      typeof info.modelID === "string"
    ) {
      return `${info.providerID}/${info.modelID}`;
    }
  }
  return null;
}

export async function tickActivity(deps) {
  const { load = loadJobs, save = saveJobs, publish, listMessages, now = () => Date.now() } = deps;
  // Under the jobs-store lock: the read-compare-write of `activity` is atomic,
  // so a stale poller write can never overwrite a terminal transition a
  // concurrent writer just persisted, or resurrect a completed job to running.
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    let changed = false;
    await Promise.all(
      jobs.map(async (job) => {
        if (job.status !== "running") return;
        // A launch whose child may not exist yet (create lost / not yet sent) has no
        // transcript to summarise — skip it rather than warn every tick.
        if (job.launchState === "creating" || (job.launchState === "uncertain" && job.submittedAt == null)) return;
        let activity = null;
        let activityChanged = false;
        let modelChanged = false;
        try {
          const messages = listMessages ? await listMessages(job.childSessionID) : [];
          activity = describeChatActivity(summarizeTranscript(messages));
          const model = effectiveModelFromMessages(messages);
          if (model !== null && model !== job.model) {
            job.model = model;
            modelChanged = true;
          }
        } catch (e) {
          console.warn(`[delegate] activity poll failed for ${job.id}:`, e?.message ?? e);
          return;
        }
        if (activity !== job.activity) {
          job.activity = activity;
          activityChanged = true;
        }
        if (activityChanged || modelChanged) {
          changed = true;
          publish?.({
            kind: "delegate.updated",
            payload: { id: job.id, status: job.status, activity },
          });
        }
      }),
    );
    if (changed) await save(jobs);
    void now;
  });
}

export function startActivityPoller(deps = {}, { intervalMs = ACTIVITY_INTERVAL_MS } = {}) {
  return startPoller(() => tickActivity(deps), { intervalMs, label: "delegate-activity" });
}

// ---------------------------------------------------------------------------
// Sweeper — reuses the capability sweeper's constants and shape. Running jobs
// older than 30 minutes become `failed` with error "timed out after 30
// minutes". Terminal jobs are retained 7 days or 50 records, whichever bites
// first. The window and worktree are NEVER removed by the sweeper — only by an
// explicit delete.
// ---------------------------------------------------------------------------

export async function sweepDelegateJobs(deps = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    now = () => Date.now(),
    sessionExists,
    abortSession,
  } = deps;
  try {
    // V2 jobs: the authoritative re-check of every unfinished one (reconnect /
    // boot / a missed event all end here) and the retry of every result not yet
    // posted to its parent. Both are no-ops without their readers injected.
    await reconcileV2Jobs(deps);
    await retryPendingDeliveries(deps);

    const jobs = await load();
    if (jobs.length === 0) return;
    const nowMs = now();

    // Jobs that finished before worktree-less windows were closed on finish still
    // have their window open: close it once (cleanedUp marks it done).
    for (const job of jobs) {
      if (!isTerminal(job) || job.worktree || job.cleanedUp != null || job.completionDelivery === "pending") continue;
      await withSessionResources(job.childSessionID, async () => {
        // The window of a superseded run belongs to its successor: re-read the LIVE record.
        const live = ((await load()) ?? []).find((j) => j.id === job.id) ?? job;
        if (!live.supersededBy) await closeJobWindowLocked(live, deps);
        await patchJob(job.id, { cleanedUp: true }, deps);
      });
    }

    // BET-418 §B: parent session gone → stop the job immediately (there is
    // nobody left to report to), then the same terminal cleanup runs inside
    // stopJob. Best-effort: a sessionExists failure degrades to "assume
    // alive" so a transient opencode blip never orphans a healthy job.
    const orphaned = [];
    if (sessionExists) {
      for (const job of jobs) {
        if (job.status !== "running" || !job.parentSessionID) continue;
        // A session opencode (or a script) runs has no reporting parent for Manta to wait on.
        if (completionOwnerOf(job) === "opencode") continue;
        try {
          const alive = await sessionExists(job.parentSessionID);
          if (!alive) orphaned.push(job);
        } catch {
          /* best-effort: assume alive */
        }
      }
    }

    const transitioned = [];
    for (const job of jobs) {
      // An uncertain launch is never failed on a clock: nothing proves the run
      // did not start, so it stays (and is re-checked every sweep) until there
      // is evidence either way.
      // A V2 child opencode owns (an adopted subagent, a native background
      // command) has no running timeout: opencode runs its lifecycle and
      // settleV2Job finishes it from the real outcome.
      if (completionOwnerOf(job) === "opencode") continue;
      if (job.status === "running" && job.startedAt != null && job.launchState !== "uncertain") {
        // Per-job running-sweep allowance: default 30 min, or the caller's
        // sweepAllowanceMs (spec §11.6-4 — CTO overnight jobs pass
        // overnightWindowRemainingMs). User-started jobs keep the 30-min rule.
        const allowance = job.sweepAllowanceMs ?? RUNNING_TIMEOUT_MS;
        if (nowMs - job.startedAt > allowance) {
          transitioned.push({ job, allowance });
        }
      }
    }

    // spec §11.6: `paused` jobs older than 7 days → `stopped` (terminal, with
    // the same keep-on-dirty cleanup). Silent: the job has been idle for a week
    // and the parent session is likely long gone, so no completion is
    // delivered — matching how a long-stopped background run fades out.
    const pausedExpired = [];
    for (const job of jobs) {
      if (job.status === "paused" && job.pausedAt != null && nowMs - job.pausedAt > PAUSE_KEEP_MS) {
        pausedExpired.push(job);
      }
    }

    if (transitioned.length === 0 && orphaned.length === 0 && pausedExpired.length === 0) {
      await persistRetention({ load, save, deps }, nowMs);
      return;
    }

    // Orphaned jobs → stopped (parent gone). stopJob aborts + marks stopped +
    // runs the same terminal cleanup. Runs BEFORE the timeout pass so a job
    // that is both orphaned and timed-out is recorded as "stopped" (parent
    // gone is the more precise reason); finishV2Job is a no-op on the
    // already-terminal record.
    for (const job of orphaned) {
      await stopJob(job.id, deps);
    }
    // Timed-out jobs → failed. Pass the FULL deps so the terminal cleanup
    // (killWindow + gitRemoveWorktree) actually runs. The error reflects the
    // job's own allowance, so the default path stays "timed out after 30 minutes".
    for (const { job, allowance } of transitioned) {
      const mins = Math.round(allowance / 60_000);
      const res = await finishV2Job(job, "failed", `timed out after ${mins} minutes`, deps);
      // A child Manta started keeps running (and spending) after its result said
      // "failed" unless it is interrupted. The record is already terminal here, so
      // the interrupt's own outcome event finds nothing left to do.
      if (!res?.alreadyTerminal && abortSession && job.childSessionID) {
        try {
          await abortSession(job.childSessionID);
        } catch (e) {
          console.warn(`[delegate] interrupting the timed-out child of ${job.id} failed:`, e?.message ?? e);
        }
      }
    }
    // Paused-expired jobs → stopped. A job still owes its parent its one result,
    // even a stopped one, so this goes through stopJob.
    for (const job of pausedExpired) {
      await stopJob(job.id, deps, { error: "paused for over 7 days, stopped" });
    }
    await persistRetention({ load, save, deps }, nowMs);
  } catch (e) {
    console.warn("[delegate] sweep failed:", e?.message ?? e);
  }
}

// Retention prune: re-read the store fresh so the prune cannot clobber a write a concurrent
// writer persisted while this sweep was inspecting a stale snapshot.
//
// A worktree-less row's window may still be open (the user reopened the session after it
// finished), so pruning its record closes that window FIRST — a window left without a record
// would reappear as an ordinary top-level session. That close takes the session's resource
// lock (OUTER), so it runs before the store lock (INNER), and never for a superseded run
// (its window belongs to the successor).
async function persistRetention({ load, save, deps }, nowMs) {
  const peek = (await load()) ?? [];
  if (peek.length === 0) return;
  for (const j of applyRetention(peek, nowMs).pruned) {
    if (j.worktree) continue;
    await withSessionResources(j.childSessionID, async () => {
      const live = ((await load()) ?? []).find((x) => x.id === j.id) ?? j;
      if (!live.supersededBy) await closeJobWindowLocked(live, deps ?? {});
    });
  }
  await jobsLock.runExclusive(async () => {
    const jobs = await load();
    if (jobs.length === 0) return;
    const { retained, pruned } = applyRetention(jobs, nowMs);
    if (pruned.length === 0) return;
    await save(retained);
  });
}

function applyRetention(jobs, nowMs) {
  const cutoff = nowMs - TERMINAL_RETENTION_MS;
  // BET-418 §B: a terminal job whose worktree was kept (dirty) must NOT be
  // pruned — its tmux window is still live and the record is what keeps it
  // recognisable as a job (pruning it would let the stale window reappear as
  // an ordinary top-level session). cleanedUp===false is set only by the new
  // cleanup path; undefined (old records) prunes as before. A record whose
  // result has not been posted to its parent yet is never pruned either.
  // A superseded record's resources belong to its successor: `cleanedUp:false` never keeps it.
  const keeps = (j) => (j.cleanedUp === false && !j.supersededBy) || j.completionDelivery === "pending";
  const isTerm = (j) => j.status === "done" || j.status === "failed" || j.status === "stopped";
  const pruned = new Set();
  for (const j of jobs) {
    if (isTerm(j) && j.finishedAt != null && j.finishedAt < cutoff && !keeps(j)) pruned.add(j.id);
  }
  let out = jobs.filter((j) => !pruned.has(j.id));
  const terminal = out.filter(isTerm);
  if (terminal.length > MAX_TERMINAL_JOBS) {
    const sorted = [...terminal].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const dropped = new Set(
      sorted
        .filter((j) => !keeps(j))
        .slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))
        .map((j) => j.id),
    );
    for (const id of dropped) pruned.add(id);
    out = out.filter((j) => !dropped.has(j.id));
  }
  return { retained: out, pruned: jobs.filter((j) => pruned.has(j.id)) };
}

export function startSweeper(deps = {}, { intervalMs = SWEEP_INTERVAL_MS } = {}) {
  const pathBound = {
    ...deps,
    load: () => loadJobs(deps.storePath ?? STORE_PATH),
    save: (jobs) => saveJobs(jobs, deps.storePath ?? STORE_PATH),
  };
  return startPoller(() => sweepDelegateJobs(pathBound), { intervalMs, label: "delegate" });
}

// ---------------------------------------------------------------------------
// Stopping and deleting
// ---------------------------------------------------------------------------

// Shared lock + lookup + running-guard for the job-lifecycle controls (stop,
// pause). The callback runs INSIDE the jobs-store lock and performs its own
// save — the read-check-mutate sequence stays atomic against other writers.
async function withRunningJob(id, deps, fn, { allowPaused = false } = {}) {
  const { load = loadJobs } = deps;
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: "not found" };
    const job = jobs[idx];
    if (job.status !== "running" && !(allowPaused && job.status === "paused")) {
      return { ok: false, error: "job not running", status: job.status };
    }
    return fn(jobs, idx, job);
  });
}

/**
 * stopJob interrupts the child session with oc.abortSession, marks the job
 * `stopped` in ONE terminal write (result-delivery fields included), posts its
 * one result to the parent, then cleans up the window + worktree (a dirty
 * worktree keeps both; the branch always survives).
 *
 * A PAUSED job can be stopped too (2026-09-25: nine workers frozen by an old
 * dispatch bug could not be stopped by any tool, so their cancelled cards
 * could never be archived). A paused job has no turn in flight, so there is
 * nothing to interrupt — but it still emits its `stopped` result: a job reports
 * exactly one result, at its final terminal state.
 */
export async function stopJob(id, deps = {}, { error: stopError } = {}) {
  const {
    save = saveJobs,
    publish,
    abortSession,
    now = () => Date.now(),
  } = deps;
  // Under the jobs-store lock: the read-check-mutate is atomic, so a stop cannot
  // race another writer into a half-state. The N7 / admission delivery happens
  // after the lock is released.
  const stopped = await withRunningJob(id, deps, async (jobs, idx, job) => {
    if (job.status === "running" && abortSession && job.childSessionID && job.launchState !== "creating") {
      try {
        await abortSession(job.childSessionID);
      } catch (e) {
        console.warn(`[delegate] abortSession failed for ${id}:`, e?.message ?? e);
      }
    }
    const manta = completionOwnerOf(job) === "manta";
    const updated = {
      ...job,
      status: "stopped",
      error: stopError ?? "stopped by user",
      stopRequested: true,
      finishedAt: now(),
      pauseRequested: false,
      pausedAt: null,
      completionMessageId: manta ? (job.completionMessageId ?? mintMessageId()) : (job.completionMessageId ?? null),
      completionDelivery: manta ? "pending" : null,
    };
    jobs[idx] = updated;
    await save(jobs);
    pauseInterrupts.delete(updated.id);
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: updated.status, activity: updated.activity },
    });
    return { ok: true, deliver: manta, stopped: updated };
  }, { allowPaused: true });
  if (stopped?.stopped) {
    if (stopped.deliver) await deliverJobResult(id, deps);
    await finishV2Cleanup(stopped.stopped, deps);
    return { ok: true };
  }
  return stopped;
}

/**
 * deleteJob removes the tmux window, then calls
 * local.gitRemoveWorktree({ path, force }), then removes the record.
 * force defaults to false. If gitRemoveWorktree returns {removed:false,
 * reason:"dirty"}, keep the worktree AND keep the job record, and return that
 * reason so the UI can explain it. The engine's own paths NEVER pass
 * force: true; the ONLY caller allowed to is the §12 CTO cleanup override
 * (ctoWorkTools workCleanup with overrideDirty:true — the user explicitly
 * accepted destroying uncommitted changes and the file list is preserved as
 * evidence first).
 */
export async function deleteJob(id, deps = {}, opts = {}) {
  const { load = loadJobs } = deps;
  // The window / worktree part runs under the session's resource lock (OUTER) and then the
  // store lock (INNER). A resume swaps a record's child, so the lock taken from a peek is
  // re-checked against the live record and the attempt retried when it moved.
  for (let attempt = 0; attempt < 3; attempt++) {
    const peek = (await load()).find((j) => j.id === id);
    if (!peek) return { ok: false, error: "not found" };
    const outcome = await withSessionResources(peek.childSessionID, () => deleteJobLocked(id, peek.childSessionID, deps, opts));
    if (!outcome.moved) return outcome;
  }
  return { ok: false, error: "the job changed while it was being deleted — try again" };
}

async function deleteJobLocked(id, lockedChild, deps, opts) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    killWindow,
    gitRemoveWorktree,
  } = deps;
  // Under the jobs-store lock: the load → remove-record save is atomic.
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: "not found" };
    const job = jobs[idx];
    if (job.childSessionID !== lockedChild) return { moved: true };

    // A superseded run's window and worktree belong to its successor: only the record goes.
    if (job.supersededBy) {
      await save(jobs.filter((j) => j.id !== id));
      publish?.({ kind: "delegate.updated", payload: { id, status: "deleted" } });
      return { ok: true };
    }

    // V2 rows with no worktree (background commands / subagents): closing the
    // row of work that is still running, unresolved, or holds an unposted result
    // closes the WINDOW only — the record stays, and still reports when the work
    // ends, until retention prunes it. A finished, delivered row is closed for
    // good (window + record) as before.
    if (
      !job.worktree &&
      (!isTerminal(job) || job.launchState === "uncertain" || job.completionDelivery === "pending")
    ) {
      await closeJobWindowLocked(job, deps);
      jobs[idx] = { ...job, windowIndex: null };
      await save(jobs);
      publish?.({ kind: "delegate.updated", payload: { id, status: job.status, launchState: job.launchState } });
      return { ok: true, retained: true };
    }

    // 1. Remove the tmux window (best-effort).
    if (killWindow && job.tmuxSession != null && job.windowIndex != null) {
      try {
        await killWindow({ sessionName: job.tmuxSession, windowIndex: job.windowIndex });
      } catch (e) {
        console.warn(`[delegate] killWindow failed for ${id}:`, e?.message ?? e);
      }
    }

    // 2. Remove the worktree (non-forced by default; force only via the §12
    // explicit override — see the header comment).
    if (gitRemoveWorktree && job.worktree) {
      try {
        const res = await gitRemoveWorktree({ path: job.worktree, force: opts?.force === true });
        if (res && res.removed === false && res.reason === "dirty") {
          // Keep the worktree AND keep the job record; report `dirty`.
          return { ok: false, error: "dirty", reason: "dirty" };
        }
      } catch (e) {
        console.warn(`[delegate] gitRemoveWorktree failed for ${id}:`, e?.message ?? e);
        // A failed remove leaves the worktree on disk; still drop the record so
        // the UI isn't stuck, but surface the error.
      }
    }

    // 3. Remove the record.
    const next = jobs.filter((j) => j.id !== id);
    await save(next);
    publish?.({ kind: "delegate.updated", payload: { id, status: "deleted" } });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Pausing, resuming, reconciliation (spec §11.6)
//
// `paused` is a distinct, non-terminal state. A paused job keeps its window,
// worktree and branch; only its V2 child session is interrupted. Paused jobs
// do NOT count against the global running cap (MAX_RUNNING_JOBS counts only
// `running`), so parking a job frees a slot while keeping its work intact.
//
// pause → pauseJob flags the job; at its next completed-tool-part boundary
//   (observeEvent → interruptForPause) the child is interrupted, and the
//   child's raw `interrupted` outcome parks the job (finishV2Job).
// resume → a FRESH V2 child is created in the SAME worktree/branch (never a new
//   worktree), re-acquiring a cap slot like a fresh start, and seeded with the
//   original prompt plus git log / git status / last progress.
// ---------------------------------------------------------------------------

/**
 * Request a pause. Only flags the job — the actual transition to `paused`
 * happens when its child is interrupted at the job's next completed-tool-part
 * boundary, so an in-flight tool is never interrupted mid-write. Idempotent for
 * a running job (re-sets the flag).
 */
export async function pauseJob(id, deps = {}) {
  const { save = saveJobs, publish } = deps;
  return withRunningJob(id, deps, async (jobs, idx, job) => {
    // V2 owns a background command's / subagent's lifecycle: there is nothing
    // to park, so the control is refused rather than half-working.
    if (job.origin === "command" || completionOwnerOf(job) === "opencode") {
      return { ok: false, error: "pause isn't available for this job" };
    }
    const updated = { ...job, pauseRequested: true };
    jobs[idx] = updated;
    await save(jobs);
    // Status stays "running" until the child's interrupted outcome parks the job;
    // the flag is what observeEvent acts on.
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: updated.status, pauseRequested: true },
    });
    return { ok: true, job: updated };
  });
}

/**
 * @returns {Promise<number>} the box-wide count of currently `running` jobs.
 * Paused jobs are excluded (they do not consume a cap slot). Exposed for the
 * CTO engine's own sub-cap accounting, which needs the global running read.
 */
export async function runningJobCount(deps = {}) {
  const { load = loadJobs } = deps;
  const jobs = await load();
  return jobs.filter(countsTowardCap).length;
}

/**
 * Build the opening prompt for a RESUME: the original prompt plus context that
 * lets a fresh session pick up where the aborted one left off in the SAME
 * worktree/branch — the last ~20 commits, the porcelain status, and the job's
 * last progress report (read from the OLD child session, before it is replaced).
 */
async function buildResumePrompt(job, deps, childSessionID) {
  const { gitRun, readProgress } = deps;
  const blocks = [String(job.prompt ?? "").trim()];
  if (job.worktree && gitRun) {
    try {
      const { stdout } = await gitRun(["-C", job.worktree, "log", "--oneline", "-20"]);
      // trimEnd (NOT trim): porcelain-style output preserves a meaningful
      // leading column, and the log is a list we never want right-padded.
      const log = String(stdout ?? "").trimEnd();
      blocks.push(`Recent commit history (branch ${job.branch ?? job.worktree}):\n${log || "(no commits yet)"}`);
    } catch {
      /* best-effort */
    }
    try {
      const { stdout } = await gitRun(["-C", job.worktree, "status", "--porcelain"]);
      // trimEnd, not trim: git status --porcelain uses a leading two-column
      // status (index/worktree) whose first character can be a space — trimming
      // the head would silently corrupt the per-file status of the first entry.
      const st = String(stdout ?? "").trimEnd();
      blocks.push(`Working tree status:\n${st || "(clean)"}`);
    } catch {
      /* best-effort */
    }
  }
  if (readProgress && childSessionID) {
    try {
      const rec = await readProgress(childSessionID);
      if (rec) {
        const bits = [];
        if (rec.label) bits.push(String(rec.label));
        if (rec.step != null) {
          const total = rec.total != null ? ` of ${rec.total}` : "";
          bits.push(`step ${rec.step}${total}`);
        }
        if (rec.state) bits.push(String(rec.state));
        if (rec.detail) bits.push(String(rec.detail));
        blocks.push(`Last progress report:\n${bits.length ? bits.join(" — ") : "(none)"}`);
      }
    } catch {
      /* best-effort */
    }
  }
  return blocks.filter((b) => b && b.trim()).join("\n\n---\n\n");
}

/**
 * Resume a paused job: start a FRESH V2 child session in the SAME worktree +
 * branch (attempt + 1, same job id and result id), re-acquiring a cap slot like
 * a fresh start, and send it the resume context. If the cap is full the job
 * stays `paused` and the call is retriable ({ok:false, error:CAP_ERROR,
 * retriable:true}).
 */
export async function resumeJob(id, deps = {}) {
  const { load = loadJobs } = deps;

  // The resume prompt (git + progress reads) is built BEFORE the lock, from a
  // peek at the record; the lock then checks it is still about the same attempt.
  let preparedResume = null;
  {
    const peek = (await load()).find((j) => j.id === id);
    if (peek?.status === "paused") {
      preparedResume = {
        childId: peek.childSessionID,
        text: buildJobPrompt({
          prompt: await buildResumePrompt(peek, deps, peek.childSessionID),
          worktree: peek.worktree,
          branch: peek.branch,
        }),
      };
    }
  }

  const reg = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: "not found" };
    const job = jobs[idx];
    if (job.status !== "paused") {
      return { ok: false, error: "job not paused", status: job.status };
    }
    // Re-acquire a cap slot like a fresh start; `paused` is not counted by the
    // cap, but the resumed job needs a free slot to run. Cap full → stay
    // paused and let the caller retry.
    const running = jobs.filter(countsTowardCap).length;
    if (running >= MAX_RUNNING_JOBS) {
      return { ok: false, error: CAP_ERROR, retriable: true };
    }
    return registerV2Resume(jobs, idx, job, preparedResume, deps);
  });

  if (!reg.ok) return reg;
  // Fresh child the same way a first launch makes one (create → move → window →
  // prompt); the job id, result id and worktree are unchanged.
  try {
    return await launchDelegate(reg.job, deps);
  } finally {
    inLaunch.delete(reg.job.id);
  }
}

// ---------------------------------------------------------------------------
// Boot reconciliation of pre-C2 records
//
// Before Stage C2 a CTO-dispatched job was a legacy record (no `engine`) that
// completed from the idle/busy event pairing — a path that no longer exists. A
// box upgraded while one was unfinished leaves it in the store, once:
//   • `running` → `failed: "interrupted by upgrade"`. Nothing can finish it any
//     more, and its child may still be spending. It is made V2-shaped, its child
//     interrupted, and it ends through the SAME terminal transition every job
//     uses (finishV2Job) — so a Manta-owned job reports its one result to its
//     parent exactly as before (through admission for the CTO conversation, N7
//     otherwise), the CTO's work envelope hears its outcome (onJobTerminal), and
//     the worktree is cleaned up like any finished job's.
//   • `paused` → upgraded IN PLACE to a V2 paused record, so the user can still
//     resume it (on the V2 path: a fresh child in the same worktree).
//   • terminal records are inert history and are left to retention.
// V2 jobs that were running when the box restarted are NOT handled here: their
// state is read from opencode (reconcileV2Jobs), never guessed.
// ---------------------------------------------------------------------------

/** "providerID/modelID" → {providerID, modelID} (the model id may itself contain "/"). */
function parseModelString(value) {
  if (typeof value !== "string") return null;
  const i = value.indexOf("/");
  if (i <= 0 || i === value.length - 1) return null;
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) };
}

// The V2 shape of a record that predates `engine` (everything finishV2Job /
// resume / reconcile read), without changing what the record already says.
function upgradeLegacyRecord(job) {
  const manta = completionOwnerOf(job) === "manta";
  return {
    ...job,
    engine: "v2",
    completionOwner: completionOwnerOf(job),
    attempt: 1,
    launchState: "running",
    submittedAt: job.startedAt ?? null,
    // minted once per JOB; null for a child opencode reports itself
    completionMessageId: manta ? (job.completionMessageId ?? mintMessageId()) : null,
    completionDelivery: null,
    agent: V2_JOB_AGENT,
    executionDirectory: job.worktree ?? job.parentDirectory ?? null,
    launch: {
      text: buildJobPrompt({ prompt: job.prompt, worktree: job.worktree, branch: job.branch }),
      model: parseModelString(job.model ?? job.requestedModel),
      messageId: mintMessageId(),
    },
  };
}

/**
 * @returns {Promise<{ok:true, reconciled:number}>} how many pre-C2 records were
 * settled (running → failed, paused → upgraded). A healthy box reconciles none.
 */
export async function reconcileJobsOnBoot(deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, abortSession } = deps;
  const interrupted = [];
  let reconciled = 0;
  await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const next = jobs.map((job) => {
      if (job.engine === "v2" || (job.status !== "running" && job.status !== "paused")) return job;
      reconciled += 1;
      const upgraded = upgradeLegacyRecord(job);
      if (job.status === "running") interrupted.push(upgraded);
      else publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "paused" } });
      return upgraded;
    });
    if (reconciled > 0) await save(next);
  });
  for (const job of interrupted) {
    // its child may still be running under the new server, with nothing left to end it
    if (abortSession && job.childSessionID) {
      try {
        await abortSession(job.childSessionID);
      } catch (e) {
        console.warn(`[delegate] interrupting the pre-upgrade child of ${job.id} failed:`, e?.message ?? e);
      }
    }
    try {
      await finishV2Job(job, "failed", "interrupted by upgrade", deps);
    } catch (e) {
      console.warn(`[delegate] settling the pre-upgrade job ${job.id} failed:`, e?.message ?? e);
    }
  }
  return { ok: true, reconciled };
}

// ---------------------------------------------------------------------------
// Pre-flight approval (BET-418 §A)
//
// When trust mode is OFF and the model declared `tools`, the `delegate` call
// blocks for a single approval before creating anything. The engine owns a
// pending-approvals map (approvalId → {approval, resolve, timer}); the REST
// handler creates an approval, publishes `delegate.approval.requested`, and
// awaits the decision. The renderer's approval card resolves it via
// approve/decline; a 2-minute timeout resolves it as declined. Pure-ish: the
// map + timers are owned by the engine instance; exported for unit tests.
// ---------------------------------------------------------------------------

export function createApprovalState({ now = () => Date.now() } = {}) {
  const pending = new Map();
  return {
    pending,
    create({ parentSessionID, name, prompt, tools }) {
      const id = genId();
      const approval = {
        id,
        parentSessionID,
        name,
        prompt,
        tools: Array.isArray(tools) ? tools : [],
        createdAt: now(),
      };
      pending.set(id, { approval, resolve: null, timer: null });
      return approval;
    },
    list(parentSessionID) {
      const out = [];
      for (const { approval } of pending.values()) {
        if (parentSessionID && approval.parentSessionID !== parentSessionID) continue;
        out.push({ ...approval });
      }
      return out;
    },
    get(id) {
      const entry = pending.get(id);
      return entry ? { ...entry.approval } : null;
    },
    /**
     * Block until the approval is resolved or the timeout elapses.
     * @returns {{ decision: "approve"|"decline"|"timeout", tools?: Array }}
     */
    awaitDecision(id, timeoutMs = APPROVAL_TIMEOUT_MS) {
      const entry = pending.get(id);
      if (!entry) return Promise.resolve({ decision: "declined" });
      return new Promise((resolve) => {
        entry.resolve = (decision, tools) => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = null;
          pending.delete(id);
          resolve({ decision, tools });
        };
        entry.timer = setTimeout(() => {
          pending.delete(id);
          resolve({ decision: "timeout" });
        }, timeoutMs);
      });
    },
    resolve(id, decision, tools) {
      const entry = pending.get(id);
      if (!entry || !entry.resolve) return false;
      entry.resolve(decision, tools);
      return true;
    },
    clear() {
      for (const { timer } of pending.values()) {
        if (timer) clearTimeout(timer);
      }
      pending.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// V2 jobs (Stage B): background command runs, adoption, raw completion, N7
//
// A job with `engine:"v2"` is a real V2 child session. Two kinds exist here:
//   • completionOwner "manta"    — Manta started the child (a wrapped command run,
//     startCommandJob) and posts the ONE result to the parent (N7).
//   • completionOwner "opencode" — opencode started the child (a background
//     `task` subagent, a V2-native background command) and reports its result
//     itself; Manta only tracks the row and NEVER posts a result for it.
// Completion comes from the child's RAW execution outcome, never from the
// lifecycle adapter (which reads an interrupt as success). Every unfinished job
// is also re-checked from authoritative reads on each sweep (settleV2Job), which
// is what makes a missed event, a reconnect and a boot all converge.
// ---------------------------------------------------------------------------

/** How long a child's latest raw execution outcome is remembered. */
export const LIFECYCLE_TTL_MS = 10 * 60_000;
const LIFECYCLE_MAX = 500;
/** A command's child that no `task` tool part claims is adopted this long after its window closes. */
export const ADOPT_GRACE_MS = 2_000;
const TREE_MAX_SESSIONS = 64;
const TREE_MAX_DEPTH = 6;
const TREE_INDEX_MAX = 2000;

const isTerminal = (j) => j?.status === "done" || j?.status === "failed" || j?.status === "stopped";

/** The ONE accounting predicate: does this record use one of the box-wide job slots? A session Manta merely observes never does. */
export function countsTowardCap(job) {
  return job?.status === "running" && job?.origin !== "observed";
}

/** Who reports this job's result to its parent. Records from before the field existed: adopted subagents were always opencode's. */
export function completionOwnerOf(job) {
  return job?.completionOwner ?? (job?.origin === "subagent" ? "opencode" : "manta");
}

/** V2 session ids are `ses…`, message ids `msg…`; both are minted here so a lost response stays reconcilable by id. */
export function mintSessionId() {
  return `ses_${randomUUID().replaceAll("-", "")}`;
}
export function mintMessageId() {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

/** A refusal opencode gave definitively (4xx) — nothing was admitted. Anything else (network, timeout, 5xx) is unknown. */
const isDefiniteRefusal = (e) => typeof e?.status === "number" && e.status >= 400 && e.status < 500;

/** Raw V2 execution outcome → the job's terminal state. `null` for an unknown outcome. */
export function outcomeToTerminal(outcome, { error } = {}) {
  if (outcome === "succeeded") return { status: "done", error: null };
  if (outcome === "failed") return { status: "failed", error: error || "The run failed." };
  if (outcome === "interrupted") return { status: "failed", error: "interrupted" };
  return null;
}

/**
 * The short-lived map of each session's latest RAW execution outcome the pump
 * feeds, so a child that finished before it was adopted is recorded finished at
 * once. Entries expire after `ttlMs` and the map is capped (oldest evicted).
 */
export function createLifecycleMap({ now = () => Date.now(), ttlMs = LIFECYCLE_TTL_MS, max = LIFECYCLE_MAX } = {}) {
  const map = new Map();
  function prune() {
    const cutoff = now() - ttlMs;
    for (const [sid, v] of map) if (v.at < cutoff) map.delete(sid);
    while (map.size > max) map.delete(map.keys().next().value);
  }
  return {
    record(sid, { outcome, error = null }) {
      map.delete(sid); // re-insert at the tail so eviction is oldest-first
      map.set(sid, { outcome, error, at: now() });
      prune();
    },
    get(sid) {
      prune();
      return map.get(sid) ?? null;
    },
    size: () => map.size,
  };
}

// A guarded patch of one record under the jobs lock. `patch` is an object or a
// function of the live record; `onlyIf` (when given) must accept the live
// record or nothing is written. Publishes the same bus event every job change
// uses, so a card driven by launchState updates without polling (P7).
async function patchJob(id, patch, deps = {}, { onlyIf } = {}) {
  const { load = loadJobs, save = saveJobs, publish } = deps;
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return null;
    if (onlyIf && !onlyIf(jobs[idx])) return null;
    const next = { ...jobs[idx], ...(typeof patch === "function" ? patch(jobs[idx]) : patch) };
    jobs[idx] = next;
    await save(jobs);
    publish?.({
      kind: "delegate.updated",
      payload: { id, status: next.status, launchState: next.launchState, activity: next.activity },
    });
    return next;
  });
}

/**
 * Auto-handoff commit (§6.3): move every job that belonged to `fromSessionId` onto
 * `toSessionId`. `parent` re-points jobs the session STARTED; `child` re-points a
 * running job whose OWN session was the one replaced. Idempotent — a recovery
 * re-runs it. Returns how many records changed.
 * @param {{ fromSessionId: string, toSessionId: string, parent?: boolean, child?: boolean }} a
 */
export async function repointJobSessions({ fromSessionId, toSessionId, parent = true, child = true }, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish } = deps;
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    let changed = 0;
    const next = jobs.map((j) => {
      let u = j;
      if (parent && j.parentSessionID === fromSessionId) u = { ...u, parentSessionID: toSessionId };
      if (child && j.childSessionID === fromSessionId) u = { ...u, childSessionID: toSessionId };
      if (u !== j) changed++;
      return u;
    });
    if (changed > 0) {
      await save(next);
      for (const j of next) if (j.parentSessionID === toSessionId || j.childSessionID === toSessionId) publish?.({ kind: "delegate.updated", payload: { id: j.id, status: j.status, launchState: j.launchState, activity: j.activity } });
    }
    return changed;
  });
}

async function removeJobRecord(id, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish } = deps;
  await jobsLock.runExclusive(async () => {
    const jobs = await load();
    if (!jobs.some((j) => j.id === id)) return;
    await save(jobs.filter((j) => j.id !== id));
    publish?.({ kind: "delegate.updated", payload: { id, status: "deleted" } });
  });
}

/**
 * Close a job's tmux window, only if the window at its recorded index is STILL
 * the one stamped with this job's child session: indexes get reused, and a
 * stale one must never close somebody else's window. Best-effort; never throws.
 *
 * The caller holds `sessionResources(job.childSessionID)`; `closeJobWindow` below is the
 * variant for a caller that does not.
 */
async function closeJobWindowLocked(job, deps = {}) {
  const { killWindow, listProjects } = deps;
  if (!killWindow || job?.tmuxSession == null || job?.windowIndex == null) return false;
  try {
    if (typeof listProjects === "function") {
      const projects = await listProjects();
      const win = (Array.isArray(projects) ? projects : [])
        .filter((p) => p.tmuxSession === job.tmuxSession)
        .flatMap((p) => p.windows || [])
        .find((w) => w.index === job.windowIndex);
      if (!win || win.opencodeSessionId !== job.childSessionID) return false;
    }
    await killWindow({ sessionName: job.tmuxSession, windowIndex: job.windowIndex });
    return true;
  } catch (e) {
    console.warn(`[delegate] closing the window of ${job?.id} failed:`, e?.message ?? e);
    return false;
  }
}

/** closeJobWindowLocked for a caller that holds no session lock (a launch undoing the window it just made). */
const closeJobWindow = (job, deps = {}) => withSessionResources(job?.childSessionID, () => closeJobWindowLocked(job, deps));

// ---- pause + resume bookkeeping -------------------------------------------

// Jobs whose child was interrupted for a pause request (job id → child id), so the
// several tool boundaries a busy child can emit before the interrupt lands send one
// interrupt, not many. Cleared when the job parks or ends; a failed interrupt is not
// recorded, so the next boundary tries again.
const pauseInterrupts = new Map();

/**
 * A pause was requested and the child just finished a tool: interrupt it. Only the
 * interrupt happens here — it is the child's raw `interrupted` outcome that parks the
 * job (finishV2Job), so a child that completes in the same instant is simply done.
 */
async function interruptForPause(job, deps = {}) {
  if (!deps.abortSession || !job.childSessionID) return;
  if (pauseInterrupts.get(job.id) === job.childSessionID) return;
  try {
    await deps.abortSession(job.childSessionID);
    pauseInterrupts.set(job.id, job.childSessionID);
    while (pauseInterrupts.size > 200) pauseInterrupts.delete(pauseInterrupts.keys().next().value);
  } catch (e) {
    console.warn(`[delegate] pause interrupt failed for ${job.id}:`, e?.message ?? e);
  }
}

/**
 * A resumed attempt keeps the paused attempt's window until the new one is known to
 * be running (so a refused launch can put the job back as it was). Once it is, the
 * old window goes — stamp-checked, so a reused index never closes somebody else's.
 *
 * It acts on the restore's OWN child, which for a resume differs from the record's current
 * one: that session's lock is taken here unless the caller already holds it (`heldSession`).
 */
async function dropResumeRestore(job, deps = {}, { heldSession = null } = {}) {
  const restore = job?.launch?.restore;
  if (!restore) return;
  const closeOld = () =>
    closeJobWindowLocked(
      { id: job.id, tmuxSession: restore.tmuxSession, windowIndex: restore.windowIndex, childSessionID: restore.childSessionID },
      deps,
    );
  if (restore.childSessionID && restore.childSessionID !== heldSession) await withSessionResources(restore.childSessionID, closeOld);
  else await closeOld();
  await patchJob(job.id, (live) => ({ launch: { ...live.launch, restore: undefined } }), deps);
}

// ---- terminal transition --------------------------------------------------

/**
 * Make a V2 job terminal. ONE write holds the status, the result and — for a job
 * whose result Manta posts — the minted `completionMessageId` with
 * `completionDelivery:"pending"`, so a crash right after can never lose the
 * result nor post it twice. The first terminal transition wins; later ones are
 * no-ops. The N7 post (if any) happens AFTER the write. Then the job is cleaned
 * up: its window is closed, and a worktree (if any) is removed — a dirty worktree
 * keeps both.
 *
 * `interrupted:true` says the child's raw outcome was an interruption. What that
 * means is decided against the LIVE record, under the lock: a pause that was
 * requested parks the job (`paused` — a non-terminal state that emits NOTHING), a
 * stop that was requested makes it `stopped`, anything else is `failed:
 * "interrupted"`. Only a job that is still `running` can be finished at all: a
 * stale snapshot (a timeout sweep that read the store before a pause landed)
 * must neither time out a paused job nor resurrect one.
 *
 * `resourcesHeld:true` says the caller already holds `sessionResources(job.childSessionID)`
 * (a launch / recovery that finishes its own record): the cleanup then runs its lock-held
 * variant instead of waiting on a lock it would never get.
 */
export async function finishV2Job(job, status, error, deps = {}, { interrupted = false, resourcesHeld = false } = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    listMessages,
    clearProgress = defaultClearProgress,
    now = () => Date.now(),
  } = deps;

  // The child's last text (and the worktree's file count) are read BEFORE the
  // lock: one opencode / git read must not hold up every job write on the box.
  // The record is re-checked under the lock, so a racing finish still produces
  // exactly one terminal write.
  let result = null;
  let filesChanged = null;
  if (status === "done" && job.childSessionID) {
    try {
      result = await lastAssistantText(listMessages ? await listMessages(job.childSessionID) : []);
    } catch (e) {
      console.warn("[delegate] listMessages failed:", e?.message ?? e);
    }
    if (job.worktree && deps.gitRun) filesChanged = await countFilesChanged(job, deps);
  }

  let paused = null;
  const updated = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx === -1) return null;
    const live = jobs[idx];
    if (live.status !== "running") return null;

    if (interrupted && live.pauseRequested && completionOwnerOf(live) === "manta") {
      const parked = { ...live, status: "paused", pauseRequested: false, pausedAt: now() };
      jobs[idx] = parked;
      await save(jobs);
      publish?.({ kind: "delegate.updated", payload: { id: parked.id, status: "paused" } });
      paused = parked;
      return null;
    }
    let outcome = { status, error };
    if (interrupted) outcome = live.stopRequested ? { status: "stopped", error: "stopped by user" } : { status: "failed", error: "interrupted" };

    const manta = completionOwnerOf(live) === "manta";
    const next = {
      ...live,
      status: outcome.status,
      error: outcome.status === "done" ? null : (outcome.error ?? null),
      result: outcome.status === "done" ? result : null,
      filesChanged: outcome.status === "done" ? filesChanged : null,
      finishedAt: now(),
      pauseRequested: false,
      completionMessageId: manta ? (live.completionMessageId ?? mintMessageId()) : (live.completionMessageId ?? null),
      completionDelivery: manta ? "pending" : null,
    };
    jobs[idx] = next;
    await save(jobs);
    publish?.({
      kind: "delegate.updated",
      payload: { id: next.id, status: next.status, launchState: next.launchState, activity: next.activity },
    });
    return next;
  });
  if (paused) {
    pauseInterrupts.delete(paused.id);
    return { ok: true, paused: true };
  }
  if (!updated) return { ok: true, alreadyTerminal: true };

  if (typeof deps.onJobTerminal === "function") {
    try {
      await deps.onJobTerminal(updated);
    } catch (e) {
      console.warn(`[delegate] onJobTerminal failed for ${updated.id}:`, e?.message ?? e);
    }
  }
  if (updated.childSessionID) {
    try {
      await clearProgress(updated.childSessionID);
    } catch (e) {
      console.warn(`[delegate] clearProgress failed for ${updated.id}:`, e?.message ?? e);
    }
  }
  pauseInterrupts.delete(updated.id);
  if (updated.completionDelivery === "pending") await deliverJobResult(updated.id, deps);
  await finishV2Cleanup(updated, deps, { held: resourcesHeld });
  return { ok: true };
}

// What a finished V2 job leaves behind: nothing in the sidebar. Its window is
// closed (only if it still belongs to the job — tmux reuses indexes) and a worktree
// is removed; a dirty worktree keeps both and the record says so, so retention never
// prunes it. An unfinished resume's old window goes too. The record stays, so the
// session can still be reopened from the job.
async function finishV2Cleanup(job, deps, { held = false } = {}) {
  if (held) return finishV2CleanupLocked(job, deps);
  return withSessionResources(job.childSessionID, () => finishV2CleanupLocked(job, deps));
}

// The caller holds sessionResources(job.childSessionID). The LIVE record decides: a run that a
// successor superseded does nothing to the window / worktree the successor now owns.
async function finishV2CleanupLocked(job, deps) {
  const { load = loadJobs } = deps;
  const live = ((await load()) ?? []).find((j) => j.id === job.id);
  if (live?.supersededBy) return;
  await dropResumeRestore(job, deps, { heldSession: job.childSessionID });
  // A session Manta only observes never loses a worktree (a script may prompt it again): its
  // window closes, and a worktree it inherited and still holds keeps the record from pruning.
  if (job.origin === "observed") {
    await closeJobWindowLocked(job, deps);
    const holds = !!job.worktree && (await pathExistsVia(deps, job.worktree));
    await patchJob(job.id, holds ? { cleanedUp: false, cleanupReason: "kept" } : { cleanedUp: true }, deps);
    return;
  }
  if (!job.worktree) {
    await closeJobWindowLocked(job, deps);
    await patchJob(job.id, { cleanedUp: true }, deps);
    return;
  }
  let cleanedUp = false;
  try {
    cleanedUp = !!(await cleanupTerminalJobLocked(job, deps)).cleanedUp;
  } catch (e) {
    console.warn(`[delegate] cleanup failed for ${job.id}:`, e?.message ?? e);
  }
  await patchJob(job.id, { cleanedUp }, deps);
}

// ---- N7: the one result posted to the parent ------------------------------

const deliveringIds = new Set();
const loggedDeliveryFailures = new Set();

const STATE_FOR_STATUS = { done: "completed", failed: "failed", stopped: "cancelled" };

/** The N7 body for a finished job — a pure function of the record, so a retry posts the same thing. */
export function buildResultSynthetic(job) {
  return {
    id: job.completionMessageId,
    text: buildCompletionText(job),
    description: job.name,
    metadata: {
      source: "subagent",
      childID: job.childSessionID,
      agent: job.agent ?? null,
      state: STATE_FOR_STATUS[job.status] ?? job.status,
      manta: { jobId: job.id, name: job.name },
    },
    delivery: "queue",
    resume: true,
  };
}

/**
 * Post a finished job's result to its parent (N7): `delivery:"queue"` (never
 * steers a running parent turn), `resume:true`, the job's persisted
 * `completionMessageId` (a retry after an uncertain POST admits once). Marks the
 * record `delivered` on success and `abandoned` when the parent is gone (404);
 * any other failure leaves it `pending` for the next retry (sweep / boot). A CTO
 * conversation parent keeps the admission path (`deliver`), never N7.
 */
export async function deliverJobResult(id, deps = {}) {
  const { load = loadJobs, postSynthetic, deliver, isCtoConversationSession } = deps;
  if (deliveringIds.has(id)) return { ok: true, skipped: "in-flight" };
  deliveringIds.add(id);
  try {
    const job = (await load()).find((j) => j.id === id);
    if (!job || !isTerminal(job) || job.completionDelivery !== "pending") return { ok: true, skipped: "not-pending" };
    const markIfPending = (completionDelivery) =>
      patchJob(id, { completionDelivery }, deps, { onlyIf: (j) => j.completionDelivery === "pending" });

    // Which route is decided from facts, never guessed: the CTO's tracked-work
    // workers (correlation.kind "work") are dispatched with the CTO conversation
    // as their completion parent, so they ALWAYS go through admission — even when
    // classifying the session fails open (the conversation store unreadable),
    // which would otherwise post their result straight into the CTO conversation
    // past its admission queue. Anything else asks the classifier, and a
    // classifier that cannot answer leaves the result pending for the next retry
    // rather than risking the wrong route.
    let cto = job.correlation?.kind === "work";
    if (!cto) {
      try {
        cto = !!(await isCtoConversationSession?.(job.parentSessionID));
      } catch (e) {
        console.warn(`[delegate] could not classify the parent of ${id} (will retry):`, e?.message ?? e);
        return { ok: false, error: String(e?.message ?? e) };
      }
    }
    if (cto) {
      // The CTO conversation keeps promptDelivery + its admission redirect. The
      // job's persisted `completionMessageId` is the admission dedupe identity
      // (`ctoKey`), so a retry of this very result — after a refusal, or a boot
      // mid-delivery — is recognised and admitted once, whatever the text.
      //
      // Marking `delivered` after this call is safe because `deliver` NEVER
      // rejects (promptDelivery.mjs: the redirect and every send failure are
      // caught inside it) and says what happened in its RESULT: a redirect result
      // means admission durably holds the result (queued, or already settled under
      // that id, `deduped`); only an explicit refusal (`rejected`, or neither
      // delivered nor queued) leaves the record `pending` for the next retry.
      let outcome;
      try {
        outcome = await deliver?.({ sessionId: job.parentSessionID, text: buildCompletionText(job), ctoKey: job.completionMessageId });
      } catch (e) {
        console.warn(`[delegate] completion delivery failed for ${id}:`, e?.message ?? e);
        return { ok: false, error: String(e?.message ?? e) };
      }
      if (outcome && (outcome.rejected === true || (outcome.delivered === false && outcome.queued === false && !outcome.deduped))) {
        if (!loggedDeliveryFailures.has(id)) {
          loggedDeliveryFailures.add(id);
          console.warn(`[delegate] result delivery for ${id} to the CTO conversation was refused (will retry):`, outcome.error ?? "not queued");
        }
        return { ok: false, error: String(outcome.error ?? "not queued") };
      }
      loggedDeliveryFailures.delete(id);
      await markIfPending("delivered");
      return { ok: true, delivered: true };
    }
    if (typeof postSynthetic !== "function") return { ok: false, error: "no synthetic poster" };
    try {
      await postSynthetic(job.parentSessionID, buildResultSynthetic(job));
    } catch (e) {
      if (e?.status === 404) {
        if (!loggedDeliveryFailures.has(id)) {
          loggedDeliveryFailures.add(id);
          console.warn(`[delegate] parent session of ${id} is gone — result abandoned`);
        }
        await markIfPending("abandoned");
        return { ok: true, abandoned: true };
      }
      if (!loggedDeliveryFailures.has(id)) {
        loggedDeliveryFailures.add(id);
        console.warn(`[delegate] result delivery for ${id} failed (will retry):`, e?.message ?? e);
      }
      return { ok: false, error: String(e?.message ?? e) };
    }
    loggedDeliveryFailures.delete(id);
    await markIfPending("delivered");
    return { ok: true, delivered: true };
  } finally {
    deliveringIds.delete(id);
  }
}

/** Retry every result still `pending` (the sweeper tick and boot). Sequential; a failure never stops the rest. */
export async function retryPendingDeliveries(deps = {}) {
  const { load = loadJobs } = deps;
  if (typeof deps.postSynthetic !== "function" && typeof deps.deliver !== "function") return 0;
  const pending = (await load()).filter((j) => isTerminal(j) && j.completionDelivery === "pending");
  for (const j of pending) {
    try {
      await deliverJobResult(j.id, deps);
    } catch (e) {
      console.warn(`[delegate] delivery retry failed for ${j.id}:`, e?.message ?? e);
    }
  }
  return pending.length;
}

// ---- completion: authoritative reads --------------------------------------

// Is the user input of THIS launch known to opencode? A continued session already holds many user
// messages, so for a continuation only the record / inbox item carrying the launch's own message id counts.
async function hasAdmissionEvidence(job, deps) {
  const child = job.childSessionID;
  const mine = job.launch?.continuation ? job.launch.messageId : null;
  if (job.launch?.continuation && !mine) return false;
  const tries = mine
    ? [
        async () => ((await deps.listInbox?.(child)) ?? []).some((i) => i?.id === mine),
        async () => ((await deps.listRawTimeline?.(child, { type: "user" })) ?? []).some((r) => r?.id === mine),
      ]
    : [
        // (a pending `move` item is Manta's own doing — a delegate child is moved into its
        // worktree before the prompt — and proves nothing about the prompt)
        async () => ((await deps.listInbox?.(child)) ?? []).filter((i) => i?.type !== "move").length > 0,
        async () => ((await deps.listRawTimeline?.(child, { type: "user" })) ?? []).length > 0,
        async () => ((await deps.listChildSessions?.(child)) ?? []).length > 0,
      ];
  for (const t of tries) {
    try {
      if (await t()) return true;
    } catch {
      /* an unreadable source proves nothing */
    }
  }
  return false;
}

// A `subagent` tool block in an assistant record that names `childId`.
function toolBlockFor(assistantRecords, childId) {
  for (const rec of assistantRecords) {
    for (const block of Array.isArray(rec?.content) ? rec.content : []) {
      if (block?.type !== "tool") continue;
      const md = block.state?.metadata;
      if ((md?.sessionID ?? md?.sessionId) === childId) return block;
    }
  }
  return null;
}

/**
 * The completion predicate's descendant part (spec B-server 3): every session
 * below the wrapper child is finished AND its completion evidence is present —
 * a FOREGROUND child by its `task` tool block being completed/error in its
 * parent's timeline, a BACKGROUND child by its result synthetic
 * (`metadata.childID`) in its parent's timeline — and every such parent's inbox
 * is empty. Returns `{complete, newestSyntheticAt}`; throws when something could
 * not be read (the caller treats that as "unknown", never "finished").
 */
async function descendantEvidence(job, active, deps) {
  if (typeof deps.listChildSessions !== "function") return { complete: true, newestSyntheticAt: null };
  const nodes = [];
  const seen = new Set([job.childSessionID]);
  let layer = [job.childSessionID];
  for (let depth = 0; layer.length > 0; depth++) {
    if (depth >= TREE_MAX_DEPTH) throw new Error("descendant tree too deep");
    const next = [];
    for (const parent of layer) {
      for (const kid of await deps.listChildSessions(parent)) {
        if (seen.has(kid.id)) continue;
        seen.add(kid.id);
        if (seen.size > TREE_MAX_SESSIONS) throw new Error("too many descendants");
        nodes.push({ id: kid.id, parent });
        next.push(kid.id);
      }
    }
    layer = next;
  }
  if (nodes.length === 0) return { complete: true, newestSyntheticAt: null };
  if (nodes.some((n) => active.has(n.id))) return { complete: false, newestSyntheticAt: null };

  const synthetics = new Map();
  const assistants = new Map();
  for (const parent of new Set(nodes.map((n) => n.parent))) {
    if ((((await deps.listInbox?.(parent)) ?? []).length) > 0) return { complete: false, newestSyntheticAt: null };
    synthetics.set(parent, (await deps.listRawTimeline(parent, { type: "synthetic" })) ?? []);
    assistants.set(parent, (await deps.listRawTimeline(parent, { type: "assistant" })) ?? []);
  }
  let newest = null;
  for (const n of nodes) {
    const block = toolBlockFor(assistants.get(n.parent), n.id);
    const st = block?.state;
    const background = st?.input?.background === true || st?.metadata?.background === true;
    if (block && !background) {
      if (st?.status !== "completed" && st?.status !== "error") return { complete: false, newestSyntheticAt: null };
      continue;
    }
    const syn = synthetics.get(n.parent).filter((r) => r?.metadata?.childID === n.id);
    if (syn.length === 0) return { complete: false, newestSyntheticAt: null };
    for (const r of syn) newest = Math.max(newest ?? 0, r?.time?.created ?? 0);
  }
  return { complete: true, newestSyntheticAt: newest };
}

/**
 * Decide, from authoritative reads only, what state a V2 job is in — the ONE
 * evaluator behind the live pump, reconnect, boot and the sweeper. Never guesses:
 * anything unreadable or inconclusive leaves the record exactly as it is.
 *
 *  • `GET /api/session/active` — is the child running?
 *  • `GET /api/session/{child}` — `outcome` and `time.idle`.
 *  • the job's persisted `launchState` / `submittedAt`.
 *
 * For a `completionOwner:"manta"` job the run is finished only when the whole
 * tree is (descendantEvidence) AND the child's latest outcome came after the
 * newest descendant result — a wrapper that backgrounded itself replies to that
 * result in a turn of its own. `hint` is the raw outcome the pump just saw.
 */
export async function settleV2Job(job, deps = {}, { hint } = {}) {
  const { listActiveIds, readSession } = deps;
  if (typeof listActiveIds !== "function" || typeof readSession !== "function") return { settled: false, reason: "no-readers" };
  if (isTerminal(job)) return { settled: false, reason: "terminal" };
  // Auto-handoff (§6.3): the job's turn end is its completion signal, but a `send`
  // handoff registered on its own session means the work continues in a successor.
  // Defer; the handoff commit re-points the job, a failure re-runs this settlement.
  if (deps.deferSettlement?.(job.childSessionID)) return { settled: false, reason: "handoff-pending" };
  // A paused job's last child ended `interrupted` — that is WHY it is paused. Only a
  // running job has a run to settle.
  if (job.status !== "running") return { settled: false, reason: "not-running" };
  let active;
  try {
    active = new Set(await listActiveIds());
  } catch {
    return { settled: false, reason: "unknown" };
  }
  let rs;
  try {
    rs = await readSession(job.childSessionID);
  } catch {
    rs = { state: "unknown" };
  }
  if (rs.state === "unknown") return { settled: false, reason: "unknown" };
  const manta = completionOwnerOf(job) === "manta";

  if (rs.state === "missing") {
    // A child that was never confirmed to exist (create lost / never sent) stays
    // as it is; one that DID exist and is gone was deleted.
    if (job.launchState === "creating" || (manta && job.submittedAt == null)) return { settled: false, reason: "unsent" };
    await finishV2Job(job, "failed", "the session no longer exists", deps);
    return { settled: true, status: "failed" };
  }

  // A job Manta starts has no run to settle until its opening input was submitted:
  // whatever execution the child showed before that (V2 runs one just to apply the
  // move into the worktree) is not the job finishing.
  if (manta && job.submittedAt == null) return { settled: false, reason: "unsent" };

  const session = rs.session ?? {};
  const outcome = session.outcome ?? hint?.outcome ?? null;
  const idleAt = session.time?.idle ?? hint?.at ?? null;
  // Which run does this outcome belong to? A Manta job: one at/after its submission. A session
  // opencode runs: one at/after the moment THIS run was first seen — a resumed session's
  // previous outcome must not finish its new record.
  const fresh =
    !manta && job.runStartedAt != null
      ? idleAt != null && idleAt >= job.runStartedAt
      : job.submittedAt == null || (idleAt != null && idleAt >= job.submittedAt);

  if (job.launchState === "uncertain") {
    // A continuation's session is busy / has outcomes of its own: only the launch's own message id proves it was admitted.
    const evidence = job.launch?.continuation
      ? await hasAdmissionEvidence(job, deps)
      : active.has(job.childSessionID) || (outcome && fresh) || (await hasAdmissionEvidence(job, deps));
    if (!evidence) return { settled: false, reason: "uncertain" };
    job = (await patchJob(job.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) })) ?? job;
    await dropResumeRestore(job, deps);
  }
  if (active.has(job.childSessionID)) return { settled: false, reason: "active" };
  if (!outcome || !fresh) return { settled: false, reason: "no-outcome" };

  // (An interrupted run is never going to reply to a descendant's result, so the
  // descendant predicate doesn't apply to it: a pause must not wait on a subagent.)
  if (manta && outcome !== "interrupted") {
    let tree;
    try {
      tree = await descendantEvidence(job, active, deps);
    } catch (e) {
      console.warn(`[delegate] could not read the descendants of ${job.id}:`, e?.message ?? e);
      return { settled: false, reason: "unknown" };
    }
    if (!tree.complete) return { settled: false, reason: "descendants" };
    if (tree.newestSyntheticAt != null && !(idleAt != null && idleAt > tree.newestSyntheticAt)) {
      return { settled: false, reason: "reply-pending" };
    }
  }
  const t = outcomeToTerminal(outcome, { error: hint?.error });
  if (!t) return { settled: false, reason: "no-outcome" };
  // A delegate job has run only once the child holds the user message its opening
  // prompt became: an outcome without one belongs to something else (a move-applying
  // execution that finished late). Unreadable proves nothing, so it stays unsettled —
  // the sweep's running timeout is the backstop.
  if (job.launch && typeof deps.listRawTimeline === "function") {
    let sawInput = false;
    try {
      const users = (await deps.listRawTimeline(job.childSessionID, { type: "user" })) ?? [];
      sawInput = job.launch.continuation ? users.some((r) => r?.id === job.launch.messageId) : users.length > 0;
    } catch {
      sawInput = false;
    }
    if (!sawInput) return { settled: false, reason: "no-input" };
  }
  // A fresh outcome proves the run happened, whatever the launch bookkeeping
  // says (it can finish before the send's own response is recorded).
  if (job.launchState !== "running") {
    job = (await patchJob(job.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) })) ?? job;
  }
  await finishV2Job(job, t.status, t.error, deps, { interrupted: outcome === "interrupted" });
  return { settled: true, status: t.status };
}

const resuming = new Set();
// Jobs this process is launching right now (between registration and the send):
// a reconcile must leave them alone, and any other record still mid-launch was
// interrupted (a restart) and is therefore uncertain.
const inLaunch = new Set();

/**
 * A wrapped run whose command was NEVER sent (the create response was lost, or
 * the process died before the send) and whose child now provably exists:
 * finish the launch — window, then the one send. Claimed under the lock so two
 * triggers can't both send. Nothing was ever submitted, so this cannot double-run.
 */
async function resumeUnsentLaunch(job, deps) {
  if (resuming.has(job.id)) return;
  resuming.add(job.id);
  try {
    const { listProjects, newWindow, stampOwner } = deps;
    let current = job;
    // A delegate job's child is moved into its worktree before anything else; the
    // move is re-issued only when neither the session nor its inbox shows it.
    if (current.launch) {
      const moved = await ensureMoved(current, deps);
      if (!moved.ok) {
        if (moved.definite) await abandonLaunch(current, `could not move the session into its worktree: ${moved.error}`, deps, { reconciled: true });
        return;
      }
    }
    if (current.windowIndex == null) {
      const projects = typeof listProjects === "function" ? await listProjects() : [];
      // A restart between the window's creation and the patch recording its index
      // leaves a live window stamped with this child but a null index: reuse it.
      let existing = null;
      for (const p of Array.isArray(projects) ? projects : []) {
        const win = (p.windows || []).find((w) => w.opencodeSessionId === current.childSessionID);
        if (win) {
          existing = { tmuxSession: p.tmuxSession, windowIndex: win.index };
          break;
        }
      }
      if (existing) {
        current = (await patchJob(current.id, existing, deps)) ?? current;
      } else {
        const owner = current.tmuxSession ? { tmuxSession: current.tmuxSession } : resolveOwner(projects, current.parentSessionID);
        if (!owner) return;
        const created = await newWindow({
          sessionName: owner.tmuxSession,
          windowName: current.launch ? current.name : windowNameFor(current.name),
          cwd: current.executionDirectory ?? current.parentDirectory,
          chatMode: true,
          existingSessionId: current.childSessionID,
          ...(current.worktree ? { worktreePath: current.worktree } : {}),
          oc: deps.oc,
        });
        if (stampOwner) {
          try {
            await stampOwner(owner.tmuxSession, created.windowIndex, "job");
          } catch {
            /* advisory */
          }
        }
        current = (await patchJob(current.id, { tmuxSession: owner.tmuxSession, windowIndex: created.windowIndex ?? null }, deps)) ?? current;
      }
    }
    const claimed = await patchJob(
      current.id,
      () => ({ launchState: "submitting", submittedAt: (deps.now ?? Date.now)() }),
      deps,
      { onlyIf: (j) => j.status === "running" && j.submittedAt == null },
    );
    if (!claimed) return;
    await submitCommand(claimed, deps, { reconciled: true });
  } catch (e) {
    console.warn(`[delegate] resuming the launch of ${job.id} failed:`, e?.message ?? e);
  } finally {
    resuming.delete(job.id);
  }
}

/**
 * Re-check every unfinished job (boot, reconnect, each sweep).
 * Sequential: a box with a handful of background rows must not fan out reads.
 */
export async function reconcileV2Jobs(deps = {}) {
  const { load = loadJobs } = deps;
  // A pre-C2 record is settled before anything reads the store as V2 (the boot call
  // and the sweeper's first tick can overlap; whichever comes first does it, once).
  await reconcileJobsOnBoot(deps);
  if (typeof deps.listActiveIds !== "function") return 0;
  // (a paused job has no run to re-check: it is parked until someone resumes it)
  const targets = (await load()).filter((j) => j.status === "running" && j.childSessionID);
  for (let job of targets) {
    try {
      if (inLaunch.has(job.id) || resuming.has(job.id)) continue;
      // A record still mid-launch that no launch in THIS process owns was cut off
      // (a restart): what happened to its requests is unknown, so say so.
      if (job.launchState === "creating" || job.launchState === "submitting") {
        job = (await patchJob(job.id, { launchState: "uncertain" }, deps, { onlyIf: (j) => !isTerminal(j) && (j.launchState === "creating" || j.launchState === "submitting") })) ?? job;
      }
      // A continuation shares its session with earlier runs: it is recovered by its own
      // routine (never resumeUnsentLaunch, whose move step and abandon path delete the session).
      if (job.launch?.continuation && job.launchState !== "running") {
        await recoverContinuation(job, deps);
        continue;
      }
      if (completionOwnerOf(job) === "manta" && job.submittedAt == null && (job.launchState === "creating" || job.launchState === "uncertain")) {
        const rs = await deps.readSession(job.childSessionID);
        if (rs.state === "found") await resumeUnsentLaunch(job, deps);
        continue;
      }
      await settleV2Job(job, deps);
    } catch (e) {
      console.warn(`[delegate] reconcile of ${job.id} failed:`, e?.message ?? e);
    }
  }
  return targets.length;
}

// ---- startCommandJob: a Manta-wrapped background command run --------------

// tmux window names: manta's own rename rule — 1–40 chars, no ':' or control characters.
function windowNameFor(displayName) {
  const clean = String(displayName ?? "").replace(/[:\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return clean || "background-command";
}

/** The row's display name: `/<name> <args>` trimmed. */
export function commandDisplayName(command, args) {
  return `/${command} ${String(args ?? "").trim()}`.trim();
}

// Undo a launch proven not admitted: the child, its window and the record.
async function rollbackLaunch(job, deps) {
  // (a continuation's session is shared with earlier runs: it has its own, session-preserving undo)
  if (job.launch?.continuation) return rollbackContinuation(job, deps);
  if (job.launch) return rollbackDelegateLaunch(job, deps);
  if (deps.deleteSession && job.childSessionID) {
    try {
      await deps.deleteSession(job.childSessionID);
    } catch (e) {
      console.warn(`[delegate] deleting the child of ${job.id} failed:`, e?.message ?? e);
    }
  }
  await closeJobWindow(job, deps);
  await removeJobRecord(job.id, deps);
}

/**
 * Send the command to the child (step c). `submittedAt` was persisted BEFORE this
 * call and is never rewritten. A definite refusal rolls the whole launch back; an
 * UNCERTAIN failure never does — no snapshot proves the request can't still be
 * admitted, so the record, child and window stay, marked `uncertain`, and the
 * sweeper keeps reconciling them.
 */
async function submitCommand(job, deps, { reconciled = false, undo = {} } = {}) {
  const delegate = !!job.launch;
  const continuation = !!job.launch?.continuation;
  const run = job.commandRun ?? {};
  try {
    if (delegate) {
      // A delegate job's opening prompt goes straight to the child (never through
      // promptDelivery, which swallows the failure this has to classify). The
      // persisted message id makes a retry after an unknown outcome admit once.
      await deps.sendChildPrompt({
        sessionId: job.childSessionID,
        text: job.launch.text,
        ...(job.launch.model ? { model: job.launch.model } : {}),
        agent: job.agent,
        messageID: job.launch.messageId,
      });
    } else {
      await deps.runCommandOnChild({
        sessionId: job.childSessionID,
        command: run.command,
        arguments: run.arguments ?? "",
        model: run.model,
        agent: run.agent,
        attachments: run.attachments,
      });
    }
  } catch (e) {
    if (isDefiniteRefusal(e)) {
      // A delegate whose launch was finished by a RECONCILE (not by the call that
      // started it) was reported to its caller as started: it must not vanish, so
      // it ends `failed` with its one result — unless it is a resume, which simply
      // goes back to being paused.
      if (continuation) {
        // The caller holds the session's resource lock either way. A RECONCILED refusal was
        // reported as sent: it ends `failed` with its one result. A live one is simply undone.
        // Nothing here ever deletes the session — it is shared with earlier runs.
        if (reconciled) await finishV2Job(job, "failed", `could not send: ${String(e?.message ?? e)}`, deps, { resourcesHeld: true });
        else await rollbackContinuation(job, deps, undo);
      } else if (reconciled && delegate && !job.launch.restore) {
        await finishV2Job(job, "failed", `could not start: ${String(e?.message ?? e)}`, deps);
      } else {
        await rollbackLaunch(job, deps);
      }
      return { ok: false, error: String(e?.message ?? e) };
    }
    const kept = (await patchJob(job.id, { launchState: "uncertain" }, deps, { onlyIf: (j) => !isTerminal(j) })) ?? job;
    return { ok: true, job: kept, uncertain: true };
  }
  const running = (await patchJob(job.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) && j.launchState !== "running" })) ?? job;
  if (delegate) await dropResumeRestore(running, deps);
  return { ok: true, job: running };
}

// ---- delegate_send: another round of one of YOUR finished jobs --------------
//
// One run = one record. A new round of a finished job is a NEW record sharing the old one's
// session (`continues` / `supersededBy`), so a late settle, delivery or cleanup of the old
// record can only ever touch the old record. The worktree travels to the successor; the
// session is never deleted. Everything from the record write through its window step (and any
// undo) runs inside `sessionResources(childSessionID)`.

// A `git worktree add` for a worktree a finished run's cleanup removed (its branch survives).
async function restoreWorktree(job, deps) {
  const dir = job.parentDirectory;
  if (!dir || !job.branch || !job.worktree || typeof deps.gitRun !== "function") return { ok: false };
  try {
    try {
      await deps.gitRun(["-C", dir, "worktree", "prune"]);
    } catch {
      /* best-effort: a stale registration would make the add refuse */
    }
    await deps.gitRun(["-C", dir, "worktree", "add", job.worktree, job.branch]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Undo a continuation that was refused before anything ran: the new record goes, the old one is
// its own again, and only what THIS attempt made (a window, a re-added worktree) is taken back.
// The session itself is shared with earlier runs and is NEVER deleted. The caller holds the
// session's resource lock.
async function rollbackContinuation(job, deps, { createdWindow = null, worktreeRestored = false } = {}) {
  const { load = loadJobs, save = saveJobs, publish } = deps;
  if (createdWindow) {
    await closeJobWindowLocked(
      { id: job.id, tmuxSession: createdWindow.tmuxSession, windowIndex: createdWindow.windowIndex, childSessionID: job.childSessionID },
      deps,
    );
  }
  if (worktreeRestored && job.worktree && deps.gitRemoveWorktree) {
    try {
      await deps.gitRemoveWorktree({ path: job.worktree, force: false });
    } catch (e) {
      console.warn(`[delegate] removing the re-added worktree of ${job.id} failed:`, e?.message ?? e);
    }
  }
  await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const next = jobs
      .filter((j) => j.id !== job.id)
      .map((j) => {
        if (j.id !== job.continues || j.supersededBy !== job.id) return j;
        const { supersededBy: _drop, ...rest } = j;
        return rest;
      });
    await save(next);
    publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "deleted" } });
    if (job.continues) publish?.({ kind: "delegate.updated", payload: { id: job.continues } });
  });
}

// The window for a continuation: the one already stamped with the session, else a new one in the
// job's own workspace (the caller's, when that workspace is gone). Returns where it is and whether
// THIS call made it.
async function ensureContinuationWindow(job, sessionDirectory, deps) {
  const { listProjects, newWindow, stampOwner } = deps;
  const projects = (await listProjects()) ?? [];
  const stamped = findStampedWindow(projects, job.childSessionID);
  let target = stamped?.tmuxSession ?? null;
  let windowIndex = stamped?.windowIndex ?? null;
  let created = false;
  if (!stamped) {
    target = projects.some((p) => p.tmuxSession === job.tmuxSession) ? job.tmuxSession : (resolveOwner(projects, job.parentSessionID)?.tmuxSession ?? null);
    if (!target) throw new Error("could not find a workspace to open the job in");
    const made = await newWindow({
      sessionName: target,
      windowName: windowNameFor(job.name),
      cwd: job.worktree || sessionDirectory,
      chatMode: true,
      existingSessionId: job.childSessionID,
      ...(job.worktree ? { worktreePath: job.worktree } : {}),
      oc: deps.oc,
    });
    windowIndex = made.windowIndex ?? null;
    created = true;
  }
  if (stampOwner && windowIndex != null) {
    try {
      await stampOwner(target, windowIndex, "job");
    } catch {
      /* advisory */
    }
  }
  return { tmuxSession: target, windowIndex, created };
}

// Everything `delegate_send` checks against the store, in the order the spec fixes (first failure wins).
function continueRefusal(jobs, id, { prompt, sessionID }, deps) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: false, status: 404, error: "that background job no longer exists" };
  if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, status: 400, error: "prompt is required" };
  const chain = typeof deps.replacementChain === "function" ? deps.replacementChain(job.parentSessionID) : null;
  const mine = typeof sessionID === "string" && !!sessionID && (sessionID === job.parentSessionID || (Array.isArray(chain) && chain.includes(sessionID)));
  if (!mine) return { ok: false, status: 403, error: "that job belongs to another session" };
  if (job.correlation) return { ok: false, status: 403, error: "that job is managed by the CTO" };
  if (job.supersededBy && jobs.some((j) => j.id === job.supersededBy)) {
    const newest = newestRecordFor(jobs, job.childSessionID);
    const eligible = newest && newest.origin !== "observed" && completionOwnerOf(newest) === "manta";
    return {
      ok: false,
      status: 409,
      error: eligible ? `that job has a newer run — use ${newest.id}` : "that job's session was continued outside delegate — start a new job instead",
    };
  }
  if (job.origin === "observed" || completionOwnerOf(job) !== "manta") {
    return { ok: false, status: 409, error: "only jobs started with delegate can be continued — start a new job instead" };
  }
  if (job.status === "running") return { ok: false, status: 409, error: "that job is still working — its result will arrive on its own" };
  if (job.status === "paused") return { ok: false, status: 409, error: "that job is paused — resume it first" };
  if (job.completionDelivery === "pending") return { ok: false, status: 409, error: "its result is still being delivered — try again shortly" };
  return { ok: true, job };
}

/**
 * Start another round of one of the caller's finished jobs: a NEW record on the same session
 * (see the section header), the follow-up sent with a persisted message id.
 *
 * @param {string} id the finished job's id
 * @param {{ prompt: string, sessionID: string }} input `sessionID` is the caller's own session
 * @returns {Promise<{ok:true, job:object, uncertain?:true}|{ok:false, status:number, error:string}>}
 */
export async function continueJob(id, input, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, now = () => Date.now() } = deps;
  const args = { prompt: input?.prompt, sessionID: input?.sessionID };
  const peeked = continueRefusal((await load()) ?? [], id, args, deps);
  if (!peeked.ok) return peeked;
  const child = peeked.job.childSessionID;
  if (!child) return { ok: false, status: 409, error: "that job has no session to continue" };
  const followUp = String(args.prompt).trim();

  return withSessionResources(child, async () => {
    // Who else is driving the session, and does it still exist? (async reads, so outside the store lock)
    let active;
    try {
      active = await deps.listActiveIds();
    } catch {
      return { ok: false, status: 500, error: "couldn't check whether the job's session is busy — try again" };
    }
    if (active.includes(child)) return { ok: false, status: 409, error: "that job's session is busy" };
    let rs;
    try {
      rs = await deps.readSession(child);
    } catch {
      rs = { state: "unknown" };
    }
    if (rs.state === "missing") return { ok: false, status: 409, error: "that job has no session to continue" };
    if (rs.state !== "found") return { ok: false, status: 500, error: "couldn't read the job's session — try again" };
    const sessionDirectory = rs.session?.directory || peeked.job.parentDirectory;

    // The record write: re-check everything against the LIVE store, then append the successor.
    const reg = await jobsLock.runExclusive(async () => {
      const jobs = (await load()) ?? [];
      const recheck = continueRefusal(jobs, id, args, deps);
      if (!recheck.ok) return recheck;
      if (jobs.filter(countsTowardCap).length >= MAX_RUNNING_JOBS) return { ok: false, status: 409, error: CAP_ERROR };
      const old = recheck.job;
      const t = now();
      const { supersededBy: _s, cleanupReason: _c, ...inherited } = old;
      const job = {
        ...inherited,
        id: genId(),
        attempt: (old.attempt ?? 1) + 1,
        continues: old.id,
        prompt: followUp,
        status: "running",
        createdAt: t,
        startedAt: t,
        finishedAt: null,
        result: null,
        error: null,
        filesChanged: null,
        activity: null,
        completionOwner: "manta",
        completionMessageId: null,
        completionDelivery: null,
        pauseRequested: false,
        stopRequested: false,
        pausedAt: null,
        cleanedUp: null,
        launchState: "creating",
        submittedAt: null,
        windowIndex: null,
        launch: { text: followUp, messageId: mintMessageId(), model: null, continuation: true },
      };
      inLaunch.add(job.id); // from the moment it exists: a sweep must never read it as cut off
      try {
        await save([...jobs.map((j) => (j.id === old.id ? { ...j, supersededBy: job.id } : j)), job]);
      } catch (e) {
        inLaunch.delete(job.id);
        throw e;
      }
      publish?.({ kind: "delegate.updated", payload: { id: old.id, status: old.status } });
      publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "running", launchState: "creating" } });
      return { ok: true, job };
    });
    if (!reg.ok) return reg;

    const job = reg.job;
    const undo = { createdWindow: null, worktreeRestored: false };
    try {
      // 1. the worktree a finished run's cleanup removed
      if (job.worktree && !(await pathExistsVia(deps, job.worktree))) {
        const restored = await restoreWorktree(job, deps);
        if (!restored.ok) {
          await rollbackContinuation(job, deps, undo);
          return { ok: false, status: 409, error: `that job's branch ${job.branch} no longer exists` };
        }
        undo.worktreeRestored = true;
      }
      // 2. its window
      let placed;
      try {
        placed = await ensureContinuationWindow(job, sessionDirectory, deps);
      } catch (e) {
        await rollbackContinuation(job, deps, undo);
        return { ok: false, status: 500, error: `couldn't send to the job: ${String(e?.message ?? e)}` };
      }
      if (placed.created) undo.createdWindow = { tmuxSession: placed.tmuxSession, windowIndex: placed.windowIndex };
      // 3. claim, then send (the one place a definite refusal is told to the caller)
      const claimed = await patchJob(
        job.id,
        () => ({ tmuxSession: placed.tmuxSession, windowIndex: placed.windowIndex, launchState: "submitting", submittedAt: now() }),
        deps,
        { onlyIf: (j) => j.status === "running" && j.submittedAt == null },
      );
      // Ended meanwhile (stopped / timed out): that record carries the terminal state and its one result.
      if (!claimed) return { ok: false, status: 409, error: "that job was stopped before the new round started" };
      const sent = await submitCommand(claimed, deps, { undo });
      if (!sent.ok) return { ok: false, status: 500, error: `couldn't send to the job: ${sent.error}` };
      return { ok: true, job: sent.job, ...(sent.uncertain ? { uncertain: true } : {}) };
    } finally {
      inLaunch.delete(job.id);
    }
  });
}

// Finish (or end) a continuation a restart / lost response left unresolved. Idempotent; every
// step is continuation-safe — a definite refusal is the RECONCILED one (the caller was already
// told "sent", so the record ends `failed` with its one result) and nothing deletes the session.
async function recoverContinuation(job, deps) {
  if (resuming.has(job.id)) return;
  resuming.add(job.id);
  try {
    await withSessionResources(job.childSessionID, async () => {
      const { load = loadJobs } = deps;
      const live = ((await load()) ?? []).find((j) => j.id === job.id);
      if (!live || live.status !== "running" || !live.launch?.continuation || live.launchState === "running") return;
      const held = { resourcesHeld: true };

      // (a) the session
      let rs;
      try {
        rs = await deps.readSession(live.childSessionID);
      } catch {
        rs = { state: "unknown" };
      }
      if (rs.state === "missing") {
        await finishV2Job(live, "failed", "the session no longer exists", deps, held);
        return;
      }
      if (rs.state !== "found") return;

      // (b) the worktree
      if (live.worktree && !(await pathExistsVia(deps, live.worktree))) {
        const restored = await restoreWorktree(live, deps);
        if (!restored.ok) {
          await finishV2Job(live, "failed", `its branch ${live.branch} no longer exists`, deps, held);
          return;
        }
      }

      // (c) the window — found by the session's stamp; the recorded index proves nothing
      let current = live;
      try {
        const placed = await ensureContinuationWindow(live, rs.session?.directory || live.parentDirectory, deps);
        if (placed.tmuxSession !== live.tmuxSession || placed.windowIndex !== live.windowIndex) {
          current = (await patchJob(live.id, { tmuxSession: placed.tmuxSession, windowIndex: placed.windowIndex }, deps)) ?? live;
        }
      } catch (e) {
        console.warn(`[delegate] recovering the window of ${live.id} failed:`, e?.message ?? e);
        return;
      }

      // (d) the send
      if (current.submittedAt == null) {
        // never sent
        const claimed = await patchJob(
          current.id,
          () => ({ launchState: "submitting", submittedAt: (deps.now ?? Date.now)() }),
          deps,
          { onlyIf: (j) => j.status === "running" && j.submittedAt == null },
        );
        if (claimed) await submitCommand(claimed, deps, { reconciled: true });
        return;
      }
      // sent, outcome unknown: is the launch's own message known to opencode?
      if (await hasAdmissionEvidence(current, deps)) {
        await patchJob(current.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) });
        return;
      }
      let active;
      try {
        active = await deps.listActiveIds();
      } catch {
        return;
      }
      if (active.includes(current.childSessionID)) return; // someone is driving it: look again next tick
      // not there and nothing running: send it again — SAME message id, which opencode admits once
      await submitCommand(current, deps, { reconciled: true });
    });
  } catch (e) {
    console.warn(`[delegate] recovering the continuation ${job.id} failed:`, e?.message ?? e);
  } finally {
    resuming.delete(job.id);
  }
}

/**
 * Launch a slash command in a background child session (N2, a command N3 could
 * not prove runs in the background). A NEW entry point — not adoptSubagentJob,
 * which skips launch checks because opencode already started that child.
 *
 * Checked BEFORE anything is created: the box-wide running cap and the
 * no-nesting rule (same refusals as startJob), and the parent's own permission
 * ruleset (the child gets exactly it, never wider). Then, in order: register the
 * job (client-minted child id + result id) → create the child (explicit
 * agent/model/permissions) → its window → persist submittedAt → send. Roll back
 * only what is proven not admitted (see submitCommand).
 *
 * @param {{ parentSessionID: string, parentDirectory?: string, command: string, arguments?: string,
 *           model?: {providerID:string, modelID:string, variant?:string}, agent?: string,
 *           attachments?: Array<object> }} input
 * @returns {Promise<{ok:true, job:object, uncertain?:true}|{ok:false, error:string}>}
 */
export async function startCommandJob(input, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, listProjects, readSession, now = () => Date.now() } = deps;
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  const parentSessionID = input?.parentSessionID;
  if (!parentSessionID) return { ok: false, error: "parentSessionID is required" };
  if (!command) return { ok: false, error: "command is required" };
  const args = String(input?.arguments ?? "");

  const refusal = (jobs) => {
    if (jobs.find((j) => j.childSessionID === parentSessionID && countsTowardCap(j))) {
      return { ok: false, error: "a background job cannot start another background job" };
    }
    if (jobs.filter(countsTowardCap).length >= MAX_RUNNING_JOBS) return { ok: false, error: CAP_ERROR };
    return null;
  };
  // Cheap early refusal (re-checked atomically below, before anything is created).
  {
    const early = refusal(await load());
    if (early) return early;
  }

  let parent;
  try {
    parent = await readSession(parentSessionID);
  } catch {
    parent = { state: "unknown" };
  }
  if (parent.state === "missing") return { ok: false, error: "this conversation no longer exists" };
  if (parent.state !== "found") return { ok: false, error: "Couldn't read this conversation's settings — try again" };
  const parentInfo = parent.session ?? {};
  const parentDirectory = input.parentDirectory || parentInfo.directory;
  if (!parentDirectory) return { ok: false, error: "parentDirectory is required" };

  const owner = resolveOwner(await listProjects(), parentSessionID);
  if (!owner) return { ok: false, error: `could not resolve the tmux session owning ${parentSessionID}` };

  // The child's controls: what the composer shows, else the parent's own —
  // passed EXPLICITLY (create AND run) so nothing can flip them afterwards.
  const agent = (typeof input.agent === "string" && input.agent) || (typeof parentInfo.agent === "string" && parentInfo.agent) || "build";
  const model =
    input.model?.providerID && input.model?.modelID
      ? { providerID: input.model.providerID, modelID: input.model.modelID, ...(input.model.variant ? { variant: input.model.variant } : {}) }
      : parentInfo.model?.providerID && parentInfo.model?.id
        ? { providerID: parentInfo.model.providerID, modelID: parentInfo.model.id, ...(parentInfo.model.variant ? { variant: parentInfo.model.variant } : {}) }
        : undefined;
  const permissions = Array.isArray(parentInfo.permissions) ? parentInfo.permissions : [];
  const name = commandDisplayName(command, args);
  const modelString = model ? `${model.providerID}/${model.modelID}` : null;

  // (a) Register FIRST, under the lock that also enforces the cap and nesting.
  const reg = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const refused = refusal(jobs);
    if (refused) return refused;
    const t = now();
    const job = {
      id: genId(),
      name,
      prompt: name,
      model: modelString,
      requestedModel: modelString,
      parentSessionID,
      parentDirectory,
      childSessionID: mintSessionId(),
      tmuxSession: owner.tmuxSession,
      windowIndex: null,
      worktree: null,
      branch: null,
      baseSha: null,
      origin: "command",
      link: null,
      actor: "user",
      correlation: null,
      sweepAllowanceMs: null,
      permission: null,
      status: "running",
      activity: null,
      createdAt: t,
      startedAt: t,
      finishedAt: null,
      result: null,
      error: null,
      filesChanged: null,
      engine: "v2",
      completionOwner: "manta",
      attempt: 1,
      launchState: "creating",
      submittedAt: null,
      completionMessageId: mintMessageId(),
      completionDelivery: null,
      agent,
      commandRun: { command, arguments: args, model, agent, ...(input.attachments?.length ? { attachments: input.attachments } : {}) },
    };
    jobs.push(job);
    inLaunch.add(job.id); // from the moment it exists: a sweep must never read it as cut off
    try {
      await save(jobs);
    } catch (e) {
      inLaunch.delete(job.id);
      throw e;
    }
    publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "running", launchState: "creating" } });
    return { ok: true, job };
  });
  if (!reg.ok) return reg;
  try {
    return await launchRegistered(reg.job, { owner, parentSessionID, parentDirectory, agent, model, permissions, name }, deps);
  } finally {
    inLaunch.delete(reg.job.id);
  }
}

// Steps (b)–(c) of startCommandJob, for a job already registered.
async function launchRegistered(job, { owner, parentSessionID, parentDirectory, agent, model, permissions, name }, deps) {
  const { newWindow, stampOwner, createChildSession, now = () => Date.now() } = deps;

  // (b) the child session
  try {
    await createChildSession({
      directory: parentDirectory,
      id: job.childSessionID,
      parentID: parentSessionID,
      title: name,
      agent,
      model,
      permissions,
    });
  } catch (e) {
    if (isDefiniteRefusal(e)) {
      await removeJobRecord(job.id, deps);
      return { ok: false, error: String(e?.message ?? e) };
    }
    const kept = (await patchJob(job.id, { launchState: "uncertain" }, deps)) ?? job;
    return { ok: true, job: kept, uncertain: true };
  }

  // …then the window / sidebar row
  let windowIndex = null;
  try {
    const created = await newWindow({
      sessionName: owner.tmuxSession,
      windowName: windowNameFor(name),
      cwd: parentDirectory,
      chatMode: true,
      existingSessionId: job.childSessionID,
      oc: deps.oc,
    });
    windowIndex = created.windowIndex ?? null;
  } catch (e) {
    // The child exists but nothing was sent: undo it all, report.
    await rollbackLaunch(job, deps);
    return { ok: false, error: String(e?.message ?? e) };
  }
  if (stampOwner && windowIndex != null) {
    try {
      await stampOwner(owner.tmuxSession, windowIndex, "job");
    } catch {
      /* advisory */
    }
  }

  // (c) persist submittedAt BEFORE sending; never rewritten for this attempt.
  job = (await patchJob(job.id, { windowIndex, launchState: "submitting", submittedAt: now() }, deps)) ?? job;
  return submitCommand(job, deps);
}

// ---- delegate jobs on V2 (Stage C1) ---------------------------------------
//
// Every job — the CTO's workers included — is a real V2
// child session: created under the parent with a client-minted id, moved into the
// job's worktree, given a window, and sent its opening prompt. It completes from the
// child's raw execution outcome (settleV2Job — the same evaluator B's wrapped runs
// use) and reports ONE result through N7, whatever route it takes to a terminal state.

// The agent every delegate child runs. Today's jobs always ran the default agent; a
// child created under a parent would otherwise be free to inherit a plan-mode one.
const V2_JOB_AGENT = "build";

/**
 * Register a delegate job and launch it (spec C1 steps 1–5).
 *
 * Everything before the first network call happens under the jobs lock: the nesting
 * and cap refusals, the worktree + branch, and the job record itself — registered
 * FIRST, with a minted child session id and result id, so every later step is
 * reconcilable by id. Then (outside the lock) launchDelegate runs create → move →
 * window → send. A definite refusal at any step undoes what was made; an UNKNOWN
 * outcome never rolls anything back (see launchDelegate).
 */
async function startJobV2({ input, prompt, parentSessionID, parentDirectory, requestedModel, effectiveModel }, deps) {
  const { load = loadJobs, save = saveJobs, publish, listProjects, gitRemoveWorktree, now = () => Date.now() } = deps;
  for (const dep of ["createChildSession", "moveSession", "sendChildPrompt", "newWindow", "listProjects"]) {
    if (typeof deps[dep] !== "function") return { ok: false, error: `background jobs are not wired in this server (${dep} is missing)` };
  }

  const reg = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const refused = launchRefusal(jobs, parentSessionID);
    if (refused) return refused;
    const name = jobNameFor(input, prompt);

    // Which workspace hosts the window — resolved before anything is created.
    let tmuxSession = input?.targetProject ?? null;
    if (!tmuxSession) {
      const owner = resolveOwner(await listProjects(), parentSessionID);
      if (!owner) return { ok: false, error: `could not resolve the tmux session owning ${parentSessionID}` };
      tmuxSession = owner.tmuxSession;
    }

    const wt = await prepareWorktree({ input, name, parentDirectory }, deps);
    if (wt.refusal) return wt.refusal;
    const { worktree, branch, baseSha } = wt;
    // THE execution directory, resolved once and persisted: the worktree, or the
    // parent's own directory when none could be made and isolation isn't required.
    const executionDirectory = worktree ?? parentDirectory;

    const t = now();
    const launchModel = toDeliverModel(effectiveModel);
    const job = {
      id: genId(),
      name,
      prompt,
      model: requestedModel ?? null,
      requestedModel: requestedModel ?? null,
      parentSessionID,
      parentDirectory,
      childSessionID: mintSessionId(),
      tmuxSession,
      windowIndex: null,
      worktree,
      branch,
      baseSha,
      origin: "delegate",
      link: input?.link ?? null,
      actor: input?.actor ?? "user",
      correlation: input?.correlation ?? null,
      sweepAllowanceMs: input?.sweepAllowanceMs ?? null,
      permission: input?.permission ?? null,
      status: "running",
      activity: null,
      createdAt: t,
      startedAt: t,
      finishedAt: null,
      result: null,
      error: null,
      filesChanged: null,
      engine: "v2",
      completionOwner: "manta",
      attempt: 1,
      launchState: "creating",
      submittedAt: null,
      // minted once per JOB: a resume keeps it, so the job's one result has one id
      completionMessageId: mintMessageId(),
      completionDelivery: null,
      agent: V2_JOB_AGENT,
      executionDirectory,
      // what the launch sends, persisted so a reconcile can finish a launch this
      // process never got to (and a resume reuses the first attempt's model)
      launch: {
        text: buildJobPrompt({ prompt, worktree, branch }),
        model: launchModel,
        messageId: mintMessageId(),
      },
    };
    inLaunch.add(job.id); // from the moment it exists: a sweep must never read it as cut off
    try {
      await save([...jobs, job]);
    } catch (e) {
      inLaunch.delete(job.id);
      if (worktree && gitRemoveWorktree) {
        try {
          await gitRemoveWorktree({ path: worktree, force: false });
        } catch {
          /* best-effort; the failed save is the headline error */
        }
      }
      return { ok: false, error: String(e?.message ?? e) };
    }
    publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "running", launchState: "creating" } });
    return { ok: true, job };
  });
  if (!reg.ok) return reg;
  try {
    return await launchDelegate(reg.job, deps);
  } finally {
    inLaunch.delete(reg.job.id);
  }
}

// The job's record, if it is still the running attempt this launch is for. A stop (or
// a timeout) that lands mid-launch ends the job; the launch must then not go on to
// give a finished job a window and a prompt.
async function launchStillWanted(job, deps) {
  const live = ((await (deps.load ?? loadJobs)()) ?? []).find((j) => j.id === job.id);
  return !!live && live.status === "running" && live.childSessionID === job.childSessionID;
}

// A launch that stopped because the job was ended meanwhile: take back what it made
// (never the record — that now carries the job's terminal state and its one result).
async function dropHaltedLaunch(job, deps) {
  if (deps.deleteSession && job.childSessionID) {
    try {
      await deps.deleteSession(job.childSessionID);
    } catch (e) {
      console.warn(`[delegate] deleting the child of ${job.id} failed:`, e?.message ?? e);
    }
  }
  await closeJobWindow(job, deps);
  return { ok: false, error: "the job was stopped before it started" };
}

/**
 * Steps (b)–(c) of a delegate launch, for a job already registered (also a resume's):
 * create the child → move it into the execution directory (when that isn't where it
 * was created) → its window → persist submittedAt → send the opening prompt.
 *
 * A DEFINITE refusal (4xx) undoes what this launch made and reports it. An UNKNOWN
 * outcome (network, timeout, 5xx) on the create, the move or the send keeps
 * everything — child, worktree, window, record — marked `launchState:"uncertain"`:
 * no read proves the original request can't still be admitted, so the sweeper keeps
 * reconciling it instead.
 */
async function launchDelegate(job, deps) {
  const { createChildSession, moveSession, newWindow, stampOwner, now = () => Date.now() } = deps;
  const uncertain = async () => {
    const kept = (await patchJob(job.id, { launchState: "uncertain" }, deps, { onlyIf: (j) => !isTerminal(j) })) ?? job;
    return { ok: true, job: kept, uncertain: true };
  };

  // (b) the child session — created under the parent, which places it at the parent's location
  let created = null;
  try {
    created = await createChildSession({
      directory: job.parentDirectory,
      id: job.childSessionID,
      parentID: job.parentSessionID,
      title: job.name,
      agent: job.agent,
      model: job.launch.model ?? undefined,
      permission: Array.isArray(job.permission) && job.permission.length > 0 ? job.permission : undefined,
    });
  } catch (e) {
    if (isDefiniteRefusal(e)) {
      await abandonLaunch(job, String(e?.message ?? e), deps, { childExists: false });
      return { ok: false, error: String(e?.message ?? e) };
    }
    return uncertain();
  }

  // …into the execution directory. V2 applies a move as an inbox item run by an
  // execution of its own (which "succeeds" ~half a second later), so the prompt is
  // held back until the move has landed and that execution is over: otherwise its
  // outcome would read as the job finishing.
  // Where the child actually IS decides whether it needs moving: a parent that is
  // not at the job's own directory (the CTO conversation, which sits wherever the
  // CTO does, not in the repository a worker is dispatched into) puts it elsewhere.
  const childDirectory = (typeof created?.directory === "string" && created.directory) || job.parentDirectory;
  const trimSlash = (d) => (d.length > 1 ? d.replace(/\/+$/, "") : d);
  if (job.executionDirectory && trimSlash(job.executionDirectory) !== trimSlash(childDirectory)) {
    if (!(await launchStillWanted(job, deps))) return dropHaltedLaunch(job, deps);
    try {
      await moveSession(job.childSessionID, job.executionDirectory);
    } catch (e) {
      if (isDefiniteRefusal(e)) {
        await abandonLaunch(job, String(e?.message ?? e), deps);
        return { ok: false, error: `could not move the session into its worktree: ${String(e?.message ?? e)}` };
      }
      return uncertain();
    }
    if (!(await awaitMoveApplied(job, deps))) return uncertain();
  }

  // …its window / sidebar row
  if (!(await launchStillWanted(job, deps))) return dropHaltedLaunch(job, deps);
  let windowIndex = null;
  try {
    const created = await newWindow({
      sessionName: job.tmuxSession,
      windowName: job.name,
      cwd: job.executionDirectory ?? job.parentDirectory,
      chatMode: true,
      existingSessionId: job.childSessionID,
      worktreePath: job.worktree ?? undefined,
      oc: deps.oc,
    });
    windowIndex = created.windowIndex ?? null;
  } catch (e) {
    await abandonLaunch(job, String(e?.message ?? e), deps);
    return { ok: false, error: String(e?.message ?? e) };
  }
  if (stampOwner && windowIndex != null) {
    try {
      await stampOwner(job.tmuxSession, windowIndex, "job");
    } catch {
      /* advisory */
    }
  }

  // (c) persist submittedAt BEFORE sending; never rewritten for this attempt. A job
  // that was ended while the window was being made gets nothing sent.
  const submitting = await patchJob(
    job.id,
    { windowIndex, launchState: "submitting", submittedAt: now() },
    deps,
    { onlyIf: (j) => j.status === "running" && j.childSessionID === job.childSessionID },
  );
  if (!submitting) return dropHaltedLaunch({ ...job, windowIndex }, deps);
  return submitCommand(submitting, deps);
}

/**
 * Undo a delegate launch that was REFUSED before anything ran: the child (when it
 * exists), the window, the worktree and the record — or, for a resume, just put the
 * paused job back exactly as it was (its old window was never closed).
 */
async function rollbackDelegateLaunch(job, deps, { childExists = true } = {}) {
  if (childExists && deps.deleteSession && job.childSessionID) {
    try {
      await deps.deleteSession(job.childSessionID);
    } catch (e) {
      console.warn(`[delegate] deleting the child of ${job.id} failed:`, e?.message ?? e);
    }
  }
  await closeJobWindow(job, deps);
  const restore = job.launch?.restore;
  if (restore) {
    await patchJob(job.id, { ...restore, launch: restore.launch ?? null }, deps);
    return;
  }
  if (job.worktree && deps.gitRemoveWorktree) {
    try {
      await deps.gitRemoveWorktree({ path: job.worktree, force: false });
    } catch (e) {
      console.warn(`[delegate] removing the worktree of ${job.id} failed:`, e?.message ?? e);
    }
  }
  await removeJobRecord(job.id, deps);
}

// A launch that can't go on. Called synchronously by the launch that was refused
// (nothing was promised yet: undo it all) and by a reconcile finishing a launch that
// was reported as started — that one must end `failed` with its one result, unless it
// is a resume, which just goes back to paused.
async function abandonLaunch(job, message, deps, { childExists = true, reconciled = false } = {}) {
  if (reconciled && !job.launch?.restore) {
    await finishV2Job(job, "failed", `could not start: ${message}`, deps);
    return;
  }
  await rollbackDelegateLaunch(job, deps, { childExists });
}

/**
 * Wait (bounded) until the move has LANDED: the child's own directory is the
 * execution directory and the execution that applied the move is over. V2 answers
 * the move with a 204 and applies it as an inbox item, so neither is true right away.
 * Any unreadable poll just counts as "not yet".
 */
async function awaitMoveApplied(job, deps) {
  const { attempts = 75, intervalMs = 200 } = deps.moveWait ?? {};
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const rs = await deps.readSession(job.childSessionID);
      if (rs.state === "found" && rs.session?.directory === job.executionDirectory) {
        const active = await deps.listActiveIds();
        if (!active.includes(job.childSessionID)) return true;
      }
    } catch {
      /* not yet */
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}

/**
 * Has the child been moved into the job's execution directory? Re-issues the move
 * only when neither the session nor its inbox shows it, and answers `ok` only once
 * the move has landed (awaitMoveApplied) — a launch that goes on before that would
 * mistake the move's own execution for the job finishing.
 */
async function ensureMoved(job, deps) {
  const dir = job.executionDirectory;
  if (!job.launch || !dir) return { ok: true };
  try {
    const rs = await deps.readSession(job.childSessionID);
    if (rs.state !== "found") return { ok: false };
    // (the child's own directory is the authority: created under the parent, it sits
    // at the PARENT's location, which is not always the job's directory)
    if (rs.session?.directory !== dir) {
      const inbox = (await deps.listInbox?.(job.childSessionID)) ?? [];
      if (!inbox.some((i) => i?.type === "move" && i?.payload?.location?.directory === dir)) {
        await deps.moveSession(job.childSessionID, dir);
      }
    }
  } catch (e) {
    return isDefiniteRefusal(e) ? { ok: false, definite: true, error: String(e?.message ?? e) } : { ok: false };
  }
  return { ok: await awaitMoveApplied(job, deps) };
}

/**
 * Register a paused delegate job's next attempt (spec C1 step 8): the SAME job — id,
 * result id and worktree unchanged — with `attempt` bumped, a new client-minted child
 * and a launch to run. What it replaces is kept in `launch.restore`, so a refused
 * launch puts the job back as it was and the old window outlives the swap until the
 * new attempt is known to be running. Runs under the jobs lock.
 */
async function registerV2Resume(jobs, idx, job, prepared, deps) {
  const { save = saveJobs, publish, now = () => Date.now() } = deps;
  if (job.origin === "command" || completionOwnerOf(job) === "opencode") return { ok: false, error: "resume isn't available for this job" };
  if (!prepared || prepared.childId !== job.childSessionID) return { ok: false, error: "the job changed while it was being resumed — try again", retriable: true };
  let tmuxSession = job.tmuxSession ?? null;
  if (!tmuxSession) {
    const owner = resolveOwner(await deps.listProjects(), job.parentSessionID);
    if (!owner) return { ok: false, error: `could not resolve the tmux session owning ${job.parentSessionID}` };
    tmuxSession = owner.tmuxSession;
  }
  const updated = {
    ...job,
    status: "running",
    tmuxSession,
    childSessionID: mintSessionId(),
    attempt: (job.attempt ?? 1) + 1,
    windowIndex: null,
    pauseRequested: false,
    pausedAt: null,
    stopRequested: false,
    // Reset the running-timeout clock: a resumed job re-acquires a cap slot AND a
    // fresh allowance window "like a fresh start".
    startedAt: now(),
    launchState: "creating",
    submittedAt: null,
    executionDirectory: job.executionDirectory ?? job.worktree ?? job.parentDirectory,
    launch: {
      text: prepared.text,
      model: job.launch?.model ?? null,
      messageId: mintMessageId(),
      restore: {
        status: "paused",
        childSessionID: job.childSessionID,
        attempt: job.attempt ?? 1,
        tmuxSession: job.tmuxSession ?? null,
        windowIndex: job.windowIndex ?? null,
        pausedAt: job.pausedAt ?? null,
        startedAt: job.startedAt ?? null,
        submittedAt: job.submittedAt ?? null,
        launchState: job.launchState ?? "running",
        launch: job.launch ? { ...job.launch, restore: undefined } : null,
      },
    },
  };
  jobs[idx] = updated;
  inLaunch.add(updated.id);
  try {
    await save(jobs);
  } catch (e) {
    inLaunch.delete(updated.id);
    throw e;
  }
  publish?.({ kind: "delegate.updated", payload: { id: updated.id, status: "running", launchState: "creating" } });
  return { ok: true, v2: true, job: updated };
}

// ---- open a job's session -------------------------------------------------

/**
 * `delegate:open-session`: where the job's chat window is — re-created, stamped
 * with the child session id, if it was closed. A child that no longer exists is
 * a visible error, never a window onto nothing.
 * @returns {Promise<{ok:true, tmuxSession:string, windowIndex:number}|{ok:false, error:string}>}
 */
export async function openJobSession(id, deps = {}) {
  const { load = loadJobs } = deps;
  const peek = (await load()).find((j) => j.id === id);
  if (!peek) return { ok: false, error: "that background job no longer exists" };
  if (!peek.childSessionID) return { ok: false, error: "this background job has no session yet" };
  // Window creation is a session resource: it must not interleave with a cleanup or a successor's setup.
  return withSessionResources(peek.childSessionID, () => openJobSessionLocked(id, peek.childSessionID, deps));
}

async function openJobSessionLocked(id, lockedChild, deps) {
  const { load = loadJobs, listProjects, newWindow, stampOwner, readSession } = deps;
  const all = (await load()) ?? [];
  const found = all.find((j) => j.id === id);
  if (!found) return { ok: false, error: "that background job no longer exists" };
  if (found.childSessionID !== lockedChild) return { ok: false, error: "the job changed while it was being opened — try again" };
  // A superseded run shares the session with its successor: the window it opens belongs to the successor.
  const job = found.supersededBy ? (newestRecordFor(all, lockedChild) ?? found) : found;
  id = job.id;

  let rs;
  try {
    rs = await readSession(job.childSessionID);
  } catch {
    rs = { state: "unknown" };
  }
  if (rs.state === "missing") return { ok: false, error: "The session no longer exists" };
  if (rs.state !== "found") return { ok: false, error: "Couldn't reach opencode to open the session — try again" };

  try {
    const projects = (await listProjects()) ?? [];
    for (const p of projects) {
      const win = (p.windows || []).find((w) => w.opencodeSessionId === job.childSessionID);
      if (win) {
        if (win.index !== job.windowIndex || p.tmuxSession !== job.tmuxSession) {
          await patchJob(id, { tmuxSession: p.tmuxSession, windowIndex: win.index }, deps);
        }
        return { ok: true, tmuxSession: p.tmuxSession, windowIndex: win.index };
      }
    }
    const owner = job.tmuxSession
      ? { tmuxSession: job.tmuxSession }
      : resolveOwner(projects, job.parentSessionID);
    if (!owner) return { ok: false, error: `could not find the workspace that owns this job` };
    const created = await newWindow({
      sessionName: owner.tmuxSession,
      windowName: windowNameFor(job.name),
      cwd: job.worktree || job.parentDirectory,
      chatMode: true,
      existingSessionId: job.childSessionID,
      worktreePath: job.worktree ?? undefined,
      oc: deps.oc,
    });
    if (stampOwner && created.windowIndex != null) {
      try {
        await stampOwner(owner.tmuxSession, created.windowIndex, "job");
      } catch {
        /* advisory */
      }
    }
    await patchJob(id, { tmuxSession: owner.tmuxSession, windowIndex: created.windowIndex ?? null }, deps);
    return { ok: true, tmuxSession: owner.tmuxSession, windowIndex: created.windowIndex };
  } catch (e) {
    return { ok: false, error: `Couldn't open the session: ${String(e?.message ?? e)}` };
  }
}

// ---------------------------------------------------------------------------
// The active-session reconciler
//
// A session that is busy but has no job row is invisible: a script drove it through opencode's
// HTTP API, a finished job was prompted again, a background `task` ran under a parent that has no
// window, or work started while this server was restarting. Each tick lists the sessions with a
// turn in flight and adopts the ones nothing tracks (origin "observed" — track-only: no result is
// ever posted for them, they never count toward the cap).
//
// What it deliberately leaves alone: a session that already has a live row, one a launch in this
// process is making, anything inside a live job's tree, Manta's own helper sessions, an inline
// (foreground) `task` child, a user's own window, and a session whose handoff is pending. A session
// must be seen busy on consecutive ticks before it is adopted, so seconds-long helpers never appear.
// ---------------------------------------------------------------------------

const RECONCILE_TICKS = 2;
// A child whose parent's `task` block can't be found yet is held a tick longer: the block is what
// tells an inline child (never a row) from a background one.
const RECONCILE_TICKS_NO_BLOCK = 3;

const modelStringOf = (m) => (m?.providerID && (m.id ?? m.modelID) ? `${m.providerID}/${m.id ?? m.modelID}` : null);

/**
 * @param {object} deps readSession, listActiveIds, listProjects, listRawTimeline, load, now, plus
 *   the optional predicates isInternalSession / isCtoConversationSession / deferSettlement, and
 *   everything adoptExistingSession needs.
 * @returns {{ reconcile: () => Promise<{adopted:number}|{skipped:string}>, seenCount: () => number }}
 */
export function createActiveSessionReconciler(deps = {}) {
  const { now = () => Date.now() } = deps;
  const seen = new Map(); // sid -> { ticks, since }: consecutive ticks seen busy + the first one
  const driverLookedUpAt = new Map(); // job id -> when its DB driver lookup last ran

  // Is `session` somewhere below a job that is still live? → "inside" | "outside" | "unknown"
  async function insideLiveJobTree(session, jobs) {
    const live = new Set(jobs.filter((j) => !isTerminal(j) && j.childSessionID).map((j) => j.childSessionID));
    if (live.size === 0) return "outside";
    const visited = new Set([session.id]);
    let parent = typeof session.parentID === "string" ? session.parentID : null;
    for (let depth = 0; parent && depth < MAX_ANCESTOR_DEPTH; depth++) {
      if (live.has(parent)) return "inside";
      if (visited.has(parent)) return "outside";
      visited.add(parent);
      let rs;
      try {
        rs = await deps.readSession(parent);
      } catch {
        return "unknown";
      }
      if (rs?.state === "unknown" || !rs) return "unknown";
      if (rs.state === "missing") return "outside";
      parent = typeof rs.session?.parentID === "string" ? rs.session.parentID : null;
    }
    return "outside";
  }

  async function consider(sid, { jobs, projects, windowed }) {
    const records = jobs.filter((j) => j.childSessionID === sid);
    // a. a live row (running / paused) already represents it; b. a launch in this process is making it
    if (records.some((j) => !isTerminal(j) || inLaunch.has(j.id) || resuming.has(j.id))) return skip(sid);
    if (deps.deferSettlement?.(sid)) return skip(sid);
    // a session that already has a window is visible: the user's own, or a finished job they reopened
    if (windowed.has(sid)) return skip(sid);
    // a handoff's successor is busy and windowless until the handoff commits
    if (deps.isHandoffSuccessor?.(sid)) return skip(sid);

    let rs;
    try {
      rs = await deps.readSession(sid);
    } catch {
      rs = { state: "unknown" };
    }
    if (rs?.state !== "found") return false; // unreadable: look again next tick, no warning
    const session = { ...(rs.session ?? {}), id: sid };

    // c. below a live job: that row already represents the work
    const tree = await insideLiveJobTree(session, jobs);
    if (tree === "unknown") return false;
    if (tree === "inside") return skip(sid);

    // d. Manta's own helper sessions
    if (isMarkedInternal(session)) return skip(sid);
    try {
      if ((await deps.isInternalSession?.(sid)) || (await deps.isCtoConversationSession?.(sid))) return skip(sid);
    } catch {
      return false; // a provenance store that can't answer fails closed
    }

    // e. an inline `task` child is part of its parent's turn, never a row
    let required = RECONCILE_TICKS;
    if (session.parentID) {
      let timeline;
      try {
        timeline = (await deps.listRawTimeline(session.parentID, { type: "assistant" })) ?? [];
      } catch {
        return false;
      }
      const block = toolBlockFor(timeline, sid);
      if (block) {
        const background = block.state?.input?.background === true || block.state?.metadata?.background === true;
        if (!background) return skip(sid);
      } else {
        required = RECONCILE_TICKS_NO_BLOCK;
      }
    }

    // f. seen busy on consecutive ticks
    const entry = seen.get(sid) ?? { ticks: 0, since: now() };
    entry.ticks += 1;
    seen.set(sid, entry);
    if (entry.ticks < required) return false;

    // g. adopt
    const prev = newestRecordFor(records, sid);
    const ownWindow = resolveOwner(projects, sid);
    const res = await resolveSessionOwner(sid, deps, { session });
    if (res.status === "unknown") return false;
    const owner = res.status === "ok" ? res.owner : ownWindow ? { tmuxSession: ownWindow.tmuxSession } : null;
    if (!owner) {
      warnOnce(`no-owner:${sid}`, "[delegate] could not find a workspace for the busy session", sid, "— not tracked");
      return false;
    }
    const title = typeof session.title === "string" ? session.title.trim() : "";
    const out = await adoptExistingSession(
      {
        childSessionID: sid,
        owner,
        displayParentID: res.status === "ok" ? res.displayParentID : (prev?.parentSessionID ?? null),
        sessionParentID: session.parentID ?? null,
        cwd: session.directory || undefined,
        parentDirectory: session.directory || undefined,
        name: title.slice(0, 80) || "Background session",
        prompt: "",
        model: modelStringOf(session.model),
        origin: "observed",
        runStartedAt: entry.since,
      },
      deps,
    );
    seen.delete(sid);
    if (!out.ok) {
      warnOnce(`adopt:${sid}`, `[delegate] adopting the busy session ${sid} failed:`, out.error);
      return false;
    }
    return !!out.job;
  }

  function skip(sid) {
    seen.delete(sid);
    return false;
  }

  async function reconcile() {
    if (typeof deps.listActiveIds !== "function" || typeof deps.readSession !== "function" || typeof deps.listProjects !== "function") {
      return { skipped: "no-readers" };
    }
    let active;
    try {
      active = await deps.listActiveIds();
    } catch {
      return { skipped: "unknown" };
    }
    if (!Array.isArray(active)) return { skipped: "unknown" };
    const activeSet = new Set(active);
    for (const sid of [...seen.keys()]) if (!activeSet.has(sid)) seen.delete(sid);
    let projects;
    try {
      projects = (await deps.listProjects()) ?? [];
    } catch {
      return { skipped: "unknown" };
    }
    const jobs = (await (deps.load ?? loadJobs)()) ?? [];
    const windowed = new Set();
    for (const p of Array.isArray(projects) ? projects : []) for (const w of p.windows || []) if (w?.opencodeSessionId) windowed.add(w.opencodeSessionId);
    let adopted = 0;
    for (const sid of active) {
      try {
        if (await consider(sid, { jobs, projects, windowed })) adopted += 1;
      } catch (e) {
        console.warn(`[delegate] reconciling the busy session ${sid} failed:`, e?.message ?? e);
      }
    }
    // A row whose display parent lost its window (or never had one) may now have a better one. The DB rule is
    // throttled per record so a row nothing drives doesn't re-scan the transcripts every tick.
    try {
      const t = now();
      const minGap = deps.driverLookupMinIntervalMs ?? DRIVER_LOOKUP_MIN_INTERVAL_MS;
      await refreshDisplayParents(deps, {
        driverFor: (job) => {
          const last = driverLookedUpAt.get(job.id);
          if (last != null && t - last < minGap) return false;
          driverLookedUpAt.set(job.id, t);
          while (driverLookedUpAt.size > 500) driverLookedUpAt.delete(driverLookedUpAt.keys().next().value);
          return true;
        },
      });
    } catch (e) {
      console.warn("[delegate] refreshing background row parents failed:", e?.message ?? e);
    }
    return { adopted };
  }

  return { reconcile, seenCount: () => seen.size };
}

// ---------------------------------------------------------------------------
// Engine factory — wires the runtime deps once (in src/server/index.mjs) and
// returns bound methods the REST/RPC handlers + the pump call. Mirrors the
// createPromptDelivery / createWebhookEngine pattern.
// ---------------------------------------------------------------------------

export function createDelegateEngine(baseDeps) {
  // Per-session promise chain. opencode emits several events per turn boundary
  // and the pump calls observeEvent without awaiting it, so two invocations can
  // be in flight at once. Every observeEvent branch is a read store -> decide
  // -> write store sequence with awaits in the middle; without serialisation
  // each sequence interleaves with itself (one subagent adopted twice, one job
  // reporting completion twice — BET-773). Serialising per session makes the
  // second adoption event load a store that already holds the record and the
  // second idle event find no running job. Per-session, not global: different
  // sessions share no state, and a global chain would queue every session
  // behind one slow transcript read.
  const chains = new Map(); // key -> tail promise
  const serialize = (key, fn) => {
    const tail = (chains.get(key) ?? Promise.resolve())
      .then(fn)
      .catch((e) => console.warn("[delegate] event handling failed:", e?.message ?? e));
    chains.set(key, tail);
    // Drop the chain tail from the map only if it is still the current one,
    // so the map cannot grow without bound and a live chain is never removed
    // from under a queued event.
    const drop = () => { if (chains.get(key) === tail) chains.delete(key); };
    tail.then(drop, drop);
    return tail;
  };

  // ---- V2 state: raw outcomes, the descendant index, provisional adoption ----
  const nowFn = baseDeps.now ?? (() => Date.now());
  const lifecycle = baseDeps.lifecycle ?? createLifecycleMap({ now: nowFn });
  const treeIndex = new Map(); // descendant session id -> root job id (Manta-owned wrapped runs)
  const candidates = new Map(); // child session id -> { parentID, name, timer }
  const claims = new Map(); // child session id -> { background, at }
  const setTimer = baseDeps.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; });
  const clearTimer = baseDeps.clearTimer ?? ((h) => clearTimeout(h));
  const boundMap = (m, cap) => { while (m.size > cap) m.delete(m.keys().next().value); };

  // A `task` tool part named this child: foreground → inline only (never a row),
  // background → the existing subagent adoption. Either way it is no longer a
  // candidate for command adoption.
  function noteClaim(childId, background) {
    const cutoff = nowFn() - LIFECYCLE_TTL_MS;
    for (const [id, v] of claims) if (v.at < cutoff) claims.delete(id);
    claims.set(childId, { background, at: nowFn() });
    boundMap(claims, 500);
    const c = candidates.get(childId);
    if (c) {
      if (c.timer) clearTimer(c.timer);
      candidates.delete(childId);
    }
  }
  const deps = { ...baseDeps, lifecycleGet: (sid) => lifecycle.get(sid), onSubagentClaim: noteClaim };
  const activeReconciler = createActiveSessionReconciler(deps);

  async function adoptCandidate(childId) {
    const c = candidates.get(childId);
    if (!c) return;
    candidates.delete(childId);
    if (claims.has(childId)) return;
    // The parent may have no window of its own: the row nests under its nearest windowed ancestor
    // (or lands in the workspace owning its directory) instead of being dropped.
    const res = await adoptSubagentJob(
      { parentSessionID: c.parentID, childSessionID: childId, name: c.name, prompt: c.name, model: null, origin: "command", runStartedAt: c.since },
      deps,
    );
    if (res?.none) warnOnce(`no-owner:${childId}`, "[delegate] could not resolve the owning workspace to adopt a background command:", c.parentID);
  }

  // The last open command window of a session closed: its unclaimed candidates
  // are adopted ADOPT_GRACE_MS later (a claiming tool part may still arrive).
  function windowClosed({ sessionId }) {
    const open = deps.openCommandWindows?.(sessionId) ?? [];
    if (open.length > 0) return;
    for (const [childId, c] of candidates) {
      if (c.parentID !== sessionId || c.timer) continue;
      c.timer = setTimer(() => { void serialize(`adopt:${childId}`, () => adoptCandidate(childId)); }, ADOPT_GRACE_MS);
    }
  }

  const rawOutcome = (type) =>
    type === "session.execution.succeeded" ? "succeeded" : type === "session.execution.failed" ? "failed" : type === "session.execution.interrupted" ? "interrupted" : null;

  async function onSessionCreated(raw) {
    const d = raw.data ?? {};
    const childId = d.sessionID;
    const parentID = d.parentID;
    if (typeof childId !== "string" || typeof parentID !== "string") return;
    const jobs = await (deps.load ?? loadJobs)();
    // A descendant of a Manta-owned wrapped run: remember whose tree it is.
    const root = jobs.find((j) => completionOwnerOf(j) === "manta" && !isTerminal(j) && j.childSessionID === parentID);
    const rootId = root?.id ?? treeIndex.get(parentID);
    if (rootId) {
      treeIndex.set(childId, rootId);
      boundMap(treeIndex, TREE_INDEX_MAX);
      return; // inside a wrapped run's tree: never a row of its own
    }
    if (jobs.some((j) => j.childSessionID === childId || j.childSessionID === parentID)) return;
    if (claims.has(childId)) return;
    const open = deps.openCommandWindows?.(parentID) ?? [];
    if (open.length === 0) return;
    const name = open.length === 1 ? commandDisplayName(open[0].name, open[0].arguments) : "Background command";
    candidates.set(childId, { parentID, name, timer: null, since: nowFn() });
    boundMap(candidates, 200);
  }

  async function onExecutionEvent(raw) {
    const sid = raw.data?.sessionID;
    const type = raw.type;
    const outcome = rawOutcome(type);
    const jobs = await (deps.load ?? loadJobs)();
    for (const job of jobs) {
      if (job.status !== "running" || !job.childSessionID) continue;
      const own = job.childSessionID === sid;
      if (!own && treeIndex.get(sid) !== job.id) continue;
      // A start only matters as proof an uncertain launch was admitted.
      if (!outcome && !(own && job.launchState === "uncertain")) continue;
      await settleV2Job(job, deps, { hint: own && outcome ? lifecycle.get(sid) : undefined });
    }
  }

  // observeRaw: the pump hands every RAW V2 event here (alongside the lifecycle
  // adapter's). Only a child's creation and its execution boundaries matter.
  const observeRaw = (raw) => {
    const type = raw?.type;
    const sid = raw?.data?.sessionID;
    if (typeof sid !== "string" || !sid) return Promise.resolve();
    if (type === "session.created") return serialize(`raw:${sid}`, () => onSessionCreated(raw));
    if (
      type === "session.execution.started" ||
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted"
    ) {
      // A raw outcome is remembered synchronously — adoption may read it any moment.
      const outcome = rawOutcome(type);
      if (outcome) lifecycle.record(sid, { outcome, error: raw.data?.error?.message ?? null });
      return serialize(`raw:${sid}`, () => onExecutionEvent(raw));
    }
    return Promise.resolve();
  };

  const approvals = deps.approvals ?? createApprovalState({ now: deps.now });
  // startJobWithApproval: the REST handler's entry point (BET-418 §A). Builds
  // the ruleset, requests approval when trust mode is OFF + tools were
  // declared, and only then starts the job. Returns the startJob result OR
  // {ok:false, error:"declined"}.
  const startJobWithApproval = async (input) => {
    const tools = Array.isArray(input?.tools) ? input.tools : [];
    const trustMode = !!input?.trustMode;
    // Skip the card entirely when trust mode is on (nothing to approve) or
    // when the model declared no tools (nothing to scope). The ruleset is
    // still applied so the catch-all deny keeps an unscoped job from asking.
    let resolvedTools = tools;
    if (!trustMode && tools.length > 0) {
      const approval = approvals.create({
        parentSessionID: input.parentSessionID,
        name: deriveName(input.prompt),
        prompt: input.prompt,
        tools,
      });
      deps.publish?.({ kind: "delegate.approval.requested", payload: approval });
      const { decision, tools: edited } = await approvals.awaitDecision(approval.id);
      if (decision !== "approve") {
        return { ok: false, error: decision === "timeout" ? "approval timed out" : "declined" };
      }
      resolvedTools = Array.isArray(edited) && edited.length > 0 ? edited : tools;
    }
    const permission = buildPermissionRuleset(resolvedTools);
    return startJob({ ...input, permission }, deps);
  };
  const bound = {
    startJob: (input) => startJob(input, deps),
    startJobWithApproval,
    startCommandJob: (input) => startCommandJob(input, deps),
    openSession: (id) => openJobSession(id, deps),
    /** `delegate_send`: another round of one of the caller's finished jobs (a NEW record on the same session). */
    continueJob: (id, input) => continueJob(id, input, deps),
    stopJob: (id) => stopJob(id, deps),
    deleteJob: (id, opts) => deleteJob(id, deps, opts),
    pauseJob: (id) => pauseJob(id, deps),
    resumeJob: (id) => resumeJob(id, deps),
    runningJobCount: () => runningJobCount(deps),
    reconcileJobsOnBoot: () => reconcileJobsOnBoot(deps),
    // Boot / (re)connect: the authoritative re-check of every unfinished V2 job
    // and the retry of every result not yet posted to its parent.
    reconcileV2: async () => {
      await reconcileV2Jobs(deps);
      await retryPendingDeliveries(deps);
    },
    // Adopt every busy session nothing tracks (see createActiveSessionReconciler). Boot runs it once
    // after reconcileV2, then starts the poller.
    reconcileActiveSessions: () => activeReconciler.reconcile(),
    startActiveSessionReconciler: ({ intervalMs = ACTIVE_RECONCILE_INTERVAL_MS } = {}) =>
      startPoller(() => activeReconciler.reconcile(), { intervalMs, label: "delegate-reconcile", immediate: false }),
    observeRaw,
    windowClosed,
    lifecycle,
    observeEvent: (evt) => {
      const sid = evt?.properties?.sessionID;
      if (typeof sid !== "string" || !sid) {
        // Nothing to serialise on — call through unchanged.
        return observeEvent(evt, deps);
      }
      return serialize(sid, () => observeEvent(evt, deps));
    },
    sweep: () => sweepDelegateJobs(deps),
    // §6.3: a parent's list includes the jobs of its whole replacement chain.
    listJobs: (filter) => {
      const chain = filter?.sessionID !== undefined ? deps.replacementChain?.(filter.sessionID) : null;
      return listJobs(Array.isArray(chain) && chain.length > 1 ? { sessionIDs: chain } : filter, deps);
    },
    repointSessions: (a) => repointJobSessions(a, deps),
    /** Is `sessionId` the own session of a job that is still running? */
    isRunningJobSession: async (sessionId) => ((await (deps.load ?? loadJobs)()).some((j) => j.childSessionID === sessionId && j.status === "running")),
    getJob: (id) => getJob(id, deps),
    startSweeper: (opts) => startSweeper(deps, opts),
    startActivityPoller: (opts) => startActivityPoller(deps, opts),
    approvals,
    approve: (id, tools) => approvals.resolve(id, "approve", tools),
    decline: (id) => approvals.resolve(id, "declined"),
    listPendingApprovals: (parentSessionID) => approvals.list(parentSessionID),
    /** Test seam. */
    _state: { candidates, claims, treeIndex },
  };
  return bound;
}
