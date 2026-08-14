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

import { randomBytes } from "node:crypto";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic, createMutex } from "./jsonStore.mjs";
import {
  readProgressRecord as defaultReadProgress,
  clearProgress as defaultClearProgress,
} from "./progress.mjs";
import { startPoller } from "./startPoller.mjs";
import { slugify } from "../shared/worktree.mjs";
import {
  parseGitStatus,
  summarizeTranscript,
  describeChatActivity,
} from "./peers.mjs";
import { extractSubagentInfo } from "../shared/streamInterpretation.mjs";

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
export function buildJobPrompt({ prompt, worktree, branch }) {
  const head = String(prompt ?? "").trim();
  if (!worktree) {
    return (
      head +
      "\n\n---\n" +
      "You are running as a background job. The user is not watching this session and\n" +
      "cannot see your intermediate output — only your final message is reported back.\n\n" +
      "When you are done, end with a short summary of what you changed and why."
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
    "When you are done, end with a short summary of what you changed and why."
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

// Derive the job name from the first four whitespace-separated words of the
// prompt, slugified. Pure.
export function deriveName(prompt) {
  const words = String(prompt ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
  return slugify(words || "background");
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
export function buildPermissionRuleset(tools) {
  const input = Array.isArray(tools) ? tools : [];
  const rules = [];
  for (const t of input) {
    if (!t || typeof t !== "object") continue;
    const permission = typeof t.permission === "string" ? t.permission : null;
    const pattern = typeof t.pattern === "string" ? t.pattern : null;
    if (!permission || !pattern) continue;
    const action = t.action === "deny" ? "deny" : "allow";
    rules.push({ permission, pattern, action });
  }
  // De-dup identical rules (model may repeat).
  const seen = new Set();
  const deduped = rules.filter((r) => {
    const key = `${r.permission}\u0000${r.pattern}\u0000${r.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    cwd,
    worktree,
    branch,
    baseSha,
    existingSessionId,
    origin,
    permission,
    link,
  },
  deps = {},
) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    newWindow,
    listProjects,
    gitRemoveWorktree,
    oc,
    now = () => Date.now(),
  } = deps;

  let childSessionID = null;
  let tmuxSession = null;
  let windowIndex = null;
  try {
    const owner = resolveOwner(await listProjects(), parentSessionID);
    if (!owner) {
      throw new Error(`could not resolve the tmux session owning ${parentSessionID}`);
    }
    tmuxSession = owner.tmuxSession;
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

  // Persist the record with status "running", startedAt = now.
  const id = genId();
  const job = {
    id,
    name,
    prompt,
    model: model ?? null,
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
    status: "running",
    activity: null,
    createdAt: now(),
    startedAt: now(),
    finishedAt: null,
    result: null,
    error: null,
    filesChanged: null,
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
 * @param {{prompt:string, model?:string, parentSessionID:string, parentDirectory:string,
 *          link?: {issue?:{repoKey:string,number:number}, pr?:{repoKey:string,number:number}}|null}} input
 *        `link` (BET-844) — the optional session link (at most one issue + one
 *        PR, `{issue?, pr?}` shape) a forge-triggered delegate carries so the
 *        progress sink addresses the linked issue/PR. Stored on the job record.
 * @param {object} deps injected I/O (load/save/publish/deliver/listProjects/
 *        newWindow/gitAddWorktree/gitRun/oc listMessages/now)
 */
export async function startJob(input, deps = {}) {
  const { deliver } = deps;

  const prompt = String(input?.prompt ?? "");
  const parentSessionID = input?.parentSessionID;
  const parentDirectory = input?.parentDirectory;

  if (!parentSessionID) return { ok: false, error: "parentSessionID is required" };
  if (!parentDirectory) return { ok: false, error: "parentDirectory is required" };

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

    // 3. Derive the name.
    const name = deriveName(prompt);

    // 4. Create the worktree. On throw, catch and continue with
    //    worktree = branch = baseSha = null and cwd = parentDirectory.
    let worktree = null;
    let branch = null;
    let baseSha = null;
    let cwd = parentDirectory;
    try {
      const wt = await gitAddWorktree({ cwd: parentDirectory, name });
      worktree = wt.path;
      branch = wt.branch;
      cwd = wt.path;
    } catch {
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
        model: input?.model,
        cwd,
        worktree,
        branch,
        baseSha,
        existingSessionId: undefined,
        origin: "delegate",
        permission: input?.permission,
        link: input?.link,
      },
      deps,
    );
  });

  if (!reg.ok) return reg;

  // 8. Send the opening prompt via the shared delivery module's deliver.
  try {
    await deliver({
      sessionId: reg.job.childSessionID,
      text: buildJobPrompt({ prompt, worktree: reg.job.worktree, branch: reg.job.branch }),
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
  { parentSessionID, parentDirectory, childSessionID, name, prompt, model },
  deps = {},
) {
  const { load = loadJobs } = deps;

  if (!parentSessionID || !parentDirectory || !childSessionID) {
    return { ok: false, error: "parentSessionID, parentDirectory and childSessionID are required" };
  }

  // Under the jobs-store lock: the idempotency read + the record append happen
  // as one atomic unit, so a repeated adoption event cannot interleave with
  // another writer.
  return jobsLock.runExclusive(async () => {
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
        cwd: parentDirectory,
        worktree: null,
        branch: null,
        baseSha: null,
        existingSessionId: childSessionID,
        origin: "subagent",
      },
      deps,
    );
  });
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
export async function observeEvent(evt, deps = {}, sawBusy = new Map()) {
  const sid = evt?.properties?.sessionID;
  if (typeof sid !== "string" || !sid) return;
  const { load = loadJobs } = deps;
  const jobs = await load();

  // BET-721: passively adopt a background subagent into the job store so it
  // appears as a nested sidebar row. Detection is passive (events never carry
  // `background:true` unless the capability is on) and must never throw into
  // the pump.
  if (evt.type === "message.part.updated") {
    try {
      const info = extractSubagentInfo(evt?.properties?.part);
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

  const job = jobs.find((j) => j.childSessionID === sid && j.status === "running");
  if (!job) {
    // Not a tracked background job — but still keep the sawBusy flag honest so
    // a job that starts later in this same session id isn't instantly
    // completed by a stale idle. (Session ids are unique per opencode
    // session, so this is defensive only.)
    return;
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
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await tickActivity(deps);
    } catch (e) {
      console.warn("[delegate] activity tick failed:", e?.message ?? e);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop() { clearInterval(timer); } };
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
      if (
        job.status === "running" &&
        job.startedAt != null &&
        nowMs - job.startedAt > RUNNING_TIMEOUT_MS
      ) {
        transitioned.push(job);
      }
    }

    if (transitioned.length === 0 && orphaned.length === 0) {
      await persistRetention({ load, save }, nowMs);
      return;
    }

    // Orphaned jobs → stopped (parent gone). stopJob aborts + marks stopped +
    // runs the same terminal cleanup. Runs BEFORE the timeout pass so a job
    // that is both orphaned and timed-out is recorded as "stopped" (parent
    // gone is the more precise reason); finishJob is idempotent on the
    // already-terminal record.
    for (const job of orphaned) {
      await stopJob(job.id, { load, save, publish, deliver, abortSession, now, killWindow: deps.killWindow, gitRemoveWorktree: deps.gitRemoveWorktree });
    }
    // Timed-out jobs → failed. Pass the FULL deps so finishJob's terminal
    // cleanup (killWindow + gitRemoveWorktree) actually runs.
    for (const job of transitioned) {
      await finishJob(job, "failed", "timed out after 30 minutes", deps, new Map());
    }
    await persistRetention({ load, save }, nowMs);
  } catch (e) {
    console.warn("[delegate] sweep failed:", e?.message ?? e);
  }
}

// Retention prune under the jobs-store lock: re-read the store fresh so the
// prune cannot clobber a write a concurrent writer persisted while this sweep
// was inspecting a stale snapshot.
async function persistRetention({ load, save }, nowMs) {
  await jobsLock.runExclusive(async () => {
    const jobs = await load();
    if (jobs.length === 0) return;
    const retained = applyRetention(jobs, nowMs);
    if (retained.length !== jobs.length) await save(retained);
  });
}

function applyRetention(jobs, nowMs) {
  const cutoff = nowMs - TERMINAL_RETENTION_MS;
  // BET-418 §B: a terminal job whose worktree was kept (dirty) must NOT be
  // pruned — its tmux window is still live and the record is what keeps it
  // recognisable as a job (pruning it would let the stale window reappear as
  // an ordinary top-level session). cleanedUp===false is set only by the new
  // cleanup path; undefined (old records) prunes as before.
  let out = jobs.filter(
    (j) =>
      !(
        (j.status === "done" || j.status === "failed" || j.status === "stopped") &&
        j.finishedAt != null &&
        j.finishedAt < cutoff &&
        j.cleanedUp !== false
      ),
  );
  const terminal = out.filter(
    (j) => j.status === "done" || j.status === "failed" || j.status === "stopped",
  );
  if (terminal.length > MAX_TERMINAL_JOBS) {
    const sorted = [...terminal].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const dropped = new Set(
      sorted
        .filter((j) => j.cleanedUp !== false)
        .slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))
        .map((j) => j.id),
    );
    out = out.filter((j) => !dropped.has(j.id));
  }
  return out;
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

/**
 * stopJob aborts the child session with oc.abortSession, marks the job
 * `stopped`, and sends a completion message. Window and worktree are kept.
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
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: "not found" };
    const job = jobs[idx];
    if (job.status !== "running") {
      return { ok: false, error: "job not running", status: job.status };
    }
    if (abortSession && job.childSessionID) {
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
    if (deliver && job.parentSessionID) {
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
  });
}

/**
 * deleteJob removes the tmux window, then calls
 * local.gitRemoveWorktree({ path, force: false }), then removes the record.
 * NEVER pass force: true. If gitRemoveWorktree returns {removed:false,
 * reason:"dirty"}, keep the worktree AND keep the job record, and return that
 * reason so the UI can explain it.
 */
export async function deleteJob(id, deps = {}) {
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

    // 1. Remove the tmux window (best-effort).
    if (killWindow && job.tmuxSession != null && job.windowIndex != null) {
      try {
        await killWindow({ sessionName: job.tmuxSession, windowIndex: job.windowIndex });
      } catch (e) {
        console.warn(`[delegate] killWindow failed for ${id}:`, e?.message ?? e);
      }
    }

    // 2. Remove the worktree (force: false, NEVER force: true).
    if (gitRemoveWorktree && job.worktree) {
      try {
        const res = await gitRemoveWorktree({ path: job.worktree, force: false });
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
// Engine factory — wires the runtime deps once (in src/server/index.mjs) and
// returns bound methods the REST/RPC handlers + the pump call. Mirrors the
// createPromptDelivery / createWebhookEngine pattern.
// ---------------------------------------------------------------------------

export function createDelegateEngine(deps) {
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
  const chains = new Map(); // sessionID -> tail promise
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
    stopJob: (id) => stopJob(id, deps),
    deleteJob: (id) => deleteJob(id, deps),
    observeEvent: (evt) => {
      const sid = evt?.properties?.sessionID;
      if (typeof sid !== "string" || !sid) {
        // Nothing to serialise on — call through unchanged.
        return observeEvent(evt, deps, sawBusy);
      }
      const tail = (chains.get(sid) ?? Promise.resolve())
        .then(() => observeEvent(evt, deps, sawBusy))
        .catch((e) => console.warn("[delegate] observeEvent failed:", e?.message ?? e));
      chains.set(sid, tail);
      // Drop the chain tail from the map only if it is still the current one,
      // so the map cannot grow without bound and a live chain is never removed
      // from under a queued event.
      tail.then(
        () => { if (chains.get(sid) === tail) chains.delete(sid); },
        () => { if (chains.get(sid) === tail) chains.delete(sid); },
      );
      return tail;
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
  };
  return bound;
}
