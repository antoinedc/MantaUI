// src/server/ctoSessions.mjs
// BET-1378 — the Adaptive CTO's ephemeral session runner (§3.1) + model task
// classes (§12.3). The one helper every model-needing CTO step uses: run a
// headless opencode session, read the result synchronously (GET …/message,
// no scoped SSE, no directory registration), delete it, and never leak.
//
// Pure logic + injected I/O in the style of delegate.mjs — no live
// tmux/opencode/network in tests.

import { startPoller } from "./startPoller.mjs";
import { engineStateStore } from "./ctoStores.mjs";
import { listRoutableModels } from "./opencode.mjs";
import { buildRoutingServices } from "./routingServices.mjs";
import { lookupModel, matchModel, allModels } from "./modelCatalog.mjs";
import { chooseSubagentModel } from "./delegate.mjs";

// ---------------------------------------------------------------------------
// Task classes (§12.3) — a literal table in code. NEVER a model id.
//
//   nano tier  : ambient-summarize (≤4k ctx), gatekeeper, worthiness
//   mid tier   : digest-compose (≤12k ctx), suggest
//   spawn      : context-assembly budget ≤8k (a delegate job, not a tier)
//
// `tier` is the routing band; `contextBudget` is the token cap for the
// assembled context (absent → no cap). Model resolution always goes through
// the existing model catalog/router (never hardcoded).
// ---------------------------------------------------------------------------
export const TASK_CLASSES = Object.freeze({
  "ambient-summarize": Object.freeze({ tier: "nano", contextBudget: 4000 }),
  gatekeeper: Object.freeze({ tier: "nano" }),
  worthiness: Object.freeze({ tier: "nano" }),
  "digest-compose": Object.freeze({ tier: "mid", contextBudget: 12000 }),
  suggest: Object.freeze({ tier: "mid" }),
  spawn: Object.freeze({ contextBudget: 8000 }),
});

// Route-band per §12.3 tier — what the existing router is asked to satisfy.
export const TIER_TO_ROUTER_TIER = Object.freeze({
  nano: "fast", // cheapest qualifying
  mid: "balanced",
});

// Cascade rule (§12.3): an AMBIENT (nano) class may escalate exactly one tier
// when its structured output fails validation, at most once per call. Mid-tier
// classes and `spawn` never escalate.
export const TIER_ESCALATION = Object.freeze({ nano: "mid" });

export const CTO_TITLE_PREFIX = "cto:";

// Reaper (§3.1): every 10 min sweep orphaned `cto:` sessions older than 30 min
// that are not in the active set (so a crash between create and delete can't
// leak sessions).
export const REAPER_INTERVAL_MS = 10 * 60 * 1000;
export const REAPER_MAX_AGE_MS = 30 * 60 * 1000;

export function getTaskClass(taskClass) {
  const meta = TASK_CLASSES[taskClass];
  if (!meta) {
    throw new Error(`runEphemeral: unknown task class "${taskClass}" (see TASK_CLASSES)`);
  }
  return meta;
}

// One-step escalation for a class tier; null when the tier must not escalate.
export function escalateTier(tier) {
  return TIER_ESCALATION[tier] ?? null;
}

// Approximate token count (1 token ≈ 4 chars) for budget truncation.
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

/**
 * Pure context assembly (§3.1, §12.3). `context` is an ORDERED list of
 * `{ priority, text }` blocks. Budgets the result to the task class's token
 * budget by dropping the LOWEST-priority blocks first (high-priority kept),
 * then joining with a blank line. No budget on the class → all blocks kept in
 * priority order. A single highest-priority block that alone overflows the
 * budget is truncated rather than dropped, so the model always sees something.
 */
export function assembleContext(context = [], { taskClass } = {}) {
  const meta = getTaskClass(taskClass);
  const budget = meta?.contextBudget;
  const blocks = Array.isArray(context) ? context : [];
  const ordered = blocks
    .map((b) => ({ priority: Number(b?.priority) || 0, text: String(b?.text ?? "") }))
    .sort((a, b) => b.priority - a.priority);

  if (budget == null) {
    return ordered.map((b) => b.text).join("\n\n");
  }

  const kept = [];
  let tokens = 0;
  for (const b of ordered) {
    const t = estimateTokens(b.text);
    if (tokens + t > budget) {
      if (kept.length === 0) {
        const chars = Math.max(0, Math.floor(budget * 4));
        kept.push(b.text.slice(0, chars));
      }
      break; // this and every lower-priority block are dropped first
    }
    kept.push(b.text);
    tokens += t;
  }
  return kept.join("\n\n");
}

// ---------------------------------------------------------------------------
// Active-set bookkeeping (engine-state.json `activeEphemeral`, A1 store).
// The active set protects a mid-flight session from the reaper.
// ---------------------------------------------------------------------------

export function addActive(set, id) {
  const out = new Set(Array.isArray(set) ? set : []);
  out.add(id);
  return [...out];
}

export function removeActive(set, id) {
  return (Array.isArray(set) ? set : []).filter((x) => x !== id);
}

async function loadActivePayload(engineState) {
  try {
    const p = await engineState.load();
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

async function activeAdd(sid, { engineState }) {
  const payload = await loadActivePayload(engineState);
  await engineState.save({
    ...payload,
    activeEphemeral: addActive(payload.activeEphemeral, sid),
  });
}

async function activeRemove(sid, { engineState }) {
  const payload = await loadActivePayload(engineState);
  await engineState.save({
    ...payload,
    activeEphemeral: removeActive(payload.activeEphemeral, sid),
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Run ONE headless ephemeral session for a task class.
 *
 * 1. Resolves the model for the class tier through the existing model
 *    catalog/router (cheapest qualifying model; null → box default).
 * 2. Runs the session via the injected oc.runEphemeralSession — which (a)
 *    creates a headless session (no tmux window, no @manta-session-id stamp →
 *    no sidebar row) titled `cto:<taskClass>`, (b) calls onCreated(sid) BEFORE
 *    prompting (records the session in engine-state's activeEphemeral set),
 *    (c) prompts then reads the result synchronously, (d) deletes the session.
 * 3. On any path (success or error) removes the session from the active set.
 *
 * The production `oc` adapter wires opencode.mjs's `runSynchronousSession`
 * (the one non-SSE create→prompt→poll→read→delete primitive — used by
 * auto-rename and the optimizer too; never a second copy). Tests inject a mock.
 *
 * @param {object} a
 * @param {string} a.taskClass  a key of TASK_CLASSES
 * @param {Array<{priority,text}>} [a.context]  ordered rank-ordered blocks
 * @param {string} [a.directory]  headless session workdir (default "~")
 * @param {object} [a.deps]
 * @param {object} a.deps.oc  { runEphemeralSession(opts) -> {text, sid} }
 * @param {object} [a.deps.engineState]  { load, save } (default engineStateStore)
 * @param {Function} [a.deps.resolveModel]  async ({taskClass,tier,meta,configGet}) -> model|null
 * @param {Function} [a.deps.configGet]  async () -> AppConfig (for model routing)
 * @param {Function} [a.deps.validate]  async (result) => bool — structured-output check; triggers the cascade
 * @returns {Promise<{text:string, taskClass:string, tier:string}>}
 */
export async function runEphemeral({ taskClass, context = [], directory = "~", deps = {} } = {}) {
  const meta = getTaskClass(taskClass);

  let tier = meta.tier;
  let escalated = false;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const out = await runOnce({ taskClass, meta, tier, context, directory, deps });
    const valid = typeof deps.validate === "function" ? await deps.validate(out) : true;
    if (valid) return out;
    const next = escalateTier(meta.tier); // nano -> mid; others null
    if (next && next !== tier && !escalated) {
      escalated = true;
      tier = next;
      continue; // cascade exactly one tier, at most once per call
    }
    return out;
  }
  // unreachable: the loop runs at most twice
  throw new Error(`runEphemeral: cascade exceeded maximum attempts for "${taskClass}"`);
}

async function runOnce({ taskClass, meta, tier, context, directory, deps }) {
  const {
    oc,
    engineState = engineStateStore,
    resolveModel = defaultResolveModel,
    configGet,
  } = deps;
  if (!oc || typeof oc.runEphemeralSession !== "function") {
    throw new Error("runEphemeral requires deps.oc with runEphemeralSession()");
  }
  const model = typeof resolveModel === "function"
    ? await resolveModel({ taskClass, tier, meta, configGet })
    : null;
  const instruction = assembleContext(context, { taskClass });

  let sid = null;
  try {
    const res = await oc.runEphemeralSession({
      directory,
      title: `${CTO_TITLE_PREFIX}${taskClass}`,
      instruction,
      model,
      onCreated: async (s) => {
        sid = s;
        await activeAdd(s, { engineState });
      },
    });
    return { text: res?.text ?? "", taskClass, tier, sid: res?.sid ?? sid };
  } finally {
    // Remove from the active set even when the run errored (finally).
    if (sid) {
      try {
        await activeRemove(sid, { engineState });
      } catch {
        /* a failed removal must not mask the run's own result/error */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Model resolution (productions default — the existing catalog/router path).
// ---------------------------------------------------------------------------

/**
 * Default model resolver: pick the CHEAPEST model satisfying the class tier
 * through the existing router. Reuses the same inputs delegate.mjs builds
 * (routable catalogue + RoutingServices), but FORCES the §12.3 tier via a
 * per-agent routing directive, so an ambient (nano) or digest/suggest (mid)
 * step is never up-routed by the user's own modelRouting and never hardcodes a
 * model id. Returns the structured {providerID, modelID} (or null → box
 * default, which chooseSubagentModel returns when nothing survives).
 */
export async function defaultResolveModel({ taskClass, tier, meta, configGet }) {
  const nowMs = Date.now();
  let cfg = {};
  if (typeof configGet === "function") {
    try {
      cfg = (await configGet()) ?? {};
    } catch {
      cfg = {};
    }
  }
  const policy = (cfg && cfg.modelRouting) || {};
  const agent = `cto:${taskClass}`;
  // Force the class tier; never let the user's own perAgent/preset override it.
  const forcedPolicy = {
    ...policy,
    perAgent: { ...(policy.perAgent ?? {}), [agent]: TIER_TO_ROUTER_TIER[tier] },
  };

  let catalog = [];
  try {
    catalog = (await listRoutableModels("sub", cfg)) ?? [];
  } catch {
    catalog = [];
  }

  let services = null;
  try {
    services = await buildRoutingServices(cfg, {
      catalogIndex: { lookupModel, matchModel, allModels },
      endpoints: catalog,
      snapshots: [],
      providerHealthState: null,
      endpointSummary: null,
      pacing: null,
    }, nowMs);
  } catch {
    services = null; // degraded → router routes on absent context (box default)
  }

  try {
    return chooseSubagentModel({
      incumbent: null,
      catalog,
      policy: forcedPolicy,
      agent,
      nowMs,
      contextTokens: meta?.contextBudget ?? undefined,
      services,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reaper (§3.1): sweep orphaned `cto:` sessions every 10 min.
// ---------------------------------------------------------------------------

/**
 * The age of a session (epoch ms created), for reaping. Unknown → null (the
 * reaper never reaps a session it cannot date — safe default).
 */
export function sessionCreatedMs(session) {
  const t = session?.time;
  if (t && typeof t === "object") {
    if (typeof t.created === "number") return t.created;
    if (typeof t.updated === "number") return t.updated;
  }
  if (typeof session?.time === "number") return session.time;
  if (typeof session?.created === "number") return session.created;
  return null;
}

/**
 * Pure reaper selection: sessions with the `cto:` title prefix that are older
 * than `maxAgeMs` and NOT in the active set. Returns the session ids to delete.
 */
export function selectReapCandidates({
  sessions = [],
  activeSet = [],
  nowMs = Date.now(),
  maxAgeMs = REAPER_MAX_AGE_MS,
  prefix = CTO_TITLE_PREFIX,
} = {}) {
  const active = new Set(Array.isArray(activeSet) ? activeSet : []);
  const cut = nowMs - maxAgeMs;
  const doomed = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const id = s?.id;
    if (!id) continue;
    const title = typeof s?.title === "string" ? s.title : "";
    if (!title.startsWith(prefix)) continue;
    if (active.has(id)) continue;
    const ts = sessionCreatedMs(s);
    if (ts == null || ts >= cut) continue; // recent, or undatable → not an orphan
    doomed.push(id);
  }
  return doomed;
}

/**
 * The reaper, as a poller. `listSessions` + `deleteSession` default to the
 * injected `oc`; construction is injected I/O only. `tick()` sweeps once;
 * `start()` runs it on the 10-min cadence via the shared startPoller (inFlight
 * guard + timer.unref()). First tick is NOT immediate — nothing to sweep at
 * boot that isn't already handled, and the interval is the contract.
 */
export function createEphemeralReaper({
  oc,
  engineState = engineStateStore,
  listSessions,
  deleteSession,
  now = () => Date.now(),
  poller = startPoller,
  intervalMs = REAPER_INTERVAL_MS,
  maxAgeMs = REAPER_MAX_AGE_MS,
  prefix = CTO_TITLE_PREFIX,
} = {}) {
  const list = listSessions ?? oc?.listSessions;
  const del = deleteSession ?? oc?.deleteSession;
  if (typeof list !== "function" || typeof del !== "function") {
    throw new Error("createEphemeralReaper requires listSessions + deleteSession (or an oc client)");
  }

  async function tick() {
    let sessions = [];
    let active = new Set();
    try {
      sessions = (await list()) ?? [];
    } catch {
      sessions = [];
    }
    try {
      const payload = await engineState.load();
      active = new Set(Array.isArray(payload?.activeEphemeral) ? payload.activeEphemeral : []);
    } catch {
      active = new Set();
    }
    const doomed = selectReapCandidates({
      sessions,
      activeSet: [...active],
      nowMs: now(),
      maxAgeMs,
      prefix,
    });
    for (const id of doomed) {
      try {
        await del(id);
      } catch {
        /* a failed delete is retried next sweep */
      }
    }
    return doomed;
  }

  return {
    tick,
    start() {
      return poller(tick, { intervalMs, label: "ctoEphemeralReaper", immediate: false });
    },
  };
}

/** Convenience: build + start the reaper; returns the poller handle ({ stop }). */
export function startEphemeralReaper(deps) {
  return createEphemeralReaper(deps).start();
}
