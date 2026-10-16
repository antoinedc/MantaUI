// Seat resolution against manta-server — behaviour identical to V1
// `manta-accounts.ts`: `GET /api/accounts/resolve` (1.5 s), a 30 s cache per
// conversation (500 entries), single-flight lookups, and FAIL-SAFE answers (the
// last result for the conversation, else "no seat" = the single live login).
// `POST /api/accounts/refresh` (30 s) and `/limit` (10 s) are single-purpose
// round trips; refresh is also single-flight per seat.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./creds.ts";

export const DEFAULT_SERVER = "http://127.0.0.1:8787";
export const RESOLVE_CACHE_MS = 30_000;
export const RESOLVE_TIMEOUT_MS = 1_500;
export const REFRESH_TIMEOUT_MS = 30_000;
export const LIMIT_TIMEOUT_MS = 10_000;
export const MAX_CACHE_ENTRIES = 500;

/** The conversation a request belongs to, plus its model when known. */
export interface RequestIds {
  sessionID: string;
  parentSessionID: string | null;
  model?: string | null;
}

/** manta-server's answer: which seat, and where its credential file is. */
export interface Resolved {
  seatId: string | null;
  live: boolean;
  credentialFile?: string;
  moved?: boolean;
}

/** The conversation key: a sub-agent shares its parent's seat. */
export const rootKey = (provider: Provider, ids: { sessionID: string; parentSessionID: string | null }): string =>
  `${provider}|${ids.parentSessionID ?? ids.sessionID}`;

/** Validate a resolve/refresh/limit answer. Anything unusable degrades to "live". */
export function parseResolved(json: any): Resolved | null {
  if (!json || typeof json !== "object") return null;
  const seatId = typeof json.seatId === "string" ? json.seatId : null;
  const moved = typeof json.moved === "boolean" ? json.moved : undefined;
  if (json.live === false && typeof json.credentialFile === "string" && json.credentialFile) {
    return { seatId, live: false, credentialFile: json.credentialFile, ...(moved === undefined ? {} : { moved }) };
  }
  return { seatId, live: true, ...(moved === undefined ? {} : { moved }) };
}

/** Only a loopback http(s) URL is ever accepted from the environment. */
export function loopbackBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function serverBase(env: Record<string, string | undefined> = process.env): string {
  return loopbackBase(env.MANTA_ACCOUNTS_SERVER) ?? loopbackBase(env.MANTA_SERVER_URL) ?? DEFAULT_SERVER;
}

/** Same lookup as the shared manta-auth helper (a plugin cannot import the tools dir). */
export function boxToken(env: Record<string, string | undefined> = process.env): string | null {
  if (env.MANTA_BOX_TOKEN) return env.MANTA_BOX_TOKEN;
  try {
    const tok = JSON.parse(readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8"))?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null;
  }
}

export interface SeatResolverDeps {
  fetch: typeof fetch;
  base: () => string;
  token?: () => string | null;
  now?: () => number;
}

export interface SeatResolver {
  /** Which seat serves this conversation (cached 30 s). null = no answer. */
  seatFor(provider: Provider, ids: RequestIds): Promise<Resolved | null>;
  /** Refresh a seat server-side (single-flight). null = refused/unreachable. */
  refresh(provider: Provider, seatId: string): Promise<Resolved | null>;
  /** A 429 happened: re-place the conversation and answer where it goes now. */
  limit(provider: Provider, ids: RequestIds): Promise<Resolved | null>;
  /** Drop the cached placement (the next seatFor asks again). */
  forget(provider: Provider, ids: RequestIds): void;
  /** Remember a placement we learned from a /limit answer. */
  remember(provider: Provider, ids: RequestIds, result: Resolved): void;
}

export function createSeatResolver(deps: SeatResolverDeps): SeatResolver {
  const now = deps.now ?? (() => Date.now());
  const token = deps.token ?? (() => boxToken());
  const byConversation = new Map<string, { result: Resolved; at: number }>();
  const resolving = new Map<string, Promise<Resolved | null>>();
  const refreshing = new Map<string, Promise<Resolved | null>>();

  const put = <V>(map: Map<string, V>, key: string, value: V) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value as string);
  };

  async function call(
    pathAndQuery: string,
    opts: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
  ): Promise<Resolved | null> {
    const headers: Record<string, string> = {};
    const tok = token();
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
    try {
      const res = await deps.fetch(`${deps.base()}${pathAndQuery}`, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      return parseResolved(await res.json());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async seatFor(provider, ids) {
      const key = rootKey(provider, ids);
      const cached = byConversation.get(key);
      if (cached && now() - cached.at < RESOLVE_CACHE_MS) return cached.result;
      let run = resolving.get(key);
      if (!run) {
        const q = new URLSearchParams({ provider, sessionID: ids.sessionID });
        if (ids.parentSessionID) q.set("parentSessionID", ids.parentSessionID);
        if (ids.model) q.set("model", ids.model);
        run = call(`/api/accounts/resolve?${q}`, { method: "GET", timeoutMs: RESOLVE_TIMEOUT_MS })
          .catch(() => null)
          .finally(() => resolving.delete(key));
        resolving.set(key, run);
      }
      const fresh = await run;
      if (fresh) {
        put(byConversation, key, { result: fresh, at: now() });
        return fresh;
      }
      // FAIL-SAFE: the last answer for this conversation, however old; else none.
      return cached?.result ?? null;
    },

    refresh(provider, seatId) {
      const key = `${provider}|${seatId}`;
      let run = refreshing.get(key);
      if (!run) {
        run = call("/api/accounts/refresh", {
          method: "POST",
          body: { provider, seatId },
          timeoutMs: REFRESH_TIMEOUT_MS,
        })
          .catch(() => null)
          .finally(() => refreshing.delete(key));
        refreshing.set(key, run);
      }
      return run;
    },

    async limit(provider, ids) {
      const body: Record<string, string> = { provider, sessionID: ids.sessionID };
      if (ids.parentSessionID) body.parentSessionID = ids.parentSessionID;
      if (ids.model) body.model = ids.model;
      return call("/api/accounts/limit", { method: "POST", body, timeoutMs: LIMIT_TIMEOUT_MS }).catch(() => null);
    },

    forget(provider, ids) {
      byConversation.delete(rootKey(provider, ids));
    },

    remember(provider, ids, result) {
      put(byConversation, rootKey(provider, ids), { result, at: now() });
    },
  };
}
