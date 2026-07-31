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
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { slugify } from "../shared/worktree.mjs";
import {
  parseGitStatus,
  summarizeTranscript,
  describeChatActivity,
} from "./peers.mjs";

// ---------------------------------------------------------------------------
// Constants (mirrors capabilities.mjs exactly — reuse, do not diverge)
// ---------------------------------------------------------------------------

const STORE_PATH = statePath("delegate-jobs.json");

// Max concurrently `running` jobs, counted box-wide. There is no `queued`
// state — a job either starts immediately or is refused by the cap.
export const MAX_RUNNING_JOBS = 5;
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
    "Commit your work to that branch before you finish. Do not push, do not open a\n" +
    "pull request, do not merge, and do not touch any other checkout.\n\n" +
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

export async function listJobs({ sessionID } = {}, { load = loadJobs } = {}) {
  const jobs = await load();
  if (sessionID === undefined) return jobs.map((j) => ({ ...j }));
  return jobs.filter((j) => j.parentSessionID === sessionID).map((j) => ({ ...j }));
}

export async function getJob(id, { load = loadJobs } = {}) {
  const jobs = await load();
  const job = jobs.find((j) => j.id === id);
  return job ? { ...job } : null;
}

// ---------------------------------------------------------------------------
// startJob — performs the steps in the exact order the spec dictates. If any
// step throws, undo the steps already done, in reverse, and return
// {ok:false, error} — never leave a half-created job.
// ---------------------------------------------------------------------------

/**
 * @param {{prompt:string, model?:string, parentSessionID:string, parentDirectory:string}} input
 * @param {object} deps injected I/O (load/save/publish/deliver/listProjects/
 *        newWindow/gitAddWorktree/gitRun/oc listMessages/now)
 */
export async function startJob(input, deps = {}) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    deliver,
    listProjects,
    newWindow,
    gitAddWorktree,
    gitRun,
    now = () => Date.now(),
  } = deps;

  const prompt = String(input?.prompt ?? "");
  const parentSessionID = input?.parentSessionID;
  const parentDirectory = input?.parentDirectory;

  if (!parentSessionID) return { ok: false, error: "parentSessionID is required" };
  if (!parentDirectory) return { ok: false, error: "parentDirectory is required" };

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

  // 2. Refuse if at cap.
  {
    const jobs = await load();
    const running = jobs.filter((j) => j.status === "running").length;
    if (running >= MAX_RUNNING_JOBS) {
      return {
        ok: false,
        error:
          "too many background jobs running (5). Do not retry — either wait for one to finish, or do this work yourself.",
      };
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

  // 6. Create the window. Because chatMode is true, newWindow already creates
  //    the opencode session and stamps @manta-session-id; read the new
  //    window's opencodeSessionId back out of the returned project list —
  //    that is childSessionID. On throw, undo step 4 (remove the worktree)
  //    and return {ok:false, error}.
  let childSessionID = null;
  let tmuxSession = null;
  let windowIndex = null;
  try {
    const owner = resolveOwner(await listProjects(), parentSessionID);
    if (!owner) {
      throw new Error(`could not resolve the tmux session owning ${parentSessionID}`);
    }
    tmuxSession = owner.tmuxSession;
    const projects = await newWindow({
      sessionName: tmuxSession,
      windowName: name,
      cwd,
      chatMode: true,
      worktreePath: worktree,
      oc: deps.oc,
    });
    const owner2 = resolveOwner(projects, parentSessionID);
    const proj = (projects || []).find((p) => p.tmuxSession === tmuxSession);
    const win = (proj?.windows || []).find(
      (w) => w.name === name && w.opencodeSessionId,
    );
    childSessionID = win?.opencodeSessionId ?? null;
    windowIndex = win?.index ?? null;
    // Sanity: if we somehow failed to read the child session id back, abort.
    if (!childSessionID) {
      throw new Error("could not read the new window's opencode session id");
    }
    void owner2;
  } catch (e) {
    // Undo step 4 in reverse: remove the worktree (force:false, best-effort).
    if (worktree && deps.gitRemoveWorktree) {
      try {
        await deps.gitRemoveWorktree({ path: worktree, force: false });
      } catch {
        /* best-effort cleanup; the start failure is the headline error */
      }
    }
    return { ok: false, error: String(e?.message ?? e) };
  }

  // 7. Persist the record with status "running", startedAt = now.
  const id = genId();
  const job = {
    id,
    name,
    prompt,
    model: input?.model ?? null,
    parentSessionID,
    parentDirectory,
    childSessionID,
    tmuxSession,
    windowIndex,
    worktree,
    branch,
    baseSha,
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

  // 8. Send the opening prompt via the shared delivery module's deliver.
  try {
    await deliver({
      sessionId: childSessionID,
      text: buildJobPrompt({ prompt, worktree, branch }),
    });
  } catch (e) {
    // deliver never rejects in production, but guard anyway — the job is
    // already persisted + running; a delivery failure surfaces as a normal
    // completion (the child will idle immediately).
    console.warn("[delegate] opening prompt delivery failed:", e?.message ?? e);
  }

  return { ok: true, job };
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

export async function finishJob(job, status, error, deps = {}, sawBusy) {
  const {
    load = loadJobs,
    save = saveJobs,
    publish,
    deliver,
    listMessages,
    now = () => Date.now(),
  } = deps;

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

  // Deliver the completion message to the parent session (deferred until idle
  // by the shared delivery engine). Swallow a failure — the job is terminal
  // regardless.
  if (deliver && job.parentSessionID) {
    try {
      await deliver({
        sessionId: job.parentSessionID,
        text: buildCompletionText(updated),
      });
    } catch (e) {
      console.warn(`[delegate] completion delivery failed for ${job.id}:`, e?.message ?? e);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Activity summaries — a 10s poller updates `activity` for running jobs only.
// Reuses summarizeTranscript(messages) then describeChatActivity(summary),
// both from peers.mjs. No model call. No Groq. No new config.
// ---------------------------------------------------------------------------

async function tickActivity(deps) {
  const { load = loadJobs, save = saveJobs, publish, listMessages, now = () => Date.now() } = deps;
  const jobs = await load();
  let changed = false;
  await Promise.all(
    jobs.map(async (job) => {
      if (job.status !== "running") return;
      let activity = null;
      try {
        const messages = listMessages ? await listMessages(job.childSessionID) : [];
        activity = describeChatActivity(summarizeTranscript(messages));
      } catch (e) {
        console.warn(`[delegate] activity poll failed for ${job.id}:`, e?.message ?? e);
        return;
      }
      if (activity !== job.activity) {
        job.activity = activity;
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
  } = deps;
  try {
    const jobs = await load();
    if (jobs.length === 0) return;
    const nowMs = now();
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

    if (transitioned.length === 0) {
      const retained = applyRetention(jobs, nowMs);
      if (retained.length !== jobs.length) await save(retained);
      return;
    }

    for (const job of transitioned) {
      // finishJob persists + publishes + delivers. Pass a fresh sawBusy map —
      // the sweeper has no event-stream state.
      await finishJob(job, "failed", "timed out after 30 minutes", { load, save, publish, deliver, now }, new Map());
    }
    const retained = applyRetention(await load(), nowMs);
    await save(retained);
  } catch (e) {
    console.warn("[delegate] sweep failed:", e?.message ?? e);
  }
}

function applyRetention(jobs, nowMs) {
  const cutoff = nowMs - TERMINAL_RETENTION_MS;
  let out = jobs.filter(
    (j) =>
      !(
        (j.status === "done" || j.status === "failed" || j.status === "stopped") &&
        j.finishedAt != null &&
        j.finishedAt < cutoff
      ),
  );
  const terminal = out.filter(
    (j) => j.status === "done" || j.status === "failed" || j.status === "stopped",
  );
  if (terminal.length > MAX_TERMINAL_JOBS) {
    const sorted = [...terminal].sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const dropped = new Set(
      sorted.slice(0, terminal.length - MAX_TERMINAL_JOBS).map((j) => j.id),
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
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sweepDelegateJobs(pathBound);
    } catch (e) {
      console.warn("[delegate] sweep tick failed:", e?.message ?? e);
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
  void listMessages;
  return { ok: true };
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
}

// ---------------------------------------------------------------------------
// Engine factory — wires the runtime deps once (in src/server/index.mjs) and
// returns bound methods the REST/RPC handlers + the pump call. Mirrors the
// createPromptDelivery / createWebhookEngine pattern.
// ---------------------------------------------------------------------------

export function createDelegateEngine(deps) {
  const sawBusy = new Map();
  const bound = {
    startJob: (input) => startJob(input, deps),
    stopJob: (id) => stopJob(id, deps),
    deleteJob: (id) => deleteJob(id, deps),
    observeEvent: (evt) => observeEvent(evt, deps, sawBusy),
    sweep: () => sweepDelegateJobs(deps),
    listJobs: (filter) => listJobs(filter, deps),
    getJob: (id) => getJob(id, deps),
    startSweeper: (opts) => startSweeper(deps, opts),
    startActivityPoller: (opts) => startActivityPoller(deps, opts),
  };
  return bound;
}
