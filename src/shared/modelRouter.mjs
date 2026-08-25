// modelRouter.mjs — the pure routing decision core (no wiring).
//
// BET-1236 restructured this around ENDPOINTS (a `(model, provider)` pair)
// with an explicit hard/soft filter split. Cost, quality, identity,
// eligibility, reliability and health all live OUT of this file in the
// Stage-2 modules it consumes (marginalCost ~> blendedPrice, modelQuality,
// modelIdentity, autoEligibility, toolReliability + injected health). Pure,
// no node: imports, no Date.now() — time arrives as `nowMs`. No provider NAME
// ever appears here or in its imports.

import { tierRank, acceptsModality } from "./modelGuide.mjs";
import { endpointKey } from "./endpointKey.mjs";
import { qualityScore, tierForScore, meetsFloor, AGENT_FLOOR_SCORE } from "./modelQuality.mjs";
import { resolveIdentity } from "./modelIdentity.mjs";
import { autoEligibility, MISSING } from "./autoEligibility.mjs";
import { marginalCost } from "./marginalCost.mjs";
import { blendedPrice } from "./blendedPrice.mjs";
import { shouldDerank } from "./toolReliability.mjs";

// The inspectable decision record (BET-1265). `quality.basis` and `cost.basis`
// are passed through VERBATIM from qualityScore / marginalCost — never
// re-mapped or prettified. `reliability` is "measured" when a sample exists on
// the box, "unmeasured" otherwise.
/**
 * @typedef {object} RoutingSignals
 * @property {{ score: number, basis: "benchmark"|"family"|"structural", known: boolean }} quality
 * @property {{ value: number, basis: string, mixSource: "measured"|"default",
 *              reference: "catalogue"|"absent" }} cost
 * @property {"measured"|"unmeasured"} reliability
 * @property {{ p50Ms: number|null, p90Ms: number|null, tokensPerSec: number|null }} telemetry
 */

/**
 * @typedef {object} RoutingTrace
 * @property {number} considered
 * @property {{ stage: "eligible"|"capable", reason: string, n: number }[]} dropped
 * @property {{ contextTokens: number, needs: { tools: boolean, image: boolean, pdf: boolean } }} intent
 * @property {{ tier: string, floorTier: string, widened: boolean }} target
 * @property {RoutingSignals|null} winner
 */

export const AGENT_TIER = {
  economy: { build: "balanced", plan: "deep", general: "fast", explore: "fast" },
  balanced: { build: "deep", plan: "deep", general: "balanced", explore: "fast" },
  performance: { build: "deep", plan: "deep", general: "deep", explore: "balanced" },
};

const BINDING_ORDER = [
  "context headroom", "tool calling", "image input", "pdf input",
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

// Hard Stage 2 — the capability reason an endpoint cannot do THIS turn. Every
// `needs.*` stays hard, but the parser PERMISSIVE-missing (an unknown / absent
// capability set reads as allow — `readModalities` returns [] for "no
// information" and that is never "supports nothing").
function capabilityDrop(m, { contextTokens, needs, health }) {
  // No `status` check here: an opted-in deprecated model passed the routable
  // catalogue (listRoutableModels) and must not be re-litigated at the decision
  // core. The router trusts its input catalogue for status.
  if (typeof m?.limit?.context === "number" && m.limit.context < contextTokens * 1.25) return "context headroom";
  if (needs.tools === true && m?.capabilities?.toolcall === false) return "tool calling";
  if (needs.image === true && !acceptsModality(m, "image")) return "image input";
  if (needs.pdf === true && !acceptsModality(m, "pdf")) return "pdf input";
  const hs = HEALTH_EXCLUDED[health?.[m.providerID]];
  return hs ?? null;
}

// Assess one endpoint once — Hard Stage 1 (eligibility), marginal cost and
// reliability — everything the hard and soft stages read. The shadow price is
// folded in HERE (the full `services` bag is visible), never inside the
// comparator, which only sees the reduced {preset, telemetry, health} object.
function assess(candidate, { nowMs, replacementCost, expectedTurnTokens, isLowStakes }, services) {
  const key = endpointKey(candidate);
  const dec = services.declared?.[key] ?? null;
  const identity = resolveIdentity(candidate, dec, services.catalogMatcher);
  // The endpoint AS WE UNDERSTAND IT: the provider's credible claims, with the
  // catalogue's facts filling the gaps and the user's declaration on top.
  // Everything downstream judges THIS, never the raw provider payload — which
  // may report `limit.context: 0` / empty `cost` as false "claims" (BET-1268).
  // `candidate` stays the identity of the endpoint (winner + endpointKey); only
  // its description is merged.
  const m = identity.effective ?? candidate;
  const catalogEntry = typeof services.catalogEntryFor === "function" ? services.catalogEntryFor(candidate) : null;
  const quality = qualityScore(m, catalogEntry, services.qualityField);
  const perMix = mixFor(services, key);
  const ref = referenceFor(dec, services, candidate);
  const elig = autoEligibility({
    model: m,
    identity: { known: identity.state === "resolved" },
    quality,
    declared: dec,
    providerClass: services.providerClass?.[candidate.providerID] ?? "supported",
  });
  const mc = marginalCost({
    model: m,
    account: services.accounts?.[candidate.providerID],
    nowMs,
    mix: perMix,
    reference: ref,
    replacementCost,
    // Optimizer P2.3 (BET-1345): the pacing shadow price for THIS provider,
    // additive on top of the subscription pace curve. Absent → marginalCost
    // prices exactly as today (the whole on/under-pace regime is preserved).
    expectedTurnTokens,
    isLowStakes,
    shadowPrice: services.pressure?.[candidate.providerID],
  });
  // The raw mix/reference flags blendedPrice already computed with the SAME
  // inputs marginalCost handed it — reported verbatim, not recomputed. This is
  // what makes a silently-defaulted mix / absent catalogue visible (BET-1265).
  const bp = blendedPrice(m, perMix, ref);
  // 7d: three-valued reliability rank (0 measured, 1 unmeasured, 2 deranked),
  // NOT the old binary "penalise?" — an unmeasured endpoint is treated as
  // average, never as good (a binary flag made it identical to a measured-
  // reliable one).
  const rank = shouldDerank(services.reliability?.samples?.[key], services.reliability?.baseline?.[candidate.id]).rank;
  const rankIsNum = typeof rank === "number" && Number.isFinite(rank);
  return {
    key,
    candidate,
    effective: m,
    quality,
    qualityScore: quality.known ? quality.score : 0,
    tier: tierForScore(quality.known ? quality.score : undefined),
    eligible: elig.eligible,
    missing: elig.missing,
    marginalCost: mc.exhausted ? Infinity : mc.cost,
    exhausted: mc.exhausted,
    costBasis: mc.basis,
    mixSource: bp.mixSource,
    reference: bp.reference,
    reliability: services.reliability?.samples?.[key] ? "measured" : "unmeasured",
    telemetry: services.telemetry?.[key] ?? {},
    rank: rankIsNum ? rank : 1,
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

// The reference price to judge implausible-zero against, or null when the user
// has declared a price for this endpoint (a declaration — including "free" —
// is authoritative; it must not be re-classified by the catalogue).
function referenceFor(dec, services, endpoint) {
  return dec?.price !== undefined ? null : services.referenceByModel?.[endpoint?.id];
}

// The mix for one endpoint: its own measured ledger mix, else the box's overall
// measured mix, else absent (falls back to DEFAULT_MIX inside blendedPrice).
function mixFor(services, key) {
  return services.mix?.[key] ?? services.mixDefault;
}

// The subscription exchange rate needs "the cheapest acceptable alternative":
// the minimum blended price across every non-subscription endpoint in the
// candidate set. Computed once per decision, before the per-candidate loop.
function computeReplacementCost(catalog, services) {
  let best = null;
  for (const c of Array.isArray(catalog) ? catalog : []) {
    if (c === null || typeof c !== "object") continue;
    const account = services.accounts?.[c?.providerID] ?? null;
    if (account?.kind === "subscription") continue;
    const key = endpointKey(c);
    const dec = services.declared?.[key] ?? null;
    const identity = resolveIdentity(c, dec, services.catalogMatcher);
    const m = identity.effective ?? c;
    const price = blendedPrice(m, mixFor(services, key), referenceFor(dec, services, c)).price;
    if (best === null || price < best) best = price;
  }
  return best === null ? undefined : best;
}

const num0 = (v) => (isNum(v) ? v : 0);
const numInf = (v) => (isNum(v) ? v : Infinity);
const telemetryOf = (a, services) => services.telemetry?.[a.key] ?? {};

// The winner's cache-WRITE price per token, taken from the SAME cost rates
// blendedPrice reads (a missing cacheWrite bills at the input rate — BET-1269 5a
// semantics). Returns null when neither rate is a finite number (price unknown →
// the rewarm cost is unknown → the rewarm hysteresis term is skipped).
function cacheWritePriceOf(model) {
  const cost = model && typeof model.cost === "object" ? model.cost : null;
  if (!cost) return null;
  if (isNum(cost.cacheWrite)) return cost.cacheWrite;
  return isNum(cost.input) ? cost.input : null;
}

// The winner's inspectable signals, read off the assessed entry — every value
// was already computed during assess(); nothing new is derived here.
function signalsOf(a) {
  return {
    quality: {
      score: a.quality.score,
      basis: a.quality.basis,
      known: a.quality.known,
    },
    cost: {
      value: a.marginalCost,
      basis: a.costBasis,
      mixSource: a.mixSource,
      reference: a.reference,
    },
    reliability: a.reliability,
    telemetry: {
      p50Ms: typeof a.telemetry?.p50Ms === "number" ? a.telemetry.p50Ms : null,
      p90Ms: typeof a.telemetry?.p90Ms === "number" ? a.telemetry.p90Ms : null,
      tokensPerSec: typeof a.telemetry?.tokensPerSec === "number" ? a.telemetry.tokensPerSec : null,
    },
  };
}

// BET-1270 6e: is the incumbent still describable by Auto (the completeness
// gate)? The renderer's hysteresis (shouldSwitch) needs this to force a switch
// off an incumbent Auto can no longer describe — computed here, server-side,
// from the SAME assess machinery, so the renderer keeps no eligibility state of
// its own (one round trip, one source of truth).
export function incumbentStillEligible(candidate, services) {
  if (!candidate || typeof candidate !== "object") return true;
  const key = endpointKey(candidate);
  const dec = services?.declared?.[key] ?? null;
  const identity = resolveIdentity(candidate, dec, services?.catalogMatcher);
  const m = identity.effective ?? candidate;
  const catalogEntry =
    typeof services?.catalogEntryFor === "function" ? services.catalogEntryFor(candidate) : null;
  const quality = qualityScore(m, catalogEntry, services?.qualityField);
  const elig = autoEligibility({
    model: m,
    identity: { known: identity.state === "resolved" },
    quality,
    declared: dec,
    providerClass: services?.providerClass?.[candidate.providerID] ?? "supported",
  });
  return elig.eligible;
}

function healthRank(a, services) {
  const providerID = a?.candidate?.providerID ?? a?.effective?.providerID;
  const st = services?.health?.[providerID];
  // Only `failing` is a soft/deprioritised signal here. `out-of-credit` and
  // `rate-limited` never reach the ordering — they are EXCLUDED (hard) in
  // capabilityDrop, so a survivor's health is either ok or failing.
  return st === "failing" ? 1 : 0;
}

// Soft ordering within a competing set (same model, or a flattened economy
// set): reliability RANK sorts first (0 measured-reliable, 1 unmeasured, 2
// deranked — BET-1270 6a placed reliability before cost); then a soft
// `failing` health sorts behind a healthy endpoint; then cost; then quality,
// throughput (p50 then p90), the latency percentiles (p50 then p90), and
// finally the full provider/model key — deterministic (the model id alone is
// identical for exactly the endpoints most likely to tie, so the old final
// tie-break was deterministic by accident). `latencyMs` is gone (7e): it was a
// duplicate of p90Ms and the p90 throughput the ledger emits was discarded.
function cmpWithinModel(a, b, services) {
  const ra = typeof a.rank === "number" ? a.rank : 1;
  const rb = typeof b.rank === "number" ? b.rank : 1;
  if (ra !== rb) return ra - rb;
  const ha = healthRank(a, services);
  const hb = healthRank(b, services);
  if (ha !== hb) return ha - hb;
  if (a.marginalCost !== b.marginalCost) return a.marginalCost - b.marginalCost;
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
  const ta = telemetryOf(a, services);
  const tb = telemetryOf(b, services);
  const tsA = num0(ta.tokensPerSec);
  const tsB = num0(tb.tokensPerSec);
  if (tsA !== tsB) return tsB - tsA;
  const p90tsA = num0(ta.p90TokensPerSec);
  const p90tsB = num0(tb.p90TokensPerSec);
  if (p90tsA !== p90tsB) return p90tsB - p90tsA;
  const p50A = numInf(ta.p50Ms);
  const p50B = numInf(tb.p50Ms);
  if (p50A !== p50B) return p50A - p50B;
  const p90A = numInf(ta.p90Ms);
  const p90B = numInf(tb.p90Ms);
  if (p90A !== p90B) return p90A - p90B;
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
    return `${agent} → ${tierName} tier (economy): ${endpointKey(winner)} cheapest at $${cost.toFixed(4)}`;
  }
  return `${agent} → ${tierName} tier: ${endpointKey(winner)}`;
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
 * @returns {{ model: object|null, reason: string, alternatives: object[], changed: boolean, trace: object }}
 */
export function chooseModel(input = {}) {
  const { intent = {}, catalog = [], policy = {}, nowMs = 0 } = input;
  const services = input.services && typeof input.services === "object" ? input.services : {};
  const agent = intent?.agent ?? "general";
  const incumbent = intent?.incumbent ?? null;
  // Echoes back EXACTLY what the caller passed — unmodified, never the
  // normalised `contextTokens`. A caller hardcoding contextTokens: 0 becomes
  // visible here (BET-1265) without reading the caller.
  const traceIntent = {
    contextTokens: intent?.contextTokens,
    needs: intent?.needs ?? {},
  };

  if (intent?.kind === "mid-exchange") {
    return {
      model: incumbent,
      reason: "mid-exchange switching is disabled",
      alternatives: [],
      changed: false,
      trace: { considered: 0, dropped: [], intent: traceIntent, target: { tier: "", floorTier: "", widened: false }, winner: null },
    };
  }
  // Off-path (no routing directive): return the incumbent BY REFERENCE,
  // byte-identical so a box without routing behaves exactly as before.
  if (!routingActive(policy)) {
    return {
      model: incumbent,
      reason: "routing not activated for this conversation",
      alternatives: [],
      changed: false,
      trace: { considered: 0, dropped: [], intent: traceIntent, target: { tier: "", floorTier: "", widened: false }, winner: null },
    };
  }

  const needs = intent?.needs ?? {};
  // contextTokens arrives as the real conversation size; an absent value is a
  // caller bug — let the headroom check SKIP (undefined * 1.25 = NaN never
  // < limit) rather than silently passing 0, which would read as "zero
  // tokens" and lie about how full the context is.
  const hardCtx = { contextTokens: typeof intent?.contextTokens === "number" ? intent.contextTokens : undefined, needs, health: services.health };

  const survivors = [];
  const counts = {};
  const drops = [];
  let considered = 0;
  // The subscription exchange rate anchors to the cheapest non-subscription
  // endpoint's blended price — computed once, before the per-candidate loop.
  const replacementCost = computeReplacementCost(catalog, services);
  // Optimizer P2.3 (BET-1345): the pacing shadow price is sized by the turn's
  // expected tokens and stakes. `expectedTurnTokens` is the real conversation
  // size when it is a finite number, else omitted → no pressure. A "low-stakes"
  // turn (general/explore) is the one the newsvendor protection multiplier can
  // inflate — build/plan work keeps its quality floor regardless of pressure.
  const expectedTurnTokens =
    isNum(intent?.contextTokens) && intent.contextTokens > 0 ? intent.contextTokens : undefined;
  const isLowStakes = agent === "general" || agent === "explore";
  const addDrop = (stage, reason) => {
    const existing = drops.find((d) => d.stage === stage && d.reason === reason);
    if (existing) existing.n += 1;
    else drops.push({ stage, reason, n: 1 });
  };
  for (const c of Array.isArray(catalog) ? catalog : []) {
    considered += 1;
    const a = assess(c, { nowMs, replacementCost, expectedTurnTokens, isLowStakes }, services);
    const cap = capabilityDrop(a.effective ?? a.candidate, hardCtx);
    if ((a.exhausted && !cap) || cap || !a.eligible) {
      const label = bindLabel(a, cap);
      counts[label] = (counts[label] ?? 0) + 1;
      // "capable" = can't do THIS turn (missing capability / exhausted);
      // "eligible" = not admissible by the completeness rules at all.
      addDrop(cap || a.exhausted ? "capable" : "eligible", label);
      continue;
    }
    survivors.push(a);
  }

  // Eco (Optimizer P2.3): `policy.preset` stays whatever config holds
  // ("balanced" — the preset key is retained + pinned, never removed). The
  // EFFECTIVE preset is "economy" only while the box is under eco pressure
  // (services.ecoLevel >= 2), which moves the TARGET tier (and stage3Order's
  // flattening) down for cheap endpoints — but it NEVER relaxes AGENT_FLOOR_SCORE
  // / meetsFloor: build and plan keep their quality floor no matter how much
  // pressure the box is under. Eco moves the target, never the floor.
  const ecoLevel = services.ecoLevel ?? 0;
  const effectivePreset = ecoLevel >= 2 ? "economy" : policy?.preset;
  const targetRaw = policy?.perAgent?.[agent] ?? AGENT_TIER?.[effectivePreset]?.[agent] ?? "balanced";
  const floorScore = AGENT_FLOOR_SCORE[agent] ?? 0;
  const targetRank = Math.max(tierRank(targetRaw), tierRank(tierForScore(floorScore)));
  const targetTrace = {
    tier: TIER_BY_RANK[targetRank],
    floorTier: tierForScore(floorScore),
    widened: false,
    eco: ecoLevel,
  };

  if (survivors.length === 0) {
    return {
      model: incumbent,
      reason: `no ${agent} model passes constraints (${bindingReason(counts)})`,
      alternatives: [],
      changed: false,
      trace: { considered, dropped: drops, intent: traceIntent, target: targetTrace, winner: null },
    };
  }

  const explored = stage3Order(survivors, { preset: effectivePreset, telemetry: services.telemetry, health: services.health });
  const band = selectBand(explored, targetRank, agent);
  if (band.length === 0) {
    return {
      model: incumbent,
      reason: `no ${agent} model meets the ${TIER_BY_RANK[targetRank]} target above the ${floorScore} floor`,
      alternatives: [],
      changed: false,
      trace: { considered, dropped: drops, intent: traceIntent, target: targetTrace, winner: null },
    };
  }

  const winnerEntry = band[0];
  const winner = winnerEntry.candidate;
  const winnerKey = winnerEntry.key;
  // Optimizer P2.3 (BET-1345): a minimal COST accessor so the wiring can
  // report savingsPerTurn / rewarmCost WITHOUT re-running assess(). `incumbent`
  // is the catalogIncumbent projection; when it survived routing it has an
  // assessed cost here, else null (shouldSwitch will have forced the switch).
  const incumbentEntry = incumbent
    ? (survivors.find((a) => endpointKey(a.candidate) === endpointKey(incumbent)) ?? null)
    : null;
  return {
    model: winner,
    reason: explain({ agent, tierName: TIER_BY_RANK[tierRank(band[0].tier)], preset: effectivePreset, winner, cost: winnerEntry.marginalCost }),
    alternatives: band.slice(1, 4).map((a) => a.candidate),
    changed: !incumbent || endpointKey(incumbent) !== winnerKey,
    costs: {
      winner: winnerEntry.marginalCost,
      incumbent: incumbentEntry ? incumbentEntry.marginalCost : null,
      winnerCacheWritePrice: cacheWritePriceOf(winnerEntry.effective ?? winnerEntry.candidate),
    },
    trace: {
      considered,
      dropped: drops,
      intent: traceIntent,
      target: { ...targetTrace, widened: tierRank(band[0].tier) !== targetRank },
      winner: signalsOf(band[0]),
    },
  };
}

/**
 * The single [router] decision line (BET-1301). Prints the decision's INPUTS
 * (conversation size + what the turn needed) alongside its outputs, so a
 * decision is auditable from the log alone. Pure: takes data, returns a
 * string, no I/O / clock / console. Every field falls back independently —
 * a partial or null decision yields a well-formed line, never a throw.
 *
 * @param {object|null} decision the chooseModel result (or null)
 * @param {{ surface: "main"|"sub", agent: string }} ctx
 * @returns {string} the complete line, `[router] ` prefix included
 */
export function describeDecision(decision, { surface, agent }) {
  const trace = decision?.trace;
  const w = endpointKey(decision?.model) || "-";

  // ctx: print the real conversation size verbatim when it is a number (0
  // included — a caller bug must stay visible). Never coerce absent to 0.
  const ctxTokens = trace?.intent?.contextTokens;
  const ctx = typeof ctxTokens === "number" ? String(ctxTokens) : "absent";

  // needs: the keys whose value is true, sorted alphabetically (deterministic
  // and testable), comma-joined with no spaces.
  const needs = trace?.intent?.needs;
  const needKeys =
    needs && typeof needs === "object"
      ? Object.keys(needs)
          .filter((k) => needs[k] === true)
          .sort()
      : [];
  const needsStr = needKeys.length > 0 ? needKeys.join(",") : "none";

  const considered = trace?.considered ?? 0;
  const dropped = Array.isArray(trace?.dropped)
    ? trace.dropped.reduce((sum, d) => sum + (d?.n ?? 0), 0)
    : 0;
  const basis = trace?.winner?.cost?.basis ?? "none";
  const mix = trace?.winner?.cost?.mixSource ?? "default";
  const reason = decision?.reason || "-";

  return `[router] ${surface}/${agent} → ${w} · ctx=${ctx} needs=${needsStr} · considered=${considered} dropped=${dropped} · ${basis} mix=${mix} · ${reason}`;
}
