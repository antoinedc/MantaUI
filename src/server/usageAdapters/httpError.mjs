// httpError.mjs — the ONE place a non-2xx `fetch` Response becomes the Error
// shape usage.mjs's poller understands (`.status`, optional `.retryAfterMs`
// in ms parsed from a `Retry-After` seconds header). All three adapters
// (claude/codex/kimi) call this identically; it is not provider-specific
// logic, so it lives here rather than being duplicated three times or
// living in usage.mjs (which would create a usage.mjs <-> adapter import
// cycle, since usage.mjs imports the adapters). `retryAfterMs` is parsed
// regardless of status — only usage.mjs's 429 branch reads it.

/**
 * @param {{status:number, headers?:{get?:(name:string)=>string|null|undefined}}} res
 * @param {string} label  short adapter-provided context for the message, e.g. "claude usage"
 * @returns {Error & {status:number, retryAfterMs?:number}}
 */
export function httpError(res, label) {
  const err = new Error(`${label}: HTTP ${res.status}`);
  err.status = res.status;
  // Parsed regardless of status: only usage.mjs's 429 branch reads
  // `retryAfterMs`, so a status guard here would gate a field nobody else
  // touches. `>= 0`, NOT `> 0`: Anthropic's usage endpoint answers a 429 with
  // a literal `retry-after: 0`, and treating that as "no header" is what sent
  // the poller into its long default backoff and blanked the dial for 15
  // minutes at a time. A falsy raw header (absent or "") stays undefined.
  const raw = res.headers?.get?.("retry-after");
  const secs = raw ? Number(raw) : NaN;
  if (Number.isFinite(secs) && secs >= 0) err.retryAfterMs = secs * 1000;
  return err;
}
