// routingServices.mjs — assemble the RoutingServices context the BET-1236
// endpoint router consumes, from live box state.
//
// BET-1252. The router (src/shared/modelRouter.mjs) receives a `services`
// object that the WIRING must construct from live box readers — the model
// catalogue, provider health, usage snapshots (accounts), and the endpoint
// ledger (reliability / telemetry / mix). This is that assembly, and it is the
// single source of truth for the production callers (delegate startJob and
// rpc routing:choose) so the subagent and main-conversation paths share one
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
import { mixFromCounts } from "../shared/blendedPrice.mjs";
import { readModalities } from "../shared/modelGuide.mjs";
import { ROUTING_LEDGER_WINDOW_MS } from "./modelLedger.mjs";

const isObj = (v) => v !== null && typeof v === "object";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// 7c: the endpoint-ledger summary is memoised behind a short TTL so every
// routing decision does not re-scan the whole message history (a JSON.parse
// per assistant row — every turn boundary and every background-job spawn).
// There is ONE ledger on the box, so the cache is keyed on nothing but the
// injected endpointSummary fn (the identity key stops one test's stub leaking
// into the next; in production it is the same fn every call). A 60s-stale
// reliability figure cannot change a decision that matters, so deliberately no
// invalidation protocol, no bus event, no config knob.
const ROUTING_LEDGER_TTL_MS = 60_000;
// Deliberately value-only: this cache memos a SETTLED summary, never an
// in-flight promise. A hanging endpointSummary blocks that one caller but
// cannot poison later ones (no shared never-settling slot), so it is immune
// to the BET-1359/BET-1360 memo-wedge failure mode — it is NOT given a build
// budget or startedAt. It still inherits the shared opencodeDb busy_timeout.
let ledgerCache = null; // { sum, at, value } — one slot, TTL-bounded

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
    const windows = Array.isArray(s.windows) ? s.windows : [];
    // The account kind is DECLARED by the adapter/descriptor, never inferred
    // from `balance` (BET-1269 5e): a subscription that also reports a credit
    // balance (codex) must not be priced as prepaid credit. A snapshot with no
    // declared kind falls back to "credit" only when it is structurally a
    // balance-only account; otherwise the adapter is incomplete and must be
    // fixed, not guessed around.
    let kind =
      typeof s.kind === "string" && (s.kind === "subscription" || s.kind === "credit")
        ? s.kind
        : typeof s.balance === "number" && windows.length === 0
          ? "credit"
          : "subscription";
    const account = {
      kind,
      windows,
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
//   telemetry[key]       — { tokensPerSec, p90TokensPerSec, p50Ms, p90Ms }
export function ledgerToServices(stats) {
  // 7a — separate the ledger's availability flag from its data. `supported:
  // false` (no DB / failed query) must NOT fold to present-but-empty maps: the
  // router treats an ABSENT reliability/telemetry as "no evidence, never
  // derank, measured-average", which is exactly what a missing ledger means. A
  // supported-but-empty ledger yields present empty maps instead.
  if (stats?.supported === false) {
    return { reliability: undefined, telemetry: undefined, mix: undefined, mixDefault: undefined };
  }
  const samples = {};
  const perModel = new Map(); // modelID -> { requests, errored }
  const telemetry = {};
  const mix = {}; // per-endpoint normalised fractions
  // Aggregate every endpoint's raw token counts so an endpoint with no history
  // of its own is priced on the box's overall measured mix, not a constant.
  let agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const endpoints = isObj(stats?.endpoints) ? stats.endpoints : {};
  for (const [key, s] of Object.entries(endpoints)) {
    const rel = isObj(s?.reliability) ? s.reliability : null;
    // Only endpoints with actual tool-call evidence produce a reliability
    // sample. A `requests === 0` row (no tool-call requests measured) is NOT a
    // 0% error rate — it is unmeasured, and surfacing `rate: 0` for it was
    // fabricating "perfect reliability" on every unmeasured endpoint, making
    // the reliability dimension uniformly 0 across the catalogue and unable to
    // distinguish any pair (the BET-1297 §12d inert-signal). The router treats
    // an absent sample as unmeasured-average (rank 1) — the honest value.
    if (rel && typeof rel.requests === "number" && rel.requests > 0) {
      const requests = rel.requests;
      const errored = num(rel.errored);
      samples[key] = { requests, errored, rate: num(rel.rate) };
      const modelID = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
      const agg2 = perModel.get(modelID) ?? { requests: 0, errored: 0 };
      agg2.requests += requests;
      agg2.errored += errored;
      perModel.set(modelID, agg2);
    }
    const speed = isObj(s?.speed) ? s.speed : {};
    const latency = isObj(s?.latency) ? s.latency : {};
    telemetry[key] = {
      ...(typeof speed.p50TokensPerSec === "number" ? { tokensPerSec: speed.p50TokensPerSec } : {}),
      ...(typeof speed.p90TokensPerSec === "number" ? { p90TokensPerSec: speed.p90TokensPerSec } : {}),
      ...(typeof latency.p50Ms === "number" ? { p50Ms: latency.p50Ms } : {}),
      ...(typeof latency.p90Ms === "number" ? { p90Ms: latency.p90Ms } : {}),
    };
    if (isObj(s?.mix)) {
      // Convert raw token counts to fractions once, here, so services.mix[key]
      // arrives at the router already normalised (BET-1269 5a).
      mix[key] = mixFromCounts(s.mix);
      agg.input += num(s.mix.input);
      agg.output += num(s.mix.output);
      agg.cacheRead += num(s.mix.cacheRead);
      agg.cacheWrite += num(s.mix.cacheWrite);
    }
  }
  const baseline = {};
  for (const [modelID, ag] of perModel) {
    baseline[modelID] = { rate: ag.requests ? ag.errored / ag.requests : 0, n: ag.requests };
  }
  const hasAnyMix = agg.input + agg.output + agg.cacheRead + agg.cacheWrite > 0;
  return {
    reliability: { samples, baseline },
    telemetry,
    mix,
    ...(hasAnyMix
      ? { mixDefault: mixFromCounts({ input: agg.input, output: agg.output, cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite }) }
      : {}),
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
 * @param {object}  [deps.endpointSummary]  async ({sinceMs}) => { supported, endpoints } —
 *   src/server/modelLedger.mjs endpointSummary (memoised behind a short TTL)
 * @param {Function} [deps.buildReliabilityBaseline]  optional override for the
 *   reliability/telemetry fold (tests)
 * @param {object}  [deps.pacing]  the optimizer pacing state
 *   (src/server/optimizer/pacing.mjs) exposing `pressureFor(providerID)`.
 *   Populates `services.pressure` + `services.ecoLevel` ONLY when
 *   `cfg.optimizerEnabled === true`; absent/degraded → route exactly as today.
 * @param {number} [nowMs]          injected clock (defaults to Date.now()); the
 *   rolling-window edge and the leave it as the TTL cache's timestamp
 * @returns {Promise<object>}  the RoutingServices-shaped object
 */
export async function buildRoutingServices(cfg = {}, deps = {}, nowMs = Date.now()) {
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
          const match = catalogue.matchModel(
            endpoint?.id,
            // The endpoint's own declared facts corroborate the matcher's
            // layer-4 inference (BET-1303 5.6); read modalities via the
            // shared reader, never re-derived.
            {
              modalities: readModalities(endpoint?.capabilities?.input),
              context: endpoint?.limit?.context,
              output: endpoint?.limit?.output,
            },
          );
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

  // The implausible-zero reference (BET-1269 5b): each candidate's model priced
  // by the provider-agnostic catalogue's own typical input/output rates, keyed
  // by model id. This is what lets a reseller quoting 0/0 for a priced model be
  // judged against the real rate instead of winning on a made-up number. A
  // catalogue lookup only — the catalogue is already loaded.
  try {
    const refs = {};
    for (const ep of Array.isArray(deps.endpoints) ? deps.endpoints : []) {
      if (!ep || typeof ep.id !== "string" || ep.id === "") continue;
      const entry = typeof services.catalogEntryFor === "function" ? services.catalogEntryFor(ep) : null;
      const cost = entry && isObj(entry.cost) ? entry.cost : null;
      if (!cost) continue;
      const { input, output } = cost;
      if (typeof input !== "number" && typeof output !== "number") continue;
      refs[ep.id] = {
        ...(typeof input === "number" && Number.isFinite(input) ? { input } : {}),
        ...(typeof output === "number" && Number.isFinite(output) ? { output } : {}),
      };
    }
    if (Object.keys(refs).length > 0) services.referenceByModel = refs;
  } catch {
    /* no catalogue → no reference (the implausible-zero rule cannot fire) */
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
      if (ledgerCache && ledgerCache.sum === deps.endpointSummary && nowMs - ledgerCache.at < ROUTING_LEDGER_TTL_MS) {
        stats = ledgerCache.value;
      } else {
        // 7b: a rolling window (14 days), not all history since the epoch — a
        // single bad week eight months ago must not derank an endpoint forever.
        stats = await deps.endpointSummary({ sinceMs: nowMs - ROUTING_LEDGER_WINDOW_MS });
        if (isObj(stats)) ledgerCache = { sum: deps.endpointSummary, at: nowMs, value: stats };
        if (!isObj(stats)) stats = null;
      }
    }
    if (stats) {
      const { reliability, telemetry, mix, mixDefault } = fold(stats);
      services.reliability = reliability;
      services.telemetry = telemetry;
      if (mix && Object.keys(mix).length > 0) services.mix = mix;
      if (mixDefault) services.mixDefault = mixDefault;
    }
  } catch {
    /* no ledger → reliability/telemetry absent (never derank, measured speed) */
  }

  // Optimizer P2.3 (BET-1345): the pacing pressure + eco level. BOTH are gated
  // on the optimizer switch — `optimizerEnabled === true` and nothing else. With
  // the switch off this block contributes NOTHING (absent pressure / absent eco
  // = route exactly as today), and it never touches routingActive or the
  // modelRouting.preset default. Each field has its own guard so a failing
  // pressure reader degrades to absent without breaking the build.
  const pacingProviderIDs = [
    ...(Array.isArray(deps.endpoints) ? deps.endpoints.map((m) => m?.providerID) : []),
    ...(Array.isArray(deps.snapshots) ? deps.snapshots.flatMap((s) => (Array.isArray(s?.providerIDs) ? s.providerIDs : [])) : []),
  ];
  if (cfg?.optimizerEnabled === true) {
    try {
      if (deps.pacing && typeof deps.pacing.pressureFor === "function") {
        const pressure = {};
        for (const pid of new Set(pacingProviderIDs)) {
          if (typeof pid !== "string" || !pid) continue;
          try {
            const p = await deps.pacing.pressureFor(pid);
            if (p) pressure[pid] = p;
          } catch {
            // one provider's pressure must never break the build for the rest
          }
        }
        if (Object.keys(pressure).length > 0) services.pressure = pressure;
      }
    } catch {
      /* pressure absent → route exactly as today */
    }
    try {
      let eco = 0;
      for (const p of Object.values(services.pressure ?? {})) {
        if (p && typeof p.ecoLevel === "number" && p.ecoLevel > eco) eco = p.ecoLevel;
      }
      services.ecoLevel = eco;
    } catch {
      /* eco absent → the configured preset is used verbatim */
    }
  }

  return services;
}
