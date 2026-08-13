// httpError.mjs — the ONE place a non-2xx `fetch` Response becomes the Error
// shape usage.mjs's poller understands (`.status`, optional `.retryAfterMs`
// in ms parsed from a `Retry-After` seconds header). All three adapters
// (claude/codex/kimi) call this identically; it is not provider-specific
// logic, so it lives here rather than being duplicated three times or
// living in usage.mjs (which would create a usage.mjs <-> adapter import
// cycle, since usage.mjs imports the adapters).

/**
 * @param {{status:number, headers?:{get?:(name:string)=>string|null|undefined}}} res
 * @param {string} label  short adapter-provided context for the message, e.g. "claude usage"
 * @returns {Error & {status:number, retryAfterMs?:number}}
 */
export function httpError(res, label) {
  const err = new Error(`${label}: HTTP ${res.status}`);
  err.status = res.status;
  if (res.status === 429) {
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
  }
  return err;
}
