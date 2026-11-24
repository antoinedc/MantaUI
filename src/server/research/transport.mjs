// transport.mjs — the one way the Architect's research tools reach the network (Agents Phase 5A §4.3).
//
// node:http(s) with a `request-filtering-agent` agent on EVERY hop: private, loopback and link-local addresses are refused
// at connect time (so a DNS answer that changes between a check and the connection can't get through, and an IP literal is
// filtered like any host). Redirects are followed by hand: at most MAX_REDIRECTS, each hop a new filtered request, with ONE
// deadline and ONE streamed decoded-byte cap across all hops. Pure transport: no content rules live here.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from "request-filtering-agent";

export const FETCH_DEADLINE_MS = 20_000;
export const BYTE_CAP = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; MantaArchitect/1.0; +https://mantaui.com)";

/** A refusal whose message is a sentence for the model (never a stack, never a path). */
export class ResearchError extends Error {
  constructor(message, code = "refused") {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}

const decoderFor = (encoding) => {
  switch (String(encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
};

/**
 * Build the production transport. `agentOptions` are passed to the filtering agents (tests only: the default refuses every
 * private address). Returns `hop(request)`: ONE request, no redirect following —
 * `{ url, method?, headers?, body?, deadlineAt, bytesLeft }` → `{ status, headers, body: Buffer, bytes }`.
 * Throws a ResearchError: "timeout", "too-large" or "blocked/failed".
 */
export function createGuardedTransport({ agentOptions = {} } = {}) {
  return function hop({ url, method = "GET", headers = {}, body = null, deadlineAt, bytesLeft }) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch {
        reject(new ResearchError("That isn't a valid address"));
        return;
      }
      const secure = target.protocol === "https:";
      if (!secure && target.protocol !== "http:") {
        reject(new ResearchError("Only http and https addresses can be read"));
        return;
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        reject(new ResearchError("The page took too long to answer", "timeout"));
        return;
      }
      const agent = secure ? new RequestFilteringHttpsAgent({ ...agentOptions }) : new RequestFilteringHttpAgent({ ...agentOptions });
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        agent.destroy();
        fn(value);
      };
      const lib = secure ? https : http;
      const req = lib.request(
        target,
        {
          method,
          agent,
          headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate, br", ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) },
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          const decoder = decoderFor(res.headers["content-encoding"]);
          const source = decoder ? res.pipe(decoder) : res;
          if (decoder) decoder.on("error", () => finish(reject, new ResearchError("The page couldn't be decoded")));
          source.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > bytesLeft) {
              req.destroy();
              res.destroy();
              finish(reject, new ResearchError("The page is too large to read (over 2 MiB)", "too-large"));
              return;
            }
            chunks.push(chunk);
          });
          source.on("end", () => finish(resolve, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), bytes }));
          source.on("error", () => finish(reject, new ResearchError("The connection failed while reading the page")));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(reject, new ResearchError("The page took too long to answer", "timeout"));
      }, remaining);
      req.on("error", (e) => {
        // the filtering agent's refusal and every other connect failure read the same to the model: it can't reach that address
        const blocked = /not allowed|private IP|meta IP/i.test(String(e?.message ?? ""));
        finish(reject, new ResearchError(blocked ? "That address isn't reachable (private and local addresses are blocked)" : "Couldn't reach that address", blocked ? "blocked" : "failed"));
      });
      if (body) req.write(body);
      req.end();
    });
  };
}

const isRedirect = (status) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * Follow redirects by hand over `hop`. `check(url)` runs on EVERY hop's address (including the first) and returns a sentence
 * to refuse it or null; `onRedirect(from, to)` may refuse a redirect (a sentence) before the next request is made. One
 * deadline and one byte budget span every hop; a redirect response's own body counts against it.
 * `{ status, headers, body, finalUrl, redirects }`.
 */
export async function fetchFollowing(hop, url, { headers = {}, check = () => null, onRedirect = () => null, now = Date.now, maxRedirects = MAX_REDIRECTS, deadlineMs = FETCH_DEADLINE_MS, byteCap = BYTE_CAP } = {}) {
  const deadlineAt = now() + deadlineMs;
  let bytesLeft = byteCap;
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const refused = check(current);
    if (refused) throw new ResearchError(refused);
    const res = await hop({ url: current, headers, deadlineAt, bytesLeft });
    bytesLeft -= res.bytes ?? res.body.length;
    if (!isRedirect(res.status)) return { ...res, finalUrl: current, redirects };
    const location = res.headers.location;
    if (!location) return { ...res, finalUrl: current, redirects };
    if (redirects >= maxRedirects) throw new ResearchError("The page redirected too many times");
    let next;
    try {
      next = new URL(location, current).href;
    } catch {
      throw new ResearchError("The page redirected to an invalid address");
    }
    const no = onRedirect(current, next);
    if (no) throw new ResearchError(no);
    current = next;
  }
}
