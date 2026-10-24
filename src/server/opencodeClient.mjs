// @ts-check
// The typed OpenCode V2 client (@opencode/client, Promise entry) wired onto
// manta-server's own transport.
//
// The client is only a request builder + response decoder here: every request
// goes out through the `send` the caller provides (opencode.mjs passes its
// pooled, per-request-authenticated `ocFetch`), so pooling, timeouts, caller
// `signal`s, the Basic-auth header (re-read per request) and the base URL
// (resolved per request) all stay exactly where they were.
//
// What the client does NOT give us is the HTTP status: a non-2xx surfaces as a
// typed error (or a bare `ClientError`) with no status, no body and no
// Retry-After, while every caller classifies on `err.status` (a definitive 4xx
// refusal vs an unknown outcome). So each call runs under a per-call context
// that the fetch wrapper fills in — the failing response's status/body/headers,
// or the transport error it threw — and `call` turns that back into the
// caller-visible error. The context is found through a header the wrapper
// strips before the request leaves, so concurrent calls never see each other's.

import { OpenCode } from "@opencode/client";
import { parseRetryAfterMs } from "./usageAdapters/httpError.mjs";

/** @typedef {import("@opencode/client").OpenCodeClient} OpenCodeClient */

/**
 * A non-2xx response, captured by the fetch wrapper.
 * @typedef {{ status: number, text: string, headers: Headers }} HttpFailure
 */

/**
 * @typedef {object} CallOptions
 * @property {AbortSignal} [signal]  bounds the request through the real transport
 * @property {(failure: HttpFailure) => any} [onHttpError]  handle a non-2xx yourself: its return value is the call's result (it may throw). Without it the call throws `statusError(label, failure)`.
 * @property {boolean} [ignoreBody]  a void operation: ANY 2xx is success, whatever the (ignored) body or status — the client only accepts a 204 for these.
 */

/** @typedef {{ failure?: HttpFailure, thrown?: unknown, ok?: Response }} CallContext */

const CALL_HEADER = "x-manta-call";
// The client wants a base URL at creation; the real one is resolved per request
// by the wrapper (a sandbox can re-point `apiBase` after the client exists).
const PLACEHOLDER_BASE = "http://opencode.invalid";
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * The error a non-2xx becomes for the callers that always read `err.status`:
 * `opencode <label> <status>: <body>`, with `status` and `retryAfterMs` set.
 * @param {string} label
 * @param {HttpFailure} f
 */
export function statusError(label, f) {
  const err = /** @type {Error & { status?: number, retryAfterMs?: number }} */ (new Error(`opencode ${label} ${f.status}: ${f.text}`));
  err.status = f.status;
  err.retryAfterMs = parseRetryAfterMs(f.headers?.get?.("retry-after"));
  return err;
}

/**
 * The same message with NO `status`: for the reads whose callers have never
 * been able to tell a refusal from an unknown outcome and must not start to.
 * @param {string} label
 * @param {HttpFailure} f
 */
export function plainError(label, f) {
  return new Error(`opencode ${label} ${f.status}: ${f.text}`);
}

/**
 * The client accepts a 2xx only as `application/json` (or a bare 204); the code it replaces
 * parsed any 2xx body as JSON whatever its header said, and treated an empty one as "nothing".
 * Keep that: a 2xx that is not labelled JSON but IS JSON is relabelled, and an empty one becomes a
 * 204. (A well-behaved opencode never hits this; a proxy or a thin test double can.)
 * @param {Response} res
 * @returns {Promise<Response>}
 */
async function asJsonResponse(res) {
  if (NULL_BODY_STATUS.has(res.status) || /json/i.test(res.headers.get("content-type") ?? "")) return res;
  const text = await res.text();
  if (text === "") return new Response(null, { status: 204 });
  try {
    JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, headers: res.headers });
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  return new Response(text, { status: res.status, headers });
}

/**
 * @param {{ send: (url: string, init: RequestInit) => Promise<Response>, resolveUrl: (pathAndQuery: string) => string }} deps
 *   send       — the authenticated transport (resolves its own transport + auth per request)
 *   resolveUrl — the CURRENT base URL + `/api/...`, called for every request
 */
export function createOcClient({ send, resolveUrl }) {
  let seq = 0;
  /** @type {Map<string, CallContext>} */
  const contexts = new Map();

  /** @param {Parameters<typeof fetch>[0]} input @param {RequestInit} [init] */
  async function clientFetch(input, init) {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(href);
    /** @type {Record<string, string>} */
    const headers = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const ctx = contexts.get(headers[CALL_HEADER] ?? "");
    delete headers[CALL_HEADER];
    /** @type {RequestInit} */
    const out = { method: init?.method ?? "GET", headers };
    if (init?.body != null) out.body = init.body;
    if (init?.signal) out.signal = init.signal;
    let res;
    try {
      res = await send(resolveUrl(u.pathname + u.search), out);
    } catch (e) {
      if (ctx) ctx.thrown = e;
      throw e;
    }
    if (res.ok) {
      const lenient = await asJsonResponse(res);
      if (ctx) ctx.ok = lenient;
      return lenient;
    }
    const text = await res.text();
    if (ctx) ctx.failure = { status: res.status, text, headers: res.headers };
    // Hand the client a body it can decode; a status it cannot construct a
    // Response for still reaches the caller through the captured failure.
    const status = res.status >= 200 && res.status <= 599 ? res.status : 500;
    return new Response(NULL_BODY_STATUS.has(status) ? null : text, { status, headers: res.headers });
  }

  const client = OpenCode.make({ baseUrl: PLACEHOLDER_BASE, fetch: clientFetch });

  /**
   * Run one typed client operation and give back the caller-visible outcome:
   * the decoded result, or the error the pre-client code threw — the failing
   * response as `statusError`, a transport error / abort as itself.
   * @template T, [U=never]
   * @param {string} label  names the call in the error message
   * @param {(c: OpenCodeClient, requestOptions: { headers: Record<string, string>, signal?: AbortSignal }) => Promise<T>} fn
   * @param {CallOptions} [opts]
   * @returns {Promise<T | U>}
   */
  async function call(label, fn, opts = {}) {
    const id = String(++seq);
    /** @type {CallContext} */
    const ctx = {};
    contexts.set(id, ctx);
    try {
      return await fn(client, { headers: { [CALL_HEADER]: id }, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      if (ctx.failure) {
        if (opts.onHttpError) return opts.onHttpError(ctx.failure);
        throw statusError(label, ctx.failure);
      }
      if (ctx.thrown) throw ctx.thrown;
      if (ctx.ok) {
        // The client refused a 2xx it did not expect (or could not decode) and may
        // have left its body unread, which would pin a pooled socket.
        await ctx.ok.body?.cancel().catch(() => {});
        if (opts.ignoreBody) return /** @type {any} */ (undefined);
      }
      throw e;
    } finally {
      contexts.delete(id);
    }
  }

  return { client, call };
}
