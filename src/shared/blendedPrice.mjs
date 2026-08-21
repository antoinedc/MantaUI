// blendedPrice.mjs — price a model across all four token rates, not just
// input+output. Pure: no node:* imports, no Date.now(), no I/O. Everything
// arrives as an argument.
//
// Why this exists: `effectivePrice` in modelRouter.mjs sums only
// `cost.input + cost.output`. But the app's own spend ledger (modelLedger.mjs,
// BET-1219) found ~90% of real spend is prompt cache, not fresh input/output.
// Two endpoints can quote identical input/output and still differ wildly in
// cost once cache discounts are counted, and an input+output sum is blind to
// that term. This module blends all four rates (input, output, cacheRead,
// cacheWrite) by the mix the workload actually exhibits.

/**
 * The default workload mix: cache-heavy, consistent with the ledger's finding
 * that ~90% of spend on a real box is prompt cache (BET-1219). Fractions sum
 * to 1. A later tuner revisiting this number should come from the ledger, not
 * from vibes — the shape is what matters: cacheRead dominates, fresh input is
 * small, output smaller.
 */
export const DEFAULT_MIX = Object.freeze({
  cacheRead: 0.8,
  input: 0.08,
  cacheWrite: 0.07,
  output: 0.05,
});

// A rate is "real" when it is a finite number. NaN / Infinity / undefined /
// null are junk — treated as missing, never as the value 0 (a declared 0 is
// a real, deliberate number that means "free"; missing is a different thing).
function isRate(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Coerce a rate to a finite, non-negative dollar figure. Anything non-numeric
// is 0; a negative number is data junk, clamped to 0 (we never return a
// negative price).
function dollar(v) {
  return isRate(v) ? Math.max(0, v) : 0;
}

// Normalise a caller-supplied mix so the four fractions sum to 1. A mix that
// does not sum to 1 is rescaled, not rejected. A missing / empty / all-zero
// mix falls back to DEFAULT_MIX (a box with no ledger history).
//
// Module-private. Reports which branch it took: "measured" when the caller
// supplied a usable mix, "default" when it fell back to DEFAULT_MIX. This is
// how a box that never fed it ledger counts becomes visible (the trace).
function normalizeMix(mix) {
  if (!mix || typeof mix !== "object") return { mix: { ...DEFAULT_MIX }, source: "default" };
  const raw = {
    input: dollar(mix.input),
    output: dollar(mix.output),
    cacheRead: dollar(mix.cacheRead),
    cacheWrite: dollar(mix.cacheWrite),
  };
  const total = raw.input + raw.output + raw.cacheRead + raw.cacheWrite;
  if (!(total > 0)) return { mix: { ...DEFAULT_MIX }, source: "default" };
  return {
    mix: {
      input: raw.input / total,
      output: raw.output / total,
      cacheRead: raw.cacheRead / total,
      cacheWrite: raw.cacheWrite / total,
    },
    source: "measured",
  };
}

/**
 * The expected $ cost of one million tokens for this endpoint, blended across
 * the four rates by the mix this workload actually exhibits.
 *
 * Rules:
 *  - A missing cache rate is not zero — cached tokens bill at the full input
 *    rate (the honest, over-estimating assumption). A declared 0 is free.
 *  - A missing input or output makes the whole price unknown.
 *  - The implausible-zero rule: if `reference` says this model normally costs
 *    money but the endpoint quotes `input: 0, output: 0`, the price is unknown
 *    (a provider quoting nothing for a priced model has no price data) — the
 *    reference price is returned with `known: false`.
 *  - Always returns a finite, non-negative price.
 *
 * @param {object} model            OpencodeModel with `cost` (see S1b)
 * @param {object} [mix]            {input, output, cacheRead, cacheWrite} fractions summing to 1
 * @param {object} [reference]      {input, output} typical price for this model from the
 *                                  provider-agnostic catalogue, used for the implausible-zero rule
 * @returns {{ price: number, known: boolean, mixSource: "measured"|"default", reference: "catalogue"|"absent" }}
 */
export function blendedPrice(model, mix, reference) {
  const { mix: useMix, source: mixSource } = normalizeMix(mix);
  const cost = model && typeof model.cost === "object" && model.cost !== null ? model.cost : null;

  const hasReference = reference !== null && typeof reference === "object";
  const referenceFlag = hasReference ? "catalogue" : "absent";

  // --- known ---------------------------------------------------------------
  // A missing cost bag, or a missing (non-numeric) input/output rate, leaves
  // us with nothing to price: unknown.
  let known = true;
  if (cost == null) {
    known = false;
  } else if (!isRate(cost.input) || !isRate(cost.output)) {
    known = false;
  }

  // --- implausible zero ----------------------------------------------------
  // Rule 4: a catalogue that prices this model in dollars, paired with an
  // endpoint quoting both input and output as exactly 0, is missing price data
  // — not a gift. Only fires when a reference exists to judge against.
  if (known && hasReference) {
    const refCostsMoney = dollar(reference.input) > 0 || dollar(reference.output) > 0;
    const bothZero = cost.input === 0 && cost.output === 0;
    if (refCostsMoney && bothZero) known = false;
  }

  // --- price ---------------------------------------------------------------
  // Unknown → fall back to the catalogue's typical price for this model. With
  // no reference we return 0 rather than inventing a number anyone could trust.
  if (!known) {
    const price = hasReference ? dollar(reference.input) + dollar(reference.output) : 0;
    return { price, known: false, mixSource, reference: referenceFlag };
  }

  // Missing cache rates bill at the full input rate; declared 0 stays 0.
  const input = dollar(cost.input);
  const output = dollar(cost.output);
  const cacheRead = isRate(cost.cacheRead) ? dollar(cost.cacheRead) : input;
  const cacheWrite = isRate(cost.cacheWrite) ? dollar(cost.cacheWrite) : input;

  const price =
    input * useMix.input +
    output * useMix.output +
    cacheRead * useMix.cacheRead +
    cacheWrite * useMix.cacheWrite;

  return { price: dollar(price), known: true, mixSource, reference: referenceFlag };
}

/**
 * Fractions from raw token counts; safe on all-zero input (returns
 * DEFAULT_MIX). Lets the ledger feed measured counts in without the caller
 * doing the arithmetic.
 *
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} counts
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number }}
 */
export function mixFromCounts({ input, output, cacheRead, cacheWrite } = {}) {
  const counts = { input: dollar(input), output: dollar(output), cacheRead: dollar(cacheRead), cacheWrite: dollar(cacheWrite) };
  const total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
  if (!(total > 0)) return { ...DEFAULT_MIX };
  return {
    input: counts.input / total,
    output: counts.output / total,
    cacheRead: counts.cacheRead / total,
    cacheWrite: counts.cacheWrite / total,
  };
}
