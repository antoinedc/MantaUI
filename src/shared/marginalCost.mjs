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
import { PROTECTION_LAMBDA_MULTIPLIER } from "./quotaPressure.mjs";

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

// Which figure anchors the subscription's marginal cost. There is deliberately
// NO list-price fallback (BET-1269 5c): the subscription's fee is already paid,
// so one more token costs what the cheapest acceptable alternative would charge
// to do the same work — the replacement cost. With no cash alternative the rate
// is 0 (a subscription with nothing to compare against is free at the margin).
function exchangeRateOf(account, replacementCost) {
  if (isNum(account?.overagePrice)) {
    return { rate: dollar(account.overagePrice), source: "published overage price" };
  }
  return { rate: dollar(replacementCost), source: "replacement cost" };
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
 *     kind: "subscription" | "credit",
 *     windows?: [{ kind, pct, startedAt, resetsAt, binding }],  // subscription
 *     balance?: number,                                          // credit, may be negative
 *     overagePrice?: number,                                     // $ per unit if published
 *     exhausted?: boolean,
 *   }
 *   `kind: "none"` was removed (7f): accountsFromSnapshots only ever emits
 *   "subscription" or "credit", so the "none" branch and its `basis: "none"`
 *   were dead. An absent account already falls through to the no-account
 *   branch below at blended rate with `basis: "unknown"`.
 * @param {number} input.nowMs
 * @param {object} [input.mix]          token mix for blendedPrice
 * @param {object} [input.reference]    reference price for the implausible-zero rule
 * @param {number} [input.replacementCost]  $ of the cheapest acceptable alternative
 * @param {number} [input.expectedTurnTokens]  expected tokens in THIS turn (the
 *   routing-decision input) — only the subscription branch consumes it, to size
 *   the pacing pressure
 * @param {boolean} [input.isLowStakes]  true for general/explore turns (the
 *   protection multiplier applies only to these)
 * @param {object} [input.shadowPrice]  the pacing controller's shadow price:
 *   { lambda, tokensPerPct, protection } — ADDITIVE on top of the pace curve in
 *   the subscription branch only. Absent / zero-lambda / null-tokensPerPct /
 *   non-finite non-positive expectedTurnTokens → SKIPPED, cost + basis unchanged
 *   (the on-or-under-pace regime stays byte-identical to today; the two terms
 *   only coexist over pace).
 * @returns {{ cost: number, exhausted: boolean, basis: string, reason: string }}
 */
export function marginalCost(input = {}) {
  const { model, account, nowMs = 0, mix, reference, replacementCost, expectedTurnTokens, isLowStakes = false, shadowPrice } = input || {};

  // --- Exhausted first -------------------------------------------------------
  const windows = Array.isArray(account?.windows) ? account.windows : [];
  // A stale reading must never escalate (UsageWindow.stale is set by the usage
  // poller the moment a window's reset instant passes and the provider has not
  // published the replacement numbers). A stale window contributes neither
  // exhaustion nor pace; if every window is stale the account has no usable
  // reading and is priced as if it had none, not as exhausted (BET-1269 5f).
  const liveWindows = windows.filter((w) => w?.stale !== true);
  const exhausted =
    account?.exhausted === true ||
    (account?.kind === "credit" && isNum(account?.balance) && account.balance <= 0) ||
    (account?.kind === "subscription" && liveWindows.some((w) => isNum(w?.pct) && w.pct >= 100));

  if (exhausted) {
    return {
      cost: Infinity,
      exhausted: true,
      basis: "exhausted",
      reason: "endpoint is exhausted — excluded, not priced high",
    };
  }

  // --- credit ---------------------------------------------------------------
  // 7f: `kind: "none"` is gone — accountsFromSnapshots emits only credit or
  // subscription, so the none branch (which priced identically to credit minus
  // the premium) and its `basis: "none"` were dead. An unknown/absent kind
  // falls through to the no-account branch below.
  if (account?.kind === "credit") {
    const blended = dollar(blendedPrice(model, mix, reference).price);
    const factor = depletionFactor(account?.balance);
    const cost = blended * factor * CREDIT_PREMIUM;
    const scarcity = isNum(account?.balance)
      ? `depletion factor ${factor.toFixed(3)}`
      : "no balance reading (factor 1)";
    return {
      cost,
      exhausted: false,
      basis: isNum(account?.balance) ? "credit-depletion" : "credit-flat",
      reason: `credit: blended $${blended.toFixed(4)} (${scarcity}), credit premium ${CREDIT_PREMIUM}`,
    };
  }

  // --- subscription ----------------------------------------------------------
  if (account?.kind === "subscription") {
    const { rate, source } = exchangeRateOf(account, replacementCost);
    if (liveWindows.length === 0) {
      return {
        cost: dollar(rate),
        exhausted: false,
        basis: "subscription-no-window",
        reason: `subscription, no usable window — priced at exchange rate (${source})`,
      };
    }
    let best = 0;
    let bestBasis = "subscription-pace";
    for (const w of liveWindows) {
      const c = subscriptionWindowCost(w, rate, nowMs);
      if (c.cost > best) {
        best = c.cost;
        bestBasis = c.basis;
      }
    }
    // The pacing shadow price, ADDITIVE on top of the pace curve (Optimizer
    // P2.3, BET-1345). `max(0, Q_w)` is zero in the on/under-pace regime, so
    // today's arithmetic — including the under-pace discount that drives work
    // onto a subscription you already paid for — is preserved byte-for-byte
    // there. The pressure is skipped entirely (cost + basis unchanged) when any
    // of its inputs is unusable: a missing shadowPrice, lambda <= 0, a null
    // tokensPerPct, or a non-finite non-positive expectedTurnTokens. CREDIT
    // accounts get NO shadow price — a credit balance has no reset window, so
    // there is no deficit queue for it.
    let cost = dollar(best);
    let basis = bestBasis;
    const sp = shadowPrice;
    const tokensPerPctValid = sp && isNum(sp.tokensPerPct) && sp.tokensPerPct > 0;
    const lambdaValid = sp && isNum(sp.lambda) && sp.lambda > 0;
    const turnValid = isNum(expectedTurnTokens) && expectedTurnTokens > 0;
    if (lambdaValid && tokensPerPctValid && turnValid) {
      const protectionMult =
        sp.protection === true && isLowStakes === true ? PROTECTION_LAMBDA_MULTIPLIER : 1;
      const pressure = sp.lambda * (expectedTurnTokens / sp.tokensPerPct) * rate * protectionMult;
      cost = dollar(best) + pressure;
      basis = "subscription-pace+pressure";
    }
    return {
      cost,
      exhausted: false,
      basis,
      reason:
        `subscription priced by pace at exchange rate ${source}` +
        (basis === "subscription-pace+pressure" ? " + pacing pressure" : ""),
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
