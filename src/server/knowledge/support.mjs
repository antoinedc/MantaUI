// support.mjs — is a rule or preference actually SUPPORTED by the words the user wrote (spec §6.3, §9)?
//
// The model chooses the rule text AND the evidence quotes. Without a link between the two, any wording could
// be attached to real quotes. This is that link, checked in code and deliberately lexical: a quote supports a
// claim when it is a real sentence-sized span (≥ 20 characters once whitespace is normalized) and shares at
// least two content words with the claim (lowercased, ≥ 4 letters, a small English stop-word list removed).

const STOP = new Set(
  "that this with from have been were will would should could there their them then than they what when where which while about after again also because before being below between both does doing down during each more most only other over same some such into just like make many much must need never once onto still very your yours here those these through under until upon using want really please always don't dont not and are but for the you has had was can did its our out any all one too off own may let get got use used".split(" "),
);

export const MIN_QUOTE_CHARS = 20;
export const MIN_SHARED_WORDS = 2;

export const contentWords = (text) => {
  const out = new Set();
  for (const w of String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) if (w.length >= 4 && !STOP.has(w)) out.add(w);
  return out;
};

export const wsnorm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** true iff the whitespace-normalized quote is ≥ 20 chars AND shares ≥ 2 content words with `claimText`. */
export function quoteSupports(claimText, quote) {
  if (wsnorm(quote).length < MIN_QUOTE_CHARS) return false;
  const claim = contentWords(claimText);
  let shared = 0;
  for (const w of contentWords(quote)) if (claim.has(w) && ++shared >= MIN_SHARED_WORDS) return true;
  return false;
}

/** true iff at least one of `quotes` supports `claimText`. */
export function claimSupported(claimText, quotes) {
  return (Array.isArray(quotes) ? quotes : []).some((q) => quoteSupports(claimText, q));
}
