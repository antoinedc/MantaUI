// marginalCost.mjs — the expected $ cost of running one turn on an endpoint,
// given the account that backs it, right now.
//
// Pure. No node:* imports, no Date.now(), no I/O. Time arrives as `nowMs`.
// Provider-neutral: zero vendor names in the decision core.
//
// The frame is budget pacing, not a fill gauge. `effectivePrice` in
// modelRouter.mjs takes a model's list price and *adds* a quota penalty — wrong
// for both a subscription (the fee is already sunk; one more token costs a
// marginal *zero*) and for credit (the cost is the opportunity cost of spending
// it now, which is about consumed-vs-elapsed, not pct alone).

import { blendedPrice } from "./blendedPrice.mjs";

// --- Asymmetry: subscription < credit at equal scarcity ---------------------
// A subscription's unused quota expires worthless; unused credit carries over
// to the next billing period. So at equal scarcity a credit balance must cost
// MORE than a subscription — otherwise routing drains the subscription first
// and then still has the carried-over credit it could have spent later. This is
// an explicit named constant, not an accident of curve shape: a test pins it.
export const CREDIT_PREMIUM = 1.5;

// --- Credit depletion curve -------------------------------------------------
// `cost = blended * depletionFactor(balance)`. The factor rises as balance
// approaches 0 (a nearly-empty credit balance is scarce — spending it now may
// force a top-up). No balance reading → factor is exactly 1: no scarcity
// signal, priced at its declared rate. "No reading" is never treated as plenty.
export const CREDIT_DEPLETION_FLOOR = 1; // never below the declared rate
export const CREDIT_DEPLETION_SLOPE = 5; // how fast cost climbs as balance drops
export const CREDIT_DEPLETION_EPSILON = 1e-6; // keep the factor finite at balance → 0

// --- Near-reset damping -----------------------------------------------------
// A window whose remainder is about to expire is cheap — hoarding a balance
// that resets in a few hours is pointless. `RESET_RAMP_MS` is the horizon over
// which cost damps linearly to 0 as `resetsAt` approaches `nowMs`.
export const RESET_RAMP_MS = 24 * 60 * 60 * 1000;

// --- Subscription pace curve ------------------------------------------------
// `subscriptionCost = exchangeRate * pace^k * resetDamp`. On pace (pace === 1)
// the cost IS the exchange rate — that is the anchor. k > 1 makes over-pacing
// climb steeply past the exchange rate while under-pacing falls toward 0.
export const SUBSCRIPTION_PACE_EXPONENT = 2;

export const PACING_EPSILON = 1e-9;

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function dollar(v) {
  return isNum(v) ? Math.max(0, v) : 0;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * The depletion multiplier for a credit balance. 1 when there is no reading —
 * no scarcity signal, priced at the declared rate. Otherwise rises toward
 * infinity as `balance` approaches 0 (see CREDIT_DEPLETION_SLOPE). Exported so
 * the "no reading → factor 1" rule is usable and testable.
 *
 * @param {number|undefined} balance
 * @returns {number}
 */
export function depletionFactor(balance) {
  if (!isNum(balance)) return 1;
  return CREDIT_DEPLETION_FLOOR + CREDIT_DEPLETION_SLOPE / Math.max(balance, CREDIT_DEPLETION_EPSILON);
}

// The low, exported fallback used when a window lacks elapsed data.
function resetDamp(resetsAt, nowMs) {
  if (!isNum(resetsAt) || !isNum(nowMs)) return 1;
  const remaining = resetsAt - nowMs;
  if (remaining <= 0) return 0;
  return clamp01(remaining / RESET_RAMP_MS);
}

// Which figure anchors the subscription exchange rate, in priority order.
function exchangeRateOf(account, model, mix, reference, replacementCost) {
  if (isNum(account?.overagePrice)) {
    return { rate: dollar(account.overagePrice), source: "published overage price" };
  }
  if (isNum(replacementCost)) {
    return { rate: dollar(replacementCost), source: "replacement cost" };
  }
  return { rate: blendedPrice(model, mix, reference).price, source: "blended price" };
}

// One subscription window, priced by pace vs elapsed, damped near reset.
function subscriptionWindowCost(win, rate, nowMs) {
  const pct = isNum(win?.pct) ? Math.max(0, win.pct) : 0;
  const consumed = pct / 100;
  const startedAt = win?.startedAt;
  const resetsAt = win?.resetsAt;

  let pace;
  let basis;
  if (isNum(startedAt) && isNum(resetsAt) && resetsAt > startedAt) {
    const span = resetsAt - startedAt || PACING_EPSILON;
    const elapsed = clamp01((nowMs - startedAt) / span);
    pace = consumed / Math.max(elapsed, PACING_EPSILON);
    basis = "subscription-pace";
  } else {
    // No start time → cannot compute elapsed. Fall back to consumed alone
    // (today's behaviour): a higher fill is scarcer. Do not guess a start time.
    pace = consumed;
    basis = "subscription-consumed";
  }

  const damp = resetDamp(resetsAt, nowMs);
  const cost = dollar(rate) * Math.pow(pace, SUBSCRIPTION_PACE_EXPONENT) * damp;
  return { cost, basis };
}

/**
 * The expected $ cost of running one turn on this endpoint, right now.
 *
 * Exhausted endpoints are flagged `exhausted: true` (cost set to Infinity so a
 * caller that forgets to check is still safe) — the caller EXCLUDES them; it
 * does not price them high.
 *
 * @param {object} input
 * @param {object} input.model      OpencodeModel (cost, providerID)
 * @param {object} [input.account]  the provider's account state, or null when
 *                                  unknown:
 *   {
 *     kind: "subscription" | "credit" | "none",
 *     windows?: [{ kind, pct, startedAt, resetsAt, binding }],  // subscription
 *     balance?: number,                                          // credit, may be negative
 *     overagePrice?: number,                                     // $ per unit if published
 *     exhausted?: boolean,
 *   }
 * @param {number} input.nowMs
 * @param {object} [input.mix]          token mix for blendedPrice
 * @param {object} [input.reference]    reference price for the implausible-zero rule
 * @param {number} [input.replacementCost]  $ of the cheapest acceptable alternative
 * @returns {{ cost: number, exhausted: boolean, basis: string, reason: string }}
 */
export function marginalCost(input = {}) {
  const { model, account, nowMs = 0, mix, reference, replacementCost } = input || {};

  // --- Exhausted first -------------------------------------------------------
  const windows = Array.isArray(account?.windows) ? account.windows : [];
  const exhausted =
    account?.exhausted === true ||
    (account?.kind === "credit" && isNum(account?.balance) && account.balance <= 0) ||
    (account?.kind === "subscription" && windows.some((w) => isNum(w?.pct) && w.pct >= 100));

  if (exhausted) {
    return {
      cost: Infinity,
      exhausted: true,
      basis: "exhausted",
      reason: "endpoint is exhausted — excluded, not priced high",
    };
  }

  // --- credit / none ---------------------------------------------------------
  if (account?.kind === "credit" || account?.kind === "none") {
    const blended = dollar(blendedPrice(model, mix, reference).price);
    const factor = depletionFactor(account?.balance);
    const premium = account?.kind === "credit" ? CREDIT_PREMIUM : 1;
    const cost = blended * factor * premium;
    const scarcity =
      account?.kind === "credit"
        ? isNum(account?.balance)
          ? `depletion factor ${factor.toFixed(3)}`
          : "no balance reading (factor 1)"
        : "no account — declared rate";
    const withPremium = account?.kind === "credit" ? `, credit premium ${CREDIT_PREMIUM}` : "";
    return {
      cost,
      exhausted: false,
      basis: account?.kind === "credit" ? (isNum(account?.balance) ? "credit-depletion" : "credit-flat") : "none",
      reason: `credit/none: blended $${blended.toFixed(4)} (${scarcity})${withPremium}`,
    };
  }

  // --- subscription ----------------------------------------------------------
  if (account?.kind === "subscription") {
    const { rate, source } = exchangeRateOf(account, model, mix, reference, replacementCost);
    if (windows.length === 0) {
      return {
        cost: dollar(rate),
        exhausted: false,
        basis: "subscription-no-window",
        reason: `subscription, no window data — priced at exchange rate (${source})`,
      };
    }
    let best = 0;
    let bestBasis = "subscription-pace";
    for (const w of windows) {
      const c = subscriptionWindowCost(w, rate, nowMs);
      if (c.cost > best) {
        best = c.cost;
        bestBasis = c.basis;
      }
    }
    return {
      cost: dollar(best),
      exhausted: false,
      basis: bestBasis,
      reason: `subscription priced by pace at exchange rate ${source}`,
    };
  }

  // --- unknown / no account --------------------------------------------------
  const blended = dollar(blendedPrice(model, mix, reference).price);
  return {
    cost: blended,
    exhausted: false,
    basis: "unknown",
    reason: `no account state — priced at blended rate $${blended.toFixed(4)}`,
  };
}
