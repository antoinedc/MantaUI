// modelRouter.mjs — the pure routing decision core (no wiring).
//
// BET-1236 restructured this around ENDPOINTS (a `(model, provider)` pair)
// with an explicit hard/soft filter split. Cost, quality, identity,
// eligibility, reliability and health all live OUT of this file in the
// Stage-2 modules it consumes (marginalCost ~> blendedPrice, modelQuality,
// modelIdentity, autoEligibility, toolReliability + injected health). Pure,
// no node: imports, no Date.now() — time arrives as `nowMs`. No provider NAME
// ever appears here or in its imports.

import { tierRank } from "./modelGuide.mjs";
import { qualityScore, tierForScore, meetsFloor, AGENT_FLOOR_SCORE } from "./modelQuality.mjs";
import { resolveIdentity } from "./modelIdentity.mjs";
import { autoEligibility, MISSING } from "./autoEligibility.mjs";
import { marginalCost } from "./marginalCost.mjs";
import { shouldDerank } from "./toolReliability.mjs";

export const PRESETS = ["economy", "balanced", "performance"];

/** Preferred tier per agent, per preset. Pure lookup table, no inference. */
export const AGENT_TIER = {
  economy: { build: "balanced", plan: "deep", general: "fast", explore: "fast" },
  balanced: { build: "deep", plan: "deep", general: "balanced", explore: "fast" },
  performance: { build: "deep", plan: "deep", general: "deep", explore: "balanced" },
};

const endpointKey = (c) => `${c?.providerID ?? ""}/${c?.id ?? ""}`;

const BINDING_ORDER = [
  "no active model", "context headroom", "tool calling", "image input", "pdf input",
  "out-of-credit", "rate-limited", "identity", "price", "caching", "quality",
];

const HEALTH_EXCLUDED = { "out-of-credit": "out-of-credit", "rate-limited": "rate-limited" };

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// BET-1251: routing is activated per conversation (a preset or per-agent
// override), not by a global switch. An empty policy means "did not ask".
function routingActive(policy) {
  if (typeof policy !== "object" || policy === null) return false;
  if (typeof policy.preset === "string" && policy.preset.length > 0) return true;
  return !!(policy.perAgent && typeof policy.perAgent === "object" && Object.keys(policy.perAgent).length > 0);
}

// Hard Stage 2 — the capability reason an endpoint cannot do THIS turn. The
// one exception to permissive-missing is `status`, as today.
function capabilityDrop(m, { contextTokens, needs, health }) {
  if (m?.status != null && m.status !== "active") return "no active model";
  if (typeof m?.limit?.context === "number" && m.limit.context < contextTokens * 1.25) return "context headroom";
  if (needs.tools === true && m?.capabilities?.toolcall === false) return "tool calling";
  if (needs.image === true && m?.capabilities && m?.capabilities?.input?.image !== true) return "image input";
  if (needs.pdf === true && m?.capabilities && m?.capabilities?.input?.pdf !== true) return "pdf input";
  const hs = HEALTH_EXCLUDED[health?.[m.providerID]];
  return hs ?? null;
}

// Assess one endpoint once — Hard Stage 1 (eligibility), marginal cost and
// reliability — everything the hard and soft stages read.
function assess(candidate, { nowMs }, services) {
  const key = endpointKey(candidate);
  const dec = services.declared?.[key] ?? null;
  const identity = resolveIdentity(candidate, dec, services.catalogMatcher);
  const catalogEntry = typeof services.catalogEntryFor === "function" ? services.catalogEntryFor(candidate) : null;
  const quality = qualityScore(candidate, catalogEntry, services.qualityField);
  const elig = autoEligibility({
    model: candidate,
    identity: { known: identity.state === "resolved" },
    quality,
    declared: dec,
    providerClass: services.providerClass?.[candidate.providerID] ?? "supported",
  });
  const mc = marginalCost({ model: candidate, account: services.accounts?.[candidate.providerID], nowMs, mix: services.mix, reference: services.referenceByModel?.[candidate.id] });
  const penalise = shouldDerank(services.reliability?.samples?.[key], services.reliability?.baseline?.[candidate.id]).penalise === true;
  return {
    key,
    candidate,
    qualityScore: quality.known ? quality.score : 0,
    tier: tierForScore(quality.known ? quality.score : undefined),
    eligible: elig.eligible,
    missing: elig.missing,
    marginalCost: mc.exhausted ? Infinity : mc.cost,
    exhausted: mc.exhausted,
    penalise,
  };
}

// One binding label per dropped endpoint: its capability reason, else the
// first missing completeness fact.
function bindLabel(a, cap) {
  if (cap) return cap;
  for (const m of [MISSING.IDENTITY, MISSING.PRICE, MISSING.CACHING, MISSING.QUALITY]) {
    if (a.missing.includes(m)) return m;
  }
  return "eligibility";
}

function bindingReason(counts) {
  let best = BINDING_ORDER[0];
  let bestCount = -1;
  for (const label of BINDING_ORDER) {
    const cv = counts?.[label] ?? 0;
    if (cv > bestCount) { bestCount = cv; best = label; }
  }
  return best;
}

const num0 = (v) => (isNum(v) ? v : 0);
const numInf = (v) => (isNum(v) ? v : Infinity);
const telemetryOf = (a, services) => services.telemetry?.[a.key] ?? {};

// Soft ordering within a competing set (same model, or a flattened economy
// set): penalised sorts last; then cost; then quality, throughput, the
// latency percentiles, and finally the full provider/model key — deterministic
// (the model id alone is identical for exactly the endpoints most likely to
// tie, so the old final tie-break was deterministic by accident).
function cmpWithinModel(a, b, services) {
  const pa = a.penalise ? 1 : 0;
  const pb = b.penalise ? 1 : 0;
  if (pa !== pb) return pa - pb;
  if (a.marginalCost !== b.marginalCost) return a.marginalCost - b.marginalCost;
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
  const ta = telemetryOf(a, services);
  const tb = telemetryOf(b, services);
  const tsA = num0(ta.tokensPerSec);
  const tsB = num0(tb.tokensPerSec);
  if (tsA !== tsB) return tsB - tsA;
  const p50A = numInf(ta.p50Ms);
  const p50B = numInf(tb.p50Ms);
  if (p50A !== p50B) return p50A - p50B;
  const p90A = numInf(ta.p90Ms);
  const p90B = numInf(tb.p90Ms);
  if (p90A !== p90B) return p90A - p90B;
  const latA = numInf(ta.latencyMs);
  const latB = numInf(tb.latencyMs);
  if (latA !== latB) return latA - latB;
  return String(a.key).localeCompare(String(b.key));
}

// The full soft ordering. Under `economy` the model partition is flattened
// (trading quality for cost is exactly what that preset asks for); otherwise
// group by model, order the groups by quality, run the within-model contest
// inside each.
function stage3Order(assessed, services) {
  if (services.preset === "economy") {
    return [...assessed].sort((a, b) => cmpWithinModel(a, b, services));
  }
  const byModel = new Map();
  for (const a of assessed) {
    let g = byModel.get(a.candidate?.id);
    if (!g) {
      g = { quality: a.qualityScore, minKey: a.key, items: [] };
      byModel.set(a.candidate?.id, g);
    }
    if (a.qualityScore > g.quality) g.quality = a.qualityScore;
    if (a.key < g.minKey) g.minKey = a.key;
    g.items.push(a);
  }
  const groups = [...byModel.values()].sort((x, y) => y.quality - x.quality || String(x.minKey).localeCompare(String(y.minKey)));
  const ordered = [];
  for (const g of groups) {
    g.items.sort((a, b) => cmpWithinModel(a, b, services));
    ordered.push(...g.items);
  }
  return ordered;
}

const TIER_BY_RANK = ["fast", "balanced", "deep"];

// The candidates considered for the winner: the target tier (never below the
// agent's floor), widening one neighbouring band when the target is empty.
function selectBand(ordered, targetRank, agent) {
  const byRank = {};
  for (const a of ordered) {
    if (!meetsFloor(a.qualityScore, agent)) continue;
    const r = tierRank(a.tier);
    (byRank[r] = byRank[r] || []).push(a);
  }
  const ranks = Object.keys(byRank).map(Number);
  if (ranks.length === 0) return [];
  if (byRank[targetRank]?.length) return byRank[targetRank];
  let bestRank = ranks[0];
  let bestDist = Math.abs(ranks[0] - targetRank);
  for (const r of ranks) {
    const d = Math.abs(r - targetRank);
    if (d < bestDist || (d === bestDist && r > bestRank)) { bestDist = d; bestRank = r; }
  }
  return byRank[bestRank];
}

function explain({ agent, tierName, preset, winner, cost }) {
  if (preset === "economy") {
    return `${agent} → ${tierName} tier (economy): ${winner.providerID}/${winner.id} cheapest at $${cost.toFixed(4)}`;
  }
  return `${agent} → ${tierName} tier: ${winner.providerID}/${winner.id}`;
}

/**
 * THE entry point. Always returns a model and a non-empty reason; never
 * throws. Candidate = one (model, provider) endpoint; the set never merges.
 *
 * @param {object} [input]
 * @param {object} [input.intent]   - { kind, agent, needs, contextTokens, incumbent }
 * @param {Array<object>} [input.catalog] - endpoints[] — one per (model, provider)
 * @param {{ preset?: string, perAgent?: Record<string,string> }} [input.policy]
 * @param {number} [input.nowMs]
 * @param {object} [input.services] - the routing context the wiring issue injects
 *   (all optional; absent is permissive / measured-average, never false):
 *   { catalogMatcher, catalogEntryFor, qualityField, declared, providerClass,
 *     accounts, health, telemetry, reliability, mix, referenceByModel }
 * @returns {{ model: object|null, reason: string, alternatives: object[], changed: boolean }}
 */
export function chooseModel(input = {}) {
  const { intent = {}, catalog = [], policy = {}, nowMs = 0 } = input;
  const services = input.services && typeof input.services === "object" ? input.services : {};
  const agent = intent?.agent ?? "general";
  const incumbent = intent?.incumbent ?? null;

  if (intent?.kind === "mid-exchange") {
    return { model: incumbent, reason: "mid-exchange switching is disabled", alternatives: [], changed: false };
  }
  // Off-path (no routing directive): return the incumbent BY REFERENCE,
  // byte-identical so a box without routing behaves exactly as before.
  if (!routingActive(policy)) {
    return { model: incumbent, reason: "routing not activated for this conversation", alternatives: [], changed: false };
  }

  const needs = intent?.needs ?? {};
  const hardCtx = { contextTokens: typeof intent?.contextTokens === "number" ? intent.contextTokens : 0, needs, health: services.health };

  const survivors = [];
  const counts = {};
  for (const c of Array.isArray(catalog) ? catalog : []) {
    const a = assess(c, { nowMs }, services);
    const cap = capabilityDrop(c, hardCtx);
    if ((a.exhausted && !cap) || cap || !a.eligible) {
      counts[bindLabel(a, cap)] = (counts[bindLabel(a, cap)] ?? 0) + 1;
      continue;
    }
    survivors.push(a);
  }

  if (survivors.length === 0) {
    return { model: incumbent, reason: `no ${agent} model passes constraints (${bindingReason(counts)})`, alternatives: [], changed: false };
  }

  const targetRaw = policy?.perAgent?.[agent] ?? AGENT_TIER?.[policy?.preset]?.[agent] ?? "balanced";
  const floorScore = AGENT_FLOOR_SCORE[agent] ?? 0;
  const targetRank = Math.max(tierRank(targetRaw), tierRank(tierForScore(floorScore)));

  const explored = stage3Order(survivors, { preset: policy?.preset, telemetry: services.telemetry });
  const band = selectBand(explored, targetRank, agent);
  if (band.length === 0) {
    return { model: incumbent, reason: `no ${agent} model meets the ${TIER_BY_RANK[targetRank]} target above the ${floorScore} floor`, alternatives: [], changed: false };
  }

  const winner = band[0].candidate;
  const winnerKey = band[0].key;
  return {
    model: winner,
    reason: explain({ agent, tierName: TIER_BY_RANK[tierRank(band[0].tier)], preset: policy?.preset, winner, cost: band[0].marginalCost }),
    alternatives: band.slice(1, 4).map((a) => a.candidate),
    changed: !incumbent || endpointKey(incumbent) !== winnerKey,
  };
}
