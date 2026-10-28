// delegateView.mjs — the box's reading of background-job records for the chat
// screen (WS02 server-first, D23/D24; audit items C9, C10, C6-enforce, S16).
//
// Clients render what this module returns and keep no job rules of their own:
//   - jobForSession(sessionId): is this session a read-only background job, and
//     if so the bar's headline / status line / parent line / stoppability;
//   - assertWritable(sessionId): the authority behind the read-only bar — a
//     prompt, inbox change, compaction or command aimed at a job session is
//     refused with HTTP 409 (ReadOnlyJobError.rpcStatus, read by handleRpcRequest);
//   - decorateList(jobs): `statusLabel` + `summary` on every delegate:list row;
//   - validateApprovalTools(tools): the rule check behind delegate:approve.
//
// Pure rules are exported for tests; `createDelegateView` takes its I/O as
// dependencies (no live box needed to test it).

import { newestRecordFor } from "./delegate.mjs";

export const READ_ONLY_JOB_MESSAGE = "This is a background job — it can't take messages";
export const APPROVAL_RULES_MESSAGE = "A job needs at least one rule with a permission and a pattern.";

/** Thrown by assertWritable; `handleRpcRequest` answers `rpcStatus` with `{error, code}`. */
export class ReadOnlyJobError extends Error {
  constructor(message = READ_ONLY_JOB_MESSAGE) {
    super(message);
    this.name = "ReadOnlyJobError";
    this.code = "read_only_job";
    this.rpcStatus = 409;
  }
}

const MODELS_TTL_MS = 5 * 60 * 1000;

/** A background job's session is read-only EXCEPT a CTO work worker (correlation.kind "work"). */
export function isReadOnlyJob(job) {
  return !!job && job.correlation?.kind !== "work";
}

/** "providerID/modelID" split on the FIRST "/" (model ids contain slashes, provider ids do not). */
export function parseModelRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const idx = ref.indexOf("/");
  if (idx < 1 || idx === ref.length - 1) return null;
  return { providerID: ref.slice(0, idx), modelID: ref.slice(idx + 1) };
}

/** The status word; "unknown" when empty. */
export function jobStatusLabel(job) {
  const s = typeof job?.status === "string" ? job.status.trim() : "";
  return s || "unknown";
}

/** "<branch> · N files changed" (branch only with a worktree) / "N file(s) changed". */
export function jobSummary(job) {
  const n = job?.filesChanged;
  const files = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const filesLabel = `${files} file${files === 1 ? "" : "s"} changed`;
  if (!job?.worktree || !job?.branch) return filesLabel;
  return `${job.branch} · ${filesLabel}`;
}

export function jobHeadline(modelName) {
  return modelName
    ? `Read-only — this is a background job running ${modelName}.`
    : "Read-only — this is a background job.";
}

/** Running / paused → the live activity; terminal → summary (+ the reason for failed / stopped). */
export function jobStatusLine(job) {
  const status = jobStatusLabel(job);
  if (status === "running" || status === "paused") {
    const activity = typeof job?.activity === "string" ? job.activity.trim() : "";
    return activity || "running…";
  }
  const base = jobSummary(job);
  if (status === "failed" || status === "stopped") {
    const reason = (typeof job?.error === "string" && job.error.trim()) || status;
    return `${base} · ${reason}`;
  }
  return base;
}

export function isStoppable(job) {
  const s = jobStatusLabel(job);
  return s === "running" || s === "paused";
}

/** The first rule problem in an approval's edited tools, or null. `undefined` = use the original request. */
export function validateApprovalTools(tools) {
  if (tools === undefined) return null;
  if (!Array.isArray(tools) || tools.length === 0) return APPROVAL_RULES_MESSAGE;
  for (const t of tools) {
    const permission = typeof t?.permission === "string" ? t.permission.trim() : "";
    const pattern = typeof t?.pattern === "string" ? t.pattern.trim() : "";
    if (!permission || !pattern) return APPROVAL_RULES_MESSAGE;
  }
  return null;
}

/** Find the window hosting `parentSessionID` across the tmux projects. */
function findParentWindow(projects, parentSessionID) {
  if (!parentSessionID || !Array.isArray(projects)) return null;
  for (const p of projects) {
    for (const w of p?.windows ?? []) {
      if (w?.opencodeSessionId === parentSessionID) {
        return { sessionId: parentSessionID, name: w.name ?? p.tmuxSession, project: p.tmuxSession, windowIndex: w.index };
      }
    }
  }
  return null;
}

/**
 * @param {{ listJobs: (filter?: object) => Promise<any>, listProjects: () => Promise<any[]>,
 *           listModels: () => Promise<any[]>, now?: () => number }} deps
 */
export function createDelegateView({ listJobs, listProjects, listModels, now = Date.now }) {
  let modelsCache = null; // { at, models }

  async function modelNameFor(ref) {
    const parsed = parseModelRef(ref);
    if (!parsed) return null;
    const t = now();
    if (!modelsCache || t - modelsCache.at >= MODELS_TTL_MS) {
      try {
        modelsCache = { at: t, models: (await listModels()) ?? [] };
      } catch {
        return null; // a catalogue hiccup only loses the name, never the bar
      }
    }
    const m = modelsCache.models.find((x) => x?.providerID === parsed.providerID && x?.id === parsed.modelID);
    return typeof m?.name === "string" && m.name ? m.name : null;
  }

  async function readJobs() {
    const r = await listJobs({});
    return Array.isArray(r) ? r : Array.isArray(r?.jobs) ? r.jobs : [];
  }

  async function jobFor(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return newestRecordFor(await readJobs(), sessionId);
  }

  return {
    async jobForSession(sessionId) {
      const job = await jobFor(sessionId);
      if (!job || !isReadOnlyJob(job)) return { readOnly: false };
      const [modelName, projects] = await Promise.all([
        modelNameFor(job.model),
        Promise.resolve().then(listProjects).catch(() => []),
      ]);
      const parent = findParentWindow(projects, job.parentSessionID);
      return {
        readOnly: true,
        job: {
          id: job.id,
          status: jobStatusLabel(job),
          statusLabel: jobStatusLabel(job),
          headline: jobHeadline(modelName),
          statusLine: jobStatusLine(job),
          parentLine: parent ? `It reports to ${parent.name}.` : "It reports to a session that's closed.",
          stoppable: isStoppable(job),
          parent,
        },
      };
    },

    async assertWritable(sessionId) {
      const job = await jobFor(sessionId);
      if (job && isReadOnlyJob(job)) throw new ReadOnlyJobError();
    },

    decorateList(jobs) {
      if (!Array.isArray(jobs)) return jobs;
      return jobs.map((j) => ({ ...j, statusLabel: jobStatusLabel(j), summary: jobSummary(j) }));
    },

    validateApprovalTools,
  };
}
