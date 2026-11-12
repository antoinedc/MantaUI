// The request/response pipeline behind the `http.request` / `http.response`
// hooks, with every effect injected so it can be unit-tested without OpenCode:
//
//   onRequest   pick the identity (seat or live login) → rewrite headers/body
//               (R2: the body is read ONCE from a clone and the Request is
//               rebuilt) → remember what was sent
//   onResponse  recover (401 refresh+retry, short 429/529 backoff, long-context
//               beta exclusion, 401/429 → ONE resend on another seat) → un-prefix (R1)
//
// A box WITH Claude seats never sends a request signed by OpenCode's own stored
// Anthropic key or by a dead live login. When no identity can be found the hook
// still NEVER THROWS (OpenCode wraps promise hooks in `Effect.promise`, so a
// rejection would be an unhandled defect): it strips `authorization` + `x-api-key`
// (marking the request "unsigned"), and `onResponse` makes one more lookup — a
// seat found → the request is resent signed; none → the response is replaced by a
// synthetic Anthropic-shaped error (529 retryable / 401 final).
//   Why 529 and not another 5xx: in OpenCode 2.0.30 `classifyProviderFailure`
//   (ai/src/provider-error.ts) turns any status >= 500 into ProviderInternal and
//   `isRetryable` (same file) is true for it; the executor reads `retry-after`
//   into `retryAfterMs` (ai/src/route/executor.ts) and the runner's schedule
//   (core/src/session/runner/retry.ts) honours it, 10 tries at most. A 401 is
//   `Authentication`, which `isRetryable` refuses.
// A box with NO seats (an API-key user, or one login) fails OPEN as before: any
// throw leaves the request/response exactly as the hook received it.
// Tokens are never logged (sha12 at most).

import { createHash } from "node:crypto";
import { LONG_CONTEXT_BETAS, isLongContextError } from "./config.ts";
import { claudeHeaders, normalizeCacheControlBody, transformBody, withBetaParam } from "./body.ts";
import { codexHeaders } from "./codex.ts";
import { expiresSoon, type CredentialReader, type Provider, type SeatCredentials } from "./creds.ts";
import { LATE_RESOLVE_BUDGET_MS, RESOLVE_TIMEOUT_MS, type LimitReason, type RequestIds, type Resolved, type SeatResolver } from "./seats.ts";
import { unprefixResponse } from "./sse.ts";

/** V1 `fetchWithRetry`: a retry-after beyond this is a quota reset, not a blip. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const TRANSIENT_RETRIES = 2;
const MAX_PARENT_CACHE = 500;
const MAX_DEAD_LIVE_TOKENS = 32;

/** What the user sees when a request is refused instead of sent. Fixed strings: never a token. */
export type FailClosed = "seat-service-unavailable" | "no-usable-seat";
export const FAIL_CLOSED_MESSAGES: Record<FailClosed, string> = {
  "seat-service-unavailable": "Manta could not reach its seat service to pick a Claude seat for this conversation; retrying.",
  "no-usable-seat":
    "Manta has no usable Claude seat right now (all seats are signed out or failing). Open Settings → Accounts.",
};

/** The Anthropic-shaped error replacing the response of a request we refused to sign. */
export function syntheticErrorResponse(kind: FailClosed): Response {
  const retryable = kind === "seat-service-unavailable";
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: retryable ? "overloaded_error" : "authentication_error", message: FAIL_CLOSED_MESSAGES[kind] },
    }),
    {
      status: retryable ? 529 : 401,
      headers: { "content-type": "application/json", ...(retryable ? { "retry-after": "3" } : {}) },
    },
  );
}

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

/** What a request was, so the response hook can replay it under another identity. */
interface Base {
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
  excluded: Set<string>;
  /** Does the box have Claude seats? (decided at request time) */
  seatsExist: boolean;
}

/** What went out. */
interface Sent extends Base {
  identity: Identity;
}

/** A request sent WITHOUT credentials, awaiting its response hook. */
interface Unsigned {
  base: Base;
  kind: FailClosed;
}

interface Decision {
  identity: Identity | null;
  /** No identity and seats exist: refuse rather than send OpenCode's own credential. */
  closed?: FailClosed;
  seatsExist: boolean;
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
  const unsigned = new WeakMap<Request, Unsigned>();

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

  /** Remember a live token Anthropic rejected (by sha12; a token never leaves this plugin instance). */
  const deadLive = new Set<string>();
  function markDead(token: string): void {
    deadLive.add(sha12(token));
    if (deadLive.size > MAX_DEAD_LIVE_TOKENS) deadLive.delete(deadLive.values().next().value as string);
  }

  /** A live token we may still send: not actually expired, not one that already got a 401. */
  function liveUsable(creds: SeatCredentials | null): creds is SeatCredentials {
    if (!creds) return false; // an empty / unreadable login is absent
    if (typeof creds.expiresAt === "number" && creds.expiresAt <= now()) return false;
    return !deadLive.has(sha12(creds.accessToken));
  }

  /**
   * The single login. Claude reads its file; Codex keeps OpenCode's own auth.
   * Soon-to-expire is NOT a reason to refuse (a single-login box would then have
   * nothing): the server is asked to refresh first, then the file is re-read and
   * only an expired or known-dead token is refused.
   */
  async function liveIdentity(provider: Provider, seatId: string | null): Promise<Identity | null> {
    if (provider === "codex") return { kind: "live", seatId, creds: null };
    let creds = credentials.readLive();
    if (creds && expiresSoon(creds.expiresAt, now()) && seatId) {
      // The server never refreshes the live login (the `claude` CLI owns it); asking
      // keeps the contract uniform and the re-read picks up a CLI-side refresh.
      await resolver.refresh(provider, seatId);
      creds = credentials.readLive();
    }
    return liveUsable(creds) ? { kind: "live", seatId, creds } : null;
  }

  /** Do seats exist, going by what the server answered (older servers send no reason: scan the directory). */
  function seatsExistFor(answer: Resolved): boolean {
    if (answer.reason === "no-seats") return false;
    if (answer.reason === "no-usable-seat" || answer.seatId !== null) return true;
    return credentials.hasSeats("claude");
  }

  async function pickDecision(provider: Provider, ids: RequestIds, budgetMs?: number): Promise<Decision> {
    if (provider === "codex") {
      // Codex behaves exactly as before seat routing hardened Claude.
      const look = await resolver.seatFor(provider, ids, { budgetMs: budgetMs ?? RESOLVE_TIMEOUT_MS });
      const seat = look.ok ? look.result : null;
      if (seat && !seat.live && seat.seatId) {
        const id = await seatIdentity(provider, seat);
        if (id) return { identity: id, seatsExist: false };
      }
      return { identity: await liveIdentity(provider, seat?.seatId ?? null), seatsExist: false };
    }

    const look = await resolver.seatFor(provider, ids, budgetMs === undefined ? undefined : { budgetMs });
    if (!look.ok) {
      // Server unreachable / slow / warming, and no earlier answer for this conversation.
      if (credentials.hasSeats(provider)) return { identity: null, closed: "seat-service-unavailable", seatsExist: true };
      const live = await liveIdentity(provider, null);
      return { identity: live, seatsExist: false };
    }
    const answer = look.result;
    if (answer.reason === "no-usable-seat") return { identity: null, closed: "no-usable-seat", seatsExist: true };
    const seatsExist = seatsExistFor(answer);
    if (!answer.live && answer.seatId) {
      const id = await seatIdentity(provider, answer);
      if (id) return { identity: id, seatsExist };
    }
    const live = await liveIdentity(provider, answer.seatId);
    if (live) return { identity: live, seatsExist };
    // The server DID answer, so this is not "unreachable": a seat that cannot sign will not heal by retrying.
    return seatsExist ? { identity: null, closed: "no-usable-seat", seatsExist } : { identity: null, seatsExist };
  }

  /** The identity for a seat answer (limit / refresh), or null when unusable. */
  async function identityFor(provider: Provider, answer: Resolved): Promise<Identity | null> {
    if (answer.reason === "no-usable-seat") return null;
    if (!answer.live && answer.seatId) return seatIdentity(provider, answer);
    return liveIdentity(provider, answer.seatId);
  }

  // ---- building the outgoing request ------------------------------------

  function headersFor(s: Base, identity: Identity): Headers {
    if (s.provider === "codex") return identity.creds ? codexHeaders(s.incoming, identity.creds) : new Headers(s.incoming);
    // claude: an identity without credentials cannot exist (pickIdentity returns null)
    return claudeHeaders(s.incoming, identity.creds!.accessToken, s.model, s.excluded, env);
  }

  function build(s: Base, identity: Identity): Request {
    return new Request(s.url, {
      method: s.method,
      headers: headersFor(s, identity),
      body: s.body ?? undefined,
      signal: s.signal,
    });
  }

  // ---- request hook ------------------------------------------------------

  /**
   * Fail closed WITHOUT throwing: send the request with its credentials removed (so
   * a stored key can never leave) and let `onResponse` decide — resend signed if a
   * seat turned up, else substitute a synthetic error. The body keeps the
   * cache_control fix.
   */
  function refuse(event: any, req: Request, text: string | null, base: Base, kind: FailClosed): void {
    const headers = new Headers(req.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    let body = text;
    if (base.provider === "claude" && text !== null) {
      const n = normalizeCacheControlBody(text);
      if (n.changed) {
        body = n.body;
        headers.delete("content-length"); // the body length changed
      }
    }
    const next = new Request(req.url, { method: req.method, headers, body: body ?? undefined, signal: req.signal });
    unsigned.set(next, { base, kind });
    event.request = next;
    log("unsigned", { provider: base.provider, sessionID: base.ids.sessionID, kind, seatsExist: base.seatsExist });
  }

  async function onRequest(event: any): Promise<void> {
    try {
      const req: Request = event.request;
      const provider = matchTarget(req.url, req.method);
      if (!provider) return;

      // R2: a Request body is a one-shot stream. Read it ONCE, from a clone.
      let text: string | null = null;
      if (req.method !== "GET" && req.method !== "HEAD" && req.body) text = await req.clone().text();

      // Every Anthropic request gets the cache_control fix, whatever happens next:
      // a request with no session, or one we sign for no identity (API-key auth,
      // where the plugin deliberately leaves headers and the rest of the body alone),
      // is still sent with the cache normalisation applied.
      const cacheOnly = () => {
        if (provider !== "claude" || text === null) return;
        const n = normalizeCacheControlBody(text);
        if (!n.changed) return;
        const headers = new Headers(req.headers);
        headers.delete("content-length"); // the body length changed
        event.request = new Request(req.url, { method: req.method, headers, body: n.body, signal: req.signal });
        log("cache_normalized", { sessionID: event.sessionID ?? null, signed: false });
      };

      if (typeof event.sessionID !== "string" || !event.sessionID) return cacheOnly();

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
      let decision: Decision;
      try {
        decision = await pickDecision(provider, ids);
      } catch (e) {
        // An unexpected failure must not hand OpenCode's own key to Anthropic on a box with seats.
        log("pick_error", { msg: String((e as any)?.message ?? e) });
        const seats = provider === "claude" && credentials.hasSeats(provider);
        decision = { identity: null, seatsExist: seats, ...(seats ? { closed: "seat-service-unavailable" as const } : {}) };
      }
      const base: Base = {
        provider,
        ids,
        url,
        method: req.method,
        incoming: new Headers(req.headers),
        body,
        signal: req.signal,
        model,
        nameMap,
        excluded: new Set(),
        seatsExist: decision.seatsExist,
      };
      const identity = decision.identity;
      if (!identity) {
        // The box has seats but none can sign this request: never let OpenCode's own key go out.
        if (decision.closed && provider === "claude") return refuse(event, req, text, base, decision.closed);
        return cacheOnly(); // fail open: send what OpenCode built (cache fix aside)
      }
      if (provider === "codex" && !identity.creds) return; // live Codex login: untouched

      const s: Sent = { ...base, identity };
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
      stripStoredCredentials(event);
    }
  }

  /**
   * Last resort after an unexpected throw in `onRequest`: on a box with Claude seats,
   * OpenCode's own `authorization` / `x-api-key` must not go out. Best effort, never
   * throws, and the body is left alone. Not registered as unsigned (there may be too
   * little state to resend), so Anthropic's own 401 is what passes through.
   */
  function stripStoredCredentials(event: any): void {
    try {
      const req: Request | undefined = event?.request;
      if (!req || sent.has(req) || unsigned.has(req)) return; // already ours
      if (matchTarget(req.url, req.method) !== "claude" || !credentials.hasSeats("claude")) return;
      try {
        req.headers.delete("authorization");
        req.headers.delete("x-api-key");
      } catch {
        const headers = new Headers(req.headers);
        headers.delete("authorization");
        headers.delete("x-api-key");
        event.request = new Request(req, { headers });
      }
      log("unsigned_after_error", { sessionID: typeof event.sessionID === "string" ? event.sessionID : null });
    } catch {
      /* nothing more can be done without throwing */
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
      return liveUsable(creds) && creds.accessToken !== before ? { kind: "live", seatId: cur.seatId, creds } : null;
    }
    return null;
  }

  /**
   * A 429 ("limit") or a seat that rejected its credentials ("auth"): report it, and
   * return the identity of a DIFFERENT seat when the conversation moved.
   */
  async function switchSeat(s: Sent, reason: LimitReason): Promise<Identity | null> {
    let answer: Resolved | null = null;
    try {
      answer = await resolver.limit(s.provider, s.ids, reason);
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

  /**
   * A 401 that a refresh did not cure: the identity of a DIFFERENT seat to resend on,
   * or null. A seat is reported to the server (`/limit {reason:"auth"}`); a dead live
   * login with seats on the box is re-placed on a seat instead.
   */
  async function anotherSeatAfterAuth(s: Sent): Promise<Identity | null> {
    if (s.provider !== "claude") return null;
    if (s.identity.kind === "seat") return switchSeat(s, "auth");
    if (s.identity.kind === "live" && s.seatsExist) {
      resolver.forget(s.provider, s.ids);
      const look = await resolver.seatFor(s.provider, s.ids, { budgetMs: LATE_RESOLVE_BUDGET_MS });
      if (!look.ok || look.result.reason || look.result.live || !look.result.seatId) return null;
      return seatIdentity(s.provider, look.result);
    }
    return null;
  }

  async function replay(s: Sent, identity: Identity): Promise<Response> {
    return deps.send(build(s, identity));
  }

  /** The recovery ladder. Returns the response to hand on (maybe the original). */
  async function recover(s: Sent, first: Response): Promise<Response> {
    let res = first;
    // `resend`: at most ONE resend on another seat per original request, whichever path asks for it.
    const used = { auth: 0, transient: 0, beta: 0, resend: 0 };
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
      // 1. rejected token → refresh server-side, re-read, retry once; if that does not
      //    cure it, move to another seat (once)
      if (res.status === 401) {
        if (s.provider === "claude" && s.identity.kind === "live" && s.identity.creds) markDead(s.identity.creds.accessToken);
        if (used.auth < 1) {
          used.auth++;
          const identity = await reauth(s);
          if (identity) {
            const next = await replay(s, identity);
            s.identity = identity;
            await adopt(next);
            log("auth_retry", { provider: s.provider, status: next.status });
            continue;
          }
        }
        if (used.resend < 1 && s.provider === "claude") {
          used.resend++;
          const identity = await anotherSeatAfterAuth(s);
          if (identity) {
            const next = await replay(s, identity);
            s.identity = identity;
            await adopt(next);
            log("seat_switched", { provider: s.provider, seatId: identity.seatId, status: next.status, why: "auth" });
            continue;
          }
        }
        break;
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
      if (res.status === 429 && used.resend < 1) {
        used.resend++;
        const identity = await switchSeat(s, "limit");
        if (identity) {
          const next = await replay(s, identity);
          s.identity = identity;
          await adopt(next);
          log("seat_switched", { provider: s.provider, seatId: identity.seatId, status: next.status, why: "limit" });
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

  /** An unsigned request's response: resend signed if a seat turns up, else answer with a synthetic error. */
  async function onUnsignedResponse(event: any, u: Unsigned): Promise<void> {
    try {
      await event.response?.body?.cancel();
    } catch {
      /* the credential-less response is discarded either way */
    }
    let kind = u.kind;
    try {
      const again = await pickDecision(u.base.provider, u.base.ids, LATE_RESOLVE_BUDGET_MS);
      if (again.identity && !u.base.signal.aborted) {
        const s: Sent = { ...u.base, seatsExist: again.seatsExist, identity: again.identity };
        log("unsigned_resent", { provider: s.provider, sessionID: s.ids.sessionID, via: again.identity.kind, seatId: again.identity.seatId });
        event.response = finalize(s, await recover(s, await replay(s, again.identity)));
        return;
      }
      if (again.closed) kind = again.closed;
    } catch (e) {
      log("http_response_error", { msg: String((e as any)?.message ?? e) });
    }
    event.response = syntheticErrorResponse(kind);
    log("unsigned_refused", { sessionID: u.base.ids.sessionID, kind });
  }

  async function onResponse(event: any): Promise<void> {
    try {
      const u = unsigned.get(event.request);
      if (u) {
        unsigned.delete(event.request);
        return await onUnsignedResponse(event, u);
      }
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
