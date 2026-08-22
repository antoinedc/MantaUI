// routingServices.mjs — assemble the RoutingServices context the BET-1236
// endpoint router consumes, from live box state.
//
// BET-1252. The router (src/shared/modelRouter.mjs) receives a `services`
// object that the WIRING must construct from live box readers — the model
// catalogue, provider health, usage snapshots (accounts), and the endpoint
// ledger (reliability / telemetry / mix). This is that assembly, and it is the
// single source of truth for BOTH production callers (delegate startJob and
// rpc routing:main) so the subagent and main-conversation paths share one
// build ("one code path").
//
// Safety contract — every reader is OPTIONAL and individually guarded. The
// router treats an absent field as permissive / measured-average, never false,
// and never throws; this module extends that guarantee to the readers: a
// failing catalogue, a missing health tracker, an unavailable ledger, or a
// malformed snapshot each degrades to "absent" rather than aborting the build.
// Routing genuinely must never break a spawn, and the outer try/catch in the
// callers is the last line of that defence — this module is the first.
//
// Pure assembly + injected I/O (mirrors the sibling measurement modules):
// nothing here touches the network or the DB itself, so the whole build is
// unit-testable with fakes.
//
// The shape built matches RoutingServices in src/shared/modelRouter.d.mts:
//   { catalogMatcher, catalogEntryFor, qualityField, declared, providerClass,
//     accounts, health, reliability, telemetry, mix, referenceByModel }

import { endpointKey } from "../shared/endpointKey.mjs";

const isObj = (v) => v !== null && typeof v === "object";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// Fold the config's per-endpoint user overrides into the `declared` map the
// router reads. The config key is modelRouting.declaredModels (see
// src/shared/types.ts); it is empty until the declarations store/UI exists,
// and this function stays a passthrough of whatever IS present so a future
// store needs no change here.
export function normalizeDeclared(cfg, declaredModelsKey = "declaredModels") {
  const raw = cfg?.modelRouting?.[declaredModelsKey];
  if (!isObj(raw)) return {};
  const out = {};
  for (const [key, decl] of Object.entries(raw)) {
    if (isObj(decl)) out[key] = decl;
  }
  return out;
}

// The percentile ranking helper the router's quality stage needs. A benchmark
// score is ranked against the SAME benchmark's score on every model the box
// can currently see (the provider-agnostic catalogue). Returns null when the
// benchmark is not observed anywhere — meaning modelQuality falls through to
// family/structural, never a bogus 0.
export function buildBenchmarkField(catalogIndex) {
  const all =
    catalogIndex && typeof catalogIndex.allModels === "function" ? catalogIndex.allModels() : [];
  const field = new Map(); // benchmark name -> sorted scores
  for (const e of Array.isArray(all) ? all : []) {
    const bms = Array.isArray(e?.benchmarks) ? e.benchmarks : [];
    for (const b of bms) {
      if (!b || typeof b?.name !== "string") continue;
      const s = num(b?.score);
      if (!field.has(b.name)) field.set(b.name, []);
      field.get(b.name).push(s);
    }
  }
  for (const scores of field.values()) scores.sort((a, b) => a - b);
  return {
    benchmarkPercentile(name, score) {
      const scores = field.get(name);
      if (!Array.isArray(scores) || scores.length === 0) return null;
      const s = num(score);
      // Midrank percentile: half of the ties count below. A model at the field
      // median ranks 0.5, exactly where the ≤/≥ ties are ambiguous.
      let below = 0;
      let equal = 0;
      for (const x of scores) {
        if (x < s) below++;
        else if (x === s) equal++;
      }
      return (below + 0.5 * equal) / scores.length;
    },
  };
}

// Map usage snapshots (src/server/usage.mjs — adapter-shaped, keyed by the
// opencode providerIDs they cover) into the per-providerID AccountState the
// marginal-cost stage reads. An exhausted snapshot / a snapshot for a provider
// is carried through so the router never routes work to a provider that would
// refuse it.
export function accountsFromSnapshots(snapshots) {
  const out = {};
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (!isObj(s)) continue;
    const providerIDs = Array.isArray(s.providerIDs) ? s.providerIDs : [];
    if (providerIDs.length === 0) continue;
    const account = {
      kind: typeof s.balance === "number" ? "credit" : "subscription",
      windows: Array.isArray(s.windows) ? s.windows : [],
      ...(typeof s.balance === "number" ? { balance: s.balance } : {}),
      ...(typeof s.overagePrice === "number" ? { overagePrice: s.overagePrice } : {}),
      ...(s.exhausted === true ? { exhausted: true } : {}),
    };
    for (const pid of providerIDs) out[pid] = account;
  }
  return out;
}

// The per-provider health map (keyed by opencode providerID). Derived from the
// providerIDs present in the candidate catalogue (union with the snapshots'
// providerIDs) so every provider the router might consider carries a state.
export function healthFor(providerIDs, providerHealthState) {
  const stateFn =
    typeof providerHealthState === "function" ? providerHealthState : null;
  if (!stateFn) return {};
  const out = {};
  for (const pid of new Set(Array.isArray(providerIDs) ? providerIDs : [])) {
    if (typeof pid !== "string" || !pid) continue;
    try {
      const st = stateFn(pid);
      if (typeof st === "string" && st) out[pid] = st;
    } catch {
      // A throwing health reader must never break the build.
    }
  }
  return out;
}

// Fold the endpoint ledger (src/server/modelLedger.mjs endpointSummary, keyed
// by "providerID/modelID") into the router's reliability + telemetry inputs:
//   reliability.samples  — per-endpoint { requests, errored, rate }
//   reliability.baseline — per-MODEL aggregate across its endpoints, so a
//                          single bad endpoint can be told apart from a model
//                          that is simply hard everywhere
//   telemetry[key]       — { tokensPerSec, p50Ms, p90Ms, latencyMs }
export function ledgerToServices(stats) {
  const samples = {};
  const perModel = new Map(); // modelID -> { requests, errored }
  const telemetry = {};
  const mix = {};
  for (const [key, s] of Object.entries(isObj(stats) ? stats : {})) {
    const rel = isObj(s?.reliability) ? s.reliability : null;
    if (rel && typeof rel.requests === "number") {
      const requests = rel.requests;
      const errored = num(rel.errored);
      samples[key] = { requests, errored, rate: num(rel.rate) };
      const modelID = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
      const agg = perModel.get(modelID) ?? { requests: 0, errored: 0 };
      agg.requests += requests;
      agg.errored += errored;
      perModel.set(modelID, agg);
    }
    const speed = isObj(s?.speed) ? s.speed : {};
    const latency = isObj(s?.latency) ? s.latency : {};
    telemetry[key] = {
      ...(typeof speed.p50TokensPerSec === "number" ? { tokensPerSec: speed.p50TokensPerSec } : {}),
      ...(typeof latency.p50Ms === "number" ? { p50Ms: latency.p50Ms } : {}),
      ...(typeof latency.p90Ms === "number" ? { p90Ms: latency.p90Ms } : {}),
      ...(typeof latency.p90Ms === "number" ? { latencyMs: latency.p90Ms } : {}),
    };
    if (isObj(s?.mix)) mix[key] = s.mix;
  }
  const baseline = {};
  for (const [modelID, agg] of perModel) {
    baseline[modelID] = { rate: agg.requests ? agg.errored / agg.requests : 0, n: agg.requests };
  }
  return {
    reliability: { samples, baseline },
    telemetry,
    mix,
  };
}

/**
 * Build the full RoutingServices context from live box state. Every field that
 * has a box-side reader is populated; a missing or throwing reader degrades to
 * "absent" (the router's permissive default) — never an exception.
 *
 * @param {object} [cfg]            box config ({ modelRouting: { preset, perAgent, declaredModels } })
 * @param {object}  [deps]
 * @param {object}  [deps.catalogIndex]     the model catalogue controller
 *   ({ lookupModel, matchModel, allModels }) from src/server/modelCatalog.mjs
 * @param {Array<object>} [deps.endpoints]  the candidate model list (for the
 *   providerIDs health is keyed by) — e.g. listRoutableModels output
 * @param {Array<object>} [deps.snapshots]  usage snapshots (src/server/usage.mjs)
 * @param {Function} [deps.providerHealthState]  (providerID) => state string
 * @param {Function} [deps.endpointSummary]  async () => { supported, ... } —
 *   src/server/modelLedger.mjs endpointSummary
 * @param {Function} [deps.buildReliabilityBaseline]  optional override for the
 *   reliability/telemetry fold (tests)
 * @returns {Promise<object>}  the RoutingServices-shaped object
 */
export async function buildRoutingServices(cfg = {}, deps = {}) {
  const services = {};
  const catalogue = deps.catalogIndex ?? null;

  // Catalogue matcher + per-endpoint catalogue entry + percentile field.
  try {
    if (catalogue && typeof catalogue.matchModel === "function") {
      services.catalogMatcher = {
        lookupModel: (id) => catalogue.lookupModel(id),
        matchModel: (id) => catalogue.matchModel(id),
      };
      services.catalogEntryFor = (endpoint) => {
        try {
          // A declared identity always beats a fuzzy match: the user told us
          // exactly which catalogue model this endpoint is (BET-1268). Fall
          // back to the fuzzy match only when nothing is declared.
          const declaredId = services.declared?.[endpointKey(endpoint)]?.catalogId;
          if (typeof declaredId === "string" && declaredId !== "") {
            return catalogue.lookupModel(declaredId) ?? null;
          }
          const match = catalogue.matchModel(endpoint?.id);
          return match?.kind === "exact" ? match.candidates?.[0] ?? null : null;
        } catch {
          return null;
        }
      };
    }
  } catch {
    /* catalogue absent → identity/quality degrade to structural — safe */
  }
  try {
    const field = buildBenchmarkField(catalogue);
    if (field) services.qualityField = field;
  } catch {
    /* no benchmark field is fine — quality falls through to family/structural */
  }

  // Per-endpoint user overrides (config). Empty until the declarations store
  // exists; this reads through whatever the config carries.
  try {
    services.declared = normalizeDeclared(cfg);
  } catch {
    services.declared = {};
  }

  // Accounts per providerID from the usage snapshots.
  try {
    const accounts = accountsFromSnapshots(deps.snapshots);
    if (Object.keys(accounts).length > 0) services.accounts = accounts;
  } catch {
    /* no snapshots → no account constraints (measured-average pricing) */
  }

  // Provider health per providerID.
  try {
    const providerIDs = [
      ...(Array.isArray(deps.endpoints) ? deps.endpoints.map((m) => m?.providerID) : []),
      ...(Array.isArray(deps.snapshots) ? deps.snapshots.flatMap((s) => (Array.isArray(s?.providerIDs) ? s.providerIDs : [])) : []),
    ];
    const health = healthFor(providerIDs, deps.providerHealthState);
    if (Object.keys(health).length > 0) services.health = health;
  } catch {
    /* no health tracker → every provider treated as working */
  }

  // Reliability + telemetry + mix from the endpoint ledger (DB-backed, async).
  try {
    const fold = typeof deps.buildReliabilityBaseline === "function" ? deps.buildReliabilityBaseline : ledgerToServices;
    let stats = null;
    if (typeof deps.endpointSummary === "function") {
      stats = await deps.endpointSummary();
      if (!isObj(stats)) stats = null;
    }
    if (stats) {
      const { reliability, telemetry, mix } = fold(stats);
      services.reliability = reliability;
      services.telemetry = telemetry;
      if (mix && Object.keys(mix).length > 0) services.mix = mix;
    }
  } catch {
    /* no ledger → reliability/telemetry absent (never derank, measured speed) */
  }

  return services;
}
