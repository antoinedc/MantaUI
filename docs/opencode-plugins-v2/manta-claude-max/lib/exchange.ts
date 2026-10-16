// The request/response pipeline behind the `http.request` / `http.response`
// hooks, with every effect injected so it can be unit-tested without OpenCode:
//
//   onRequest   pick the identity (seat or live login) → rewrite headers/body
//               (R2: the body is read ONCE from a clone and the Request is
//               rebuilt) → remember what was sent
//   onResponse  recover (401 refresh+retry, short 429/529 backoff, long-context
//               beta exclusion, 429 → seat switch + retry) → un-prefix (R1)
//
// Everything fails OPEN: any throw leaves the request/response exactly as the
// hook received it. Tokens are never logged (sha12 at most).

import { createHash } from "node:crypto";
import { LONG_CONTEXT_BETAS, isLongContextError } from "./config.ts";
import { claudeHeaders, transformBody, withBetaParam } from "./body.ts";
import { codexHeaders } from "./codex.ts";
import { expiresSoon, type CredentialReader, type Provider, type SeatCredentials } from "./creds.ts";
import type { RequestIds, Resolved, SeatResolver } from "./seats.ts";
import { unprefixResponse } from "./sse.ts";

/** V1 `fetchWithRetry`: a retry-after beyond this is a quota reset, not a blip. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const TRANSIENT_RETRIES = 2;
const MAX_PARENT_CACHE = 500;

export const sha12 = (token: string): string => createHash("sha256").update(token).digest("hex").slice(0, 12);

/** Which provider's MODEL endpoint is this request for, if any. */
export function matchTarget(rawUrl: string, method: string): Provider | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "api.anthropic.com") return "claude";
  if (u.hostname === "chatgpt.com" && u.pathname.startsWith("/backend-api/codex/") && method.toUpperCase() === "POST") {
    return "codex";
  }
  return null;
}

interface Identity {
  kind: "seat" | "live";
  seatId: string | null;
  /** Credential file a seat identity was read from. */
  file?: string;
  /** null = "the original request identity" (codex on the live login). */
  creds: SeatCredentials | null;
}

/** What went out, so the response hook can replay it under another identity. */
interface Sent {
  provider: Provider;
  ids: RequestIds;
  url: string;
  method: string;
  /** Headers as OpenCode built them (before the identity was applied). */
  incoming: Headers;
  /** The final body text (already rewritten), or null. */
  body: string | null;
  signal: AbortSignal;
  model: string;
  nameMap: Map<string, string>;
  identity: Identity;
  excluded: Set<string>;
}

export interface ExchangeDeps {
  resolver: SeatResolver;
  credentials: CredentialReader;
  /** The parent session id of `sessionID`, or null. Never throws. */
  parentOf(sessionID: string): Promise<string | null>;
  /** Sends a REPLAYED request (the real fetch in production). */
  send(request: Request): Promise<Response>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  env?: Record<string, string | undefined>;
  log?: (tag: string, fields: Record<string, unknown>) => void;
}

/** Abort-aware sleep. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Wraps `get` so each session is looked up once (fail open: null on any error). */
export function createParentLookup(get: (sessionID: string) => Promise<unknown>): (sessionID: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (sessionID) => {
    if (cache.has(sessionID)) return cache.get(sessionID) ?? null;
    try {
      const r: any = await get(sessionID);
      const info = r?.data ?? r;
      const parent = typeof info?.parentID === "string" && info.parentID ? info.parentID : null;
      cache.set(sessionID, parent);
      if (cache.size > MAX_PARENT_CACHE) cache.delete(cache.keys().next().value as string);
      return parent;
    } catch {
      return null; // not cached: the next request asks again
    }
  };
}

function maxRetryDelayMs(env: Record<string, string | undefined>): number {
  const parsed = parseInt(env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RETRY_DELAY_MS;
}

/** Milliseconds a 429/529 asks us to wait; the V1 backoff when it names none. */
function retryDelayMs(res: Response, attempt: number): number {
  const parsed = parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isNaN(parsed) ? (attempt + 1) * 2000 : parsed * 1000;
}

export function createExchange(deps: ExchangeDeps) {
  const { resolver, credentials, parentOf } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepUnlessAborted;
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  // Keyed by the Request OpenCode hands the response hook (verified identical to
  // the one this plugin set on the request event).
  const sent = new WeakMap<Request, Sent>();

  // ---- identity ----------------------------------------------------------

  /** A seat's credentials, refreshed first when they are about to expire. */
  async function seatIdentity(provider: Provider, seat: Resolved): Promise<Identity | null> {
    let file = seat.credentialFile;
    let creds = credentials.readSeat(provider, file);
    if (!creds) return null; // unreadable / outside the seats dir → live login
    if (expiresSoon(creds.expiresAt, now()) && seat.seatId) {
      const fresh = await resolver.refresh(provider, seat.seatId);
      if (fresh?.live) return null; // the seat became the live login
      if (fresh) {
        credentials.invalidate(file);
        file = fresh.credentialFile ?? file;
        creds = credentials.readSeat(provider, file) ?? creds;
      }
    }
    return { kind: "seat", seatId: seat.seatId, file, creds };
  }

  /** The single login. Claude reads its file; Codex keeps OpenCode's own auth. */
  async function liveIdentity(provider: Provider, seatId: string | null): Promise<Identity | null> {
    if (provider === "codex") return { kind: "live", seatId, creds: null };
    let creds = credentials.readLive();
    if (creds && expiresSoon(creds.expiresAt, now()) && seatId) {
      // The server never refreshes the live login (the `claude` CLI owns it); asking
      // keeps the contract uniform and the re-read picks up a CLI-side refresh.
      await resolver.refresh(provider, seatId);
      creds = credentials.readLive() ?? creds;
    }
    return creds ? { kind: "live", seatId, creds } : null;
  }

  async function pickIdentity(provider: Provider, ids: RequestIds): Promise<Identity | null> {
    const seat = await resolver.seatFor(provider, ids);
    if (seat && !seat.live && seat.seatId) {
      const id = await seatIdentity(provider, seat);
      if (id) return id;
    }
    return liveIdentity(provider, seat?.seatId ?? null);
  }

  /** The identity for a seat answer (limit / refresh), or null when unusable. */
  async function identityFor(provider: Provider, answer: Resolved): Promise<Identity | null> {
    if (!answer.live && answer.seatId) return seatIdentity(provider, answer);
    return liveIdentity(provider, answer.seatId);
  }

  // ---- building the outgoing request ------------------------------------

  function headersFor(s: Sent, identity: Identity): Headers {
    if (s.provider === "codex") return identity.creds ? codexHeaders(s.incoming, identity.creds) : new Headers(s.incoming);
    // claude: an identity without credentials cannot exist (pickIdentity returns null)
    return claudeHeaders(s.incoming, identity.creds!.accessToken, s.model, s.excluded, env);
  }

  function build(s: Sent, identity: Identity): Request {
    return new Request(s.url, {
      method: s.method,
      headers: headersFor(s, identity),
      body: s.body ?? undefined,
      signal: s.signal,
    });
  }

  // ---- request hook ------------------------------------------------------

  async function onRequest(event: any): Promise<void> {
    try {
      const req: Request = event.request;
      const provider = matchTarget(req.url, req.method);
      if (!provider || typeof event.sessionID !== "string" || !event.sessionID) return;

      // R2: a Request body is a one-shot stream. Read it ONCE, from a clone.
      let text: string | null = null;
      if (req.method !== "GET" && req.method !== "HEAD" && req.body) text = await req.clone().text();

      let model = typeof event.model?.id === "string" ? event.model.id : "";
      let body = text;
      let nameMap = new Map<string, string>();
      let url = req.url;
      if (provider === "claude" && text !== null) {
        const tb = transformBody(text, env);
        if (tb.rewritten) {
          body = tb.body;
          nameMap = tb.nameMap;
        }
        if (tb.model) model = tb.model;
      } else if (text !== null) {
        try {
          const m = JSON.parse(text)?.model;
          if (typeof m === "string" && m) model = m;
        } catch {
          /* model unknown — resolve still works without it */
        }
      }
      if (provider === "claude") url = withBetaParam(url);

      const ids: RequestIds = {
        sessionID: event.sessionID,
        parentSessionID: await parentOf(event.sessionID),
        model: model || null,
      };
      const identity = await pickIdentity(provider, ids);
      if (!identity) return; // fail open: send what OpenCode built
      if (provider === "codex" && !identity.creds) return; // live Codex login: untouched

      const s: Sent = {
        provider,
        ids,
        url,
        method: req.method,
        incoming: new Headers(req.headers),
        body,
        signal: req.signal,
        model,
        nameMap,
        identity,
        excluded: new Set(),
      };
      const next = build(s, identity);
      sent.set(next, s);
      event.request = next;
      log("signed", {
        provider,
        kind: event.kind ?? null,
        sessionID: event.sessionID,
        via: identity.kind,
        seatId: identity.seatId,
        tokenSha12: identity.creds ? sha12(identity.creds.accessToken) : null,
        model,
        rewritten: provider === "claude" && body !== text,
      });
    } catch (e) {
      log("http_request_error", { msg: String((e as any)?.message ?? e) });
    }
  }

  // ---- response hook -----------------------------------------------------

  /** Refresh the identity that just got a 401; a usable DIFFERENT identity or null. */
  async function reauth(s: Sent): Promise<Identity | null> {
    const cur = s.identity;
    const before = cur.creds?.accessToken;
    if (cur.kind === "seat" && cur.seatId) {
      const fresh = await resolver.refresh(s.provider, cur.seatId);
      if (!fresh) return null;
      if (fresh.live) return liveIdentity(s.provider, fresh.seatId ?? cur.seatId).then((i) => (i?.creds?.accessToken !== before ? i : null));
      credentials.invalidate(cur.file);
      const file = fresh.credentialFile ?? cur.file;
      const creds = credentials.readSeat(s.provider, file);
      return creds && creds.accessToken !== before ? { kind: "seat", seatId: cur.seatId, file, creds } : null;
    }
    if (cur.kind === "live" && s.provider === "claude") {
      if (cur.seatId) await resolver.refresh(s.provider, cur.seatId);
      const creds = credentials.readLive();
      return creds && creds.accessToken !== before ? { kind: "live", seatId: cur.seatId, creds } : null;
    }
    return null;
  }

  /** A 429: report it, and return the identity of a DIFFERENT seat when it moved. */
  async function switchSeat(s: Sent): Promise<Identity | null> {
    let answer: Resolved | null = null;
    try {
      answer = await resolver.limit(s.provider, s.ids);
    } catch {
      answer = null;
    }
    // whatever the answer, the cached placement is stale
    resolver.forget(s.provider, s.ids);
    if (!answer || answer.seatId === s.identity.seatId) return null;
    const identity = await identityFor(s.provider, answer);
    if (!identity) return null;
    resolver.remember(s.provider, s.ids, answer);
    return identity;
  }

  async function replay(s: Sent, identity: Identity): Promise<Response> {
    return deps.send(build(s, identity));
  }

  /** The recovery ladder. Returns the response to hand on (maybe the original). */
  async function recover(s: Sent, first: Response): Promise<Response> {
    let res = first;
    const used = { auth: 0, transient: 0, beta: 0, seat: 0 };
    const maxDelay = maxRetryDelayMs(env);

    /** Swap in a retried response; the first one is discarded only once the retry exists. */
    const adopt = async (next: Response) => {
      try {
        await res.body?.cancel();
      } catch {
        /* the earlier response is discarded either way */
      }
      res = next;
    };

    try {
    for (let step = 0; step < 8; step++) {
      // 1. rejected token → refresh server-side, re-read, retry once
      if (res.status === 401 && used.auth < 1) {
        used.auth++;
        const identity = await reauth(s);
        if (!identity) break;
        const next = await replay(s, identity);
        s.identity = identity;
        await adopt(next);
        log("auth_retry", { provider: s.provider, status: next.status });
        continue;
      }

      // 2. a blip: honour a SHORT retry-after ourselves (V1 fetchWithRetry)
      if ((res.status === 429 || res.status === 529) && used.transient < TRANSIENT_RETRIES) {
        const delay = retryDelayMs(res, used.transient);
        if (delay <= maxDelay) {
          used.transient++;
          await sleep(delay, s.signal);
          if (s.signal.aborted) break;
          await adopt(await replay(s, s.identity));
          continue;
        }
      }

      // 3. "long context" rejections: drop one long-context beta and retry
      if ((res.status === 400 || res.status === 429) && s.provider === "claude" && used.beta < LONG_CONTEXT_BETAS.length) {
        const bodyText = await res.clone().text();
        if (isLongContextError(bodyText)) {
          const beta = LONG_CONTEXT_BETAS.find((b) => !s.excluded.has(b));
          if (beta) {
            used.beta++;
            s.excluded.add(beta);
            await adopt(await replay(s, s.identity));
            log("beta_excluded", { model: s.model, beta });
            continue;
          }
        }
      }

      // 4. the seat hit its usage limit → report, retry ONCE if the seat moved
      if (res.status === 429 && used.seat < 1) {
        used.seat++;
        const identity = await switchSeat(s);
        if (identity) {
          const next = await replay(s, identity);
          s.identity = identity;
          await adopt(next);
          log("seat_switched", { provider: s.provider, seatId: identity.seatId, status: next.status });
          continue;
        }
      }
      break;
    }
    } catch (e) {
      // `res` is whatever was last adopted: never throw a half-consumed response away
      log("recover_error", { msg: String((e as any)?.message ?? e) });
    }
    return res;
  }

  /** What the caller finally sees: un-prefixed on success; a quota 429 made visible. */
  function finalize(s: Sent, res: Response): Response {
    if (res.ok) return s.provider === "claude" ? unprefixResponse(res, s.nameMap) : res;
    if ((res.status === 429 || res.status === 529) && retryDelayMs(res, 0) > maxRetryDelayMs(env)) {
      // A quota reset hours away must surface as an error, not park the turn in
      // OpenCode's own retry loop (V1: "surfaced rather than hung on").
      const headers = new Headers(res.headers);
      headers.delete("retry-after");
      headers.delete("x-should-retry");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  }

  async function onResponse(event: any): Promise<void> {
    try {
      const s = sent.get(event.request);
      if (!s) return;
      sent.delete(event.request);
      event.response = finalize(s, await recover(s, event.response));
    } catch (e) {
      log("http_response_error", { msg: String((e as any)?.message ?? e) });
    }
  }

  return { onRequest, onResponse };
}
