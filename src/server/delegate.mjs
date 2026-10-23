// delegate.mjs — background job engine for the MantaUI server (BET-378).
//
// The core of "background delegation": a durable record of jobs plus the
// machinery to start one (worktree → session → window → prompt), detect when
// it finishes, assemble its result, and hand that result back to the parent
// session WITHOUT interrupting the user.
//
// Modelled on src/server/capabilities.mjs (dependency-injected pure-logic +
// injected I/O, an in-flight-guarded sweeper/poller with timer.unref()), but a
// SEPARATE module and a SEPARATE store (~/.manta/delegate-jobs.json). Do NOT
// extend capabilities.mjs: its records are plugin-capability shaped and
// background jobs complete from a different signal (the opencode event stream,
// not an executor POST).
//
// Completion is detected from the opencode event firehose via observeEvent,
// which the pump in src/server/index.mjs calls alongside the existing
// observers (promptDelivery, webhookEngine). A job completes on the first
// idle transition for its childSessionID that occurs AFTER at least one busy
// has been observed (per-job in-memory sawBusy flag) — that ordering is what
// stops a stray pre-prompt idle from completing the job instantly.
//
// The result is assembled in finishJob (final assistant text + filesChanged
// count) and delivered to the parent session through the shared
// prompt-delivery engine (src/server/promptDelivery.mjs), which defers it
// until the parent is idle so a completion notice never aborts the parent's
// in-flight turn.

import { randomBytes, randomUUID } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Constants (mirrors capabilities.mjs exactly — reuse, do not diverge)
// ---------------------------------------------------------------------------

const STORE_PATH = statePath("delegate-jobs.json");

// Single-writer serialization for the jobs store (BET-770 P2-1/2-2/2-3). Every
// read-modify-write mutation of the jobs array runs inside `jobsLock`, shared by
// ALL writers: startJob (+ the MAX_RUNNING_JOBS check), adoptSubagentJob,
// finishJob, stopJob, deleteJob, the activity poller, and the sweeper. Without
// this, a stale activity-poller write could resurrect a terminal job to
// `running`, a just-completed job could be flipped to "timed out", and two
// near-simultaneous `delegate` POSTs could both pass the cap check. Each
// mutation re-reads the store inside the lock, so a writer that lost a race
// observes the winner's state instead of overwriting it.
const jobsLock = createMutex();

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

export async function listJobs({ sessionID } = {}, { load = loadJobs, readProgress = defaultReadProgress } = {}) {
  const jobs = await load();
  const scoped = sessionID === undefined ? jobs : jobs.filter((j) => j.parentSessionID === sessionID);
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
// startJob — performs the steps in the exact order the spec dictates. If any
// step throws, undo the steps already done, in reverse, and return
// {ok:false, error} — never leave a half-created job.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// registerJob — the shared "window + record + publish" half of startJob
// (formerly steps 6 and 7). Registers an existing-or-new opencode session into
// a chat-mode tmux window and persists the record. `existingSessionId` adopts
// an already-running session (the backgrounded-subagent path); undefined
// creates a fresh one (the delegate path). The ONLY place that builds a job
// record or calls newWindow. On a window-creation throw it undoes the worktree
// (best-effort) and returns {ok:false, error}.
// ---------------------------------------------------------------------------

async function registerJob(
  {
    parentSessionID,
    parentDirectory,
    name,
    prompt,
    model,
    requestedModel,
    cwd,
    worktree,
    branch,
    baseSha,
    existingSessionId,
    origin,
    permission,
    link,
    actor,
    sweepAllowanceMs,
    // §8.1 explicit-contract path (spec: "Accept a preallocated operation/job
    // identity and persist its reservation before creating any worktree,
    // window or opencode session"): the execution target is the CALLER-
    // VALIDATED project reference, never re-derived from the parent's tmux
    // window — a headless completion parent (the on-call CTO conversation)
    // has no holder to resolve. `correlation` is the preallocated operation
    // identity persisted on the record so a crash after creation can adopt
    // the matching worker instead of creating another blindly.
    targetTmuxSession,
    correlation,
    // V2 job fields (engine, completionOwner, launchState, …) merged onto the
    // record. Absent for the legacy delegate path.
    extra,
  },
  deps = {},
) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    newWindow,
    stampOwner,
    listProjects,
    gitRemoveWorktree,
    oc,
    now = () => Date.now(),
  } = deps;

  let childSessionID = null;
  let tmuxSession = null;
  let windowIndex = null;
  try {
    if (targetTmuxSession) {
      // §8.1: target workspace resolution uses the explicit project reference,
      // not parent lookup. The caller already failed it closed against live
      // tmux; newWindow below still fails loudly if the target vanished.
      tmuxSession = targetTmuxSession;
    } else {
      const owner = resolveOwner(await listProjects(), parentSessionID);
      if (!owner) {
        throw new Error(`could not resolve the tmux session owning ${parentSessionID}`);
      }
      tmuxSession = owner.tmuxSession;
    }
    const created = await newWindow({
      sessionName: tmuxSession,
      windowName: name,
      cwd,
      chatMode: true,
      existingSessionId,
      worktreePath: worktree,
      oc,
      permission,
    });
    childSessionID = created.sessionId ?? existingSessionId ?? null;
    windowIndex = created.windowIndex ?? null;
    if (!childSessionID) {
      throw new Error("could not read the new window's opencode session id");
    }
  } catch (e) {
    // Undo the worktree in reverse (best-effort) — mirrors the old startJob
    // rollback on a window-creation throw.
    if (worktree && gitRemoveWorktree) {
      try {
        await gitRemoveWorktree({ path: worktree, force: false });
      } catch {
        /* best-effort cleanup; the start failure is the headline error */
      }
    }
    return { ok: false, error: String(e?.message ?? e) };
  }

  // BET-1377: stamp the window's owner as "job" now that it exists, so the
  // CTO digest (and any other consumer of listProjects) can tell a delegate
  // job's window apart from a user's window. Mirror of the @manta-session-id
  // stamp — a separate option (@manta-owner) so the two never collide. This
  // is advisory metadata: a stamp failure must not fail the job start (absent
  // option ⇒ "user"), so it is best-effort and never rolled back.
  if (stampOwner) {
    try {
      await stampOwner(tmuxSession, windowIndex, "job");
    } catch {
      /* best-effort; the window already exists and the job record below is
         the source of truth for the job's own lifecycle */
    }
  }

  // Persist the record with status "running", startedAt = now.
  const id = genId();
  const job = {
    id,
    name,
    prompt,
    model: model ?? null,
    // What was ASKED for (canonical "providerID/modelID" string or null).
    // Never overwritten — distinct from `job.model`, which tickActivity stamps
    // with the model OBSERVED in the child's own transcript (BET-947).
    requestedModel: requestedModel ?? null,
    parentSessionID,
    parentDirectory,
    childSessionID,
    tmuxSession,
    windowIndex,
    worktree,
    branch,
    baseSha,
    origin,
    // Session-link primitive (§3.4⑥, BET-847/844): the at-most-one issue + one
    // pull request this job's session is about. Stored on the job's own session
    // record in the shared `{ issue?, pr? }` shape so the forge progress sink
    // (and future notification/inbox readers) address the linked issue or PR —
    // the triggering issue — with no per-feature plumbing. A forge-triggered
    // delegate sets this at dispatch; a user delegate leaves it null.
    link: link ?? null,
    // Who started the job ("user" default; "cto" for the adaptive-CTO engine).
    // Persisted so the CTO engine can reason about its own jobs across restarts.
    actor: actor ?? "user",
    // §8.1 operation-correlation identity ({kind:"work", workId, receiptId, op})
    // persisted so a crashed dispatch can ADOPT the matching worker instead of
    // creating another blindly ("never create another blindly"). Ordinary
    // user/CTO jobs carry null.
    correlation: correlation ?? null,
    // Running-sweep allowance (ms) this job gets; absent ⇒ the 30-min default.
    // The CTO engine passes overnightWindowRemainingMs for its overnight sweep.
    // Persisted so a resumed or restarted job keeps the same allowance.
    sweepAllowanceMs: sweepAllowanceMs ?? null,
    // The permission ruleset the job's session was created with, persisted so a
    // RESUME (a fresh session in the same worktree) is re-scoped and never
    // silently falls back to an unscoped session that could prompt the user.
    permission: permission ?? null,
    status: "running",
    activity: null,
    createdAt: now(),
    startedAt: now(),
    finishedAt: null,
    result: null,
    error: null,
    filesChanged: null,
    ...(extra ?? {}),
  };
  {
    const jobs = await load();
    jobs.push(job);
    await save(jobs);
  }
  publish?.({ kind: "delegate.updated", payload: { id, status: "running" } });

  return { ok: true, job };
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
 * @param {object} deps injected I/O (load/save/publish/deliver/listProjects/
  *        newWindow/gitAddWorktree/gitRun/oc listMessages/listModels/now;
  *        routingServices/catalogIndex/providerHealthState/endpointSummary/pacing
  *        for the router; chooseSubagentModel only as a test seam)
 */
export async function startJob(input, deps = {}) {
  const { deliver, listModels, configGet = async () => ({}), listSnapshots = () => [] } = deps;
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

  // The whole creation — nesting + cap checks, worktree, window, record append —
  // runs inside the jobs-store lock so a concurrent `delegate` POST cannot pass
  // the (read-then-act) MAX_RUNNING_JOBS check at the same moment as another
  // and start >5 running jobs, and so the record append cannot interleave with
  // another writer's read-modify-write. The prompt is delivered AFTER the lock
  // releases.
  const reg = await jobsLock.runExclusive(async () => {
    const { load = loadJobs, gitAddWorktree, gitRun } = deps;

    // 1. Refuse if nesting.
    {
      const jobs = await load();
      const nesting = jobs.find(
        (j) => j.childSessionID === parentSessionID && j.status === "running",
      );
      if (nesting) {
        return { ok: false, error: "a background job cannot start another background job" };
      }
    }

    // 2. Refuse if at cap. Checked here, inside the lock and BEFORE any
    //    worktree/window is created, so a burst of concurrent POSTs cannot
    //    exceed MAX_RUNNING_JOBS without leaking created worktrees.
    {
      const jobs = await load();
      const running = jobs.filter((j) => j.status === "running").length;
      if (running >= MAX_RUNNING_JOBS) {
        return { ok: false, error: CAP_ERROR };
      }
    }

    // 3. Derive the name — an explicit `name` (e.g. the work item's objective,
    // so CTO workers aren't all "you-are-the-implementation") wins over the
    // first words of the prompt.
    const name = (typeof input?.name === "string" && slugifyProjectName(input.name.trim().split(/\s+/).slice(0, 6).join(" "))) ||
      deriveName(prompt);

    // 4. Create the worktree. On throw, catch and continue with
    //    worktree = branch = baseSha = null and cwd = parentDirectory —
    //    UNLESS the caller demands isolation (§8.1: for implementation work,
    //    isolationRequired is true and a worktree failure must fail BEFORE
    //    prompting, never fall back to the original repository directory).
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
          ok: false,
          code: "worktree_failed",
          error:
            `worktree creation failed, refusing to fall back to the original repository directory ` +
            `(isolationRequired): ${e?.message ?? e}`,
        };
      }
      worktree = null;
      branch = null;
      baseSha = null;
      cwd = parentDirectory;
    }

    // 5. Record baseSha — git -C <worktree> rev-parse HEAD, trimmed. Skip when
    //    there is no worktree.
    if (worktree) {
      try {
        const { stdout } = await gitRun(["-C", worktree, "rev-parse", "HEAD"]);
        baseSha = String(stdout ?? "").trim() || null;
      } catch {
        baseSha = null;
      }
    }

    // 6+7. Register the window + record + publish.
    return registerJob(
      {
        parentSessionID,
        parentDirectory,
        name,
        prompt,
        model: requestedModel,
        requestedModel,
        cwd,
        worktree,
        branch,
        baseSha,
        existingSessionId: undefined,
        origin: "delegate",
        permission: input?.permission,
        link: input?.link,
        actor: input?.actor,
        sweepAllowanceMs: input?.sweepAllowanceMs,
        // §8.1 explicit-contract path (absent on ordinary callers — their
        // behavior is byte-identical): the execution target comes from the
        // caller's validated project reference, and `correlation` is the
        // preallocated operation identity persisted on the job record.
        targetTmuxSession: input?.targetProject ?? null,
        correlation: input?.correlation ?? null,
      },
      deps,
    );
  });

  if (!reg.ok) return reg;

  // 8. Send the opening prompt via the shared delivery module's deliver. The
  //    effective model was decided above, before the lock: a caller-named
  //    model is used VERBATIM (11b), and silence was routed with the same
  //    never-break-a-spawn degradation contract (11a/11e, BET-1535).
  const effectiveModel = input?.model ? deliverModel : routedModel;
  try {
    await deliver({
      sessionId: reg.job.childSessionID,
      text: buildJobPrompt({ prompt, worktree: reg.job.worktree, branch: reg.job.branch }),
      ...(effectiveModel ? { model: effectiveModel } : {}),
    });
  } catch (e) {
    // deliver never rejects in production, but guard anyway — the job is
    // already persisted + running; a delivery failure surfaces as a normal
    // completion (the child will idle immediately).
    console.warn("[delegate] opening prompt delivery failed:", e?.message ?? e);
  }

  return { ok: true, job: reg.job };
}

// ---------------------------------------------------------------------------
// adoptSubagentJob — promote an opencode background subagent into a delegate
// job record (BET-721). opencode has ALREADY started the child session (the
// parent's `task` tool ran with background:true), so this entry point adopts
// that session into the store + a window rather than creating anything. The
// detecting event fires repeatedly as the tool part updates, so adoption must
// be idempotent.
// ---------------------------------------------------------------------------

/**
 * @param {{parentSessionID:string, parentDirectory:string, childSessionID:string,
 *          name:string, prompt:string, model?:object}} input
 * @param {object} deps injected I/O (load/save/publish/newWindow/listProjects)
 * @returns {Promise<{ok:true, job:object}|{ok:true, alreadyAdopted:true}|{ok:false, error:string}>}
 */
export async function adoptSubagentJob(
  { parentSessionID, parentDirectory, childSessionID, name, prompt, model, origin = "subagent" },
  deps = {},
) {
  const { load = loadJobs } = deps;

  if (!parentSessionID || !parentDirectory || !childSessionID) {
    return { ok: false, error: "parentSessionID, parentDirectory and childSessionID are required" };
  }

  // Under the jobs-store lock: the idempotency read + the record append happen
  // as one atomic unit, so a repeated adoption event cannot interleave with
  // another writer.
  const adopted = await jobsLock.runExclusive(async () => {
    // Idempotent — the detecting event fires repeatedly as the tool part updates.
    {
      const jobs = await load();
      const exists = jobs.find((j) => j.childSessionID === childSessionID);
      if (exists) {
        return { ok: true, alreadyAdopted: true };
      }
    }

    // We deliberately do NOT enforce MAX_RUNNING_JOBS and do NOT enforce the
    // no-nesting rule: opencode has already started this subagent, so refusing
    // to record it would only make it invisible — the exact bug this fixes.
    // We also do NOT create a worktree (the session is adopted, not created)
    // and do NOT call deliver() — opencode already sent the child its prompt.
    return registerJob(
      {
        parentSessionID,
        parentDirectory,
        name,
        prompt,
        model,
        requestedModel: null,
        cwd: parentDirectory,
        worktree: null,
        branch: null,
        baseSha: null,
        existingSessionId: childSessionID,
        origin,
        // opencode started this child and reports its result to the parent
        // itself: Manta only tracks the row and never posts a result for it.
        extra: {
          engine: "v2",
          completionOwner: "opencode",
          attempt: 1,
          launchState: "running",
          submittedAt: null,
          completionMessageId: null,
          completionDelivery: null,
        },
      },
      deps,
    );
  });

  // No lost lifecycle: a child that finished before it was adopted is recorded
  // as finished at once, from the raw outcome the pump remembered for it.
  if (adopted.ok && adopted.job && typeof deps.lifecycleGet === "function") {
    const seen = deps.lifecycleGet(childSessionID);
    const t = seen ? outcomeToTerminal(seen.outcome, { error: seen.error }) : null;
    if (t) await finishV2Job(adopted.job, t.status, t.error, deps);
  }
  return adopted;
}

// ---------------------------------------------------------------------------
// Completion detection — observeEvent, called by the opencode pump.
//
// A job completes on the first idle transition for its childSessionID that
// occurs AFTER at least one busy has been observed for that session. Track a
// per-job in-memory sawBusy flag (passed in so each engine instance owns its
// own map).
// ---------------------------------------------------------------------------

/**
 * @param {object} evt an opencode event
 * @param {object} deps { load, save, publish, deliver, listMessages, gitRun, now }
 * @param {Map<string,boolean>} sawBusy per-childSessionID busy flag (engine-owned)
 */
// The only event types observeEvent acts on. Everything else (notably the
// per-token `message.part.delta` stream) is a no-op, so it must return BEFORE
// loading the job store — that load is a synchronous read + parse of
// delegate-jobs.json, and doing it per streamed token ran it ~40×/s.
const OBSERVED_EVENT_TYPES = new Set([
  "message.part.updated",
  "session.error",
  "session.idle",
  "session.status",
]);

export async function observeEvent(evt, deps = {}, sawBusy = new Map()) {
  const sid = evt?.properties?.sessionID;
  if (typeof sid !== "string" || !sid) return;
  if (!OBSERVED_EVENT_TYPES.has(evt?.type)) return;
  const { load = loadJobs } = deps;
  const jobs = await load();

  // BET-721: passively adopt a background subagent into the job store so it
  // appears as a nested sidebar row. Detection is passive (events never carry
  // `background:true` unless the capability is on) and must never throw into
  // the pump.
  if (evt.type === "message.part.updated") {
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
        const projects = deps.listProjects ? await deps.listProjects() : [];
        const owner = resolveOwner(projects, evt?.properties?.sessionID);
        if (!owner) {
          const shape = (Array.isArray(projects) ? projects : []).map((p) => ({
            tmuxSession: p?.tmuxSession,
            windows: (p?.windows || []).map((w) => `${w?.index}:${w?.opencodeSessionId}`),
          }));
          console.warn(
            "[delegate] could not resolve the owning window to adopt background subagent:",
            evt?.properties?.sessionID,
            "projects=", shape,
          );
          return;
        }
        await adoptSubagentJob(
          {
            parentSessionID: evt?.properties?.sessionID,
            parentDirectory: owner.cwd,
            childSessionID: info.childSessionId,
            name: info.description || info.agent,
            prompt: info.prompt,
            model: info.model ? `${info.model.providerID}/${info.model.modelID}` : null,
          },
          deps,
        );
        return;
      }
    } catch (e) {
      console.warn("[delegate] background-subagent adoption failed:", e?.message ?? e);
    }
  }

  // engine:"v2" jobs complete from the RAW execution outcomes (observeRaw), not
  // from this adapted lifecycle — which reads an interrupt as success.
  const job = jobs.find((j) => j.childSessionID === sid && j.status === "running" && j.engine !== "v2");
  if (!job) {
    // Not a tracked background job — but still keep the sawBusy flag honest so
    // a job that starts later in this same session id isn't instantly
    // completed by a stale idle. (Session ids are unique per opencode
    // session, so this is defensive only.)
    return;
  }

  // Pause (spec §11.6-1): pauseJob set `pauseRequested`; the actual transition
  // to `paused` happens HERE at the next completed-tool-part boundary — the
  // current tool has finished, so drain-aborting the session loses no
  // half-written tool work. The window + worktree + branch are KEPT so
  // resumeJob can spin up a fresh session in the same worktree later.
  if (job.pauseRequested) {
    const boundary =
      evt.type === "message.part.updated" && isToolStepBoundary(evt?.properties?.part);
    if (boundary) {
      await pauseAtBoundary(job, deps);
      // After the drain-abort the aborting opencode session emits a
      // MessageAbortedError (ignored) then an idle; by then this job is
      // `paused`, so those events find no `running` job and are no-ops. Deliberately
      // do NOT fall through to the completion handlers below.
      return;
    }
  }

  if (evt.type === "session.error") {
    const errName = evt?.properties?.error?.name;
    if (errName === "MessageAbortedError") return; // intentional abort — ignore
    await finishJob(job, "failed", String(evt?.properties?.error?.message ?? "error"), deps, sawBusy);
    return;
  }

  if (evt.type === "session.idle") {
    if (sawBusy.get(sid)) {
      await finishJob(job, "done", null, deps, sawBusy);
    }
    return;
  }

  if (evt.type === "session.status") {
    const t = evt?.properties?.status?.type;
    if (t === "busy" || t === "retry") {
      sawBusy.set(sid, true);
    } else if (t === "idle") {
      if (sawBusy.get(sid)) {
        await finishJob(job, "done", null, deps, sawBusy);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// finishJob — assemble the result, persist, and deliver the completion
// message to the parent session through the shared delivery engine (which
// defers until the parent is idle). If the parent session no longer exists,
// deliver fails; swallow it, log, and still mark the job terminal.
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
  const { killWindow, gitRemoveWorktree } = deps;
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
  if (killWindow && job?.tmuxSession != null && job?.windowIndex != null) {
    try {
      await killWindow({ sessionName: job.tmuxSession, windowIndex: job.windowIndex });
    } catch (e) {
      console.warn(`[delegate] cleanup killWindow failed for ${job?.id}:`, e?.message ?? e);
    }
  }
  return { cleanedUp: true };
}

export async function finishJob(job, status, error, deps = {}, sawBusy) {
  if (job?.engine === "v2") return finishV2Job(job, status, error, deps);
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    deliver,
    listMessages,
    clearProgress = defaultClearProgress,
    now = () => Date.now(),
  } = deps;

  return jobsLock.runExclusive(async () => {
    // Re-read the job under the lock: the `job` passed in may be a stale
    // snapshot (e.g. a sweeper candidate read before another writer completed,
    // stopped or pruned it). If the live record is already terminal — or was
    // pruned — do nothing. This is what stops a completing job being flipped
    // to "timed out" (and a false timeout being notified) or a truly timed-out
    // job being resurrected to "done" by a stale writer.
    {
      const jobs = await load();
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx === -1) return { ok: true, alreadyTerminal: true };
      job = jobs[idx];
    }

    // Idempotent: if the job is already terminal, do nothing.
    if (job.status === "done" || job.status === "failed" || job.status === "stopped") {
      return { ok: true, alreadyTerminal: true };
    }

    let result = "";
    let filesChanged = null;
    if (status === "done") {
      try {
        const messages = listMessages ? await listMessages(job.childSessionID) : [];
        result = await lastAssistantText(messages);
      } catch (e) {
        console.warn("[delegate] listMessages failed:", e?.message ?? e);
        result = "";
      }
      filesChanged = await countFilesChanged(job, deps);
    }

    const finishedAt = now();
    const updated = {
      ...job,
      status,
      error: status === "done" ? null : (error ?? null),
      result: status === "done" ? result : null,
      filesChanged,
      finishedAt,
    };

    // Persist.
    {
      const jobs = await load();
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx !== -1) {
        jobs[idx] = updated;
        await save(jobs);
      }
    }
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: updated.status, activity: updated.activity },
    });
    if (sawBusy) sawBusy.delete(job.childSessionID);

    // §8.1 outcome-routing seam: the engine composition may route a terminal
    // job to the work coordinator (jobs carrying correlation.kind === "work").
    // Best-effort — a routing failure must never break the job's own terminal
    // transition or its completion delivery.
    if (typeof deps.onJobTerminal === "function") {
      try {
        await deps.onJobTerminal(updated);
      } catch (e) {
        console.warn(`[delegate] onJobTerminal failed for ${updated.id}:`, e?.message ?? e);
      }
    }

    // The child session is ending — clear its progress record (progress is
    // "where are we right now"; a finished job leaves none). Reads the SAME
    // progress.json store, no second record/event. Never fails the transition.
    if (job.childSessionID) {
      try {
        await clearProgress(job.childSessionID);
      } catch (e) {
        console.warn(`[delegate] clearProgress failed for ${job.id}:`, e?.message ?? e);
      }
    }

    // Deliver the completion message to the parent session (deferred until idle
    // by the shared delivery engine). Swallow a failure — the job is terminal
    // regardless.
    //
    // BET-721: skip the deliver for adopted subagents — opencode ALREADY injects
    // the <task ...> result into the parent when the child finishes, so
    // delivering ours too would report the same job twice. A missing `origin`
    // (records written before this change) means `delegate` and still delivers.
    if (deliver && job.parentSessionID && job.origin !== "subagent") {
      try {
        await deliver({
          sessionId: job.parentSessionID,
          text: buildCompletionText(updated),
        });
      } catch (e) {
        console.warn(`[delegate] completion delivery failed for ${job.id}:`, e?.message ?? e);
      }
    }

    // BET-418 §B: remove the tmux window + worktree now that the job is
    // terminal. A dirty worktree keeps both (cleanupTerminalJob returns
    // cleanedUp:false); persist that flag so the retention sweep does NOT prune
    // the record (the window must stay recognisable as a job, not leak as an
    // ordinary session). A clean cleanup sets cleanedUp:true so retention may
    // prune the record normally once it ages out.
    let cleanedUp = false;
    try {
      const res = await cleanupTerminalJob(updated, deps);
      cleanedUp = !!res.cleanedUp;
    } catch (e) {
      console.warn(`[delegate] cleanup failed for ${job.id}:`, e?.message ?? e);
    }
    {
      const jobs = await load();
      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx !== -1) {
        jobs[idx] = { ...jobs[idx], cleanedUp };
        await save(jobs);
      }
    }
    return { ok: true };
  });
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
    publish,
    deliver,
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

    // BET-418 §B: parent session gone → stop the job immediately (there is
    // nobody left to report to), then the same terminal cleanup runs inside
    // stopJob. Best-effort: a sessionExists failure degrades to "assume
    // alive" so a transient opencode blip never orphans a healthy job.
    const orphaned = [];
    if (sessionExists) {
      for (const job of jobs) {
        if (job.status !== "running" || !job.parentSessionID) continue;
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
    // gone is the more precise reason); finishJob is idempotent on the
    // already-terminal record.
    for (const job of orphaned) {
      await stopJob(job.id, deps);
    }
    // Timed-out jobs → failed. Pass the FULL deps so finishJob's terminal
    // cleanup (killWindow + gitRemoveWorktree) actually runs. The error
    // reflects the job's own allowance, so the default path stays byte-for-byte
    // the legacy "timed out after 30 minutes".
    for (const { job, allowance } of transitioned) {
      const mins = Math.round(allowance / 60_000);
      await finishJob(job, "failed", `timed out after ${mins} minutes`, deps, new Map());
    }
    // Paused-expired jobs → stopped.
    for (const job of pausedExpired) {
      await stopExpiredPausedJob(job, {
        load, save, publish, now,
        killWindow: deps.killWindow,
        gitRemoveWorktree: deps.gitRemoveWorktree,
      });
    }
    await persistRetention({ load, save, deps }, nowMs);
  } catch (e) {
    console.warn("[delegate] sweep failed:", e?.message ?? e);
  }
}

/**
 * Terminal transition for a `paused` job that exceeded PAUSE_KEEP_MS: mark it
 * `stopped` and run the standard keep-on-dirty terminal cleanup (the dirty
 * worktree survives; the record is retained via the cleanedUp=false stamp).
 */
async function stopExpiredPausedJob(job, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, now = () => Date.now(), killWindow, gitRemoveWorktree } = deps;
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx === -1) return;
    const live = jobs[idx];
    if (live.status !== "paused") return; // a writer already resumed/stopped it
    const stopped = {
      ...live,
      status: "stopped",
      error: "paused for over 7 days, stopped",
      finishedAt: now(),
    };
    jobs[idx] = stopped;
    await save(jobs);
    publish?.({ kind: "delegate.updated", payload: { id: stopped.id, status: "stopped" } });
    let cleanedUp = false;
    try {
      const res = await cleanupTerminalJob(stopped, { killWindow, gitRemoveWorktree });
      cleanedUp = !!res.cleanedUp;
    } catch (e) {
      console.warn(`[delegate] paused-expiry cleanup failed for ${job.id}:`, e?.message ?? e);
    }
    {
      const jobs2 = await load();
      const i2 = jobs2.findIndex((j) => j.id === job.id);
      if (i2 !== -1) {
        jobs2[i2] = { ...jobs2[i2], cleanedUp };
        await save(jobs2);
      }
    }
  });
}

// Retention prune under the jobs-store lock: re-read the store fresh so the
// prune cannot clobber a write a concurrent writer persisted while this sweep
// was inspecting a stale snapshot.
async function persistRetention({ load, save, deps }, nowMs) {
  await jobsLock.runExclusive(async () => {
    const jobs = await load();
    if (jobs.length === 0) return;
    const { retained, pruned } = applyRetention(jobs, nowMs);
    if (pruned.length === 0) return;
    // A V2 row with no worktree keeps its window after it finishes, so pruning
    // its record closes that window FIRST — a window left without a record
    // would reappear as an ordinary top-level session.
    for (const j of pruned) {
      if (j.engine === "v2" && !j.worktree) await closeJobWindow(j, deps ?? {});
    }
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
  const keeps = (j) => j.cleanedUp === false || j.completionDelivery === "pending";
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
 * stopJob aborts the child session with oc.abortSession, marks the job
 * `stopped`, and sends a completion message, then cleans up the window +
 * worktree (a dirty worktree keeps both; the branch always survives).
 *
 * A PAUSED job can be stopped too (2026-09-25: nine workers frozen by an old
 * dispatch bug could not be stopped by any tool, so their cancelled cards
 * could never be archived). A paused job has no turn in flight, so there is
 * nothing to abort and no completion notice is sent — the caller already
 * knows it is ending it.
 */
export async function stopJob(id, deps = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    deliver,
    abortSession,
    listMessages,
    now = () => Date.now(),
  } = deps;
  // Under the jobs-store lock: the read-check-mutate + the cleanedUp stamp are
  // atomic, so a stop cannot race another writer into a half-state.
  const stopped = await withRunningJob(id, deps, async (jobs, idx, job) => {
    if (job.engine === "v2") {
      // V2 job: one terminal write (result-delivery fields included); the N7
      // result, when Manta owns it, is posted after the lock is released.
      if (abortSession && job.childSessionID && job.launchState !== "creating") {
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
        error: "stopped by user",
        finishedAt: now(),
        pauseRequested: false,
        completionMessageId: manta ? (job.completionMessageId ?? mintMessageId()) : (job.completionMessageId ?? null),
        completionDelivery: manta ? "pending" : null,
      };
      jobs[idx] = updated;
      await save(jobs);
      publish?.({
        kind: "delegate.updated",
        payload: { id: updated.id, status: updated.status, activity: updated.activity },
      });
      return { ok: true, deliverV2: manta };
    }
    const wasPaused = job.status === "paused";
    if (!wasPaused && abortSession && job.childSessionID) {
      try {
        await abortSession(job.childSessionID);
      } catch (e) {
        console.warn(`[delegate] abortSession failed for ${id}:`, e?.message ?? e);
      }
    }
    const finishedAt = now();
    const updated = {
      ...job,
      status: "stopped",
      error: "stopped by user",
      finishedAt,
    };
    jobs[idx] = updated;
    await save(jobs);
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: updated.status, activity: updated.activity },
    });
    // opencode reports an adopted subagent's end to the parent itself.
    if (!wasPaused && deliver && job.parentSessionID && job.origin !== "subagent") {
      try {
        await deliver({
          sessionId: job.parentSessionID,
          text: buildCompletionText(updated),
        });
      } catch (e) {
        console.warn(`[delegate] stop completion delivery failed for ${id}:`, e?.message ?? e);
      }
    }
    // BET-418 §B: a stopped job is terminal → remove the window + worktree (a
    // dirty worktree keeps both). Persist cleanedUp so retention treats it
    // correctly.
    let cleanedUp = false;
    try {
      const res = await cleanupTerminalJob(updated, deps);
      cleanedUp = !!res.cleanedUp;
    } catch (e) {
      console.warn(`[delegate] stop cleanup failed for ${id}:`, e?.message ?? e);
    }
    {
      const jobs2 = await load();
      const idx2 = jobs2.findIndex((j) => j.id === id);
      if (idx2 !== -1) {
        jobs2[idx2] = { ...jobs2[idx2], cleanedUp };
        await save(jobs2);
      }
    }
    void listMessages;
    return { ok: true };
  }, { allowPaused: true });
  if (stopped?.deliverV2) {
    await deliverJobResult(id, deps);
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
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    killWindow,
    gitRemoveWorktree,
  } = deps;
  // Under the jobs-store lock: the load → remove-record save is atomic.
  const result = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: "not found" };
    const job = jobs[idx];

    // V2 rows with no worktree (background commands / subagents): closing the
    // row of work that is still running, unresolved, or holds an unposted result
    // closes the WINDOW only — the record stays, and still reports when the work
    // ends, until retention prunes it. A finished, delivered row is closed for
    // good (window + record) as before.
    if (
      job.engine === "v2" &&
      !job.worktree &&
      (!isTerminal(job) || job.launchState === "uncertain" || job.completionDelivery === "pending")
    ) {
      await closeJobWindow(job, deps);
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
  return result;
}

// ---------------------------------------------------------------------------
// Pausing, resuming, reconciliation (spec §11.6)
//
// `paused` is a distinct, non-terminal state. A paused job keeps its window,
// worktree and branch; only its opencode child session is aborted. Paused jobs
// do NOT count against the global running cap (MAX_RUNNING_JOBS counts only
// `running`), so parking a job frees a slot while keeping its work intact.
//
// pause → at the next completed-tool-part boundary, the child session is
//   drain-aborted (see observeEvent) and the job flips to `paused`.
// resume → a FRESH opencode session is started in the SAME worktree/branch
//   (never a new worktree), re-acquiring a cap slot like a fresh start, and
//   seeded with the original prompt plus git log / git status / last progress.
// ---------------------------------------------------------------------------

/**
 * Request a pause. Only flags the job — the actual transition to `paused`
 * happens in observeEvent at the job's next completed-tool-part boundary, so
 * an in-flight tool is never interrupted mid-write. Idempotent for a running
 * job (re-sets the flag).
 */
export async function pauseJob(id, deps = {}) {
  const { load = loadJobs, save = saveJobs, publish } = deps;
  return withRunningJob(id, deps, async (jobs, idx, job) => {
    // V2 owns a background command's / subagent's lifecycle: there is nothing
    // to park, so the control is refused rather than half-working.
    if (job.engine === "v2" && (job.origin === "command" || completionOwnerOf(job) === "opencode")) {
      return { ok: false, error: "pause isn't available for this job" };
    }
    const updated = { ...job, pauseRequested: true };
    jobs[idx] = updated;
    await save(jobs);
    // Status stays "running" until pauseAtBoundary flips it to `paused`; the
    // flag is what observeEvent acts on.
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: updated.status, pauseRequested: true },
    });
    return { ok: true, job: updated };
  });
}

/**
 * The drain-abort + state flip that completes a pause request, run by
 * observeEvent at a completed-tool-part boundary. The window + worktree +
 * branch are deliberately KEPT (resumeJob reuses them).
 */
async function pauseAtBoundary(job, deps = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    abortSession,
    now = () => Date.now(),
  } = deps;
  if (abortSession && job.childSessionID) {
    try {
      await abortSession(job.childSessionID);
    } catch (e) {
      console.warn(`[delegate] pause abortSession failed for ${job.id}:`, e?.message ?? e);
    }
  }
  // Under the jobs-store lock: re-read so a concurrent writer that already
  // resumed/stopped this job is not clobbered.
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx === -1) return { ok: true };
    const live = jobs[idx];
    if (live.status !== "running" || !live.pauseRequested) return { ok: true };
    const paused = { ...live, status: "paused", pauseRequested: false, pausedAt: now() };
    jobs[idx] = paused;
    await save(jobs);
    publish?.({
      kind: "delegate.updated",
      payload: { id: paused.id, status: "paused" },
    });
    return { ok: true, job: paused };
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
  return jobs.filter((j) => j.status === "running").length;
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
 * Resume a paused job: start a FRESH opencode session in the SAME worktree +
 * branch, re-acquiring a cap slot like a fresh start, and deliver the resume
 * context. If the cap is full the job stays `paused` and the call is retriable
 * ({ok:false, error:CAP_ERROR, retriable:true}).
 */
export async function resumeJob(id, deps = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    newWindow,
    stampOwner,
    killWindow,
    listProjects,
    deliver,
    now = () => Date.now(),
  } = deps;

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
    const running = jobs.filter((j) => j.status === "running").length;
    if (running >= MAX_RUNNING_JOBS) {
      return { ok: false, error: CAP_ERROR, retriable: true };
    }

    const oldChildSessionID = job.childSessionID;
    const oldWindow = { sessionName: job.tmuxSession, windowIndex: job.windowIndex };
    let newChildSessionID = null;
    let newWindowIndex = null;
    let ownerSession = job.tmuxSession ?? null;
    try {
      // A tracked-work parent may be the windowless CTO conversation. Resume
      // into the target workspace persisted on the job instead of requiring
      // that parent to acquire a tmux holder after dispatch. The fallback is
      // only for older persisted records that predate tmuxSession.
      if (!ownerSession) {
        const owner = resolveOwner(await listProjects(), job.parentSessionID);
        if (!owner) throw new Error(`could not resolve the tmux session owning ${job.parentSessionID}`);
        ownerSession = owner.tmuxSession;
      }
      const cwd = job.worktree || job.parentDirectory;
      const created = await newWindow({
        sessionName: ownerSession,
        windowName: job.name,
        cwd: cwd || null,
        chatMode: true,
        existingSessionId: undefined,
        worktreePath: job.worktree,
        oc: deps.oc,
        permission: job.permission,
      });
      newChildSessionID = created.sessionId ?? null;
      newWindowIndex = created.windowIndex ?? null;
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    if (!newChildSessionID) {
      return { ok: false, error: "could not create a session to resume into" };
    }

    // Advisory owner stamp on the fresh window (best-effort, mirrors
    // registerJob's BET-1377 stamp).
    if (stampOwner && newWindowIndex != null) {
      try {
        await stampOwner(ownerSession, newWindowIndex, "job");
      } catch {
        /* best-effort */
      }
    }
    // Best-effort remove the OLD aborted window; the worktree is what persists.
    if (killWindow && oldWindow.sessionName != null && oldWindow.windowIndex != null) {
      try {
        await killWindow(oldWindow);
      } catch (e) {
        console.warn(`[delegate] resume killWindow failed for ${id}:`, e?.message ?? e);
      }
    }

    const updated = {
      ...job,
      status: "running",
      childSessionID: newChildSessionID,
      tmuxSession: ownerSession ?? job.tmuxSession,
      windowIndex: newWindowIndex ?? job.windowIndex,
      pauseRequested: false,
      pausedAt: null,
      // Reset the running-timeout clock: a resumed job re-acquires a cap slot
      // AND a fresh allowance window "like a fresh start" — otherwise a job
      // paused for days would trip the running-sweep on its first tick back.
      startedAt: now(),
    };
    jobs[idx] = updated;
    await save(jobs);
    publish?.({
      kind: "delegate.updated",
      payload: { id: updated.id, status: "running" },
    });
    return { ok: true, job: updated, oldChildSessionID };
  });

  if (!reg.ok) return reg;
  // Build + deliver the resume prompt to the fresh session. The progress read
  // targets the OLD (aborted) child session, captured before the record's
  // childSessionID was overwritten.
  const resumeText = buildJobPrompt({
    prompt: await buildResumePrompt(reg.job, deps, reg.oldChildSessionID),
    worktree: reg.job.worktree,
    branch: reg.job.branch,
  });
  if (deliver) {
    try {
      await deliver({ sessionId: reg.job.childSessionID, text: resumeText });
    } catch (e) {
      console.warn(`[delegate] resume prompt delivery failed for ${id}:`, e?.message ?? e);
    }
  }
  return { ok: true, job: reg.job };
}

// ---------------------------------------------------------------------------
// Restart reconciliation (spec §11.6-5)
//
// A job recorded `running` whose child session no longer exists (the box
// restarted; opencode sessions are not durable across a reboot) is parked as
// `paused` — its worktree + branch persist, so it can be resumed. This runs
// once at delegate-engine boot. Exported for the CTO engine (C3) to call too.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:true, reconciled:number}>} count of jobs flipped
 * running → paused. Skips reconciliation when `sessionExists` is absent.
 */
export async function reconcileJobsOnBoot(deps = {}) {
  const { load = loadJobs, save = saveJobs, publish, sessionExists, now = () => Date.now() } = deps;
  if (typeof sessionExists !== "function") return { ok: true, reconciled: 0 };
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    let reconciled = 0;
    const next = [];
    for (const job of jobs) {
      // engine:"v2" jobs are reconciled by reconcileV2Jobs (authoritative
      // reads, never a guessed state); parking one as paused would strand it.
      if (job.status === "running" && job.childSessionID && job.engine !== "v2") {
        let alive = true;
        try {
          alive = await sessionExists(job.childSessionID);
        } catch {
          alive = true; // transient blip → don't park a healthy job
        }
        if (!alive) {
          next.push({ ...job, status: "paused", pauseRequested: false, pausedAt: now() });
          publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "paused" } });
          reconciled += 1;
          continue;
        }
      }
      next.push(job);
    }
    if (reconciled > 0) await save(next);
    return { ok: true, reconciled };
  });
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
 */
async function closeJobWindow(job, deps = {}) {
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

// ---- terminal transition --------------------------------------------------

/**
 * Make a V2 job terminal. ONE write holds the status, the result and — for a job
 * whose result Manta posts — the minted `completionMessageId` with
 * `completionDelivery:"pending"`, so a crash right after can never lose the
 * result nor post it twice. The first terminal transition wins; later ones are
 * no-ops. The N7 post (if any) happens AFTER the write. A job without a
 * worktree keeps its window and record (the row shows done).
 */
export async function finishV2Job(job, status, error, deps = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    listMessages,
    clearProgress = defaultClearProgress,
    now = () => Date.now(),
  } = deps;

  const updated = await jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === job.id);
    if (idx === -1) return null;
    const live = jobs[idx];
    if (isTerminal(live)) return null;

    let result = null;
    if (status === "done") {
      try {
        result = await lastAssistantText(listMessages ? await listMessages(live.childSessionID) : []);
      } catch (e) {
        console.warn("[delegate] listMessages failed:", e?.message ?? e);
      }
    }
    const manta = completionOwnerOf(live) === "manta";
    const next = {
      ...live,
      status,
      error: status === "done" ? null : (error ?? null),
      result: status === "done" ? result : null,
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
  if (updated.completionDelivery === "pending") await deliverJobResult(updated.id, deps);
  return { ok: true };
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

    let cto = false;
    try {
      cto = !!(await isCtoConversationSession?.(job.parentSessionID));
    } catch {
      cto = false;
    }
    if (cto) {
      try {
        await deliver?.({ sessionId: job.parentSessionID, text: buildCompletionText(job) });
      } catch (e) {
        console.warn(`[delegate] completion delivery failed for ${id}:`, e?.message ?? e);
      }
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

async function hasAdmissionEvidence(job, deps) {
  const child = job.childSessionID;
  const tries = [
    async () => ((await deps.listInbox?.(child)) ?? []).length > 0,
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

  const session = rs.session ?? {};
  const outcome = session.outcome ?? hint?.outcome ?? null;
  const idleAt = session.time?.idle ?? hint?.at ?? null;
  const fresh = job.submittedAt == null || (idleAt != null && idleAt >= job.submittedAt);

  if (job.launchState === "uncertain") {
    const evidence =
      active.has(job.childSessionID) || (outcome && fresh) || (await hasAdmissionEvidence(job, deps));
    if (!evidence) return { settled: false, reason: "uncertain" };
    job = (await patchJob(job.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) })) ?? job;
  }
  if (active.has(job.childSessionID)) return { settled: false, reason: "active" };
  if (!outcome || !fresh) return { settled: false, reason: "no-outcome" };

  if (manta) {
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
  await finishV2Job(job, t.status, t.error, deps);
  return { settled: true, status: t.status };
}

const resuming = new Set();

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
    if (current.windowIndex == null) {
      const projects = typeof listProjects === "function" ? await listProjects() : [];
      const owner = current.tmuxSession ? { tmuxSession: current.tmuxSession } : resolveOwner(projects, current.parentSessionID);
      if (!owner) return;
      const created = await newWindow({
        sessionName: owner.tmuxSession,
        windowName: windowNameFor(current.name),
        cwd: current.parentDirectory,
        chatMode: true,
        existingSessionId: current.childSessionID,
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
    const claimed = await patchJob(
      current.id,
      () => ({ launchState: "submitting", submittedAt: (deps.now ?? Date.now)() }),
      deps,
      { onlyIf: (j) => j.status === "running" && j.submittedAt == null },
    );
    if (!claimed) return;
    await submitCommand(claimed, deps);
  } catch (e) {
    console.warn(`[delegate] resuming the launch of ${job.id} failed:`, e?.message ?? e);
  } finally {
    resuming.delete(job.id);
  }
}

/**
 * Re-check every unfinished `engine:"v2"` job (boot, reconnect, each sweep).
 * Sequential: a box with a handful of background rows must not fan out reads.
 */
export async function reconcileV2Jobs(deps = {}) {
  const { load = loadJobs } = deps;
  if (typeof deps.listActiveIds !== "function") return 0;
  const targets = (await load()).filter((j) => j.engine === "v2" && !isTerminal(j) && j.childSessionID);
  for (const job of targets) {
    try {
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
async function submitCommand(job, deps) {
  const run = job.commandRun ?? {};
  try {
    await deps.runCommandOnChild({
      sessionId: job.childSessionID,
      command: run.command,
      arguments: run.arguments ?? "",
      model: run.model,
      agent: run.agent,
      attachments: run.attachments,
    });
  } catch (e) {
    if (isDefiniteRefusal(e)) {
      await rollbackLaunch(job, deps);
      return { ok: false, error: String(e?.message ?? e) };
    }
    const kept = (await patchJob(job.id, { launchState: "uncertain" }, deps, { onlyIf: (j) => !isTerminal(j) })) ?? job;
    return { ok: true, job: kept, uncertain: true };
  }
  const running = (await patchJob(job.id, { launchState: "running" }, deps, { onlyIf: (j) => !isTerminal(j) && j.launchState !== "running" })) ?? job;
  return { ok: true, job: running };
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
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    listProjects,
    newWindow,
    stampOwner,
    readSession,
    createChildSession,
    now = () => Date.now(),
  } = deps;
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  const parentSessionID = input?.parentSessionID;
  if (!parentSessionID) return { ok: false, error: "parentSessionID is required" };
  if (!command) return { ok: false, error: "command is required" };
  const args = String(input?.arguments ?? "");

  const refusal = (jobs) => {
    if (jobs.find((j) => j.childSessionID === parentSessionID && j.status === "running")) {
      return { ok: false, error: "a background job cannot start another background job" };
    }
    if (jobs.filter((j) => j.status === "running").length >= MAX_RUNNING_JOBS) return { ok: false, error: CAP_ERROR };
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
    await save(jobs);
    publish?.({ kind: "delegate.updated", payload: { id: job.id, status: "running", launchState: "creating" } });
    return { ok: true, job };
  });
  if (!reg.ok) return reg;
  let job = reg.job;

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

// ---- open a job's session -------------------------------------------------

/**
 * `delegate:open-session`: where the job's chat window is — re-created, stamped
 * with the child session id, if it was closed. A child that no longer exists is
 * a visible error, never a window onto nothing.
 * @returns {Promise<{ok:true, tmuxSession:string, windowIndex:number}|{ok:false, error:string}>}
 */
export async function openJobSession(id, deps = {}) {
  const { load = loadJobs, listProjects, newWindow, stampOwner, readSession } = deps;
  const job = (await load()).find((j) => j.id === id);
  if (!job) return { ok: false, error: "that background job no longer exists" };
  if (!job.childSessionID) return { ok: false, error: "this background job has no session yet" };

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
// Engine factory — wires the runtime deps once (in src/server/index.mjs) and
// returns bound methods the REST/RPC handlers + the pump call. Mirrors the
// createPromptDelivery / createWebhookEngine pattern.
// ---------------------------------------------------------------------------

export function createDelegateEngine(baseDeps) {
  const sawBusy = new Map();
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

  async function adoptCandidate(childId) {
    const c = candidates.get(childId);
    if (!c) return;
    candidates.delete(childId);
    if (claims.has(childId)) return;
    const owner = resolveOwner(await deps.listProjects(), c.parentID);
    if (!owner) {
      console.warn("[delegate] could not resolve the owning window to adopt a background command:", c.parentID);
      return;
    }
    await adoptSubagentJob(
      { parentSessionID: c.parentID, parentDirectory: owner.cwd, childSessionID: childId, name: c.name, prompt: c.name, model: null, origin: "command" },
      deps,
    );
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
    const root = jobs.find((j) => j.engine === "v2" && completionOwnerOf(j) === "manta" && !isTerminal(j) && j.childSessionID === parentID);
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
    candidates.set(childId, { parentID, name, timer: null });
    boundMap(candidates, 200);
  }

  async function onExecutionEvent(raw) {
    const sid = raw.data?.sessionID;
    const type = raw.type;
    const outcome = rawOutcome(type);
    const jobs = await (deps.load ?? loadJobs)();
    for (const job of jobs) {
      if (job.engine !== "v2" || isTerminal(job) || !job.childSessionID) continue;
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
    observeRaw,
    windowClosed,
    lifecycle,
    observeEvent: (evt) => {
      const sid = evt?.properties?.sessionID;
      if (typeof sid !== "string" || !sid) {
        // Nothing to serialise on — call through unchanged.
        return observeEvent(evt, deps, sawBusy);
      }
      return serialize(sid, () => observeEvent(evt, deps, sawBusy));
    },
    sweep: () => sweepDelegateJobs(deps),
    listJobs: (filter) => listJobs(filter, deps),
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
