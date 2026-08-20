// modelRouter.mjs — the pure routing decision core (no wiring).
//
// All model-routing intelligence lives here in ONE pure, fully-tested module
// with no I/O, so the server and renderer can never disagree and the logic is
// testable without a live provider. It changes no behaviour on its own; the
// caller (a separate issue) wires it in. Pure + framework-free (no node:)
// imports, no fetch, no Date.now() — time arrives as `nowMs`.

import { describeModel, tierRank } from "./modelGuide.mjs";

export const PRESETS = ["economy", "balanced", "performance"];

/** Tier a given agent must never drop below. */
export const AGENT_FLOOR = {
  build: "balanced",
  plan: "deep",
  general: "balanced",
  explore: "fast",
  title: "fast",
};

/** Preferred tier per agent, per preset. Pure lookup table, no inference. */
export const AGENT_TIER = {
  economy: { build: "balanced", plan: "deep", general: "fast", explore: "fast" },
  balanced: { build: "deep", plan: "deep", general: "balanced", explore: "fast" },
  performance: { build: "deep", plan: "deep", general: "deep", explore: "balanced" },
};

/** Comparable price baseline, in dollars, used to blend quota scarcity in. */
export const REFERENCE_PRICE = 30;

/** Floor price for a genuinely free model with no quota window. */
export const FREE_FLOOR = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;
const TIER_NAMES = ["fast", "balanced", "deep"];

// "providerID/modelID" — the identity used for telemetry lookups.
function modelKey(m) {
  return m ? `${m?.providerID ?? ""}/${m?.id ?? ""}` : "";
}

// The effective tier of a model; unrecognized families default to "balanced".
function tierOf(m) {
  const info = describeModel(m?.providerID, m?.id);
  return info && info.tier ? info.tier : "balanced";
}

// Which quota windows belong to a provider, choosing the highest-scarcity one
// when several exist.
function pickWindow(providerID, quota, nowMs) {
  const windows = (quota ?? []).filter(
    (w) => Array.isArray(w?.providerIDs) && w.providerIDs.includes(providerID),
  );
  if (windows.length === 0) return null;
  let best = windows[0];
  let bestS = scarcity(best, nowMs);
  for (let i = 1; i < windows.length; i++) {
    const s = scarcity(windows[i], nowMs);
    if (s > bestS) {
      best = windows[i];
      bestS = s;
    }
  }
  return best;
}

/**
 * Drop models that cannot do the job. Pure.
 *
 * A model is dropped when any constraint is violated:
 *   - `model.status` is present and !== "active"
 *   - `model.limit?.context` is a number and < contextTokens * 1.25
 *   - `needs.tools === true` and `model.capabilities?.toolcall === false`
 *   - `needs.image === true` and `model.capabilities?.input?.image !== true`
 *   - `needs.pdf === true` and `model.capabilities?.input?.pdf !== true`
 *
 * Missing/undefined metadata is permissive (never drops) — except `status`,
 * handled above.
 *
 * @param {Array<object>} models
 * @param {{ contextTokens?: number, needs?: { tools?: boolean, image?: boolean, pdf?: boolean } }} [opts]
 * @returns {Array<object>}
 */
export function filterByConstraints(models, { contextTokens = 0, needs = {} } = {}) {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return [];
  const headroom = contextTokens * 1.25;
  return list.filter((m) => {
    if (m?.status != null && m.status !== "active") return false;
    if (typeof m?.limit?.context === "number" && m.limit.context < headroom) return false;
    if (needs.tools === true && m?.capabilities?.toolcall === false) return false;
    // Image/pdf gates only apply when the model declares capabilities at all;
    // absent capabilities are permissive (unknown).
    if (needs.image === true && m?.capabilities && m?.capabilities?.input?.image !== true) return false;
    if (needs.pdf === true && m?.capabilities && m?.capabilities?.input?.pdf !== true) return false;
    return true;
  });
}

/**
 * 0 when a window is comfortable, ramping to 1 as it fills. Pure.
 *
 * No window, `pct < 50`, or `stale === true` → 0. Otherwise `(pct - 50) / 50`
 * clamped to [0,1], scaled by an urgency factor: 1 when `resetsAt` is missing
 * or more than 24h away, scaling linearly down to 0.25 as `resetsAt`
 * approaches `nowMs` (a window about to reset is less scarce). Always returns
 * a finite number in [0,1].
 *
 * @param {object|null|undefined} window
 * @param {number} nowMs
 * @returns {number}
 */
export function scarcity(window, nowMs) {
  if (!window || typeof window !== "object") return 0;
  if (window.stale === true) return 0;
  const pct = window.pct;
  if (typeof pct !== "number" || pct < 50) return 0;
  let ramped = (pct - 50) / 50;
  if (ramped < 0) ramped = 0;
  if (ramped > 1) ramped = 1;
  const resetsAt = window.resetsAt;
  if (resetsAt == null || typeof nowMs !== "number") return ramped;
  let f = (resetsAt - nowMs) / DAY_MS;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  return ramped * (0.25 + 0.75 * f);
}

/**
 * Comparable price for one model, blending dollars and quota scarcity. Pure.
 *
 * `dollars + scarcity(window) * REFERENCE_PRICE`, where `dollars` sums
 * `cost.input` + `cost.output`. The window is the one from `quota` whose
 * `providerIDs` includes the model's `providerID` (highest scarcity when
 * several). A genuinely free model (`dollars === 0` and no matching quota
 * window) gets `FREE_FLOOR` — so a free-but-weak model is not chosen over a
 * good one while quota is abundant.
 *
 * @param {object} model
 * @param {Array<object>} [quota]
 * @param {number} [nowMs]
 * @returns {number}
 */
export function effectivePrice(model, quota = [], nowMs = 0) {
  const dollars = (model?.cost?.input ?? 0) + (model?.cost?.output ?? 0);
  const window = pickWindow(model?.providerID, quota, nowMs);
  if (window) return dollars + scarcity(window, nowMs) * REFERENCE_PRICE;
  return dollars === 0 ? FREE_FLOOR : dollars;
}

const CONSTRAINT_LABELS = {
  status: "no active model",
  context: "context headroom",
  tools: "tool calling",
  image: "image input",
  pdf: "pdf input",
};

// Filter while tracking which constraint eliminated what, for reasons.
function applyConstraints(models, contextTokens, needs) {
  const kept = [];
  const counts = { status: 0, context: 0, tools: 0, image: 0, pdf: 0 };
  const headroom = contextTokens * 1.25;
  for (const m of models) {
    let drop = null;
    if (m?.status != null && m.status !== "active") drop = "status";
    else if (typeof m?.limit?.context === "number" && m.limit.context < headroom) drop = "context";
    else     if (needs.tools === true && m?.capabilities?.toolcall === false) drop = "tools";
    else if (needs.image === true && m?.capabilities && m?.capabilities?.input?.image !== true) drop = "image";
    else if (needs.pdf === true && m?.capabilities && m?.capabilities?.input?.pdf !== true) drop = "pdf";
    if (drop) counts[drop] += 1;
    else kept.push(m);
  }
  return { kept, counts };
}

function bindingReason(counts) {
  let best = "status";
  let bestCount = -1;
  for (const key of Object.keys(CONSTRAINT_LABELS)) {
    if (counts[key] > bestCount) {
      bestCount = counts[key];
      best = key;
    }
  }
  return CONSTRAINT_LABELS[best] ?? "constraints";
}

// Whether a policy asks the router to run at all. Routing is activated per
// conversation, not by a global switch: the composer's model picker activates
// it for a conversation by supplying a preset, and a per-agent override map can
// pin specific tiers on top. The former global `enabled` field is gone
// (BET-1243) — there is no box-wide off switch. An absent/empty policy (no
// preset, no per-agent override) means the conversation did not ask to route.
function routingActive(policy) {
  if (typeof policy !== "object" || policy === null) return false;
  if (typeof policy.preset === "string" && policy.preset.length > 0) return true;
  const perAgent = policy.perAgent;
  return !!perAgent && typeof perAgent === "object" && Object.keys(perAgent).length > 0;
}

// A single sentence naming the agent, the tier, and the binding factor.
function explain({ agent, tierName, winner, quota, nowMs }) {
  const window = pickWindow(winner?.providerID, quota, nowMs);
  const s = window ? scarcity(window, nowMs) : 0;
  if (s > 0) {
    const label = window.period ? `${window.period}` : "quota";
    return `${agent} → ${tierName} tier: ${winner.providerID} ${label} at ${Math.round(s * 100)}%`;
  }
  return `${agent} → ${tierName} tier: ${winner.providerID} quota ample`;
}

/**
 * THE entry point. Always returns a model and a non-empty reason; never
 * throws.
 *
 * @param {object} [input]
 * @param {object} [input.intent] - { kind, agent, needs, contextTokens, incumbent }
 * @param {Array<object>} [input.catalog] - Model[] from opencode
 * @param {Record<string, { tokensPerSec?: number, p50Ms?: number }>} [input.telemetry]
 * @param {Array<object>} [input.quota] - UsageSnapshot[]
 * @param {{ preset?: string, perAgent?: Record<string,string> }} [input.policy]
 * @param {number} [input.nowMs]
 * @returns {{ model: object|null, reason: string, alternatives: object[], changed: boolean }}
 */
export function chooseModel(input = {}) {
  const { intent = {}, catalog = [], telemetry = {}, quota = [], policy = {}, nowMs = 0 } = input;
  const agent = intent?.agent ?? "general";
  const incumbent = intent?.incumbent ?? null;

  // Permanent invariant: never route mid-exchange.
  if (intent?.kind === "mid-exchange") {
    return {
      model: incumbent,
      reason: "mid-exchange switching is disabled",
      alternatives: [],
      changed: false,
    };
  }

  // Activation is per-conversation: routing runs only when this conversation
  // supplied a routing directive — a preset the composer picker set, or a
  // per-agent override. The former global on/off (`enabled`) is gone
  // (BET-1243); "no preset" is a conversation that did not ask to route, not a
  // box-wide off switch, so an empty policy returns the incumbent unchanged.
  if (!routingActive(policy)) {
    return { model: incumbent, reason: "routing not activated for this conversation", alternatives: [], changed: false };
  }

  const needs = intent?.needs ?? {};
  const contextTokens = typeof intent?.contextTokens === "number" ? intent.contextTokens : 0;
  const { kept: survivors, counts } = applyConstraints(catalog, contextTokens, needs);

  if (survivors.length === 0) {
    return {
      model: incumbent,
      reason: `no ${agent} model passes constraints (${bindingReason(counts)})`,
      alternatives: [],
      changed: false,
    };
  }

  const floor = AGENT_FLOOR[agent] ?? "balanced";
  const floorRank = tierRank(floor);
  const target = policy?.perAgent?.[agent] ?? AGENT_TIER?.[policy?.preset]?.[agent] ?? "balanced";
  let targetRank = tierRank(target);
  if (targetRank < floorRank) targetRank = floorRank;

  // Keep candidates whose tier equals the target; if none, widen to the
  // nearest tier at or above the floor.
  const ranked = survivors.map((m) => ({ m, rank: tierRank(tierOf(m)) }));
  let chosen = ranked.filter((x) => x.rank === targetRank);
  if (chosen.length === 0) {
    const eligible = ranked.filter((x) => x.rank >= floorRank);
    const nearest = Math.min(...eligible.map((x) => Math.abs(x.rank - targetRank)));
    chosen = eligible.filter((x) => Math.abs(x.rank - targetRank) === nearest);
  }

  // Sort by effectivePrice ascending; ties by higher telemetry tokensPerSec,
  // then lower p50Ms, then modelID alphabetically (deterministic).
  chosen.sort((a, b) => {
    const pa = effectivePrice(a.m, quota, nowMs);
    const pb = effectivePrice(b.m, quota, nowMs);
    if (pa !== pb) return pa - pb;
    const ta = telemetry?.[modelKey(a.m)]?.tokensPerSec ?? 0;
    const tb = telemetry?.[modelKey(b.m)]?.tokensPerSec ?? 0;
    if (ta !== tb) return tb - ta;
    const la = telemetry?.[modelKey(a.m)]?.p50Ms ?? Infinity;
    const lb = telemetry?.[modelKey(b.m)]?.p50Ms ?? Infinity;
    if (la !== lb) return la - lb;
    return String(a.m?.id ?? "").localeCompare(String(b.m?.id ?? ""));
  });

  const winner = chosen[0].m;
  const winnerRank = chosen[0].rank;
  const tierName = TIER_NAMES[winnerRank] ?? "balanced";
  const alternatives = chosen.slice(1, 4).map((x) => x.m);
  const changed = !incumbent || modelKey(incumbent) !== modelKey(winner);

  return {
    model: winner,
    reason: explain({ agent, tierName, winner, quota, nowMs }),
    alternatives,
    changed,
  };
}
