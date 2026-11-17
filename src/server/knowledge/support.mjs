// support.mjs — does a user's quoted message actually support a claim? (shared by rules and skills)
//
// A quote only counts as evidence for a claim when it is long enough to mean something and shares real
// content words with the claim, so "ok do it" can't be attached to any rule or skill the model invents.

const STOP = new Set(
  "about above after again also always been before being below between both cannot could does doing done down during each from further have having here into just like make more most much must need only other over please should some such than that their them then there these they this those through under until very want were what when where which while will with would your yours".split(" "),
);

export const MIN_QUOTE_CHARS = 20;
export const MIN_SHARED_WORDS = 2;

export const wsnorm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The set of content words of a text: lowercased, ≥ 4 letters/digits, no stop words. */
export function contentWords(text) {
  const out = new Set();
  for (const w of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w)) out.add(w);
  return out;
}

/** True iff the quote (whitespace-normalised) is ≥ 20 chars and shares ≥ 2 content words with the claim text. */
export function quoteSupports(claimText, quote) {
  if (wsnorm(quote).length < MIN_QUOTE_CHARS) return false;
  const claim = contentWords(claimText);
  let shared = 0;
  for (const w of contentWords(quote)) if (claim.has(w) && ++shared >= MIN_SHARED_WORDS) return true;
  return false;
}
