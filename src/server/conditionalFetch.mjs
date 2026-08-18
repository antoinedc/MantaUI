// conditionalFetch.mjs — shared conditional-GET JSON fetcher.
//
// Extracted from src/server/serverUpdate.mjs (the old `createManifestFetcher`),
// so that both the server-manifest poller AND the CLI update probes
// (src/server/cliUpdates.mjs) reuse the SAME ETag-caching fetch instead of
// growing a second copy. The three invariants below were each a real bug once;
// they are carried over verbatim and pinned by the existing serverUpdate tests
// (which must keep passing against the thin `createManifestFetcher` wrapper).

/**
 * Build a conditional-GET fetcher that caches the last successful body and
 * revalidates it with `If-None-Match` on every later call.
 *
 * The body it fetches changes rarely but is polled forever, so re-downloading
 * it on every tick is pure waste. When the origin answers `304 Not Modified`
 * it carries no body to parse, so the cached body is returned as-is — keeping
 * the caller's contract unchanged (the returned function always resolves to a
 * parsed JSON value) without the caller knowing anything about caching.
 *
 * Invariants (each one is deliberate):
 *   1. `fetchImpl` is resolved PER CALL, not captured at construction. A
 *      caller (or a test) that replaces `globalThis.fetch` after import must
 *      still take effect.
 *   2. The ETag is cached ONLY after the body successfully parses. Caching a
 *      validator for a body we failed to read would make every later call a
 *      304 that returns a stale/absent body — a permanently stuck fetch that
 *      looks healthy.
 *   3. A 304 with no cached body throws. Possible only if a proxy fabricates
 *      a 304; throwing is the safe direction (callers treat a throw as
 *      "couldn't tell", never as a false positive).
 *
 * Each returned fetcher owns its OWN cache, so tests get a clean one per call
 * and the poller's fetcher is never shared with an unrelated caller.
 *
 * @param {object} [opts]
 * @param {(url:string, init?:any) => Promise<Response>} [opts.fetchImpl]
 * @param {string} [opts.label] used in error messages ("manifest fetch",
 *   "fetch", …). Defaults to "fetch".
 * @returns {(url:string, init?:any) => Promise<any>} resolves to parsed JSON
 */
export function createJsonFetcher({ fetchImpl, label = "fetch" } = {}) {
  let etag = null;
  let cached = null;

  return async function fetchJson(url, init) {
    // Invariant 1 — resolve the fetch impl fresh on every call.
    const doFetch = fetchImpl ?? globalThis.fetch;

    const headers = etag
      ? { "if-none-match": etag, ...(init?.headers ?? {}) }
      : init?.headers;
    const res = await doFetch(url, headers ? { ...init, headers } : init);

    // Invariant 3 — a 304 with nothing cached must not masquerade as a body.
    if (res.status === 304) {
      if (cached === null) {
        throw new Error(`${label} returned 304 with no cached body`);
      }
      return cached;
    }
    if (!res.ok) throw new Error(`${label} failed: ${res.status}`);

    const body = await res.json();
    // Invariant 2 — only remember the validator once the body parsed.
    const nextEtag = res.headers?.get?.("etag") ?? null;
    etag = typeof nextEtag === "string" && nextEtag !== "" ? nextEtag : null;
    cached = body;
    return body;
  };
}
