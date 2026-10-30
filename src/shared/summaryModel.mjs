// summaryModel.mjs — which connected model writes handoffs after a long break,
// session titles and remembered instructions (cold-cache handoff spec, Part A).
//
// PURE: the server joins its inputs (connected models, catalogue match, list
// price) and passes them in; nothing here reads a clock, a file or the network.
//
//   eligible  hard gates: what the picker may show at all
//   quality   gate for the AUTOMATIC pick only (a user may choose any eligible model)
//   pick      subscription models first (flat fee), then the cheapest by list price

import { isDeprecated, readModalities, tierRank } from "./modelGuide.mjs";
import { qualityScore, tierForScore } from "./modelQuality.mjs";

/** Smallest context window a summary model may have (it has to hold a condensed transcript). */
export const SUMMARY_MIN_CONTEXT = 64_000;
/** The shortlist the picker shows. */
export const SUMMARY_SHORTLIST_MAX = 30;
/** The most results one search returns. */
export const SUMMARY_SEARCH_MAX = 50;
/** A benchmark percentile below this never qualifies for the automatic pick. */
export const SUMMARY_MIN_BENCH_PERCENTILE = 0.2;
/** A handoff reads ~25× more than it writes: blended price = input + output / 25. */
export const SUMMARY_OUTPUT_WEIGHT = 25;

export const NO_CAPABLE_MODEL_REASON =
  "No connected model is known to be capable enough. Choose one in Settings, or handoffs after a long break will re-read the whole conversation.";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** PURE. The hard gates (A3 step 1). Free-tier `opencode` models, tiny windows and non-text models are out. */
export function isEligibleSummaryModel(model) {
  if (!model || typeof model !== "object") return false;
  if (typeof model.providerID !== "string" || !model.providerID) return false;
  if (typeof model.id !== "string" || !model.id) return false;
  if (isDeprecated(model)) return false;
  if (model.providerID === "opencode") return false;
  const ctx = model.limit?.context;
  if (!isNum(ctx) || ctx < SUMMARY_MIN_CONTEXT) return false;
  const out = readModalities(model.capabilities?.output);
  if (out.length > 0 && !out.includes("text")) return false; // [] = unknown, never "supports nothing"
  return true;
}

/** PURE. Blended $/M for ranking, or null when the model is unpriced. */
export function blendedPrice(listPrice) {
  if (!listPrice || !isNum(listPrice.input) || !isNum(listPrice.output)) return null;
  return listPrice.input + listPrice.output / SUMMARY_OUTPUT_WEIGHT;
}

const fmtRate = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** PURE. "$0.80 / $4 per M", "subscription", or null when nothing is known. */
export function priceLabelFor({ listPrice, subscription }) {
  if (subscription) return "subscription";
  if (!listPrice || !isNum(listPrice.input) || !isNum(listPrice.output)) return null;
  return `$${fmtRate(listPrice.input)} / $${fmtRate(listPrice.output)} per M`;
}

const keyOf = (c) => `${c.providerID}/${c.modelID}`;
const byPrice = (a, b) => {
  if (a.blended === null && b.blended === null) return 0;
  if (a.blended === null) return 1;
  if (b.blended === null) return -1;
  return a.blended - b.blended;
};
const byScoreThenId = (a, b) => b.score - a.score || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

/**
 * PURE. Rank every eligible model.
 *
 * `candidates` is the FULL eligible set, ordered: quality-passing models in pick
 * order (connected-subscription ones first), then the rest by price. `pick` is
 * the first of them when it passes the quality gate, else null.
 *
 * @param {{
 *   entries: Array<{ model: any, catalogEntry?: any, listPrice?: any }>,
 *   field?: { benchmarkPercentile?: (name: string, score: number) => number|null } | null,
 *   subscriptionIds?: Set<string>,
 * }} a
 */
export function rankSummaryModels({ entries, field = null, subscriptionIds = new Set() } = {}) {
  const all = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const model = e?.model;
    if (!isEligibleSummaryModel(model)) continue;
    const q = qualityScore(model, e.catalogEntry ?? null, field);
    const passes = (q.basis === "benchmark" && q.score >= SUMMARY_MIN_BENCH_PERCENTILE) || q.basis === "family";
    const subscription = subscriptionIds.has(model.providerID);
    const listPrice = e.listPrice ?? null;
    all.push({
      model,
      providerID: model.providerID,
      modelID: model.id,
      name: typeof model.name === "string" && model.name ? model.name : model.id,
      listPrice,
      blended: blendedPrice(listPrice),
      score: q.score,
      basis: q.basis,
      subscription,
      qualityKnown: passes,
      recommended: false,
      priceLabel: priceLabelFor({ listPrice, subscription }),
    });
  }
  const subs = all.filter((c) => c.qualityKnown && c.subscription);
  const paid = all.filter((c) => c.qualityKnown && !c.subscription);
  const rest = all.filter((c) => !c.qualityKnown);
  subs.sort((a, b) => tierRank(tierForScore(a.score)) - tierRank(tierForScore(b.score)) || byPrice(a, b) || byScoreThenId(a, b));
  paid.sort((a, b) => byPrice(a, b) || byScoreThenId(a, b));
  rest.sort((a, b) => byPrice(a, b) || byScoreThenId(a, b));
  const candidates = [...subs, ...paid, ...rest];
  const first = candidates[0];
  const pick = first && first.qualityKnown ? first : null;
  if (pick) pick.recommended = true;
  return { candidates, pick, reason: pick ? undefined : NO_CAPABLE_MODEL_REASON };
}

/** PURE. Eligible candidates whose name / id / provider contains `query` (case-insensitive), in rank order, capped. */
export function searchSummaryCandidates(candidates, query, limit = SUMMARY_SEARCH_MAX) {
  const q = String(query ?? "").trim().toLowerCase();
  const list = Array.isArray(candidates) ? candidates : [];
  const hits = q
    ? list.filter((c) => `${c.name} ${c.modelID} ${c.providerID} ${c.providerID}/${c.modelID}`.toLowerCase().includes(q))
    : list;
  return hits.slice(0, limit);
}

/**
 * PURE. The picker shortlist: at most SUMMARY_SHORTLIST_MAX entries; a valid
 * current model is always among them (it replaces the last entry when ranked lower).
 */
export function shortlist(candidates, current = null, max = SUMMARY_SHORTLIST_MAX) {
  const list = Array.isArray(candidates) ? candidates : [];
  const top = list.slice(0, max);
  if (current && !top.some((c) => c.providerID === current.providerID && c.modelID === current.modelID)) {
    const cur = list.find((c) => c.providerID === current.providerID && c.modelID === current.modelID);
    if (cur) {
      if (top.length >= max) top.pop();
      top.push(cur);
    }
  }
  return top;
}

/** PURE. The client-facing candidate row. */
export function publicCandidate(c) {
  return {
    providerID: c.providerID,
    modelID: c.modelID,
    name: c.name,
    priceLabel: c.priceLabel,
    recommended: c.recommended === true,
    qualityKnown: c.qualityKnown === true,
  };
}
