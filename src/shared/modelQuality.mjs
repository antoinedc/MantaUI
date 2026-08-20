// modelQuality.mjs — a model's position in the field it is competing in.
//
// Pure, injected inputs only. There is no I/O and nothing is fetched: the
// catalogue entry and the percentile helper arrive as arguments. This is the
// replacement for the hand-maintained tier table (the `tier` field in
// modelGuide.mjs's CATALOG): a percentile re-ranks itself for free whenever
// the field moves, instead of going stale by construction.
//
// The model argument is an `OpencodeModel` (id, providerID, family,
// capabilities.reasoning, limit.{context,output}, cost). Fields are read
// defensively so a not-yet-normalised model degrades gracefully.
//
// The caller decides policy. A result with `known: false` means "not a
// routing candidate" — that policy is applied by the caller, not encoded
// here.

import { FAMILY_TIERS } from "./modelGuide.mjs";

/** The three routing tiers, ordered: fast < balanced < deep. */
export const TIERS = ["fast", "balanced", "deep"];

// Percentile bands. Declared here and nowhere else:
//   fast < 0.4 <= balanced < 0.7 <= deep
const BALANCED_MIN = 0.4;
const DEEP_MIN = 0.7;

// Seeded family scores keep already-covered families in the tier their
// hand-maintained label gives them today (fast -> 0.25, balanced -> 0.55,
// deep -> 0.85), which the bands above map back to the identical tier.
const SEED_BY_TIER = { fast: 0.25, balanced: 0.55, deep: 0.85 };

// Family -> representative score, seeded from the modelGuide CATALOG tier
// labels. A family not present here (e.g. newly added to CATALOG) has no
// seed yet, so its quality falls through to structural — the drift would be
// caught by the "no regression for covered families" test.
export const FAMILY_SEED_SCORES = Object.fromEntries(
  Object.entries(FAMILY_TIERS).map(([family, tier]) => [
    family,
    SEED_BY_TIER[tier] ?? SEED_BY_TIER.balanced,
  ]),
);

/** Minimum score an agent may run on. Replaces AGENT_FLOOR's tier names. */
export const AGENT_FLOOR_SCORE = {
  build: BALANCED_MIN, // >= balanced
  plan: DEEP_MIN, // >= deep
  general: BALANCED_MIN, // >= balanced
  explore: 0, // >= fast
  title: 0, // >= fast
};

const BENCH_PREFERENCE = [
  "SWE-Bench Verified",
  "SWE-Bench Pro",
  "Terminal-Bench",
  "Aider Polyglot",
];

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// The most coding-relevant benchmark the catalogue entry carries (in
// preference order), or null when none is present with a numeric score.
function pickBenchmark(benchmarks) {
  if (!Array.isArray(benchmarks)) return null;
  for (const name of BENCH_PREFERENCE) {
    const b = benchmarks.find(
      (x) =>
        x &&
        x.name === name &&
        typeof x.score === "number" &&
        Number.isFinite(x.score),
    );
    if (b) return b;
  }
  return null;
}

function hasAnyCost(cost) {
  if (!cost || typeof cost !== "object") return false;
  return Object.values(cost).some(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

// A coarse structural placement once a model has actual structural data
// (reasoning flag, context/output limits, or a price). Returns null when the
// model carries none of those signals — that is the "nothing" path, known:false.
function structuralScore(m) {
  const reasoning = m?.capabilities?.reasoning;
  const ctx = m?.limit?.context;
  const out = m?.limit?.output;
  const cost = m?.cost;
  const hasSignal =
    typeof reasoning === "boolean" ||
    typeof ctx === "number" ||
    typeof out === "number" ||
    hasAnyCost(cost);
  if (!hasSignal) return null;

  let score = 0.5;
  if (reasoning === true) score += 0.2;
  if (typeof ctx === "number") {
    if (ctx >= 200000) score += 0.15;
    else if (ctx > 64000) score += 0.05;
    else if (ctx < 16000) score -= 0.1;
  }
  const total =
    (typeof cost?.input === "number" ? cost.input : 0) +
    (typeof cost?.output === "number" ? cost.output : 0);
  if (total >= 60) score += 0.1;
  else if (total > 0 && total < 2) score -= 0.15;
  return { score: clamp01(score) };
}

/**
 * A model's position in the field it is competing in, 0..1 (1 = strongest).
 *
 * Derivation order — first that yields a result wins:
 *   1. Benchmark. The best coding-relevant benchmark, converted to a
 *      percentile of the models we can currently see via the injected
 *      `field` helper. `basis: "benchmark"`, `known: true`.
 *   2. Family. The model's family from the catalogue (authoritative — never
 *      a regex on the id) with a seeded score. `basis: "family"`, `known: true`.
 *   3. Structural. Coarse placement from capabilities.reasoning /
 *      limit.context / limit.output / price band. `basis: "structural"`,
 *      `known: true`.
 *   4. Nothing. `known: false`, score 0. The caller decides whether an
 *      unknown model is a routing candidate — not encoded here.
 *
 * @param {object} model            OpencodeModel (family, capabilities.reasoning, limit, cost)
 * @param {object} [catalogEntry]   provider-agnostic catalogue entry:
 *                                  { family, benchmarks: [{name, score, metric}], reasoning, limit }
 * @param {object} [field]          { benchmarkPercentile(name, score) } — injected ranking helper
 * @returns {{ score: number, basis: "benchmark"|"family"|"structural", known: boolean }}
 */
export function qualityScore(model, catalogEntry, field) {
  const ce = catalogEntry && typeof catalogEntry === "object" ? catalogEntry : {};
  const m = model && typeof model === "object" ? model : {};

  // 1. Benchmark
  const bench = pickBenchmark(ce.benchmarks);
  if (bench && typeof field?.benchmarkPercentile === "function") {
    const pct = field.benchmarkPercentile(bench.name, bench.score);
    if (typeof pct === "number" && Number.isFinite(pct)) {
      return { score: clamp01(pct), basis: "benchmark", known: true };
    }
  }

  // 2. Family (from the catalogue, authoritatively; never a regex on the id)
  const family = typeof ce.family === "string" ? ce.family : m.family;
  const seed = typeof family === "string" ? FAMILY_SEED_SCORES[family] : undefined;
  if (typeof seed === "number") {
    return { score: seed, basis: "family", known: true };
  }

  // 3. Structural
  const structural = structuralScore(m);
  if (structural !== null) {
    return { score: structural.score, basis: "structural", known: true };
  }

  // 4. Nothing
  return { score: 0, basis: "structural", known: false };
}

/**
 * Which tier band a score falls in. Bands are percentile ranges, declared
 * here and nowhere else: fast < 0.4 <= balanced < 0.7 <= deep.
 *
 * @param {number|undefined} score
 * @returns {string}
 */
export function tierForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return TIERS[1];
  if (score < BALANCED_MIN) return TIERS[0];
  if (score < DEEP_MIN) return TIERS[1];
  return TIERS[2];
}

/**
 * Whether a score is high enough for a given agent. Floors map to the same
 * effective tiers AGENT_FLOOR encoded: build/general >= balanced,
 * plan >= deep, explore/title >= fast. An unknown agent has no floor.
 *
 * @param {number|undefined} score
 * @param {string} agent
 * @returns {boolean}
 */
export function meetsFloor(score, agent) {
  const floor = AGENT_FLOOR_SCORE[agent];
  if (floor === undefined) return true;
  return typeof score === "number" && Number.isFinite(score) && score >= floor;
}
