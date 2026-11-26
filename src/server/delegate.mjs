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
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { SPECIALIST_TASK_TOOLS } from "../shared/researchTools.mjs";
import { decisionLines, decisionFromForm, waitingLine, TASK_GONE, TASK_PAUSED } from "./taskDecision.mjs";
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
import { backgroundResultText } from "../shared/opencodeV2.mjs";
import { chooseModel, describeDecision } from "../shared/modelRouter.mjs";
import { listRoutableModels } from "./opencode.mjs";
import { buildRoutingServices } from "./routingServices.mjs";
import { isMarkedInternal } from "./internalSessionMarker.mjs";
import { createJobLiveness, activityTarget, activityTimeoutMs } from "./jobLiveness.mjs";
import {
  DEFAULT_CEILING_MS,
  addMilestone,
  applyChecklist,
  applyModelReport,
  defaultJobProgress,
  finalHeadline,
  formatDuration,
  headlineOf,
  initialCeilingMs,
  lacksLivenessDefaults,
  mergeUsage,
  recomputeSteps,
  validateMaxDurationMinutes,
  withLivenessDefaults,
} from "./jobProgressView.mjs";
import { createJobViews } from "./jobViews.mjs";
import {
  jobRules,
  policyKey,
  normalizePolicy,
  decide as decideAutonomy,
  taskPromptSection,
  taskFooter,
  extractActions,
  actionLines,
  isInsideMantaFolders,
  SETTINGS_UNREADABLE,
  CODE_OFF,
  POLICY_CHANGED,
  LEGACY_TASK,
  MANTA_FOLDER,
} from "./autonomy.mjs";
import { projectPatterns as buildProjectPatterns } from "./projectActions.mjs";

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
/** Narrow shared exclusion for on-demand holders (chain lock must be taken first). */
export const withSessionLock = (sid, fn) => withSessionResources(sid, fn);

// Max concurrently `running` jobs, counted box-wide. There is no `queued`
// state — a job either starts immediately or is refused by the cap.
export const MAX_RUNNING_JOBS = 10;
// Cap-refusal copy, spelled exactly for the UI/REST consumer and pinned by
// delegate.test.mjs.
export const CAP_ERROR =
  "too many background jobs running (10). Do not retry — either wait for one to finish, or do this work yourself.";
// A Manta-owned segment that runs past its `ceilingMs` (default 4 h, spec 2026-11-14 A3) → `failed`, endReason
// "time-limit". A job that makes no progress for 15 minutes is ended as stalled (jobLiveness.judgeStall).
const EXTEND_MAX_CEILING_MS = 12 * 60 * 60_000;
const FILES_REFRESH_BUDGET_MS = 5_000;
const RECONSTRUCT_BUDGET_MS = 5_000;
const SWEEP_IO_CONCURRENCY = 2;
// How often a running job's usage / last-progress time is folded into its record.
const PROGRESS_FLUSH_MS = 60_000;
// `paused` jobs are kept this long before the sweeper stops them (spec §11.6
// "[sweep] paused > 7 days → stopped"). A paused job's worktree persists, so
// the pause window is generous.
const PAUSE_KEEP_MS = 7 * 24 * 60 * 60_000;
// Terminal jobs are retained this long, OR until 50 records, whichever bites
// first. The window + worktree are NEVER removed by the sweeper — only by an
// explicit delete.
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_TERMINAL_JOBS = 50;
const MAX_SUPERSEDED_PER_SESSION = 5;
// Activity-summary poller cadence (updates `activity` for running jobs only).
const ACTIVITY_INTERVAL_MS = 10_000;
// Sweeper cadence (matches capabilities.mjs SWEEP_INTERVAL_MS).
const SWEEP_INTERVAL_MS = 60_000;
// Active-session reconciler cadence (adopts busy sessions nothing tracks).
const ACTIVE_RECONCILE_INTERVAL_MS = 15_000;
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

/**
 * Like `loadJobs`, but `[]` only for a MISSING file: any other read or parse failure throws. The lead's checks
 * (is this chat led? is a second writer allowed?) must never read an unreadable store as an empty one.
 */
export async function loadJobsStrict(path = STORE_PATH) {
  let text;
  try {
    text = await readFile(path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.jobs)) throw new Error("the jobs store has no jobs list");
  return parsed.jobs;
}

export async function saveJobs(jobs, path = STORE_PATH) {
  await writeJsonAtomic(path, JSON.stringify({ jobs }, null, 2));
  ownerIndexCache.delete(path); // every in-process write drops the index (an mtime can repeat within one clock tick)
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
export function buildJobPrompt({ prompt, worktree, branch, facts, ceilingMs, readOnly = false, allowPr = true, autonomy = "", specialist = false }) {
  const head = String(prompt ?? "").trim();
  const factsSection =
    facts && String(facts).trim().length > 0
      ? "\n\n---\nRelevant project context (from the CTO blackboard):\n" + String(facts).trim() + "\n"
      : "";
  const limit = formatDuration(Number.isFinite(ceilingMs) && ceilingMs > 0 ? ceilingMs : DEFAULT_CEILING_MS);
  // A read-only job (an agent with isolation "none") changes nothing, so there is nothing to commit.
  const budget =
    `Time: this job is stopped after ${limit} of work (and earlier if it makes no\n` +
    (readOnly
      ? "progress for 15 minutes).\n\n"
      : "progress for 15 minutes). Commit your work as you go so nothing is lost if it\n" + "is stopped.\n\n") +
    "Progress: keep your todo list current — it is shown to the user as your\n" +
    "progress. At each plan step call progress_report with a one-line label; when\n" +
    "you find or finish something the user would want to know, add it as a\n" +
    (specialist
      ? "milestone. If you need the user to decide, use the question tool. It returns at once\n" +
        "with a note that the question is waiting; keep working on what doesn't depend on the\n" +
        "answer. The answer arrives later as a message from the user. Put what you found and\n" +
        'what you recommend in the question itself (mark the option you recommend "(Recommended)").\n\n'
      : "milestone. You cannot ask the user questions from here: if you need a decision,\n" +
        'call progress_report with state "blocked" and a label saying what you need, then\n' +
        "end your turn with the question.\n\n");
  // a specialist's task (Agents Phase 3): what needs the user's go-ahead and what is not allowed
  const autonomySection = typeof autonomy === "string" && autonomy.trim() ? `${autonomy.trim()}\n\n` : "";
  if (!worktree) {
    return (
      head +
      "\n\n---\n" +
      "You are running as a background job. The user is not watching this session and\n" +
      "cannot see your intermediate output — only your final message is reported back.\n\n" +
      (readOnly ? "You can read and search, but you cannot edit files or run commands.\n\n" : "") +
      autonomySection +
      budget +
      (readOnly
        ? specialist
          ? "When you are done, write a short summary of what you found and recommend."
          : "When you are done, end with your answer: a short summary of what you found and recommend."
        : specialist
          ? "When you are done, write a short summary of what you changed and why."
          : "When you are done, end with a short summary of what you changed and why.") +
      factsSection
    );
  }
  return (
    head +
    "\n\n---\n" +
    "You are running as a background job. The user is not watching this session and\n" +
    "cannot see your intermediate output — only your final message is reported back.\n\n" +
    `You are working in an isolated git worktree at ${worktree}, on branch ${branch}.\n` +
    "Commit your work to that branch before you finish. " +
    (allowPr
      ? "You may open a draft pull\n" +
        "request for it (never a non-draft one without a human confirming), but you may\n" +
        "never merge, never force-push, and never touch any other checkout.\n\n"
      : // An instruction, not an enforcement: the shell grants are unchanged, so a job could still run `gh pr create`.
        "Do not open pull requests; the lead and the user decide what ships.\n" +
        "Never merge, never force-push, and never touch any other checkout.\n\n") +
    autonomySection +
    budget +
    (specialist ? "When you are done, write a short summary of what you changed and why." : "When you are done, end with a short summary of what you changed and why.") +
    factsSection
  );
}

/**
 * The completion message delivered to the parent session. The Branch/Worktree
 * lines are omitted when there is no worktree. On failure `<result>` is
 * replaced by `Error: <error>`. A job that ended `done` while its model state was
 * `blocked` says "needs a decision" instead of "done"; a job ended by the engine
 * (stalled / time limit) carries a `Reason:` line; milestones the job reported
 * are listed. Built from the record alone, so a retry (or `clearProgress`) can't change it.
 */
export function buildCompletionText(job) {
  const name = job?.name ?? "";
  const status = job?.status ?? "done";
  const word = status === "done" && job?.endedBlocked === true ? "needs a decision" : status;
  const lines = [`[background job "${name}" ${word}]`];
  if (job?.worktree) {
    const changed = job?.filesChanged == null ? "0" : String(job.filesChanged);
    lines.push(`Branch: ${job.branch ?? ""} (${changed} files changed)`);
    lines.push(`Worktree: ${job.worktree}`);
  }
  if (job?.endReason) {
    lines.push(`Reason: ${job?.error ?? ""}`);
    const last = finalHeadline(job);
    if (last && !String(job?.error ?? "").includes(last)) lines.push(`Last status: ${last}`);
  }
  const milestones = Array.isArray(job?.jobProgress?.milestones) ? job.jobProgress.milestones : [];
  if (milestones.length > 0) {
    lines.push("Milestones:");
    for (const m of milestones) lines.push(`- ${m.text}`);
  }
  // a specialist's actions the user asked to hear about / that its autonomy settings blocked (spec Phase 3 §5)
  // (a specialist that left its report out is only called out on a finished task: a failed one has nothing to report)
  lines.push(
    ...actionLines({
      toldActions: job?.toldActions,
      blockedActions: job?.blockedActions,
      exceededActions: job?.exceededActions,
      // (a task that asked the user was interrupted: it owes no report of its own)
      selfReport: job?.specialist === true && status === "done" && !job?.decision ? job?.selfReport : undefined,
    }),
  );
  lines.push("");
  if (status === "failed" || status === "stopped") {
    lines.push(`Error: ${job?.error ?? ""}`);
  } else {
    lines.push(String(job?.result ?? ""));
  }
  // a task that asked the user (the question tool): the question, written by the server (the lead puts it to the user, never answers it)
  if (status === "done" && job?.endedBlocked === true && job?.decision) lines.push("", ...decisionLines(job.decision));
  // a task that ended with a question of its own still open: the server says the answer will continue it (the lead never asks it again)
  if (status === "done" && Array.isArray(job?.waiting) && job.waiting.length > 0) {
    lines.push("", ...job.waiting.map((q) => waitingLine([q])).filter(Boolean));
  }
  // an Architect task: what the server did with each proposal, written by the server (the lead relays it, never guesses it)
  const outcome = Array.isArray(job?.architectOutcome) ? job.architectOutcome.filter((l) => typeof l === "string" && l) : [];
  if (outcome.length > 0) lines.push("", ...outcome);
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

/**
 * The ruleset EVERY Manta-owned job child is created with (spec 2026-11-14 A5): a job cannot wait on a person, so a
 * trailing `question` deny is present (last-match-wins keeps it above any grant). Idempotent. A specialist's task
 * (`allowQuestion`) is the one exception: it may use the standard `question` tool (its ruleset allows it); the server captures
 * the question and ends the task as "needs a decision" (`handleQuestion`), so it never waits on a person either.
 */
export function normalizeJobRuleset(rules, { allowQuestion = false } = {}) {
  const list = (Array.isArray(rules) ? rules : []).filter(
    (r) => !(r?.permission === "question" && r?.pattern === "*" && r?.action === "deny"),
  );
  return allowQuestion ? list : [...list, { permission: "question", pattern: "*", action: "deny" }];
}

/**
 * The ruleset of an agent job that works in the chat's own folder (`isolation: "none"`): deny by default, then
 * only read-side tools, the todo list, progress reports and the agent's own folder (its skills / briefs). No bash,
 * no edit. The catch-all deny is FIRST (last match wins). Pure.
 */
export function buildReadOnlyAgentRuleset({ agentDir, home = homedir() } = {}) {
  const allow = (permission, pattern = "**") => ({ permission, pattern, action: "allow" });
  const rules = [
    { permission: "*", pattern: "**", action: "deny" },
    allow("read"),
    allow("glob"),
    allow("grep"),
    allow("list"),
    allow("webfetch"),
    allow("websearch"),
    allow("todowrite", "*"),
    allow("progress_report", "*"),
    // the research tools and the shared research library: every agent checks what is already known before outside work
    ...SPECIALIST_TASK_TOOLS.map((t) => allow(t, "*")),
    allow("external_directory", `${home}/.local/share/opencode/tool-output/*`),
  ];
  if (agentDir) rules.push(allow("external_directory", `${String(agentDir).replace(/\/+$/, "")}/**`));
  return rules;
}

/**
 * `rules` (a specialist task's base ruleset) with the research tools allowed, once, right under the leading catch-all deny
 * (last match wins). Idempotent. A grant list the user edited on the approval card carries no research tools, so they are
 * added here: they are not a file or shell permission.
 */
export function withResearchToolAllows(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const missing = SPECIALIST_TASK_TOOLS.filter((t) => !list.some((r) => r?.permission === t && r.pattern === "*" && r.action === "allow"));
  if (missing.length === 0) return list;
  const adds = missing.map((t) => ({ permission: t, pattern: "*", action: "allow" }));
  const first = list[0];
  const denyFirst = first?.permission === "*" && first.pattern === "**" && first.action === "deny";
  return denyFirst ? [first, ...adds, ...list.slice(1)] : [...adds, ...list];
}

// The tools the Architect's task may call, besides reading and searching (Agents Phase 5A §4.2).
const ARCHITECT_TOOL_ALLOWS = ["read", "glob", "grep", "list", "websearch"];
const ARCHITECT_PLUGIN_TOOLS = [...SPECIALIST_TASK_TOOLS, "agent_propose"];

/**
 * The ruleset of the Architect's task, built for launch AND resume by this one function (spec §4.2). Last match wins, so:
 * a catch-all deny FIRST; then only the allows (read-side tools, the todo list, progress reports, the four Architect tools,
 * and `external_directory` for the agent's own folder and the tool-output folder); then `jobRules` with `noSecrets` (the
 * protected files and ALL handed-secret exceptions omitted, so `~/.manta-secrets` stays fully denied, even to read, glob and
 * grep); last, explicit denies for bash, edit, write, patch and webfetch. Pure.
 */
export function buildArchitectRuleset({ policy, agentDir = null, home = homedir(), projectPatterns = [], sessionID } = {}) {
  const allow = (permission, pattern = "**") => ({ permission, pattern, action: "allow" });
  const deny = (permission, pattern) => ({ permission, pattern, action: "deny" });
  const rules = [
    { permission: "*", pattern: "**", action: "deny" },
    ...ARCHITECT_TOOL_ALLOWS.map((p) => allow(p)),
    allow("todowrite", "*"),
    allow("progress_report", "*"),
    ...ARCHITECT_PLUGIN_TOOLS.map((p) => allow(p, "*")),
    allow("external_directory", `${home}/.local/share/opencode/tool-output/*`),
  ];
  if (agentDir) rules.push(allow("external_directory", `${String(agentDir).replace(/\/+$/, "")}/**`));
  rules.push(...jobRules(policy, { home, agentDir, projectPatterns, sessionID, noSecrets: true }));
  for (const permission of ["bash", "edit", "write", "patch", "webfetch"]) rules.push(deny(permission, "*"), deny(permission, "**"));
  return rules;
}

/**
 * The ruleset of an agent job in its own worktree (`isolation: "worktree"`): it edits code, so the same grants the
 * forge-triggered implementation jobs get, plus the progress tool.
 */
export const WORKTREE_AGENT_GRANTS = Object.freeze([
  Object.freeze({ permission: "bash", pattern: "**" }),
  Object.freeze({ permission: "write", pattern: "**" }),
  Object.freeze({ permission: "edit", pattern: "**" }),
  Object.freeze({ permission: "read", pattern: "**" }),
  Object.freeze({ permission: "webfetch", pattern: "**" }),
  Object.freeze({ permission: "websearch", pattern: "**" }),
  Object.freeze({ permission: "progress_report", pattern: "*" }),
]);

export function buildWorktreeAgentRuleset({ home = homedir() } = {}) {
  return withResearchToolAllows(buildPermissionRuleset(WORKTREE_AGENT_GRANTS.map((g) => ({ ...g })), { home }));
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

// A record written before the session tree may still carry the retired `displayParentID`: nothing reads it, and
// it is never sent on. `basePermission` is the specialist task's ruleset before autonomy (kept to recompute it on a resume).
// `projectPatterns` (the project's own block rules) and `selfReport` (only drives a line of the result text) stay on the box too.
// `ending` / `continueAfter` / `gateFailed` are the ending gate's marks (spec 2026-11-26 §4.3): server-only.
function toWireRecord({ displayParentID: _retired, basePermission: _base, projectPatterns: _pp, selfReport: _sr, ending: _e, continueAfter: _ca, gateFailed: _gf, ...rest }) {
  // (a resume in flight keeps the paused record's own copies in `launch.restore`)
  const restore = rest.launch?.restore;
  if (restore && typeof restore === "object") {
    const { projectPatterns: _rp, selfReport: _rs, ...kept } = restore;
    return { ...rest, launch: { ...rest.launch, restore: kept } };
  }
  return rest;
}

// a result that carries a raw record (start / continue / resume) goes out the way a listed one does
const wireResult = (res) => (res && typeof res === "object" && res.job && typeof res.job === "object" ? { ...res, job: toWireRecord(res.job) } : res);

export async function listJobs({ sessionID, sessionIDs } = {}, { load = loadJobs, readProgress = defaultReadProgress, jobViews = null } = {}) {
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
      ...toWireRecord(j),
      progress: j.childSessionID ? await readProgress(j.childSessionID) : null,
      ...(jobViews ? { view: jobViews.viewFor(j) } : {}),
    })),
  );
}

export async function getJob(id, { load = loadJobs, readProgress = defaultReadProgress, jobViews = null } = {}) {
  const jobs = await load();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  return {
    ...toWireRecord(job),
    progress: job.childSessionID ? await readProgress(job.childSessionID) : null,
    ...(jobViews ? { view: jobViews.viewFor(job) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Owner resolution + adoptExistingSession — turning a session opencode (or a
// script) is already running into a sidebar row.
//
// resolveSessionOwner answers "which workspace hosts the row, and which session is its
// parent" for a session that may have NO window of its own.
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
 * @returns {Promise<{status:"ok", owner:{tmuxSession:string}, parentSessionID:string|null, cwd:string|null, sessionParentID:string|null, directory:string|null}|{status:"none"}|{status:"unknown"}>}
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
      return { status: "ok", owner: { tmuxSession: own.tmuxSession }, parentSessionID: sid, cwd: own.cwd ?? null, sessionParentID: null, directory: null };
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
      return { status: "ok", owner: { tmuxSession: own.tmuxSession }, parentSessionID: parent, cwd: own.cwd ?? null, sessionParentID, directory };
    }
    cur = parent;
  }
  const byDir = ownerByDirectory(projects, directory);
  if (byDir) return { status: "ok", owner: byDir, parentSessionID: sessionParentID, cwd: directory, sessionParentID, directory };
  return { status: "none" };
}

/**
 * The task a record belongs to: the first round's job id. Every job stamps `rootJobId` at launch (its own id) and continuations / resumes
 * copy it; a record from before the field resolves through the Architect's stamp, else its own id. Questions, research usage and the
 * task side panel are all keyed by it, never by the child session.
 */
export function rootJobOf(job) {
  return job?.rootJobId ?? job?.architect?.rootJobId ?? job?.id;
}

/** The newest round of a task: nothing supersedes it (highest attempt as the tie-break). */
function newestRoundOf(jobs, rootJobId) {
  const rounds = (Array.isArray(jobs) ? jobs : []).filter((j) => rootJobOf(j) === rootJobId);
  const live = rounds.filter((j) => !j.supersededBy);
  const pool = live.length > 0 ? live : rounds;
  return pool.reduce((best, j) => (!best || (j.attempt ?? 1) > (best.attempt ?? 1) || ((j.attempt ?? 1) === (best.attempt ?? 1) && (j.createdAt ?? 0) >= (best.createdAt ?? 0)) ? j : best), null);
}

/** The newest record for a session: the one nothing supersedes (highest attempt as the tie-break). */
export function newestRecordFor(jobs, childSessionID) {
  const all = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.childSessionID === childSessionID);
  const live = all.filter((j) => !j.supersededBy);
  const pool = live.length > 0 ? live : all;
  return pool.reduce((best, j) => (!best || (j.attempt ?? 1) > (best.attempt ?? 1) || ((j.attempt ?? 1) === (best.attempt ?? 1) && (j.createdAt ?? 0) >= (best.createdAt ?? 0)) ? j : best), null);
}

/**
 * Adopt a session that already exists into the job store (no window creation).
 *
 * Under `sessionResources(childSessionID)` then `jobsLock`: a session with a non-terminal
 * record is already adopted. Otherwise a NEW record is appended — linked to the session's
 * newest terminal record, which this helper finds ITSELF (`continues` / `supersededBy`, the
 * worktree transferred when it still exists on disk) — and a window stamped with the
 * session is reused if present, never created. opencode (or a script) owns the run and reports its own
 * result: `completionOwner:"opencode"`, so Manta never posts one.
 *
 * @param {{ childSessionID:string, owner:{tmuxSession:string}, parentSessionID?:string|null, sessionParentID?:string|null,
 *           cwd?:string, parentDirectory?:string, name:string, prompt?:string, model?:string|null, origin:string, runStartedAt?:number }} input
 * @returns {Promise<{ok:true, job:object}|{ok:true, alreadyAdopted:true}|{ok:false, error:string}>}
 */
export async function adoptExistingSession(input, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, listProjects, now = () => Date.now() } = deps;
  const { childSessionID, owner, parentSessionID = null, sessionParentID = null, name, prompt = "", model = null, origin, runStartedAt } = input ?? {};
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

      // Keep a real parent directory for any inherited worktree's later cleanup.
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
        }
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
      // Adoption records work, not windows. Never claim a user-opened holder.

      const t = now();
      const adoptedId = genId();
      const job = {
        id: adoptedId,
        rootJobId: adoptedId,
        name,
        prompt,
        model: model ?? null,
        requestedModel: null,
        parentSessionID: parentSessionID ?? null,
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
        extensions: [],
        endReason: null,
        endedBlocked: false,
        jobProgress: defaultJobProgress(),
      };
      const next = prev ? jobs.map((j) => (j.id === prev.id ? { ...j, supersededBy: job.id } : j)) : jobs;
      await save([...next, job]);
      deps.liveness?.rootChanged(job);
      if (prev) publish?.({ kind: "delegate.updated", payload: { id: prev.id, status: prev.status } });
      publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "running" } });
      return { ok: true, job };
    }),
  );
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
  withTrace = false,
} = {}) {
  // `withTrace: true` returns `{ model, trace }` (trace = the router's decision
  // trace, null when routing threw or was off); every other caller still gets
  // the bare model.
  const out = (model, trace) => (withTrace ? { model, trace: trace ?? null } : model);
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
    return out(incumbent, null);
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
  return out(model, decision?.trace);
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

export const ADMIT_STORE_ERROR = "Couldn't read the task list; try again";

// The store read of a registration that carries an `admit` check: strict (an unreadable store is a refusal, never an
// empty list that gets saved over). A test-injected `load` is used as given; production has none and reads strictly.
const admitLoader = (deps) => deps.loadStrict ?? (deps.load ? deps.load : loadJobsStrict);

// Run the caller's admission check under the jobs lock. A string refuses with it; a throw is a refusal too.
async function runAdmit(admit, jobs, ...extra) {
  try {
    const refusal = await admit(jobs, ...extra);
    return typeof refusal === "string" && refusal ? refusal : null;
  } catch (e) {
    return `Couldn't check the task list: ${String(e?.message ?? e)}`;
  }
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
    if (input?.isolationRequired || input?.isolation === "worktree") {
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
  const durationError = validateMaxDurationMinutes(input?.maxDurationMinutes);
  if (durationError) return { ok: false, error: durationError };

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
  return wireResult(await startJobV2({ input, prompt, parentSessionID, parentDirectory, requestedModel, effectiveModel }, deps));
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
      parentSessionID: res.parentSessionID ?? parentSessionID,
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

// The number of UNIQUE paths the job changed against its base: the working tree vs `baseSha` (committed and uncommitted,
// tracked) plus untracked files. null when git can't say (never 0 by mistake).
async function countFilesChanged(job, deps) {
  if (!job.worktree || !job.baseSha) return null;
  const { gitRun } = deps;
  if (typeof gitRun !== "function") return null;
  try {
    const paths = new Set();
    const diff = await gitRun(["-C", job.worktree, "diff", "--name-only", job.baseSha]);
    for (const l of String(diff?.stdout ?? "").split("\n")) if (l.length > 0) paths.add(l);
    const status = await gitRun(["-C", job.worktree, "status", "--porcelain"]);
    for (const f of parseGitStatus(status?.stdout).files) if (f.status === "??") paths.add(f.path);
    return paths.size;
  } catch {
    return null;
  }
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
  // A holder opened after launch may not be the record's old index. Find it by session stamp.
  if (job?.worktree && typeof deps.listProjects === "function") {
    const holders = (await deps.listProjects()).flatMap((p) => (p.windows ?? [])
      .filter((w) => w.opencodeSessionId === job.childSessionID)
      .map((w) => ({ tmuxSession: p.tmuxSession, windowIndex: w.index })));
    for (const w of holders) {
      const owner = await deps.getWindowOption?.(w.tmuxSession, w.windowIndex, "@manta-owner");
      if (owner !== "job") {
        try {
          if (!deps.setWindowOption || !deps.rebaseHolder || !job.parentDirectory) throw new Error("holder rebase is unavailable");
          await deps.rebaseHolder(w.tmuxSession, w.windowIndex, job.parentDirectory);
          await deps.setWindowOption(w.tmuxSession, w.windowIndex, "@manta-worktree-path", "");
        } catch (e) {
          console.warn(`[delegate] re-basing the window of ${job.id} failed:`, e?.message ?? e);
          return { cleanedUp: false, reason: "rebase-failed" };
        }
      }
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
  const { load = loadJobs, save = saveJobs, listMessages, now = () => Date.now() } = deps;
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
          emitUpdate(deps, job, {});
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
    await reconcileTaskQuestions(deps);

    const jobs = await load();
    if (jobs.length === 0) return;
    const nowMs = now();

    // Jobs that finished before worktree-less windows were closed on finish still
    // have their window open: close it once (cleanedUp marks it done).
    for (const job of jobs) {
      if (!isTerminal(job) || job.worktree || job.cleanedUp != null || job.completionDelivery === "pending" || job.completionDelivery === "deferred") continue;
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

    // Orphaned jobs → stopped (parent gone). stopJob aborts + marks stopped +
    // runs the same terminal cleanup. Runs BEFORE the liveness pass so a job
    // that is both orphaned and over its limit is recorded as "stopped" (parent
    // gone is the more precise reason).
    for (const job of orphaned) {
      await stopJob(job.id, deps);
    }
    // Paused-expired jobs → stopped. A job still owes its parent its one result,
    // even a stopped one, so this goes through stopJob.
    for (const job of pausedExpired) {
      await stopJob(job.id, deps, { error: "paused for over 7 days, stopped" });
    }
    // Liveness: rebuild what a restart lost, then end a job that is stalled or past its ceiling, and fold
    // usage / files into the records of the rest. (Lost runs were settled by reconcileV2Jobs above.)
    await sweepLiveness(new Set(orphaned.map((j) => j.id)), deps);
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
  const keeps = (j) => (j.cleanedUp === false && !j.supersededBy) || j.completionDelivery === "pending" || j.completionDelivery === "deferred";
  const isTerm = (j) => j.status === "done" || j.status === "failed" || j.status === "stopped";
  const pruned = new Set();
  for (const j of jobs) {
    if (isTerm(j) && j.finishedAt != null && j.finishedAt < cutoff && !keeps(j)) pruned.add(j.id);
  }
  let out = jobs.filter((j) => !pruned.has(j.id));
  // Every resumed turn of a long-lived session is a new record; the superseded ones are history of ONE session,
  // so they neither count toward the cap nor survive past the newest few per session.
  const supersededBySession = new Map();
  for (const j of out) {
    if (!isTerm(j) || !j.supersededBy) continue;
    const list = supersededBySession.get(j.childSessionID) ?? [];
    list.push(j);
    supersededBySession.set(j.childSessionID, list);
  }
  for (const list of supersededBySession.values()) {
    list.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const j of list.slice(MAX_SUPERSEDED_PER_SESSION)) if (!keeps(j)) pruned.add(j.id);
  }
  out = out.filter((j) => !pruned.has(j.id));
  const terminal = out.filter((j) => isTerm(j) && !j.supersededBy);
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

// A job reached a final state (finished, failed, timed out or stopped by the user): the agents engine releases the
// proposals its Architect round held and answers with one Outcome line per proposal; those lines are stored on the record
// BEFORE the result is built and delivered to the parent, so the parent is told what really happened. Never breaks the
// job's own transition.
//
// Then, for EVERY job (not only the Architect's), `afterJobEnded(job)` — the one hook a consumer such as the routines engine uses to settle a run
// from its task. It runs here, after the Architect's proposals were released, because this is the one place both terminal paths
// (`finishV2Job` and `stopJob`) go through; `onJobTerminal` is not that place (`stopJob` never calls it, and it runs before the release).
async function notifyJobEnded(job, deps) {
  if (typeof deps.onJobEnded === "function" && job?.architect) {
    try {
      const ended = await deps.onJobEnded(job);
      const outcome = Array.isArray(ended?.outcome) ? ended.outcome.filter((l) => typeof l === "string" && l) : [];
      if (outcome.length > 0) await patchJob(job.id, { architectOutcome: outcome }, deps);
    } catch (e) {
      console.warn(`[delegate] onJobEnded failed for ${job.id}:`, e?.message ?? e);
    }
  }
  if (typeof deps.afterJobEnded === "function") {
    try {
      // (the record as it is now: the Architect's outcome lines are on it)
      const fresh = ((await (deps.load ?? loadJobs)()) ?? []).find((j) => j.id === job.id) ?? job;
      await deps.afterJobEnded(fresh);
    } catch (e) {
      console.warn(`[delegate] afterJobEnded failed for ${job.id}:`, e?.message ?? e);
    }
  }
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
  // Cancel a handoff pending on the job's session BEFORE the abort below ends its turn: the
  // turn end would otherwise find the handoff and carry on with it.
  await cancelPendingHandoffOf(id, ["running", "paused"], deps);
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
      completionDelivery: resultDeliveryFor(job, manta),
    };
    jobs[idx] = updated;
    await save(jobs);
    pauseInterrupts.delete(updated.id);
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: updated.status, activity: updated.activity },
    });
    return { ok: true, deliver: updated.completionDelivery === "pending", stopped: updated };
  }, { allowPaused: true });
  if (stopped?.stopped) {
    await notifyJobEnded(stopped.stopped, deps);
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
    let job = jobs[idx];
    if (job.childSessionID !== lockedChild) return { moved: true };

    // A superseded run's window and worktree belong to its successor: only the record goes.
    if (job.supersededBy) {
      await save(jobs.filter((j) => j.id !== id));
      publish?.({ kind: "delegate.updated", payload: { id, status: "deleted" } });
      return { ok: true };
    }

    // A virtual job row may have been opened since this record's original holder closed.
    // Explicit deletion still closes that holder, regardless of its owner stamp.
    if (typeof deps.listProjects === "function") {
      const stamped = findStampedWindow(await deps.listProjects(), job.childSessionID);
      if (stamped) job = { ...job, tmuxSession: stamped.tmuxSession, windowIndex: stamped.windowIndex };
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
      await closeJobWindowLocked(job, deps, { explicit: true });
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
    deps.liveness?.drop(id);
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
  await cancelPendingHandoffOf(id, ["running"], deps); // before the flag: a handoff still starting must see the pause
  const res = await withRunningJob(id, deps, async (jobs, idx, job) => {
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
  return res;
}

/**
 * A stopped / paused job must not be moved onto a handoff successor: cancel any handoff pending on its session. Only for
 * a job Manta completes — an adopted (opencode-owned) session's pending handoff behaves as before. Never throws.
 */
async function cancelPendingHandoffOf(id, statuses, deps = {}) {
  if (typeof deps.cancelPendingHandoff !== "function") return;
  try {
    const job = ((await (deps.load ?? loadJobs)()) ?? []).find((j) => j.id === id);
    if (!job?.childSessionID || !statuses.includes(job.status) || completionOwnerOf(job) !== "manta") return;
    await deps.cancelPendingHandoff(job.childSessionID);
  } catch (e) {
    console.warn(`[delegate] cancelling the pending handoff of ${id} failed:`, e?.message ?? e);
  }
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
      // The resumed attempt's child session id, minted now because its rules name the secrets folder of that session.
      const nextChildId = mintSessionId();
      // A specialist's task (Agents Phase 3 §4): the resumed child is a FRESH session, so it gets the CURRENT settings —
      // the final ruleset is recomputed from the base it started with. A task from before the settings existed has no
      // base to recompute from.
      let autonomy = null;
      if (isLegacySpecialist(peek)) return { ok: false, error: LEGACY_TASK };
      if (peek.specialist === true) {
        const current = await currentAutonomyPolicy(deps);
        if (!current.ok) return { ok: false, error: current.error };
        if (isWriterJob(peek) && decideAutonomy("edit_code", current.policy) === "never") return { ok: false, error: CODE_OFF };
        const base = Array.isArray(peek.basePermission) ? peek.basePermission : [];
        // the project's own commands, read now (the resumed child is a fresh session, so it gets the current page too)
        const project = await projectActionsFor(deps, peek.parentDirectory);
        const pp = buildProjectPatterns(project.entries);
        if (pp.error) return { ok: false, error: pp.error };
        const homeDir = deps.home ?? homedir();
        autonomy = {
          key: policyKey(current.policy),
          policy: normalizePolicy(current.policy),
          projectPatterns: pp,
          // the Architect's ruleset comes from its own builder on resume too: nothing survives from the old attempt but the stamp
          permission: peek.architect
            ? normalizeJobRuleset(buildArchitectRuleset({ policy: current.policy, agentDir: peek.agentDir ?? null, home: homeDir, projectPatterns: pp, sessionID: nextChildId }), { allowQuestion: true })
            : normalizeJobRuleset([...base, ...jobRules(current.policy, { home: homeDir, agentDir: peek.agentDir ?? null, projectPatterns: pp, sessionID: nextChildId })], { allowQuestion: true }),
          text: taskPromptSection(current.policy, project.promptEntries),
        };
      }
      preparedResume = {
        childId: peek.childSessionID,
        nextChildId,
        autonomy,
        text: buildJobPrompt({
          prompt: await buildResumePrompt(peek, deps, peek.childSessionID),
          worktree: peek.worktree,
          branch: peek.branch,
          allowPr: peek.allowPr !== false,
          autonomy: autonomy?.text ?? "",
          specialist: peek.specialist === true,
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
    return wireResult(await launchDelegate(reg.job, deps));
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
  return withLivenessDefaults({
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
  });
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

/**
 * What a terminal write says about the job's result: not Manta's to post (null), never to be posted (`not-needed`: a refresh task runs under a
 * headless session nobody reads), or in flight (`pending`). Both terminal writes — `finishV2Job` and `stopJob` — use it.
 */
function resultDeliveryFor(job, manta) {
  if (!manta) return null;
  return job?.deliverResult === false ? "not-needed" : "pending";
}

// The running-job index behind `runningJobOwner`: childSessionID → "manta" | "opencode", rebuilt only when the job store
// file changed (its mtime/size, or any in-process saveJobs) instead of re-reading and parsing the whole store per call —
// the lookup runs per handoff list, per model request (optimizer policy) and per turn end.
const ownerIndexCache = new Map(); // store path -> { key, owners }
const fileKey = (path) => {
  const st = statSync(path, { bigint: true });
  return `${st.mtimeNs}:${st.size}:${st.ino}`;
};
function readOwnerIndex(path, read) {
  let key;
  try {
    key = fileKey(path);
  } catch (e) {
    if (e?.code === "ENOENT") return new Map(); // no store, no jobs
    return null; // unreadable: not a job, and nothing is cached
  }
  const hit = ownerIndexCache.get(path);
  if (hit?.key === key) return hit.owners;
  let jobs;
  try {
    jobs = JSON.parse(read(path, "utf-8"))?.jobs;
    if (fileKey(path) !== key) return null; // changed while reading: answer "not a job" this time, never cache a torn read
  } catch {
    return null; // a failed read is not cached
  }
  const owners = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j?.status !== "running" || !j.childSessionID) continue;
    const owner = completionOwnerOf(j);
    if (owners.get(j.childSessionID) !== "manta") owners.set(j.childSessionID, owner);
  }
  ownerIndexCache.set(path, { key, owners });
  return owners;
}

/**
 * The completion owner of the RUNNING job record whose own session is `sessionId`; null when there is none (a paused or
 * finished job is not running). Reads the default store through the cached index; an injected `load` (tests) is read as is.
 */
export async function runningJobOwner(sessionId, deps = {}) {
  if (typeof deps.load === "function") {
    const jobs = (await deps.load()) ?? [];
    const running = jobs.filter((j) => j.childSessionID === sessionId && j.status === "running");
    if (running.length === 0) return null;
    return running.some((j) => completionOwnerOf(j) === "manta") ? "manta" : "opencode";
  }
  return readOwnerIndex(deps.storePath ?? STORE_PATH, deps.readFile ?? readFileSync)?.get(sessionId) ?? null;
}

/**
 * The status of the job record Manta completes whose own session is `sessionId` (any status — the handoff's post-commit
 * check needs to tell "stopped/parked" from "running"); `null` when there is none or the store can't be read (a read
 * failure is never a reason to act on a job).
 */
export async function jobStatusOf(sessionId, deps = {}) {
  let jobs;
  try {
    jobs = (await (deps.load ?? loadJobs)()) ?? [];
  } catch {
    return null;
  }
  const mine = jobs.filter((j) => j?.childSessionID === sessionId && completionOwnerOf(j) === "manta");
  if (mine.length === 0) return null;
  return (mine.find((j) => j.status === "running") ?? mine[mine.length - 1]).status ?? null;
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
 * `toSessionId`. `parent` re-points jobs the session STARTED (`parentSessionID`);
 * `child` re-points a
 * running job whose OWN session was the one replaced. Idempotent — a recovery
 * re-runs it. Returns how many records changed.
 * @param {{ fromSessionId: string, toSessionId: string, parent?: boolean, child?: boolean }} a
 */
export async function repointJobSessions({ fromSessionId, toSessionId, parent = true, child = true }, deps = {}) {
  if (fromSessionId === toSessionId) return 0;
  return withSessionResources(fromSessionId, () => withSessionResources(toSessionId, () => repointJobSessionsLocked({ fromSessionId, toSessionId, parent, child }, deps)));
}

async function repointJobSessionsLocked({ fromSessionId, toSessionId, parent, child }, deps) {
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
      // a job whose own session moved gets a fresh liveness picture of the new root
      for (const j of next) if (child && j.status === "running" && j.childSessionID === toSessionId) deps.liveness?.rootChanged(j);
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
    deps.liveness?.drop(id);
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
async function closeJobWindowLocked(job, deps = {}, { explicit = false } = {}) {
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
    // Read at close time. An absent stamp is a user's window, never a cleanup target.
    if (!explicit && await deps.getWindowOption?.(job.tmuxSession, job.windowIndex, "@manta-owner") !== "job") return false;
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

// A bus update for a job: with the engine's views wired it carries the job's `view` and is not throttled (a
// terminal / paused / extended transition); without it the payload is the one every consumer already knew.
function emitUpdate(deps, job, base = {}) {
  if (deps.jobViews) {
    deps.jobViews.publishNow(job, base);
    return;
  }
  deps.publish?.({ kind: "delegate.updated", payload: { id: job.id, status: job.status, activity: job.activity, ...base } });
}

// At a segment boundary (paused / terminal) the engine's in-memory picture is folded into the record: usage since the
// last flush, the last time the job made progress, the final file count, the plan state (the bar is 1 only for a done
// job that was not waiting on a decision). Runs under the jobs lock; reads memory only.
function foldAtBoundary(live, deps, nowMs, { terminal = null, filesChanged } = {}) {
  const base = withLivenessDefaults(live);
  const manta = completionOwnerOf(live) === "manta";
  let jp = base.jobProgress;
  const delta = manta ? deps.liveness?.takeUsageDelta(live.id) : null;
  if (delta) jp = { ...jp, usage: mergeUsage(jp.usage, delta) };
  if (manta && filesChanged != null) jp = { ...jp, files: { changed: filesChanged, at: nowMs } };
  if (terminal) jp = recomputeSteps(jp, { now: nowMs, terminal });
  const snap = deps.liveness?.snapshot(live.id);
  return { jobProgress: jp, lastProgressAt: snap?.lastProgressAt ?? live.lastProgressAt ?? null };
}

// The evidence-log line for a finished Manta-owned segment, read from the engine's memory at the moment of the decision.
function segmentEvidence(live, next, deps, nowMs) {
  const ev = deps.liveness?.evidence(live.id, nowMs);
  const base = withLivenessDefaults(live);
  return {
    jobId: next.id,
    attempt: next.attempt ?? 1,
    status: next.status,
    endReason: next.endReason ?? null,
    segmentMs: next.startedAt != null ? Math.max(0, nowMs - next.startedAt) : null,
    ceilingMs: base.ceilingMs,
    extensions: base.extensions.map((e) => ({ at: e.at, minutes: e.minutes })),
    lastProgressAt: ev?.lastProgressAt ?? next.lastProgressAt ?? null,
    contentRecordsLast15m: ev?.contentRecordsLast15m ?? null,
    toolsAtEnd: ev?.toolsAtEnd ?? [],
    stepsSource: next.jobProgress?.stepsSource ?? null,
    milestoneCount: next.jobProgress?.milestones?.length ?? 0,
    usage: next.jobProgress?.usage ?? null,
  };
}

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
export async function finishV2Job(job, status, error, deps = {}, { interrupted = false, resourcesHeld = false, resultFallback = null, endReason = null, onlyIf = null } = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
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
  let actions = null; // a specialist's told / blocked / exceeded actions (Agents Phase 3 §5), read from this attempt's transcript
  const wantsActions = job.specialist === true && !!job.childSessionID && typeof listMessages === "function" && !(interrupted && job.pauseRequested);
  if (wantsActions && status !== "done") {
    try {
      actions = actionsOf(job, await listMessages(job.childSessionID), deps, null);
    } catch (e) {
      console.warn("[delegate] reading the actions of a finished task failed:", e?.message ?? e);
    }
  }
  if (status === "done" && job.childSessionID) {
    let messages = null;
    let resultText = null; // THIS attempt's own final text (a continuation that wrote none has none)
    try {
      messages = listMessages ? await listMessages(job.childSessionID) : [];
      result = await lastAssistantText(messages);
      resultText = (await lastAssistantText(attemptMessages(job, messages))) || null;
    } catch (e) {
      console.warn("[delegate] listMessages failed:", e?.message ?? e);
    }
    if (job.worktree && deps.gitRun) filesChanged = await countFilesChanged(job, deps);
    if (!result && typeof resultFallback === "function") {
      try {
        result = (await resultFallback()) || null;
        if (result && !resultText) resultText = result;
      } catch (e) {
        console.warn("[delegate] result fallback failed:", e?.message ?? e);
      }
    }
    if (wantsActions && messages) {
      try {
        actions = actionsOf(job, messages, deps, resultText);
      } catch (e) {
        console.warn("[delegate] reading the actions of a finished task failed:", e?.message ?? e);
      }
    }
  }

  // the questions this task still has waiting for the user (a synchronous read of the question store's picture: nothing under the jobs lock waits on I/O)
  let waiting = [];
  if (job.specialist === true && typeof deps.taskQuestions?.waitingFor === "function") {
    try {
      waiting = deps.taskQuestions.waitingFor(rootJobOf(job)) ?? [];
    } catch (e) {
      console.warn("[delegate] reading a task's waiting questions failed:", e?.message ?? e);
    }
  }

  let paused = null;
  let guardSkipped = false;
  let segment = null;
  const updated = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx === -1) return null;
    const live = jobs[idx];
    if (live.status !== "running") return null;
    // A caller deciding from a snapshot (the sweep ending a stalled / over-limit job) re-checks the LIVE record here,
    // atomically with the write, so an extension that landed meanwhile can never be overtaken.
    if (onlyIf && !onlyIf(live)) {
      guardSkipped = true;
      return null;
    }
    const endedAt = now();

    if (interrupted && live.pauseRequested && completionOwnerOf(live) === "manta") {
      const parked = { ...live, ...foldAtBoundary(live, deps, endedAt), status: "paused", pauseRequested: false, pausedAt: endedAt };
      jobs[idx] = parked;
      await save(jobs);
      deps.liveness?.drop(parked.id);
      emitUpdate(deps, parked, { status: "paused" });
      paused = parked;
      return null;
    }
    let outcome = { status, error };
    if (interrupted) outcome = live.stopRequested ? { status: "stopped", error: "stopped by user" } : { status: "failed", error: error || "interrupted" };

    const manta = completionOwnerOf(live) === "manta";
    // a task whose question was captured (the decision) ends "needs a decision" whatever it reported afterwards
    const endedBlocked = outcome.status === "done" && (live.jobProgress?.modelState === "blocked" || !!live.decision);
    const fold = foldAtBoundary(live, deps, endedAt, {
      terminal: { status: outcome.status, endedBlocked },
      filesChanged: outcome.status === "done" ? filesChanged : undefined,
    });
    const next = {
      ...live,
      ...fold,
      status: outcome.status,
      error: outcome.status === "done" ? null : (outcome.error ?? null),
      result: outcome.status === "done" ? result : null,
      filesChanged: outcome.status === "done" ? filesChanged : null,
      finishedAt: endedAt,
      pauseRequested: false,
      endedBlocked,
      endReason: outcome.status === "failed" ? endReason : null,
      ...(actions ? { toldActions: actions.toldActions, blockedActions: actions.blockedActions, exceededActions: actions.exceededActions, selfReport: actions.selfReport } : {}),
      completionMessageId: manta ? (live.completionMessageId ?? mintMessageId()) : (live.completionMessageId ?? null),
      // `deferred`: a finished round that an answer to the task's question will CONTINUE — its result is not posted (the continuation's is the one the
      // chat gets), and neither is `pending` (so the continuation isn't refused). Only a round that finished well and whose lock this caller
      // doesn't hold can be deferred (the continuation takes the session's lock itself).
      completionDelivery:
        manta && outcome.status === "done" && !resourcesHeld && live.deliverResult !== false && live.continueAfter === true
          ? "deferred"
          : resultDeliveryFor(live, manta),
      ...(outcome.status === "done" && waiting.length > 0 ? { waiting } : {}),
    };
    jobs[idx] = next;
    await save(jobs);
    if (manta && deps.livenessLog) segment = segmentEvidence(live, next, deps, endedAt);
    emitUpdate(deps, next, { launchState: next.launchState });
    deps.liveness?.drop(next.id);
    return next;
  });
  if (guardSkipped) return { ok: true, skipped: "guard" };
  if (paused) {
    pauseInterrupts.delete(paused.id);
    await recordBudgetSpend(paused, deps); // outside the jobs lock (§17.14)
    return { ok: true, paused: true, status: "paused" };
  }
  if (!updated) return { ok: true, alreadyTerminal: true };
  await recordBudgetSpend(updated, deps); // the final record catches the rest (§5.4)
  const endedAs = updated.status;
  if (segment) void deps.livenessLog.appendSegment(segment);

  if (typeof deps.onJobTerminal === "function") {
    try {
      await deps.onJobTerminal(updated);
    } catch (e) {
      console.warn(`[delegate] onJobTerminal failed for ${updated.id}:`, e?.message ?? e);
    }
  }
  await notifyJobEnded(updated, deps);
  if (updated.childSessionID) {
    try {
      await clearProgress(updated.childSessionID);
    } catch (e) {
      console.warn(`[delegate] clearProgress failed for ${updated.id}:`, e?.message ?? e);
    }
  }
  pauseInterrupts.delete(updated.id);
  let post = updated.completionDelivery === "pending";
  if (updated.completionDelivery === "deferred") {
    // the answers go out in ONE continuation: the successor owns the window and worktree, and its result is the one that is posted
    if (await settleDeferred(updated, deps)) return { ok: true, status: endedAs, continued: true };
    post = true; // refused: the round reports and cleans up as any other
  }
  if (post) await deliverJobResult(updated.id, deps);
  await finishV2Cleanup(updated, deps, { held: resourcesHeld });
  return { ok: true, status: endedAs };
}

// ---- the ending gate and the deferred round (spec docs/superpowers/specs/2026-11-26-agents-screens.md §4.3) ----

// An inbox item's text, wherever the pinned binary puts it (the e2e prints the shape it saw).
const inboxItemText = (i) => [i?.text, i?.payload?.text, i?.prompt?.text, i?.payload?.prompt?.text, i?.input?.text].find((t) => typeof t === "string") ?? null;
const inboxItemIs = (item, steered) => (typeof item?.id === "string" && item.id === steered.messageID) || (inboxItemText(item) !== null && inboxItemText(item) === steered.text);

/**
 * Take the answers of this task that were steered into its turn but never consumed back out of the child's inbox (each becomes continue-pending in the
 * question store). Returns whether the task now holds any answer waiting for its round to end. THROWS when the inbox or the store can't be read.
 * The caller holds `sessionResources(child)`.
 */
async function takeBackSteeredAnswers(job, deps) {
  const tq = deps.taskQuestions;
  const root = rootJobOf(job);
  const steered = await tq.pendingSteer(root);
  if (steered.length > 0) {
    if (typeof deps.listInbox !== "function") throw new Error("the child's inbox can't be read");
    const inbox = (await deps.listInbox(job.childSessionID)) ?? [];
    const cancel = deps.cancelInboxItem ?? deps.oc?.cancelInboxItem;
    for (const s of steered) {
      const item = inbox.find((i) => inboxItemIs(i, s));
      if (!item) continue;
      if (typeof cancel !== "function") throw new Error("inbox items can't be cancelled");
      await cancel(job.childSessionID, item.id);
      await tq.markContinuePending(root, [s.id]);
    }
  }
  return tq.hasContinuePending(root);
}

/**
 * Step 1 of the ending gate: `settleV2Job` has decided a specialist's round finished well. Under the session's lock: mark the record `ending` (so nothing
 * steers into it any more), take back any steered answer still unconsumed in the child's inbox, and mark the record `continueAfter` when the task holds an
 * answer that is waiting for its round to end. A failed read leaves `ending` set with `gateFailed`: the round finishes as usual and the sweep retries.
 */
async function runEndingGate(job, deps) {
  if (!deps.taskQuestions || !job.childSessionID) return;
  await withSessionResources(job.childSessionID, async () => {
    const running = (j) => j.status === "running";
    if (!(await patchJob(job.id, { ending: true }, deps, { onlyIf: running }))) return;
    try {
      if (await takeBackSteeredAnswers(job, deps)) await patchJob(job.id, { continueAfter: true }, deps, { onlyIf: running });
    } catch (e) {
      console.warn(`[delegate] the ending gate of ${job.id} could not finish (the sweep will retry):`, e?.message ?? e);
      await patchJob(job.id, { gateFailed: true }, deps, { onlyIf: running });
    }
  });
}

// Rounds whose answers this process is sending right now: the sweep must not settle one of them a second time (it would read "nothing left to send" and
// post the result of a round whose continuation is on its way).
const settlingDeferred = new Set();

/**
 * Step 2c: send every continue-pending answer of the task with ONE continuation. `true`: they are on their way (the round is `not-needed` and must not
 * post or clean up). `false`: refused — the questions are open again (the store did that) and the round goes back to `pending`.
 */
async function settleDeferred(job, deps) {
  let continued = false;
  settlingDeferred.add(job.id);
  try {
    continued = (await deps.taskQuestions?.onRoundSettled?.(job))?.continued === true;
  } catch (e) {
    console.warn(`[delegate] sending the answers waiting for ${job.id} failed:`, e?.message ?? e);
  } finally {
    settlingDeferred.delete(job.id);
  }
  await patchJob(job.id, { completionDelivery: continued ? "not-needed" : "pending" }, deps, { onlyIf: (j) => j.completionDelivery === "deferred" });
  return continued;
}

/**
 * Boot and every sweep: what a crash left half done. (1) a round whose gate could not read the inbox is retried; (2) a terminal round left `deferred`
 * runs steps c and d for itself (a continuation that already exists settles it at once); (3) the question store's own sweep. Never throws.
 */
export async function reconcileTaskQuestions(deps = {}) {
  const tq = deps.taskQuestions;
  if (!tq) return;
  const { load = loadJobs } = deps;
  try {
    for (const j of ((await load()) ?? []).filter((x) => isTerminal(x) && x.gateFailed === true && !x.supersededBy && completionOwnerOf(x) === "manta")) {
      await withSessionResources(j.childSessionID, async () => {
        try {
          await takeBackSteeredAnswers(j, deps);
          await patchJob(j.id, { gateFailed: undefined }, deps);
        } catch (e) {
          console.warn(`[delegate] retrying the ending gate of ${j.id} failed:`, e?.message ?? e);
        }
      });
    }
    for (const j of ((await load()) ?? []).filter((x) => isTerminal(x) && x.completionDelivery === "deferred" && !settlingDeferred.has(x.id))) {
      if (j.supersededBy) {
        await patchJob(j.id, { completionDelivery: "not-needed" }, deps, { onlyIf: (x) => x.completionDelivery === "deferred" });
        continue;
      }
      if (await settleDeferred(j, deps)) continue;
      await deliverJobResult(j.id, deps);
      await finishV2Cleanup(j, deps);
    }
  } catch (e) {
    console.warn("[delegate] reconciling the task questions failed:", e?.message ?? e);
  }
  try {
    await tq.sweep?.();
  } catch (e) {
    console.warn("[delegate] the question sweep failed:", e?.message ?? e);
  }
}

// A specialist task's told / blocked / exceeded actions, judged against the policy THIS attempt ran under (and the project
// commands it was started with). `resultText` is this attempt's final message (null: none to read a self-report from).
function actionsOf(job, messages, deps, resultText) {
  return extractActions({
    messages,
    afterMessageId: job.launch?.messageId ?? null,
    continuation: !!job.launch?.continuation,
    policy: job.autonomyPolicy,
    home: deps.home ?? homedir(),
    projectPatterns: Array.isArray(job.projectPatterns) ? job.projectPatterns : [],
    sessionID: job.childSessionID,
    resultText,
  });
}

// the messages of THIS attempt: after its launch message (a first attempt whose launch message can't be found reads all, a
// continuation's reads none)
function attemptMessages(job, messages) {
  const list = Array.isArray(messages) ? messages : [];
  const id = job.launch?.messageId ?? null;
  const continuation = !!job.launch?.continuation;
  if (!id) return continuation ? [] : list;
  const at = list.findIndex((m) => m?.info?.id === id);
  return list.slice(at >= 0 ? at : continuation ? list.length : 0);
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
      manta: {
        jobId: job.id,
        name: job.name,
        ...(job.status === "done" && job.endedBlocked === true ? { endedBlocked: true } : {}),
        ...(job.status === "done" && job.endedBlocked === true && job.decision ? { decision: { questions: job.decision.questions } } : {}),
        ...(Array.isArray(job.toldActions) && job.toldActions.length > 0 ? { toldActions: job.toldActions } : {}),
        ...(Array.isArray(job.blockedActions) && job.blockedActions.length > 0 ? { blockedActions: job.blockedActions } : {}),
        ...(Array.isArray(job.exceededActions) && job.exceededActions.length > 0 ? { exceededActions: job.exceededActions } : {}),
      },
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
// Every descendant of a session as `{ id, parent }`, breadth-first. Throws on an
// oversized tree or a failed read (callers treat that as "unknown").
async function listDescendants(rootId, deps) {
  const nodes = [];
  const seen = new Set([rootId]);
  let layer = [rootId];
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
  return nodes;
}

async function descendantEvidence(job, active, deps) {
  if (typeof deps.listChildSessions !== "function") return { complete: true, newestSyntheticAt: null };
  const nodes = await listDescendants(job.childSessionID, deps);
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

// ---- Lost runs: opencode stopped mid-turn and will never report an outcome ----
// V2 records no outcome for a turn killed by a restart / crash and does not resume it: the
// session just leaves the active set. A run is judged lost only after the child was seen in
// that state on >= 2 checks spanning LOST_RUN_GRACE_MS, with `time.updated` unchanged, no
// active descendant and nothing pending for a person. In-memory only: a manta-server restart
// restarts the grace.
export const LOST_RUN_GRACE_MS = 90_000;
export const LOST_RUN_MESSAGE = "the run was cut off — opencode stopped before it finished";
const LOST_RUN_MAX_RECORDS = 500;
const LOST_RUN_RECORD_TTL_MS = 60 * 60_000;
const lostRuns = new Map(); // job id -> { firstSeenAt, checks, sessionUpdatedAt, updatedAt }

/** Test seam: forget every absence record. */
export function _resetLostRuns() {
  lostRuns.clear();
}

async function anyDescendantActive(childId, active, deps) {
  if (typeof deps.listChildSessions !== "function") return false;
  return (await listDescendants(childId, deps)).some((n) => active.has(n.id));
}

async function judgeLostRun(job, session, active, deps, { confirmed }) {
  const unsettled = { settled: false, reason: "no-outcome" };
  const updatedAt = session?.time?.updated;
  if (!confirmed || !Number.isFinite(updatedAt)) return unsettled;
  const now = (deps.now ?? Date.now)();
  try {
    if (await anyDescendantActive(job.childSessionID, active, deps)) {
      lostRuns.delete(job.id);
      return unsettled;
    }
    for (const read of [deps.listPermissions, deps.listQuestions]) {
      if (typeof read !== "function") continue;
      const pending = await read(job.childSessionID);
      if (Array.isArray(pending) && pending.length > 0) return unsettled;
    }
  } catch (e) {
    console.warn(`[delegate] could not judge whether ${job.id} was cut off:`, e?.message ?? e);
    return unsettled;
  }

  for (const [id, r] of lostRuns) if (now - r.updatedAt > LOST_RUN_RECORD_TTL_MS) lostRuns.delete(id);
  while (lostRuns.size >= LOST_RUN_MAX_RECORDS) lostRuns.delete(lostRuns.keys().next().value);
  let rec = lostRuns.get(job.id);
  if (!rec || rec.sessionUpdatedAt !== updatedAt) rec = { firstSeenAt: now, checks: 0, sessionUpdatedAt: updatedAt, updatedAt: now };
  rec.checks += 1;
  rec.updatedAt = now;
  lostRuns.set(job.id, rec);
  if (rec.checks < 2 || now - rec.firstSeenAt < LOST_RUN_GRACE_MS) return { settled: false, reason: "lost-pending" };

  const res = await finishV2Job(job, "failed", LOST_RUN_MESSAGE, deps, { interrupted: true });
  lostRuns.delete(job.id);
  if (res?.alreadyTerminal) return { settled: false, reason: "terminal" };
  return { settled: true, status: res?.status ?? "failed", lost: true };
}

/** A child created this close before the record's `runStartedAt` was created FOR this run. */
export const BORN_SLACK_MS = 60_000;
const BACKGROUND_ERROR_MAX_CHARS = 500;
const BACKGROUND_RESULT_MAX_CHARS = 2_000;

/**
 * Did opencode run this child exactly once so far? The child's OWN raw timeline answers, not Manta's records (an
 * inline `task` run leaves no job record): at most one `idle` record (one execution ended) and no `user` input at or
 * after that first end (a resume). Unreadable or unprovable ⇒ false.
 */
async function singleExecutionProven(childSessionID, deps) {
  if (typeof deps.listRawTimeline !== "function") return false;
  try {
    const rows = await deps.listRawTimeline(childSessionID);
    if (!Array.isArray(rows)) return false;
    const idles = rows.filter((r) => r?.type === "idle");
    if (idles.length > 1) return false;
    if (idles.length === 0) return true;
    const endedAt = idles[0]?.time?.created;
    if (!Number.isFinite(endedAt)) return false;
    return !rows.some((r) => r?.type === "user" && !(Number.isFinite(r?.time?.created) && r.time.created < endedAt));
  } catch {
    return false;
  }
}

/**
 * The instant the run this opencode-owned record describes began. Manta first sees a run some time after it
 * started, so a child created for it (within BORN_SLACK_MS of that sighting) began at its own creation — an
 * outcome from before the sighting is then still THIS run's. That holds only for a PROVABLE first run: attempt 1,
 * continuing nothing, no other record of the child in the store, AND opencode's own timeline of the child showing
 * a single execution (a session resumed from an inline `task` run has no record at all, yet its earlier outcome must
 * never finish the new run). Anything unprovable keeps the sighting time.
 */
async function effectiveRunStart(job, session, manta, deps) {
  if (manta || job.runStartedAt == null) return job.runStartedAt ?? null;
  const created = session?.time?.created;
  if (!(Number.isFinite(created) && created >= job.runStartedAt - BORN_SLACK_MS)) return job.runStartedAt;
  if ((job.attempt ?? 1) !== 1 || job.continues != null) return job.runStartedAt;
  try {
    const records = (await (deps.load ?? loadJobs)()) ?? [];
    if (records.some((j) => j.childSessionID === job.childSessionID && j.id !== job.id)) return job.runStartedAt;
  } catch {
    return job.runStartedAt;
  }
  if (!(await singleExecutionProven(job.childSessionID, deps))) return job.runStartedAt;
  return Math.min(job.runStartedAt, created);
}

/** The text opencode posted to the parent for this child's run (the newest synthetic since `sinceMs`), or null. */
async function readParentResultText(job, deps, { sinceMs = null } = {}) {
  const parent = job.sessionParentID ?? job.parentSessionID;
  if (!parent || !job.childSessionID || typeof deps.listRawTimeline !== "function") return null;
  try {
    let best = null;
    for (const r of (await deps.listRawTimeline(parent, { type: "synthetic" })) ?? []) {
      if (r?.metadata?.childID !== job.childSessionID) continue;
      const created = r?.time?.created ?? 0;
      if (sinceMs != null && created < sinceMs) continue;
      if (!best || created >= (best.time?.created ?? 0)) best = r;
    }
    if (!best) return null;
    const text = backgroundResultText(best.text, {
      childID: job.childSessionID,
      state: typeof best.metadata.state === "string" ? best.metadata.state : undefined,
      description: typeof best.description === "string" ? best.description : undefined,
    }).trim();
    return text || null;
  } catch (e) {
    console.warn(`[delegate] could not read the result opencode posted for ${job.id}:`, e?.message ?? e);
    return null;
  }
}

// opencode posts a background result to the session that launched it; when that session has since been handed
// off — or its handoff is in flight (fenced) — the result belongs to its live successor. The handoff engine decides which
// of live / fenced / replaced the parent is (and answers a live, unfenced one before doing any I/O), so there is no guard
// here: a guard on "already replaced" is exactly what kept a fenced parent from ever reaching it.
// Fire-and-forget: this is a reconcile, not a user action.
function relayResultFromRetiredParent(job, deps) {
  const parent = job.sessionParentID;
  if (!parent || typeof deps.relayBackgroundResult !== "function") return;
  try {
    Promise.resolve(deps.relayBackgroundResult({ sessionId: parent, childSessionId: job.childSessionID })).catch((e) =>
      console.warn(`[delegate] relaying the result of ${job.id} off a retired session failed:`, e?.message ?? e));
  } catch (e) {
    console.warn(`[delegate] relaying the result of ${job.id} off a retired session failed:`, e?.message ?? e);
  }
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
  // Only a launch that was already confirmed running on entry can be judged lost.
  const confirmed = job.launchState === "running";

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
  const runStart = await effectiveRunStart(job, session, manta, deps);
  const fresh =
    !manta && runStart != null
      ? idleAt != null && idleAt >= runStart
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
  if (active.has(job.childSessionID)) {
    lostRuns.delete(job.id);
    return { settled: false, reason: "active" };
  }
  if (!outcome || !fresh) return judgeLostRun(job, session, active, deps, { confirmed });
  lostRuns.delete(job.id);

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
  let t = outcomeToTerminal(outcome, { error: hint?.error });
  if (!t) return { settled: false, reason: "no-outcome" };
  // The turn of a task whose question was captured was interrupted ON PURPOSE: that is "needs a decision" (done), not a failure.
  // A user's stop or pause still wins.
  let interrupted = outcome === "interrupted";
  if (interrupted && manta && !job.stopRequested && !job.pauseRequested && (await hasDecision(job, deps))) {
    t = { status: "done", error: null };
    interrupted = false;
  }
  // A session opencode runs reports its own result to its parent: the real error / result text lives there. Read
  // only when needed: a failed run with no raw error now, a done run only if the child yields no text of its own.
  let resultFallback = null;
  if (!manta && outcome === "failed" && !hint?.error) {
    const body = await readParentResultText(job, deps, { sinceMs: runStart });
    if (body) t.error = body.slice(0, BACKGROUND_ERROR_MAX_CHARS);
  } else if (!manta && t.status === "done") {
    resultFallback = async () => (await readParentResultText(job, deps, { sinceMs: runStart }))?.slice(0, BACKGROUND_RESULT_MAX_CHARS) ?? null;
  }
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
  // A specialist's round that finished well may hold an answer to its own question (steered in, or waiting for the round to end): the gate runs
  // BEFORE the terminal write so that write can say `deferred` (spec §4.3).
  if (manta && t.status === "done" && !interrupted && job.specialist === true) await runEndingGate(job, deps);
  await finishV2Job(job, t.status, t.error, deps, { interrupted, resultFallback });
  if (!manta) relayResultFromRetiredParent(job, deps);
  return { settled: true, status: t.status };
}

/** Does the LIVE record hold a captured decision (the snapshot a caller settles from may predate it)? */
async function hasDecision(job, deps) {
  if (job.decision) return true;
  try {
    const live = ((await (deps.load ?? loadJobs)()) ?? []).find((j) => j.id === job.id);
    return !!live?.decision && !live.stopRequested && !live.pauseRequested;
  } catch {
    return false;
  }
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
function pinKnowledgeSession(deps, job) {
  const directory = job.executionDirectory ?? job.worktree ?? job.parentDirectory;
  if (typeof deps.pinKnowledgeSession !== "function" || !directory || !job.childSessionID) return;
  try {
    Promise.resolve(deps.pinKnowledgeSession({ sessionID: job.childSessionID, directory, force: true })).catch((e) =>
      console.warn(`[delegate] knowledge pin of ${job.childSessionID} failed:`, e?.message ?? e),
    );
  } catch (e) {
    console.warn(`[delegate] knowledge pin of ${job.childSessionID} failed:`, e?.message ?? e);
  }
}

async function submitCommand(job, deps, { reconciled = false, undo = {} } = {}) {
  const delegate = !!job.launch;
  const continuation = !!job.launch?.continuation;
  const run = job.commandRun ?? {};
  try {
    if (delegate) {
      // Shared knowledge §3.1: the child was created under its parent and has just been moved into its
      // worktree, so only NOW does it have its real directory — pin it to that project (forced: it wins over a
      // parent-/move-sourced mapping). Fire-and-forget; it never delays or fails the launch.
      pinKnowledgeSession(deps, job);
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
  const confirmed = await patchJob(job.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) && j.launchState !== "running" });
  const running = confirmed ?? job;
  // the launch is confirmed: the stall clock and the tool picture start from here
  if (confirmed) deps.liveness?.rootChanged(confirmed);
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
    deps.liveness?.drop(job.id);
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
  return wireResult(await continueJobRecord(id, input, deps));
}

async function continueJobRecord(id, input, deps) {
  const { load: baseLoad = loadJobs, save = saveJobs, publish, now = () => Date.now() } = deps;
  const admit = typeof input?.admit === "function" ? input.admit : null;
  // with an admission check the store is read strictly: an unreadable one refuses (and is never saved over)
  const load = admit ? admitLoader(deps) : baseLoad;
  const args = { prompt: input?.prompt, sessionID: input?.sessionID };
  let peekJobs;
  try {
    peekJobs = (await load()) ?? [];
  } catch (e) {
    if (admit) return { ok: false, status: 500, error: ADMIT_STORE_ERROR };
    throw e;
  }
  const peeked = continueRefusal(peekJobs, id, args, deps);
  if (!peeked.ok) return peeked;
  const child = peeked.job.childSessionID;
  if (!child) return { ok: false, status: 409, error: "that job has no session to continue" };
  const followUp = String(args.prompt).trim();

  return withSessionResources(child, async () => {
    // A specialist's task keeps the permissions it was created with (OpenCode installs them at creation), so another
    // round only runs under the very settings that started it (Agents Phase 3 §4).
    if (peeked.job.specialist === true || isLegacySpecialist(peeked.job)) {
      if (isLegacySpecialist(peeked.job)) return { ok: false, status: 409, error: LEGACY_TASK };
      const current = await currentAutonomyPolicy(deps);
      if (!current.ok) return { ok: false, status: 500, error: current.error };
      if (policyKey(current.policy) !== peeked.job.autonomyKey) return { ok: false, status: 409, error: POLICY_CHANGED };
      if (isWriterJob(peeked.job) && decideAutonomy("edit_code", current.policy) === "never") return { ok: false, status: 409, error: CODE_OFF };
    }
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
      let jobs;
      try {
        jobs = (await load()) ?? [];
      } catch (e) {
        if (admit) return { ok: false, status: 500, error: ADMIT_STORE_ERROR };
        throw e;
      }
      const recheck = continueRefusal(jobs, id, args, deps);
      if (!recheck.ok) return recheck;
      if (jobs.filter(countsTowardCap).length >= MAX_RUNNING_JOBS) return { ok: false, status: 409, error: CAP_ERROR };
      const old = recheck.job;
      if (admit) {
        const refusal = await runAdmit(admit, jobs, old);
        if (refusal) return { ok: false, status: 409, error: refusal };
      }
      const t = now();
      // (a successor starts with no told / blocked / exceeded actions or self-report of its own: the previous round's stay on
      // the previous record; the project patterns are inherited — the child keeps the permissions OpenCode gave it at creation)
      // (the ending gate's marks, the seat note and the questions the old round ended waiting on belong to that round alone)
      const { supersededBy: _s, cleanupReason: _c, toldActions: _t, blockedActions: _b, exceededActions: _e, selfReport: _r, decision: _d, ending: _en, continueAfter: _ca, gateFailed: _gf, seatAdded: _sa, waiting: _w, ...inherited } = old;
      const baseCeiling = withLivenessDefaults(old).baseCeilingMs;
      const job = {
        ...inherited,
        ...livenessFieldsAtLaunch(baseCeiling),
        budgetRecorded: null, // the successor's usage restarts at 0: so does its cursor
        id: genId(),
        attempt: (old.attempt ?? 1) + 1,
        continues: old.id,
        rootJobId: rootJobOf(old),
        prompt: followUp,
        // a lead handoff's fix round: the new title, who asked, and the turn it counts against (else inherited)
        ...(typeof input?.name === "string" && input.name.trim() ? { name: jobNameFor({ name: input.name }, followUp) } : {}),
        ...(typeof input?.request === "string" && input.request ? { request: input.request } : {}),
        ...(input?.requestedBy === "manta" ? { requestedBy: "manta" } : {}),
        ...(typeof input?.turnKey === "string" && input.turnKey ? { turnKey: input.turnKey } : {}),
        ...(input?.allowPr === false ? { allowPr: false } : {}),
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
        // the Architect's stamp follows the round: the root is copied, the round's own mode is the verified lead call's (else unknown)
        ...(old.architect ? { architect: { rootJobId: old.architect.rootJobId ?? old.id, attempt: (old.attempt ?? 1) + 1, mode: architectModeOf(input?.architect?.mode) } } : {}),
        // a specialist's follow-up also carries the footer again: a task from before it was introduced never saw it
        // (a caller delivering something it must be able to find again — an answer to a task's question — names the message id)
        launch: { text: old.specialist === true ? `${followUp}\n\n${taskFooter(old.autonomyPolicy)}` : followUp, messageId: typeof input?.messageID === "string" && input.messageID ? input.messageID : mintMessageId(), model: null, continuation: true },
      };
      inLaunch.add(job.id); // from the moment it exists: a sweep must never read it as cut off
      try {
        await save([...jobs.map((j) => (j.id === old.id ? { ...j, supersededBy: job.id } : j)), job]);
        deps.liveness?.rootChanged(job);
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

// ---- deliverToTask: the user's word reaches a task (spec docs/superpowers/specs/2026-11-26-agents-screens.md §4.2) ----

/**
 * Deliver `text` (a message of the USER's, written by the server: an answer to the task's question, or the news that it was dismissed) to the task whose
 * first round is `rootJobId`. It first marks the newest round `askedUser` (so a continuation inherits it), then, under the session's lock, reads the LIVE
 * newest round and decides:
 *   - running, busy, not `ending` → STEERED into the turn (`{delivery:"steer"}`);
 *   - running but `ending`, or still idle after one 2 s re-read → `{delivery:"continue-pending"}`: the round ends first and `onRoundSettled` sends it (the
 *     round is marked `continueAfter`, which its terminal write reads);
 *   - finished (done / failed / stopped) → `continueJob` (`{delivery:"continue"}`). The lock is RELEASED first: `continueJob` takes it itself and it is not re-entrant;
 *   - paused / gone → a sentence.
 * `steerOnly` (a dismissal): never starts a round and never marks the task answered — anything but a steer is `{delivery:"none"}`.
 * `messageID` is the id the message is sent under, so a crash between sending and recording can be settled from the session.
 * Never throws; a refusal is `{error: "<sentence>"}`.
 * @returns {Promise<{delivery: "steer" | "continue" | "continue-pending" | "none"} | {error: string}>}
 */
export async function deliverToTask(rootJobId, text, { messageID, steerOnly = false } = {}, deps = {}) {
  const { load = loadJobs } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const what = steerOnly ? "Couldn't tell the task" : "Couldn't send your answer";
  const steerInto = async (round) => {
    if (typeof deps.sendChildPrompt !== "function") return { error: `${what}: background jobs are not wired in this server` };
    try {
      await deps.sendChildPrompt({ sessionId: round.childSessionID, text, delivery: "steer", ...(messageID ? { messageID } : {}) });
      return { delivery: "steer" };
    } catch (e) {
      return { error: `${what}: ${String(e?.message ?? e)}` };
    }
  };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const peek = newestRoundOf((await load()) ?? [], rootJobId);
      if (!peek) return { error: TASK_GONE };
      if (!steerOnly) await patchJob(peek.id, { askedUser: true }, deps);

      const decide = (final) =>
        withSessionResources(peek.childSessionID, async () => {
          const live = newestRoundOf((await load()) ?? [], rootJobId);
          if (!live) return { out: { error: TASK_GONE } };
          if (live.childSessionID !== peek.childSessionID) return { moved: true }; // a resume swapped the child: lock the new one
          if (live.status === "paused") return { out: steerOnly ? { delivery: "none" } : { error: TASK_PAUSED } };
          if (live.status === "running") {
            if (live.ending) {
              if (steerOnly) return { out: { delivery: "none" } };
              await patchJob(live.id, { continueAfter: true }, deps);
              return { out: { delivery: "continue-pending" } };
            }
            // a child that is being handed off is about to be replaced: a steer would land in the predecessor nobody reads. The round goes on in its
            // successor (its settlement is deferred until the commit), so the answer waits for the round to end like any other.
            if (deps.deferSettlement?.(live.childSessionID)) {
              if (steerOnly) return { out: { delivery: "none" } };
              await patchJob(live.id, { continueAfter: true }, deps);
              return { out: { delivery: "continue-pending" } };
            }
            let busy;
            try {
              busy = (await deps.listActiveIds()).includes(live.childSessionID);
            } catch (e) {
              return { out: { error: `${what}: couldn't check whether the task is busy (${String(e?.message ?? e)})` } };
            }
            if (busy) return { out: await steerInto(live) };
            if (!final) return { recheck: true };
            if (steerOnly) return { out: { delivery: "none" } };
            await patchJob(live.id, { continueAfter: true }, deps);
            return { out: { delivery: "continue-pending" } };
          }
          if (steerOnly) return { out: { delivery: "none" } };
          return { continueRound: live };
        });

      let step = await decide(false);
      if (step.recheck) {
        await sleep(2000); // (outside the lock: the round may be settling right now)
        step = await decide(true);
      }
      if (step.moved) continue;
      if (step.out) return step.out;
      const round = step.continueRound;
      const res = await continueJob(round.id, { prompt: text, sessionID: round.parentSessionID, requestedBy: "manta", ...(messageID ? { messageID } : {}) }, deps);
      return res.ok ? { delivery: "continue" } : { error: String(res.error ?? `${what}.`) };
    }
    return { error: "The task changed while your answer was being sent; try again." };
  } catch (e) {
    return { error: `${what}: ${String(e?.message ?? e)}` };
  }
}

/** A milestone on a task's newest round (any state): the server's own notes, "Asked you: …" / "You answered: …". `rootJobId` names the task. */
export async function addJobMilestone(rootJobId, text, deps = {}) {
  const { load = loadJobs } = deps;
  const round = newestRoundOf((await load()) ?? [], rootJobId);
  if (!round) return false;
  const at = (deps.now ?? (() => Date.now()))();
  const next = await patchJob(round.id, (j) => ({ jobProgress: addMilestone(withLivenessDefaults(j).jobProgress, text, at) }), deps);
  if (next) deps.jobViews?.notify(next.id);
  return !!next;
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
    const commandId = genId();
    const job = {
      id: commandId,
      rootJobId: commandId,
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
      ...livenessFieldsAtLaunch(DEFAULT_CEILING_MS),
    };
    jobs.push(job);
    inLaunch.add(job.id); // from the moment it exists: a sweep must never read it as cut off
    try {
      await save(jobs);
      deps.liveness?.rootChanged(job);
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

// The liveness / progress fields a Manta-owned record is born with (spec 2026-11-14 §5.1).
function livenessFieldsAtLaunch(ceilingMs) {
  return {
    ceilingMs,
    baseCeilingMs: ceilingMs,
    extensions: [],
    ceilingWarnedFor: null,
    endReason: null,
    endedBlocked: false,
    lastProgressAt: null,
    jobProgress: defaultJobProgress(),
  };
}

// ---- delegate jobs on V2 (Stage C1) ---------------------------------------
//
// Every job — the CTO's workers included — is a real V2
// child session: created under the parent with a client-minted id, moved into the
// job's worktree, given a window, and sent its opening prompt. It completes from the
// child's raw execution outcome (settleV2Job — the same evaluator B's wrapped runs
// use) and reports ONE result through N7, whatever route it takes to a terminal state.

const architectModeOf = (mode) => (mode === "build" || mode === "plan" ? mode : "unknown");

// The agent every delegate child runs. Today's jobs always ran the default agent; a
// child created under a parent would otherwise be free to inherit a plan-mode one.
const V2_JOB_AGENT = "build";

// ---- a specialist's task: autonomy settings (Agents Phase 3) ----------------

const isWriterJob = (job) => (job?.isolation ?? (job?.worktree ? "worktree" : "none")) === "worktree";
// a Phase 1/2 specialist job: no autonomy snapshot, but it carries an agent's name and runs an `agent-<slug>` opencode agent
const isLegacySpecialist = (job) => job?.specialist !== true && !!job?.agentName && typeof job?.agent === "string" && job.agent.startsWith("agent-");

// The user's CURRENT autonomy settings through the injected reader. Fails closed: no reader, or one that throws, is a refusal.
async function currentAutonomyPolicy(deps) {
  if (typeof deps.autonomyPolicy !== "function") return { ok: false, error: SETTINGS_UNREADABLE };
  try {
    return { ok: true, policy: await deps.autonomyPolicy() };
  } catch {
    return { ok: false, error: SETTINGS_UNREADABLE };
  }
}

// The project's own commands for a task about to start (Phase 3c §8): a failing or absent reader is "none", never a refusal.
async function projectActionsFor(deps, directory) {
  try {
    const r = await deps.projectActions?.forTask?.({ directory });
    return { entries: Array.isArray(r?.entries) ? r.entries : [], promptEntries: Array.isArray(r?.promptEntries) ? r.promptEntries : [] };
  } catch {
    return { entries: [], promptEntries: [] };
  }
}

// A new specialist job: `input.autonomy.load()` then `check(policy)`, at the last moment before anything is created.
async function loadStartPolicy(input, deps) {
  const a = input?.autonomy;
  if (!a || typeof a.load !== "function") return { ok: false, error: SETTINGS_UNREADABLE };
  let policy;
  try {
    policy = await a.load();
  } catch {
    return { ok: false, error: SETTINGS_UNREADABLE };
  }
  let refusal = null;
  try {
    refusal = typeof a.check === "function" ? a.check(policy) : null;
  } catch {
    refusal = SETTINGS_UNREADABLE;
  }
  return refusal ? { ok: false, error: String(refusal) } : { ok: true, policy };
}

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

  // A specialist's task (Agents Phase 3): the policy is read NOW — after any approval wait, before anything is
  // created — and that one object feeds the rules, the prompt and the snapshot below.
  const specialist = input?.specialist === true;
  const home = deps.home ?? homedir();
  let autonomyNow = null;
  let project = { entries: [], promptEntries: [] };
  let projectPatternsNow = [];
  if (specialist) {
    const loaded = await loadStartPolicy(input, deps);
    if (!loaded.ok) return loaded;
    autonomyNow = loaded.policy;
    if (isInsideMantaFolders(resolvePath(String(parentDirectory ?? "")), home)) return { ok: false, error: MANTA_FOLDER };
    project = await projectActionsFor(deps, parentDirectory);
    projectPatternsNow = buildProjectPatterns(project.entries);
    if (projectPatternsNow.error) return { ok: false, error: projectPatternsNow.error };
  }

  const reg = await jobsLock.runExclusive(async () => {
    let jobs;
    try {
      jobs = await (typeof input?.admit === "function" ? admitLoader(deps) : load)();
    } catch (e) {
      if (typeof input?.admit === "function") return { ok: false, error: ADMIT_STORE_ERROR };
      throw e;
    }
    const refused = launchRefusal(jobs, parentSessionID);
    if (refused) return refused;
    // The caller's admission check (agent handoffs: single writer, per-turn cap) runs BEFORE anything is allocated, so a
    // refusal leaves no record, worktree, branch or session id behind.
    if (typeof input?.admit === "function") {
      const refusal = await runAdmit(input.admit, jobs);
      if (refusal) return { ok: false, error: refusal };
    }
    const name = jobNameFor(input, prompt);

    // Which workspace hosts the window — resolved before anything is created.
    let tmuxSession = input?.targetProject ?? null;
    if (!tmuxSession) {
      const owner = resolveOwner(await listProjects(), parentSessionID);
      if (!owner) return { ok: false, error: `could not resolve the tmux session owning ${parentSessionID}` };
      tmuxSession = owner.tmuxSession;
    }

    // An agent with isolation "none" works read-only in the parent's own folder: no worktree is made at all.
    const readOnly = input?.isolation === "none";
    const wt = readOnly
      ? { worktree: null, branch: null, baseSha: null, cwd: parentDirectory }
      : await prepareWorktree({ input, name, parentDirectory }, deps);
    if (wt.refusal) return wt.refusal;
    const { worktree, branch, baseSha } = wt;
    if (specialist && worktree && isInsideMantaFolders(resolvePath(worktree), home)) {
      if (gitRemoveWorktree) {
        try {
          await gitRemoveWorktree({ path: worktree, force: false });
        } catch {
          /* best-effort; the refusal is the headline */
        }
      }
      return { ok: false, error: MANTA_FOLDER };
    }
    // The opencode agent the child runs: an agent package's `agent-<slug>`, else the default.
    const jobAgent = typeof input?.agent === "string" && input.agent.trim() ? input.agent.trim() : V2_JOB_AGENT;
    // An agent job brings its own ruleset unless the caller supplied one.
    // The Architect's task (Agents Phase 5A): only the agents engine passes `architect`; no other caller builds this input.
    const architectMode = specialist && input?.architect && typeof input.architect === "object" ? input.architect.mode : undefined;
    const architect = architectMode !== undefined;
    const baseChosen =
      input?.permission ??
      (architect
        ? null // the Architect's whole ruleset comes from buildArchitectRuleset (here and on every resume)
        : readOnly
        ? buildReadOnlyAgentRuleset({ agentDir: input?.agentDir })
        : input?.isolation === "worktree"
          ? buildWorktreeAgentRuleset()
          : null);
    // every specialist's task may research (also under a grant list edited on the approval card)
    const basePermission = specialist && !architect && baseChosen ? withResearchToolAllows(baseChosen) : baseChosen;
    // A specialist's autonomy denies are appended ONCE, last, after the base selection (caller ruleset → approval-resolved
    // grants → read-only / worktree default); the base itself is kept so a resume can recompute the final ruleset.
    const agentDir = typeof input?.agentDir === "string" && input.agentDir ? input.agentDir : null;
    // The child session's id is minted before its rules: the rules name the secrets folder of exactly this session.
    const childSessionID = mintSessionId();
    const jobPermission = architect
      ? normalizeJobRuleset(buildArchitectRuleset({ policy: autonomyNow, agentDir, home, projectPatterns: projectPatternsNow, sessionID: childSessionID }), { allowQuestion: true })
      : specialist
        ? normalizeJobRuleset([...(basePermission ?? []), ...jobRules(autonomyNow, { home, agentDir, projectPatterns: projectPatternsNow, sessionID: childSessionID })], { allowQuestion: true })
        : basePermission;
    // THE execution directory, resolved once and persisted: the worktree, or the
    // parent's own directory when none could be made and isolation isn't required.
    const executionDirectory = worktree ?? parentDirectory;

    const t = now();
    const launchModel = toDeliverModel(effectiveModel);
    const ceilingMs = initialCeilingMs({ sweepAllowanceMs: input?.sweepAllowanceMs, maxDurationMinutes: input?.maxDurationMinutes });
    const jobId = genId();
    const job = {
      id: jobId,
      name,
      prompt,
      model: requestedModel ?? null,
      requestedModel: requestedModel ?? null,
      parentSessionID,
      parentDirectory,
      childSessionID,
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
      permission: jobPermission,
      ...(specialist
        ? {
            specialist: true,
            basePermission: basePermission ?? null,
            autonomyKey: policyKey(autonomyNow),
            autonomyPolicy: normalizePolicy(autonomyNow),
            projectPatterns: projectPatternsNow,
            ...(agentDir ? { agentDir } : {}),
          }
        : {}),
      // the capability stamp (§4.2): the first job's own id is the root every continuation copies
      ...(architect ? { architect: { rootJobId: jobId, attempt: 1, mode: architectModeOf(architectMode) } } : {}),
      // the task this round belongs to (agent screens §6.1): its own id for the first round; continuations and resumes copy it
      rootJobId: jobId,
      // this launch placed the agent in a project it had no seat in (the run card says so)
      ...(seatAddedOf(input?.seatAdded) ? { seatAdded: seatAddedOf(input.seatAdded) } : {}),
      // never post this job's result (a refresh task runs under a headless session nobody reads); inherited by every round
      ...(input?.deliverResult === false ? { deliverResult: false } : {}),
      ...(typeof input?.agentName === "string" && input.agentName ? { agentName: input.agentName } : {}),
      ...(typeof input?.request === "string" && input.request ? { request: input.request } : {}),
      // what admission reads later: where the agent works, who asked, in which user turn, and whether it may open a PR
      ...(input?.isolation === "worktree" || input?.isolation === "none" ? { isolation: input.isolation } : {}),
      ...(input?.requestedBy === "manta" ? { requestedBy: "manta" } : {}),
      ...(typeof input?.turnKey === "string" && input.turnKey ? { turnKey: input.turnKey } : {}),
      ...(input?.allowPr === false ? { allowPr: false } : {}),
      // Background work budget (spec 2026-11-17 §17.14): set for overnight dispatches (`actor:"cto"` alone does not
      // identify them). The cursor is what has already been booked against the shared budget.
      budgetWorkType: typeof input?.budgetWorkType === "string" && input.budgetWorkType ? input.budgetWorkType : null,
      budgetRecorded: null,
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
      agent: jobAgent,
      executionDirectory,
      // what the launch sends, persisted so a reconcile can finish a launch this
      // process never got to (and a resume reuses the first attempt's model)
      launch: {
        text: buildJobPrompt({
          prompt,
          worktree,
          branch,
          ceilingMs,
          readOnly,
          allowPr: input?.allowPr !== false,
          autonomy: specialist ? taskPromptSection(autonomyNow, project.promptEntries) : "",
          specialist,
        }),
        model: launchModel,
        messageId: mintMessageId(),
      },
      ...livenessFieldsAtLaunch(ceilingMs),
    };
    inLaunch.add(job.id); // from the moment it exists: a sweep must never read it as cut off
    try {
      await save([...jobs, job]);
      deps.liveness?.rootChanged(job);
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

/** `{project, projectName}` as the agents engine passes it, or null. */
function seatAddedOf(v) {
  return v && typeof v === "object" && typeof v.project === "string" && v.project && typeof v.projectName === "string" ? { project: v.project, projectName: v.projectName } : null;
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
      // a job can never wait on a person: its ruleset ends with a `question` deny (a specialist's task may ask: the server captures it)
      permission: normalizeJobRuleset(job.permission, { allowQuestion: job.specialist === true }),
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
  const prior = withLivenessDefaults(job);
  const updated = {
    ...job,
    // a new segment: the launch ceiling again (extensions dropped), no end reason; the progress the job made is kept
    ceilingMs: prior.baseCeilingMs,
    baseCeilingMs: prior.baseCeilingMs,
    extensions: [],
    ceilingWarnedFor: null,
    endReason: null,
    jobProgress: { ...prior.jobProgress, modelState: null },
    decision: undefined, // the question the previous attempt ended with is answered by resuming
    rootJobId: rootJobOf(job),
    ending: undefined,
    continueAfter: undefined,
    gateFailed: undefined,
    // a specialist's task resumes under the CURRENT settings (recomputed in resumeJob); its previous attempt's told /
    // blocked actions are cleared with the new attempt
    ...(prepared.autonomy
      ? {
          permission: prepared.autonomy.permission,
          autonomyKey: prepared.autonomy.key,
          autonomyPolicy: prepared.autonomy.policy,
          projectPatterns: prepared.autonomy.projectPatterns,
          toldActions: undefined,
          blockedActions: undefined,
          exceededActions: undefined,
          selfReport: undefined,
        }
      : {}),
    status: "running",
    tmuxSession,
    childSessionID: prepared.nextChildId ?? mintSessionId(),
    attempt: (job.attempt ?? 1) + 1,
    // a resume has no verified lead call of its own: the round's mode is unknown, whatever the first round's was
    ...(job.architect ? { architect: { rootJobId: job.architect.rootJobId ?? job.id, attempt: (job.attempt ?? 1) + 1, mode: "unknown" } } : {}),
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
        ...(job.architect ? { architect: job.architect } : {}),
        ceilingMs: prior.ceilingMs,
        extensions: prior.extensions,
        ceilingWarnedFor: prior.ceilingWarnedFor,
        endReason: prior.endReason,
        jobProgress: prior.jobProgress,
        launch: job.launch ? { ...job.launch, restore: undefined } : null,
        ...(prepared.autonomy
          ? {
              permission: job.permission,
              autonomyKey: job.autonomyKey,
              autonomyPolicy: job.autonomyPolicy,
              projectPatterns: job.projectPatterns,
              toldActions: job.toldActions,
              blockedActions: job.blockedActions,
              exceededActions: job.exceededActions,
              selfReport: job.selfReport,
            }
          : {}),
      },
    },
  };
  jobs[idx] = updated;
  inLaunch.add(updated.id);
  try {
    await save(jobs);
    deps.liveness?.rootChanged(updated);
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
// The session graph now owns API-driven rows. Each tick only recovers a background task's
// missing subagent record (for transcript cards/result pairing), without creating a window.
// Existing observed records still settle through reconcileV2Jobs, unchanged.
//
// What it deliberately leaves alone: a session that already has a live row, one a launch in this
// process is making, anything inside a live job's tree, Manta's own helper sessions, an inline
// (foreground) `task` child, a user's own window, and a session whose handoff is pending. A session
// must be seen busy on consecutive ticks before it is adopted, so seconds-long helpers never appear.
// ---------------------------------------------------------------------------

const RECONCILE_TICKS = 2;

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
    let backgroundChild = false;
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
        backgroundChild = true;
      }
    }

    // API-driven roots are tree rows, not observed job records. Only background task children need adoption.
    if (!backgroundChild) return skip(sid);

    // f. seen busy on consecutive ticks
    const entry = seen.get(sid) ?? { ticks: 0, since: now() };
    entry.ticks += 1;
    seen.set(sid, entry);
    if (entry.ticks < RECONCILE_TICKS) return false;

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
        parentSessionID: res.status === "ok" ? res.parentSessionID : (prev?.parentSessionID ?? null),
        sessionParentID: session.parentID ?? null,
        cwd: session.directory || undefined,
        parentDirectory: session.directory || undefined,
        name: title.slice(0, 80) || "Background session",
        prompt: "",
        model: modelStringOf(session.model),
        origin: "subagent",
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
    return { adopted };
  }

  return { reconcile, seenCount: () => seen.size };
}


// ---------------------------------------------------------------------------
// Liveness sweep (spec 2026-11-14 §A1–A3, A5, A6, B3)
// ---------------------------------------------------------------------------

/** Run `fn` over `items`, at most `n` at a time. Never throws. */
async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (e) {
        console.warn("[delegate] liveness sweep step failed:", e?.message ?? e);
      }
    }
  });
  await Promise.all(workers);
}

/** `fn()`'s answer, or `undefined` when it threw or took longer than `ms` (a read that couldn't finish proves nothing). */
async function withBudget(fn, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Store the decision of a RUNNING task and mark it blocked: it ends "needs a decision". null when it is not running.
 * `askedUser` is the lasting mark that the user was asked in this task: the decision itself is cleared when the user's
 * answer resumes the task, the mark is inherited by every later round.
 */
function recordDecision(id, decision, deps) {
  return mutateJobProgress(id, deps, (job) => ({ decision, askedUser: true, jobProgress: { ...job.jobProgress, modelState: "blocked" } }));
}

/**
 * A question form raised in a Manta-owned job's session (the pump's A5 backstop). A specialist's task asking in its OWN session
 * is captured: the question becomes the stored decision, the turn is interrupted (the task ends "needs a decision" through
 * its raw `interrupted` outcome, `settleV2Job`) and the form is rejected so nothing stays pending. Anything else — a subagent's
 * question, a plain delegate job's, a form with no question — is rejected exactly as before. `{ captured }`.
 */
async function handleQuestion(form, deps) {
  const sessionId = form?.sessionID;
  const ask = { kind: "question", requestId: form?.id, sessionId };
  const jobId = deps.liveness?.jobIdOf(sessionId) ?? null;
  const live = jobId ? deps.liveness.get(jobId) : null;
  let decision = null;
  if (live && live.root === sessionId) {
    const rec = ((await (deps.load ?? loadJobs)()) ?? []).find((j) => j.id === jobId);
    if (rec && rec.status === "running" && rec.specialist === true && completionOwnerOf(rec) === "manta") {
      // The task's question does not block it (spec 2026-11-26 §4): the form is answered at once with a placeholder and the user's answer arrives
      // later. A form that forbids typing, a reply that fails or a 4th open question takes today's path below.
      if (deps.taskQuestions) {
        let taken = null;
        try {
          taken = await deps.taskQuestions.capture(form, rec);
        } catch (e) {
          console.warn(`[delegate] capturing the question of ${jobId} failed (taking the old path):`, e?.message ?? e);
        }
        if (taken?.captured) return { captured: true };
      }
      const d = decisionFromForm(form, (deps.now ?? (() => Date.now()))());
      if (d && (await recordDecision(jobId, d, deps))) decision = d;
    }
  }
  if (decision && typeof deps.abortSession === "function") {
    try {
      await deps.abortSession(sessionId);
    } catch (e) {
      // the task then ends when its own turn does: the stored decision still decides the outcome
      console.warn(`[delegate] interrupting ${jobId} after its question failed:`, e?.message ?? e);
    }
  }
  await rejectAsk(ask, deps);
  return { captured: decision !== null };
}

/** A guarded patch of a RUNNING record's progress fields under the jobs lock; publishes (throttled) when it wrote. */
async function mutateJobProgress(id, deps, fn) {
  const { load = loadJobs, save = saveJobs } = deps;
  const out = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1 || jobs[idx].status !== "running") return null;
    const job = withLivenessDefaults(jobs[idx]);
    const patch = fn(job);
    if (!patch && !lacksLivenessDefaults(jobs[idx])) return null;
    jobs[idx] = { ...job, ...(patch ?? {}) };
    await save(jobs);
    return jobs[idx];
  });
  if (out) deps.jobViews?.notify(out.id);
  return out;
}

const isNotFound = (e) => e?.status === 404 || /not.?found|no pending/i.test(String(e?.message ?? ""));

/** Reject one pending question / permission of a job's session. A failure is queued for the sweep to retry. */
async function rejectAsk(ask, deps) {
  const reject = ask.kind === "permission" ? deps.rejectPermission : deps.rejectQuestion;
  if (typeof reject !== "function") return false;
  try {
    await reject({ requestId: ask.requestId, sessionId: ask.sessionId });
    deps.liveness?.dropRejection(ask.requestId);
    return true;
  } catch (e) {
    if (isNotFound(e)) {
      deps.liveness?.dropRejection(ask.requestId);
      return true;
    }
    deps.liveness?.queueRejection(ask);
    return false;
  }
}

async function retryRejections(deps) {
  for (const ask of deps.liveness?.pendingRejections() ?? []) {
    if (!deps.liveness.ownsSession(ask.sessionId)) {
      deps.liveness.dropRejection(ask.requestId);
      continue;
    }
    await rejectAsk(ask, deps);
  }
}

/**
 * Rebuild a running job's liveness picture after a restart (spec A1 "Reconstruction"): the descendant tree, the tools
 * each session is running right now, and any ask still pending (rejected by the backstop). Bounded; a failure
 * leaves the job unreconstructed, so it is retried next sweep and never judged stalled meanwhile.
 */
async function reconstructLiveness(job, deps) {
  const live = deps.liveness?.get(job.id);
  if (!live || live.reconstructedAt != null) return;
  const gen = live.generation;
  const readTail = deps.listTailMessages ?? deps.listMessages;
  const read = await withBudget(async () => {
    const nodes = typeof deps.listChildSessions === "function" ? await listDescendants(job.childSessionID, deps) : [];
    const running = [];
    const asks = [];
    for (const sid of [job.childSessionID, ...nodes.map((n) => n.id)]) {
      const messages = typeof readTail === "function" ? ((await readTail(sid)) ?? []) : [];
      const newest = [...messages].reverse().find((m) => m?.info?.role === "assistant");
      for (const p of newest?.parts ?? []) {
        if (p?.type !== "tool" || p.state?.status !== "running" || !p.callID) continue;
        running.push({
          callID: p.callID,
          sessionId: sid,
          name: p.tool,
          target: activityTarget(p.tool, p.state?.input),
          timeoutMs: activityTimeoutMs(p.tool, p.state?.input),
          startedAt: Number(p.state?.time?.start),
        });
      }
      for (const [kind, readAsks] of [["permission", deps.listPermissions], ["question", deps.listQuestions]]) {
        if (typeof readAsks !== "function") continue;
        for (const a of (await readAsks(sid)) ?? []) if (a?.id) asks.push({ kind, requestId: a.id, sessionId: sid });
      }
    }
    return { nodes, running, asks };
  }, RECONSTRUCT_BUDGET_MS);
  if (!read) return;
  // Applied first so the descendants are indexed: `ownsSession` is the same test the live backstop uses (a
  // slash-command job shares its parent's permissions, so its asks are never rejected).
  if (!deps.liveness.applyReconstruction(job.id, gen, { nodes: read.nodes, running: read.running })) return;
  for (const ask of read.asks) if (deps.liveness.ownsSession(ask.sessionId)) await rejectAsk(ask, deps);
}

function stallMessage(verdict, headline) {
  if (verdict.tool) {
    const label = verdict.tool.target || verdict.tool.name;
    return verdict.tool.ranPastTimeout
      ? `stalled — "${label}" ran past its own timeout`
      : `stalled — "${label}" ran with no output for 60 minutes`;
  }
  return headline ? `stalled — no progress for 15 minutes (last: ${headline})` : "stalled — no progress for 15 minutes";
}

/**
 * Ceiling, then stall, for one running Manta-owned job. Each end re-checks the LIVE record under the jobs lock
 * (finishV2Job's `onlyIf`), atomically with the write, so an extension (`extendJob`) and a time-limit end can't both happen.
 */
async function judgeLiveness(job, deps) {
  const { liveness } = deps;
  const clock = deps.now ?? (() => Date.now());
  const ceiling = withLivenessDefaults(job).ceilingMs;
  const sameRun = (live) =>
    live.status === "running" &&
    live.childSessionID === job.childSessionID &&
    (live.attempt ?? 1) === (job.attempt ?? 1) &&
    live.startedAt === job.startedAt;
  const endChild = async (res) => {
    // A child Manta started keeps running (and spending) after its result said "failed" unless it is interrupted.
    // The record is already terminal here, so the interrupt's own outcome event finds nothing left to do.
    if (res?.alreadyTerminal || res?.skipped || !deps.abortSession || !job.childSessionID) return;
    try {
      await deps.abortSession(job.childSessionID);
    } catch (e) {
      console.warn(`[delegate] interrupting the stopped child of ${job.id} failed:`, e?.message ?? e);
    }
  };

  if (job.startedAt != null && clock() - job.startedAt > ceiling) {
    const res = await finishV2Job(job, "failed", `reached its time limit of ${formatDuration(ceiling)}`, deps, {
      endReason: "time-limit",
      onlyIf: (live) => sameRun(live) && withLivenessDefaults(live).ceilingMs === ceiling && clock() - live.startedAt > ceiling,
    });
    await endChild(res);
    return;
  }

  if (job.launchState !== "running" || !liveness) return;
  const verdict = liveness.judgeStall(job.id, clock());
  if (!verdict.stalled) return;
  const message = stallMessage(verdict, deps.jobViews?.headlineFor(job) ?? "");
  const res = await finishV2Job(job, "failed", message, deps, {
    endReason: "stalled",
    onlyIf: (live) =>
      sameRun(live) && liveness.get(job.id)?.lastProgressAt === verdict.lastProgressAt && liveness.judgeStall(job.id, clock()).stalled,
  });
  await endChild(res);
}

/**
 * How a job's tokens split when its cost is unknown or partial (so the budget cannot price them from the session's own
 * cost and the real per-kind split is not kept on the job). A tool-using agent session is dominated by cache reads
 * (the same context re-sent every step), which are billed at a tenth of the input rate: pricing a bare total 90/10
 * input/output (the budget's default for a size-only estimate) would charge several times what such a job costs.
 * The mix is an approximation, deliberately on the high side for output. Fractions sum to 1.
 */
const BUDGET_PARTIAL_MIX = Object.freeze({ cacheRead: 0.9, cacheWrite: 0.05, output: 0.03, input: 0.02 });

function estimateTokenKinds(total) {
  const t = Math.max(0, Math.round(total));
  const cacheRead = Math.round(t * BUDGET_PARTIAL_MIX.cacheRead);
  const cacheWrite = Math.round(t * BUDGET_PARTIAL_MIX.cacheWrite);
  const output = Math.round(t * BUDGET_PARTIAL_MIX.output);
  return { input: Math.max(0, t - cacheRead - cacheWrite - output), output, cacheRead, cacheWrite };
}

const budgetBooking = new Map(); // jobId → the booking in flight (bookings of one job run one after another)

/**
 * Book a job's spend against the shared background budget (spec 2026-11-17 §5.4, §17.14), INCREMENTALLY: the delta of
 * `jobProgress.usage` past the persisted cursor `budgetRecorded {tokens, usd}`. Only jobs started as budgeted work
 * (`budgetWorkType`, the overnight dispatches) are booked; any other job returns before the jobs lock is touched.
 * The delta is computed under the jobs lock, RECORDED outside it (record never throws), and the cursor is advanced
 * only AFTER the record — a crash in between re-books one delta on the next sweep rather than losing it. Bookings of
 * one job are serialised so a sweep and the terminal transition never read the same cursor.
 *   - Cost known and complete: the session's own cost is the money (`usd`, never negative); the tokens then only count
 *     against the plan windows, and the usd cursor moves to the new total.
 *   - Cost unknown or partial: no usd is booked and the usd cursor stays put; the tokens are priced by the budget from
 *     an estimated per-kind split (`BUDGET_PARTIAL_MIX`, cache-read weighted).
 * `inLedger: true`: the job's session persists, so the model ledger counts it. Never throws.
 */
function recordBudgetSpend(job, deps) {
  if (!job?.budgetWorkType || typeof deps.recordBackgroundUsage !== "function") return Promise.resolve();
  const prev = budgetBooking.get(job.id) ?? Promise.resolve();
  const run = prev.then(() => bookBudgetSpend(job.id, deps));
  const tail = run.finally(() => {
    if (budgetBooking.get(job.id) === tail) budgetBooking.delete(job.id);
  });
  budgetBooking.set(job.id, tail);
  return run;
}

async function bookBudgetSpend(jobId, deps) {
  const { load = loadJobs, save = saveJobs } = deps;
  try {
    const claim = await jobsLock.runExclusive(async () => {
      const jobs = (await load()) ?? [];
      const job = jobs.find((j) => j.id === jobId);
      if (!job || !job.budgetWorkType) return null;
      const usage = job.jobProgress?.usage ?? {};
      const cursor = job.budgetRecorded ?? {};
      const cursorTokens = Math.max(0, Number(cursor.tokens) || 0);
      const cursorUsd = Math.max(0, Number(cursor.usd) || 0);
      const tokens = Math.max(0, Math.round(Number(usage.tokens) || 0));
      const cost = typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : null;
      const complete = cost !== null && !usage.costPartial;
      const dTokens = tokens - cursorTokens;
      const dUsd = complete ? Math.max(0, cost - cursorUsd) : 0;
      if (dTokens <= 0 && !(dUsd > 0)) return null;
      return {
        next: { tokens: Math.max(tokens, cursorTokens), usd: complete ? Math.max(cost, cursorUsd) : cursorUsd },
        booking: {
          workType: job.budgetWorkType,
          model: job.launch?.model ?? job.requestedModel ?? job.model ?? null,
          usage: complete ? Math.max(0, dTokens) : estimateTokenKinds(dTokens),
          ...(complete ? { usd: dUsd } : {}),
          inLedger: true,
        },
      };
    });
    if (!claim) return;
    await deps.recordBackgroundUsage(claim.booking);
    await jobsLock.runExclusive(async () => {
      const jobs = (await load()) ?? [];
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx === -1) return;
      const cur = jobs[idx].budgetRecorded ?? {};
      jobs[idx] = {
        ...jobs[idx],
        budgetRecorded: { tokens: Math.max(claim.next.tokens, Number(cur.tokens) || 0), usd: Math.max(claim.next.usd, Number(cur.usd) || 0) },
      };
      await save(jobs);
    });
  } catch (e) {
    console.warn(`[delegate] booking ${jobId} against the background budget failed:`, e?.message ?? e);
  }
}

/** Fold usage / the last-progress time / the file count into a running job's record (once a sweep, at most one write). */
async function refreshJobProgress(job, deps) {
  const clock = deps.now ?? (() => Date.now());
  let files;
  if (job.worktree && job.baseSha && typeof deps.gitRun === "function") {
    const n = await withBudget(() => countFilesChanged(job, deps), FILES_REFRESH_BUDGET_MS);
    files = n === undefined ? null : n; // (a read that failed or ran out of budget is "unknown", never 0)
  }
  await mutateJobProgress(job.id, deps, (cur) => {
    let jp = cur.jobProgress;
    const delta = deps.liveness?.takeUsageDelta(cur.id);
    if (delta) jp = { ...jp, usage: mergeUsage(jp.usage, delta) };
    if (files !== undefined && (jp.files?.changed ?? undefined) !== files) jp = { ...jp, files: { changed: files, at: clock() } };
    const last = deps.liveness?.snapshot(cur.id)?.lastProgressAt ?? null;
    const lastChanged = last != null && last !== cur.lastProgressAt;
    if (jp === cur.jobProgress && !lastChanged) return null;
    return { jobProgress: jp, ...(lastChanged ? { lastProgressAt: last } : {}) };
  });
  await recordBudgetSpend(job, deps); // outside the jobs lock (§17.14)
}

async function sweepLiveness(skipIds, deps) {
  const { load = loadJobs } = deps;
  const { liveness } = deps;
  let jobs = (await load()) ?? [];
  liveness?.syncRoots(jobs);
  deps.jobViews?.prune(jobs.map((j) => j.id));
  const manta = (j) => j.status === "running" && !skipIds.has(j.id) && !!j.childSessionID && completionOwnerOf(j) === "manta";
  // a legacy running record gets the new fields at first touch
  for (const j of jobs.filter(manta)) if (lacksLivenessDefaults(j)) await mutateJobProgress(j.id, deps, () => null);

  if (liveness) {
    const eligible = (j) => j.launchState === "running" && !deps.deferSettlement?.(j.childSessionID);
    const todo = jobs.filter((j) => manta(j) && eligible(j) && liveness.get(j.id)?.reconstructedAt == null);
    await pool(todo, SWEEP_IO_CONCURRENCY, (j) => reconstructLiveness(j, deps));
    await retryRejections(deps);
  }

  // The store may have moved while those reads ran: judge from the current records (each end re-checks under the lock).
  jobs = (await load()) ?? [];
  for (const j of jobs.filter(manta)) {
    // An uncertain launch is never ended on a clock: nothing proves the run did not start. A job with a handoff
    // pending is not judged under it either: the limit is re-evaluated once the handoff commits or fails.
    if (j.startedAt == null || j.launchState === "uncertain" || deps.deferSettlement?.(j.childSessionID)) continue;
    try {
      await judgeLiveness(j, deps);
    } catch (e) {
      console.warn(`[delegate] judging ${j.id} failed:`, e?.message ?? e);
    }
  }

  jobs = (await load()) ?? [];
  await pool(jobs.filter((j) => manta(j) && j.launchState === "running"), SWEEP_IO_CONCURRENCY, (j) => refreshJobProgress(j, deps));
  // time moves the view even when nothing happened (a model label ages out, the quiet quantum): re-publish what changed
  for (const j of jobs) if (j.status === "running") deps.jobViews?.notify(j.id);
}

/**
 * `delegate_extend`: give a running Manta-owned job more time (spec A7). Under the jobs lock, so an accepted extension and a
 * time-limit end can't both happen. Every refusal is `{ok:false, status, error}`; the error is text for the model.
 * @param {string} id
 * @param {{ minutes: number, reason: string, sessionID: string }} input `sessionID` is the caller's own session
 */
export async function extendJob(id, input, deps = {}) {
  const { load = loadJobs, save = saveJobs, now = () => Date.now() } = deps;
  const minutes = input?.minutes;
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  return jobsLock.runExclusive(async () => {
    const jobs = (await load()) ?? [];
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, status: 404, error: "that background job no longer exists" };
    const job = jobs[idx];
    if (job.origin === "observed" || completionOwnerOf(job) !== "manta") {
      return { ok: false, status: 409, error: "only jobs started with delegate can be extended" };
    }
    if (job.status !== "running") return { ok: false, status: 409, error: `that job is not running (${job.status})` };
    const sessionID = input?.sessionID;
    const chain = typeof deps.replacementChain === "function" ? deps.replacementChain(job.parentSessionID) : null;
    const mine = typeof sessionID === "string" && !!sessionID && (sessionID === job.parentSessionID || (Array.isArray(chain) && chain.includes(sessionID)));
    if (!mine) return { ok: false, status: 403, error: "that job belongs to another session" };
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) {
      return { ok: false, status: 400, error: "minutes must be a whole number between 15 and 480" };
    }
    if (!reason || reason.length > 200) return { ok: false, status: 400, error: "reason is required (1 to 200 characters)" };
    const base = withLivenessDefaults(job);
    const ceilingMs = base.ceilingMs + minutes * 60_000;
    if (ceilingMs > EXTEND_MAX_CEILING_MS) {
      return { ok: false, status: 409, error: "that would let the job run past 12 hours, which is the most it can have" };
    }
    const next = { ...base, ceilingMs, extensions: [...base.extensions, { at: now(), minutes, reason }].slice(-20) };
    jobs[idx] = next;
    await save(jobs);
    emitUpdate(deps, next, {});
    return { ok: true, job: { id: next.id, name: next.name, ceilingMs: next.ceilingMs, startedAt: next.startedAt } };
  });
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
  // Liveness (spec 2026-11-14): the in-memory picture the activity tap feeds, the wire `view` of each job, the evidence log.
  const liveness = baseDeps.liveness ?? createJobLiveness({ now: nowFn });
  const jobViews =
    baseDeps.jobViews ??
    createJobViews({
      now: nowFn,
      epoch: baseDeps.epoch,
      liveness,
      publish: (evt) => baseDeps.publish?.(evt),
      load: async () => (await (baseDeps.load ?? loadJobs)()) ?? [],
      setTimer,
      clearTimer,
    });
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
  const deps = { ...baseDeps, liveness, jobViews, livenessLog: baseDeps.livenessLog ?? null, lifecycleGet: (sid) => lifecycle.get(sid), onSubagentClaim: noteClaim };
  // Every running job is known to the index before the first event can arrive for it.
  Promise.resolve()
    .then(async () => liveness.syncRoots((await (deps.load ?? loadJobs)()) ?? []))
    .catch(() => {});
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
    // (refused BEFORE the approval card: a job that can't start must not ask the user to approve it)
    const durationError = validateMaxDurationMinutes(input?.maxDurationMinutes);
    if (durationError) return { ok: false, error: durationError };
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
    /** The user's word to a task (an answer, or the news that its question was dismissed), by the task's root id: steered, continued or continue-pending. */
    deliverToTask: (rootJobId, text, opts) => deliverToTask(rootJobId, text, opts, deps),
    rootJobOf,
    /** A milestone on the task's newest round (`rootJobId`). */
    addJobMilestone: (rootJobId, text) => addJobMilestone(rootJobId, text, deps),
    /** The question store's engine is created AFTER this one (it needs this engine's functions): hand it over here. */
    setTaskQuestions: (taskQuestions) => {
      deps.taskQuestions = taskQuestions;
    },
    reconcileTaskQuestions: () => reconcileTaskQuestions(deps),
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
      await reconcileTaskQuestions(deps);
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
    /** Who completes the running job whose OWN session is `sessionId`: "manta", "opencode", or null (not a running job). */
    runningJobOwner: (sessionId) => runningJobOwner(sessionId, deps),
    /** Is `sessionId` the own session of a job that is still running (whoever completes it)? */
    /** The status of the manta-completed job record on `sessionId` (any status), or null. */
    jobStatusOf: (sessionId) => jobStatusOf(sessionId, deps),
    isRunningJobSession: async (sessionId) => (await runningJobOwner(sessionId, deps)) !== null,
    getJob: (id) => getJob(id, deps),
    // ---- liveness + progress (spec 2026-11-14) ----
    /** The activity tap's subscriber: `streamInterp.onActivity(engine.observeActivity)`. Synchronous; persistence is queued. */
    observeActivity: (rec) => {
      const eff = liveness.observe(rec);
      if (!eff) return;
      if (eff.todos) {
        void serialize(`progress:${eff.jobId}`, () =>
          mutateJobProgress(eff.jobId, deps, (job) => {
            const jp = applyChecklist(job.jobProgress, eff.todos, nowFn());
            return jp === job.jobProgress ? null : { jobProgress: jp };
          }),
        );
      } else if (eff.notify) jobViews.notify(eff.jobId);
    },
    /** A model's `progress_report` from a job's own session onto the job record (every accepted report is stored). */
    reportJobProgress: async ({ sessionID, input, record }) => {
      const jobId = liveness.jobIdOf(sessionID);
      if (!jobId || liveness.get(jobId)?.root !== sessionID) return { applied: false };
      const at = nowFn();
      const job = await serialize(`progress:${jobId}`, () =>
        mutateJobProgress(jobId, deps, (cur) => ({ jobProgress: applyModelReport(cur.jobProgress, { input, record, now: at }) })),
      );
      return { applied: !!job };
    },
    /** A question form raised in a Manta-owned job's session: captured as the decision for a specialist's own task, rejected otherwise. */
    handleQuestion: (form) => handleQuestion(form, deps),
    /** A running, Manta-owned `delegate` job's own session or one below it: no question or permission can wait there (A5). */
    ownsSession: (sessionId) => liveness.ownsSession(sessionId),
    /** The pump's backstop: answer a question / permission ask in an owned session with a rejection (queued for a retry on failure). */
    rejectAsk: (ask) => rejectAsk(ask, deps),
    queueRejection: (ask) => liveness.queueRejection(ask),
    extendJob: (id, input) => extendJob(id, input, deps),
    /** The opencode stream reconnected: events may have been missed, so every job's live picture is rebuilt from reads. */
    onStreamReconnect: async () => {
      liveness.resetAll((await (deps.load ?? loadJobs)()) ?? []);
    },
    recordDeployed: (info) => deps.livenessLog?.recordDeployed(info),
    liveness,
    jobViews,
    /** The raw job records (no progress reads) — the cheap read behind the read-only-job guard. */
    loadRecords: async () => (await (deps.load ?? loadJobs)()) ?? [],
    /** The raw job records, throwing when the store can't be read (a missing file is `[]`) — the lead's checks use it. */
    loadRecordsStrict: async () => (await admitLoader(deps)()) ?? [],
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
