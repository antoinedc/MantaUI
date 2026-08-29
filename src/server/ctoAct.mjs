// src/server/ctoAct.mjs
// BET-1424 — the §9.2 act-and-report executors for the §9.3-eligible classes.
//
// The suggestion engine's act branch (ctoSuggest.mjs) calls ONE injected
// `executeAction({cls, action, candidate})` with the candidate's primary bound
// option. BET-1403 wired only `record-decision` inline in index.mjs; this
// module owns all three §9.3-eligible executors (ctoTrust.mjs eligibility map)
// behind one factory:
//
//   - record-decision → a gatekeeper-checked decision fact on the CTO's own
//     blackboard (the engine's fact route). Behavior carried over verbatim
//     from the BET-1403 inline executor.
//   - queue-tonight   → an entry in tonight's overnight queue via the engine's
//     tonightAdd (§10.4/§11.4 — planning-only, nothing runs until the window
//     opens; trivially reversible).
//   - start-job       → a worktree-isolated delegate job (own git worktree +
//     branch; never touches the user's checkout), started with actor "cto"
//     under the §3.3 delegate gate (kill switch, pause, concurrent cap).
//
// Everything else refuses with `no-executor` (config-change is §9.3-capped at
// ask permanently; tool-write stays data-unreachable until a tool holds the
// §7.4 write ring). The refusal contract is load-bearing (§9.2): act-and-report
// must never silently no-op — every refusal returns {ok:false, reason} so the
// verb degrades to the veto-window card, whose options remain user-executable
// through the renderer's ask-path executors.
//
// Payload normalization: the generator emits free-form payloads; a present-but
// malformed field refuses the act (incomplete-payload) rather than being
// silently dropped — the card rendered THIS payload, so executing a doctored
// version of it would not be acting on what was shown. The field names follow
// the renderer's ask-path contract (ctoView.ts executeSuggestionOption) where
// one exists: start-job accepts `cwd` (alias `directory`), queue-tonight reads
// `cost` as the predictedCost alias.
//
// Pure over injected I/O — testable without a live tmux/opencode/delegate.

import { ACTOR, RATE_LIMITS } from "./ctoEngine.mjs";
import { resolveForgeOwner } from "./delegate.mjs";

// ---------------------------------------------------------------------------
// Payload normalization (§9.1 schema → the executor's typed input)
// ---------------------------------------------------------------------------

// record-decision: {statement, project, refs?} (+ finding refs fallback).
export function normalizeRecordDecisionPayload(payload, { findingRefs = [] } = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const statement = typeof p.statement === "string" ? p.statement.trim() : "";
  const project = typeof p.project === "string" ? p.project.trim() : "";
  const refs = Array.isArray(p.refs) && p.refs.length
    ? p.refs.filter((r) => typeof r === "string")
    : (Array.isArray(findingRefs) ? findingRefs.filter((r) => typeof r === "string") : []);
  if (!statement || !project || refs.length === 0) return null;
  return { statement, project, refs };
}

// start-job: {prompt, cwd | directory, model?, ...}. `model` mirrors the
// delegate engine's startJob contract: a free-text name or a structured
// {providerID, modelID, variant?}. Returns null when prompt/cwd are missing or
// when a supplied model has neither a valid shape.
export function normalizeStartJobPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
  const cwdRaw = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd : (typeof p.directory === "string" ? p.directory : "");
  const cwd = cwdRaw.trim();
  if (!prompt || !cwd) return null;
  let model;
  if (p.model != null) {
    if (typeof p.model === "string" && p.model.trim()) {
      model = p.model.trim();
    } else if (
      typeof p.model === "object" && !Array.isArray(p.model) &&
      typeof p.model.providerID === "string" && p.model.providerID.trim() &&
      typeof p.model.modelID === "string" && p.model.modelID.trim()
    ) {
      model = { providerID: p.model.providerID, modelID: p.model.modelID };
      if (typeof p.model.variant === "string" && p.model.variant.trim()) model.variant = p.model.variant;
    } else {
      return null;
    }
  }
  return model === undefined ? { prompt, cwd } : { prompt, cwd, model };
}

// queue-tonight: {name?, prompt?, project?, value?, confidence?, cost?/predictedCost?, refs?}.
// The name falls back to the finding text (what the card shows); tonightAdd
// still enforces its own name/prompt defaults and caps.
export function normalizeQueueTonightPayload(payload, { findingText = "", findingRefs = [] } = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const name = (typeof p.name === "string" && p.name.trim()) || String(findingText ?? "").trim();
  if (!name) return null;
  const out = { name };
  if (typeof p.prompt === "string" && p.prompt.trim()) out.prompt = p.prompt;
  if (typeof p.project === "string" && p.project.trim()) out.project = p.project.trim();
  if (Number.isFinite(p.value)) out.value = p.value;
  if (Number.isFinite(p.confidence)) out.confidence = p.confidence;
  if (Number.isFinite(p.predictedCost)) out.predictedCost = p.predictedCost;
  else if (Number.isFinite(p.cost)) out.predictedCost = p.cost;
  const refs = Array.isArray(p.refs) && p.refs.length
    ? p.refs.filter((r) => typeof r === "string")
    : (Array.isArray(findingRefs) ? findingRefs.filter((r) => typeof r === "string") : []);
  if (refs.length) out.refs = refs;
  return out;
}

// ---------------------------------------------------------------------------
// The executor factory — one `executeAction` for the suggest engine's act verb
// ---------------------------------------------------------------------------

/**
 * @param {object} deps injected I/O
 * @param {(input: {project, kind, statement, refs, sender}) => Promise<{ok?:boolean, error?:string}|null>} [deps.proposeFact]
 * @param {(task: object) => Promise<{ok?:boolean, task?:object, error?:string}|null>} [deps.tonightAdd]
 *   the engine's tonightAdd (self-gated: overnight switch + High tier).
 * @param {() => Promise<{ok?:boolean, release?:() => void, error?:string}|null>} [deps.beginDelegateJob]
 *   the §3.3 delegate gate (kill switch / pause / concurrent tracker).
 * @param {() => Promise<Array>} [deps.listProjects]
 * @param {(projects: Array, cwd: string) => {parentSessionID?:string}|null} [deps.resolveParent]
 * @param {(input: {prompt, model?, parentSessionID, parentDirectory, actor}) => Promise<{ok?:boolean, job?:{id?:string}, error?:string}|null>} [deps.startDelegateJob]
 * @param {() => Promise<Array>} [deps.listDelegateJobs] the persisted job rows
 *   (loadJobs) — the persistent source the running-CTO-job cap counts.
 * @param {number} [deps.maxConcurrentDelegate] §3.3 concurrent cto-delegate cap
 * @returns {({cls, action, candidate}) => Promise<{ok:boolean, reason?:string, detail?:string, jobId?:string|null, taskId?:string|null}>}
 */
export function createCtoActExecutor(deps = {}) {
  const {
    proposeFact = null,
    tonightAdd = null,
    beginDelegateJob = null,
    listProjects = async () => [],
    resolveParent = resolveForgeOwner,
    startDelegateJob = null,
    listDelegateJobs = async () => [],
    maxConcurrentDelegate = RATE_LIMITS.concurrentDelegate,
  } = deps;

  return async function executeAction({ cls, action, candidate } = {}) {
    // The act bookkeeping (trust counters, ledger row, digest report) is
    // per-class; executing an option whose type diverges from the candidate's
    // class would record one class and perform another. Refuse.
    if (typeof cls !== "string" || cls !== action?.type) {
      return { ok: false, reason: "class-mismatch" };
    }
    const payload = action?.payload && typeof action.payload === "object" ? action.payload : {};

    if (cls === "record-decision") {
      if (typeof proposeFact !== "function") return { ok: false, reason: "no-executor" };
      const p = normalizeRecordDecisionPayload(payload, { findingRefs: candidate?.finding?.refs });
      if (!p) return { ok: false, reason: "incomplete-payload" };
      const result = await proposeFact({ project: p.project, kind: "decision", statement: p.statement, refs: p.refs, sender: "cto" });
      return result?.ok === true
        ? { ok: true, detail: "decision fact proposed" }
        : { ok: false, reason: result?.error ?? "propose-failed" };
    }

    if (cls === "queue-tonight") {
      if (typeof tonightAdd !== "function") return { ok: false, reason: "no-executor" };
      const p = normalizeQueueTonightPayload(payload, { findingText: candidate?.finding?.text, findingRefs: candidate?.finding?.refs });
      if (!p) return { ok: false, reason: "incomplete-payload" };
      // originId binds the queue entry back to the suggestion card so the
      // drill-down edits (tonightRemove/tonightReorder) record their verdicts
      // against the suggestion's verdict subject.
      const result = await tonightAdd({ ...p, cls: "queue-tonight", originId: typeof candidate?.id === "string" ? candidate.id : null });
      return result?.ok === true
        ? { ok: true, detail: "queued for tonight", taskId: result?.task?.id ?? null }
        : { ok: false, reason: result?.error ?? "queue-refused" };
    }

    if (cls === "start-job") {
      if (typeof startDelegateJob !== "function" || typeof beginDelegateJob !== "function") {
        return { ok: false, reason: "no-executor" };
      }
      const p = normalizeStartJobPayload(payload);
      if (!p) return { ok: false, reason: "incomplete-payload" };
      // §3.3 concurrent delegate sub-cap: count RUNNING cto-actor rows — the
      // persistent source the overnight dispatch counts too. The gate's
      // transient tracker only spans the start call itself, so the running
      // rows are the real concurrency bound; the gate below still supplies
      // the kill switch / pause checks + the cto.delegate_begin ledger row.
      let running = 0;
      try {
        const jobs = await listDelegateJobs();
        running = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.actor === ACTOR && j?.status === "running").length;
      } catch {
        running = 0;
      }
      if (running >= maxConcurrentDelegate) {
        return { ok: false, reason: "rate_limit:concurrentDelegate" };
      }
      // A queued act needs a tracked project session to host the job (the
      // same resolve the overnight dispatch uses). Resolve BEFORE arming the
      // gate so a refused start never writes a cto.delegate_begin row.
      let parent = null;
      try {
        parent = resolveParent(await listProjects(), p.cwd);
      } catch {
        parent = null;
      }
      if (!parent?.parentSessionID) return { ok: false, reason: "no-project-session" };
      const gate = await beginDelegateJob();
      if (gate?.ok !== true) return { ok: false, reason: gate?.error ?? "gate-refused" };
      try {
        const input = { prompt: p.prompt, parentSessionID: parent.parentSessionID, parentDirectory: p.cwd, actor: ACTOR };
        if (p.model !== undefined) input.model = p.model;
        const res = await startDelegateJob(input);
        if (res?.ok !== true) return { ok: false, reason: res?.error ?? "start-refused" };
        return { ok: true, detail: "delegate job started", jobId: res?.job?.id ?? null };
      } finally {
        // The transient gate tracker spans the START only — the running job's
        // concurrency is bounded by the rows count above (the overnight
        // dispatch precedent; a long-lived job can never release a tracker).
        gate.release?.();
      }
    }

    return { ok: false, reason: "no-executor" };
  };
}
