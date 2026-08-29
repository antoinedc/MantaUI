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

// Mirrors the renderer's isToolStepBoundary (chatUtils.ts) exactly: a tool
// part that has reached `completed` or `error`. This is the step boundary at
// which a `pauseRequested` job's session is safely drain-aborted — the current
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
 * @param {object} [input]
 * @param {object|null} [input.incumbent]  the model the code would have used today
 * @param {Array<object>} [input.catalog]  opencode model list
 * @param {{ preset?: string, perAgent?: Record<string,string> }} [input.policy]
 * @param {string} [input.agent]           subagent type (default "general")
 * @param {number} [input.nowMs]
 * @returns {object|null} the model to run on (incumbent on off-path / failure)
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
  try {
    const decision = chooseModel(
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
    // On the off-path / no-survivors path chooseModel returns the very
    // catalogIncumbent it was handed; map that back to the original
    // structured incumbent so the deliver call stays byte-identical to today.
    // A real catalog winner is normalised into the {providerID, modelID} shape
    // sendPrompt expects.
    const model =
      decision?.model === catalogIncumbentOf(incumbent)
        ? incumbent
        : toDeliverModel(decision?.model ?? incumbent);
    console.log(describeDecision(decision, { surface: "sub", agent }));
    return model;
  } catch (e) {
    // Routing must never break a spawn — fall back to the incumbent model.
    console.warn("[router] subagent routing failed, using incumbent:", e?.message ?? e);
    return incumbent;
  }
}

/**
 * @param {{prompt:string, model?:string|{providerID:string, modelID:string, variant?:string}, subagent_type?:string, parentSessionID:string, parentDirectory:string,
 *          link?: {issue?:{repoKey:string,number:number}, pr?:{repoKey:string,number:number}}|null}} input
 *        `model` (BET-947, BET-1275 11b) — optional model for the job's session:
 *        free text resolved via the shared fuzzy matcher, or a structured
 *        {providerID, modelID, variant?} used as-is. A named model is the OFF
 *        SWITCH for Auto routing (never routed over) and must still be in the
 *        user's Sub-ticked (routable) set — an un-ticked / deactivated /
 *        unmatchable value fails the delegation loudly naming candidates.
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
      },
      deps,
    );
  });

  if (!reg.ok) return reg;

  // 8. Send the opening prompt via the shared delivery module's deliver. The
  //    effective model is decided here, and the rule is exactly the composer's
  //    (BET-1275): an explicit choice is the off switch; only silence routes.
  //    - 11b: a caller-NAMED model is that off switch — it was resolved + Sub-
  //      validated above (before any window was created) and is used VERBATIM.
  //      Routing is skipped entirely: no router is invoked, no [router] line is
  //      emitted, no substitution can ever happen.
  //    - 11a/11e: with no named model, Auto routes on the job's REQUESTED
  //      subagent type (the job's own intent declaration, not a hardcoded
  //      "general"). A routed decision with no routing directive in the policy
  //      returns the box default (null), byte-identical to today. Routing must
  //      never break a spawn, so a degraded services build is logged (never
  //      silent) and any throw falls back to the default model.
  let effectiveModel = deliverModel;
  if (input?.model) {
    effectiveModel = deliverModel;
  } else {
    const route = deps?.chooseSubagentModel ?? chooseSubagentModel;
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
          endpointSummary: deps.endpointSummary,
          pacing: deps.pacing,
        }, nowMs);
      } catch (e) {
        console.error(`[router] routing services degraded, routing on absent context: ${e?.message ?? e}`);
        services = null;
      }
    }
    try {
      effectiveModel = route({
        incumbent: null,
        catalog,
        policy,
        agent: resolveSubagentAgent(input?.subagent_type),
        nowMs,
        services,
      });
    } catch (e) {
      // The default route() already swallows internally; this is a second
      // belt-and-braces guard so an injected route stub can never break a spawn.
      console.error("[router] subagent routing threw, using default:", e?.message ?? e);
      effectiveModel = deliverModel;
    }
  }
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
        requestedModel: null,
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
      if (job.status === "running" && job.startedAt != null) {
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
    await persistRetention({ load, save }, nowMs);
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
  return jobsLock.runExclusive(async () => {
    const jobs = await load();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return { ok: false, error: "not found" };
    const job = jobs[idx];
    if (job.status !== "running") {
      return { ok: false, error: "job not running", status: job.status };
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
    let ownerSession = null;
    try {
      const owner = resolveOwner(await listProjects(), job.parentSessionID);
      if (!owner) throw new Error(`could not resolve the tmux session owning ${job.parentSessionID}`);
      ownerSession = owner.tmuxSession;
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
      if (job.status === "running" && job.childSessionID) {
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
    pauseJob: (id) => pauseJob(id, deps),
    resumeJob: (id) => resumeJob(id, deps),
    runningJobCount: () => runningJobCount(deps),
    reconcileJobsOnBoot: () => reconcileJobsOnBoot(deps),
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
