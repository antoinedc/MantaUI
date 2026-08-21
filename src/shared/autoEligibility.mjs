// autoEligibility.mjs — the ONE completeness gate shared by the router and the
// Accounts UI.
//
// Auto must only choose endpoints it can fully describe. An endpoint becomes
// describable two ways — we filled the information in (a *supported* provider
// from the catalogue + the provider's own model list) or the user did (a
// *custom* provider, or an override on a supported one). There is exactly one
// gate, asked once, so those two classes cannot drift into two behaviours.
//
// The Accounts UI reads this same function, so "what the UI says is missing"
// is exactly "what the router is waiting for". Pure + framework-free (no I/O,
// no time, no imports) so the server, renderer and tests share one answer.
//
// This function is ONLY about description completeness. It deliberately does
// NOT consider account state/balance (a custom provider legitimately has
// none), whether the user ticked the model (that is consent, checked by
// listRoutableModels), per-turn capability/context fit (the per-turn
// constraint stage), or provider health (the per-turn availability stage).

/** Stable machine keys for each thing Auto cannot yet describe. The renderer
 *  owns the human sentence for each key — never put user-facing copy here. */
export const MISSING = {
  IDENTITY: "identity", // which model is this?
  PRICE: "price", // what does a token cost here?
  CACHING: "caching", // does it cache, and at what rate?
  QUALITY: "quality", // we cannot place it in the field
};

export function autoEligibility(input) {
  const model = input?.model;
  const identity = input?.identity;
  const quality = input?.quality;
  const declared = input?.declared;

  const missing = [];

  // IDENTITY — which model is this? Resolved by identity.known (the catalogue
  // recognised it) or by the user declaring a catalogId for it.
  const identityKnown = Boolean(identity?.known) || Boolean(declared?.catalogId);
  if (!identityKnown) missing.push(MISSING.IDENTITY);

  // PRICE — what does a token cost here? Satisfied by the provider's own cost
  // figures or by an explicit declaration (incl. "free", a complete answer).
  const hasModelPrice =
    Number.isFinite(model?.cost?.input) || Number.isFinite(model?.cost?.output);
  const hasDeclaredPrice = declared?.price !== undefined;
  if (!hasModelPrice && !hasDeclaredPrice) missing.push(MISSING.PRICE);

  // CACHING — does it cache, and at what rate? Satisfied by cache rates on the
  // provider's cost or by an explicit declaration (incl. false = "no caching",
  // the safe assumption).
  const hasCacheRates =
    model?.cost?.cacheRead !== undefined || model?.cost?.cacheWrite !== undefined;
  const hasDeclaredCaches = declared?.caches !== undefined;
  if (!hasCacheRates && !hasDeclaredCaches) missing.push(MISSING.CACHING);

  // QUALITY — can we place it in the field to honour a tier floor? Missing when
  // quality is known-false. A declared catalogId supplies quality through the
  // catalogue instead (the better mechanism — the field it replaced never had a
  // producer or a working consumer, BET-1268).
  const qualityKnown = quality?.known !== false;
  if (!qualityKnown) missing.push(MISSING.QUALITY);

  return { eligible: missing.length === 0, missing };
}
