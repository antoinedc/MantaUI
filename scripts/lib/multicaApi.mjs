#!/usr/bin/env node
/**
 * Single shared helper for talking to the Multica API.
 *
 * Before this existed, scripts/multica-pr-closed.mjs, scripts/multica-unblock.mjs
 * and scripts/multica-unstick.mjs each carried their own near-identical HTTP
 * call — two named `api(base, token, path, opts)` plus a set of bare `fetch`
 * calls in the third. Three copies of one thing is why a fix made once drifted
 * into three. This module is the ONLY place a Multica write happens, which is
 * what makes "a failed write must fail the job" a single change rather than
 * three.
 *
 * Policy: the helper throws an `ApiError` on ANY non-OK response, reads and
 * writes alike. A sweep decides separately whether a given call is a read
 * (warn and continue) or a write (fail the job) — write failures must never be
 * invisible. The error carries the HTTP status and response body so a sweep can
 * log the issue key, the status and the body on a failed write.
 *
 * The GitHub API calls in multica-pr-closed.mjs (branch/PR probes, PR comments)
 * deliberately do NOT go through here: they target api.github.com with a
 * different token, different headers, and must warn-and-continue rather than
 * throw. This helper is Multica-only.
 *
 * ENV contract is unchanged and lives in the callers: MULTICA_TOKEN,
 * MULTICA_API_BASE (default https://api.multica.ai) and the workspace id each
 * script already reads. Nothing is renamed or added.
 */

export const DEFAULT_WORKSPACE = "264c89bb-4659-4570-af7b-5f8daaf87985";
export const DEFAULT_API_BASE = "https://api.multica.ai";

/** A non-OK response from the Multica API. Carries status + path + raw body so
 *  a sweep can log the key, the HTTP status and the response body. */
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
