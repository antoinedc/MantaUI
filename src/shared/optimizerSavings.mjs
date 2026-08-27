// optimizerSavings.mjs — price a window of OPTIMIZER savings honestly.
//
// Pure. No node:* imports, no Date.now(), no I/O — everything arrives as an
// argument. Two functions:
//   promptSideRate(cost, mix) — $ per 1M tokens saved by REMOVING a token from
//     a prompt.
//   savedUsd({ byModel, rewarmTokens, rates }) — a window's savings in dollars.
//
// Why this module exists (BET-1370): OptimizerCard used to compute the savings
// figure with a flat `$3/Mtok` counterfactual guess — Claude Sonnet's *input*
// rate. But the tokens being trimmed are old *tool outputs* removed from the
// prompt, tokens that would overwhelmingly have been billed as prompt-cache
// reads at a tenth of that. Measured against real published rates the flat
// figure overstated savings by ~10x on a Haiku box and ~3x on a Sonnet box.
// Worse, masking rewrites the prompt prefix, so everything after the mask point
// loses its cache entry and is re-written once at cache-write rate — nothing
// subtracted that re-warm cost, and on a conversation that ends a few turns
// after the trim the "saving" was actually a loss.
//
// Both errors are fixed here. The rate is derived from the measured per-model
// cache mix restricted to the prompt side (a removed token is billed as input /
// cache-write / cache-read, NEVER output), and the re-warm cost is subtracted
// using the dominant model's cacheWrite−cacheRead delta. A negative result is
// real and is returned, never clamped — reporting a gain on a trim that cost
// money is the failure this module engineers out.

import { DEFAULT_MIX } from "./blendedPrice.mjs";

// A finite number >= 0, else 0 (non-numeric / negative junk → 0; a declared 0
// stays 0 — "free" is a deliberate number, distinct from "unknown").
function dollar(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

// Is `v` a finite, non-negative rate we can trust? (distinct from dollar(): a
// declared 0 here is meaningful, so this returns true for 0 rather than a flag.)
function isRate(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

// The prompt-side mix weights. A token removed from a prompt is billed as
// input, cache-write or cache-read — never as output — so the workload mix is
// restricted to those three buckets and renormalised. A mix that is missing or
// has no positive prompt-side weight falls back to DEFAULT_MIX's prompt buckets.
function promptWeights(mix) {
  const use = mix && typeof mix === "object" ? mix : DEFAULT_MIX;
  const i = dollar(use.input);
  const r = dollar(use.cacheRead);
  const w = dollar(use.cacheWrite);
  const denom = i + r + w;
  if (denom > 0) return { wInput: i / denom, wRead: r / denom, wWrite: w / denom };
  const di = dollar(DEFAULT_MIX.input);
  const dr = dollar(DEFAULT_MIX.cacheRead);
  const dw = dollar(DEFAULT_MIX.cacheWrite);
  return { wInput: di / (di + dr + dw), wRead: dr / (di + dr + dw), wWrite: dw / (di + dr + dw) };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * PURE. $ per 1M tokens for a token REMOVED FROM A PROMPT.
 *
 * A masked token is an old tool output taken out of the prompt — it would have
 * been billed as input, cache-write or cache-read, and NEVER as output. So the
 * weights are the measured mix restricted to those three buckets and
 * renormalised; using the router's full blended rate (which weights output
 * heavily) would overstate savings.
 *
 * Missing cacheRead / cacheWrite rates bill at the full input rate, matching
 * blendedPrice(); a declared 0 stays 0. Returns { rate, known, cacheRead,
 * cacheWrite }, with known:false when `cost.input` is not a finite number >= 0 —
 * unknown is NOT zero and must never be silently treated as free.
 *
 * @param {object} cost  normalised per-model cost { input, output, cacheRead, cacheWrite } in $/Mtok
 * @param {object} [mix] workload mix { input, output, cacheRead, cacheWrite } fractions
 * @returns {{ rate: number, known: boolean, cacheRead: number, cacheWrite: number }}
 */
export function promptSideRate(cost, mix) {
  const input = isRate(cost?.input) ? cost.input : null;
  if (input === null) return { rate: 0, known: false, cacheRead: 0, cacheWrite: 0 };

  // Missing cache rates bill at the full input rate; declared 0 stays 0.
  const cacheRead = isRate(cost.cacheRead) ? dollar(cost.cacheRead) : input;
  const cacheWrite = isRate(cost.cacheWrite) ? dollar(cost.cacheWrite) : input;

  const { wInput, wRead, wWrite } = promptWeights(mix);
  const rate = input * wInput + cacheRead * wRead + cacheWrite * wWrite;

  return { rate, known: true, cacheRead, cacheWrite };
}

// The model key with the most tokens that has a known rate, else null. Used for
// the re-warm subtraction (the dominant model's cacheWrite−cacheRead delta).
function dominantRateKey(byModel, rates) {
  let bestKey = null;
  let bestTokens = -1;
  for (const [mk, tokens] of Object.entries(byModel)) {
    if (mk === "unknown") continue;
    if (rates[mk]?.known !== true) continue;
    const t = num(tokens);
    if (t > bestTokens) {
      bestTokens = t;
      bestKey = mk;
    }
  }
  return bestKey;
}

/**
 * PURE. The window's savings in dollars.
 *
 * @param byModel      { "<providerID>/<modelID>": tokens } — the window's
 *                     token-turns, summed across buckets. The key "unknown"
 *                     holds tokens reported without a model.
 * @param rewarmTokens prompt-cache re-warm tokens the trimming caused, summed.
 * @param rates        { "<providerID>/<modelID>": { rate, known, cacheRead, cacheWrite } }
 * @returns {{ usd: number | null, basis: "measured"|"partial"|"unpriced", pricedShare: number }}
 */
export function savedUsd({ byModel = {}, rewarmTokens = 0, rates = {} }) {
  let knownContrib = 0; // $ from models with a directly-known rate
  let knownTokens = 0; // tokens under a directly-known rate
  let unknownTokens = 0; // tokens under "unknown" or an unpriced model

  for (const [mk, tokens] of Object.entries(byModel)) {
    const t = num(tokens);
    if (t <= 0) continue;
    if (mk !== "unknown" && rates[mk]?.known === true && Number.isFinite(rates[mk].rate)) {
      knownContrib += (t / 1e6) * rates[mk].rate;
      knownTokens += t;
    } else {
      unknownTokens += t;
    }
  }

  const total = knownTokens + unknownTokens;
  if (total <= 0) {
    // Nothing to price: the genuine zero (a window with no applied turns — e.g.
    // the optimizer is off). This is NOT "unpriced"; it is "nothing saved".
    return { usd: 0, basis: "measured", pricedShare: 1 };
  }

  const pricedShare = knownTokens / total;
  if (pricedShare === 0) {
    // Tokens exist but none are directly priceable — do NOT invent a figure.
    // The card renders "not priced".
    return { usd: null, basis: "unpriced", pricedShare: 0 };
  }
  const basis = pricedShare === 1 ? "measured" : "partial";

  // Unknown-model tokens price at the token-weighted average of the known rates.
  let usd = knownContrib;
  if (unknownTokens > 0) usd += unknownTokens * (knownContrib / knownTokens);

  // Re-warm: the mask rewrote part of the prefix, losing the cache entry for
  // everything after it so it is re-billed once at cache-write instead of read.
  // Subtract that using the dominant known model's rates. Missing cache rate →
  // its input rate (already resolved by promptSideRate). Never clamped: a loss
  // is real and must render as such.
  const rewarm = num(rewarmTokens);
  if (rewarm > 0) {
    const dominant = dominantRateKey(byModel, rates);
    const dr = dominant !== null ? rates[dominant] : null;
    if (dr && dr.known === true) {
      const delta = dollar(dr.cacheWrite) - dollar(dr.cacheRead);
      usd -= (rewarm / 1e6) * delta;
    }
  }

  return { usd, basis, pricedShare };
}
