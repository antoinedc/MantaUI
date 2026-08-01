/**
 * Single shared helper for talking to the Multica API.
 *
 * Previously scripts/multica-pr-closed.mjs, multica-unblock.mjs and
 * multica-unstick.mjs each carried their own near-identical HTTP call — two
 * named `api(base, token, path, opts)` plus many bare `fetch` calls in the
 * third. Three copies is why a fix made once drifted into three. This module is
 * now the ONLY place a Multica write happens, which makes "a failed write must
 * fail the job" a single change rather than three.
 *
 * Policy: the helper throws an `ApiError` on ANY non-OK response, reads and
 * writes alike. A sweep decides separately whether a call is a read (warn and
 * continue) or a write (fail the job) — write failures must never be invisible.
 * The error carries the HTTP status + body so a sweep can log key + status +
 * body on a failed write. The GitHub API calls in multica-pr-closed.mjs stay
 * out of here on purpose: different API, different token/headers, and they must
 * warn-and-continue rather than throw.
 *
 * ENV contract is unchanged and lives in the callers: MULTICA_TOKEN,
 * MULTICA_API_BASE (default https://api.multica.ai) and the workspace id each
 * script already reads.
 */

export const DEFAULT_WORKSPACE = "264c89bb-4659-4570-af7b-5f8daaf87985";
export const DEFAULT_API_BASE = "https://api.multica.ai";

/** A non-OK response from the Multica API; carries `status`, `path`, `body`. */
export class ApiError extends Error {
  constructor({ status, path, body }) {
    const snippet = typeof body === "string" ? body.slice(0, 200) : "";
    super(`HTTP ${status} on ${path}${snippet ? `: ${snippet}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/**
 * @param {string} base         API base URL (without trailing `/api`)
 * @param {string} token        bearer token (MULTICA_TOKEN)
 * @param {string} path         API path starting with `/` (e.g. `/issues/BET-1`)
 * @param {object} [opts]       fetch options (method, body, headers)
 * @param {typeof fetch} [fetchImpl]  injectable fetch for tests; defaults to global
 * @returns {Promise<object>} parsed JSON body (or `{}` when empty)
 * @throws {ApiError} on a non-OK response
 */
export async function api(base, token, path, opts = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${base}/api${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new ApiError({ status: res.status, path, body });
  }
  return body ? JSON.parse(body) : {};
}
