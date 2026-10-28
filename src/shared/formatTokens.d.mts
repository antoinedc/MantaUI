/** Compact token figure without a unit ("999", "12.3k", "128k", "1.2M"). */
export function formatTokenCount(n: number): string;
/** Token figure with the " tokens" suffix ("999 tokens", "12.3k tokens", "1200k tokens"). */
export function formatTokens(n: number): string;
