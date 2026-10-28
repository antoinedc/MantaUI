// formatTokens.mjs — the ONE token-count formatter (master D26). The box
// (streamInterpretation.mjs, the view modules) and every renderer caller import
// it; nothing keeps a private copy.
//
//   formatTokenCount(n) — compact figure, no unit: 999 → "999", 12_340 → "12.3k",
//                         128_000 → "128k", 1_200_000 → "1.2M".
//   formatTokens(n)     — the same figure with the " tokens" suffix. Byte-identical
//                         to the historical chatUtils.formatTokens (which never
//                         switched to millions: 1_200_000 → "1200k tokens").

function thousands(n) {
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Compact token figure without a unit. */
export function formatTokenCount(n) {
  if (n < 1000) return String(n);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return thousands(n);
}

/** Token figure with the " tokens" suffix. */
export function formatTokens(n) {
  if (n < 1000) return `${n} tokens`;
  return `${thousands(n)} tokens`;
}
