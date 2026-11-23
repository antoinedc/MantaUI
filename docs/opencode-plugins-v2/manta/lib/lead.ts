// The lead brief (Agents Phase 2, spec docs/superpowers/specs/2026-11-22-agents-phase2.md §4 / §7).
//
// Manta leads every chat: its instructions, the user's roster of agents and how to hand work off are appended to the
// system prompt of a chat the BOX says is led. The decision is the server's (agents.classifySession); this module only
// fetches and caches the answer per session:
//
//   context hook → cached text for the session? append it (byte-stable for the prompt cache).
//                  else GET /api/agents/lead-brief?sessionID= (timeout 1.5 s), cache the answer — an empty text too —
//                  and append it when non-empty.
//   a 503 that says the user's autonomy settings couldn't be read (`autonomy: "unreadable"`) → cache NOTHING, but append a
//   fixed fallback block for this turn: Manta must not act on rules it couldn't load (Agents Phase 3 §3). A settings
//   change reaches a chat on a new chat or after a compaction (the cache is per session).
//   anything else (503 "couldn't classify", a transport error, a bad body) → cache NOTHING and append nothing: the next
//   request asks again. Never throws, never delays a request beyond the timeout.
//   session.compacted / session.deleted → forget, so the next request refetches (a roster change shows up then).

import { append, remember } from "./briefing.ts";
import { authHeaders, serverUrl } from "./server.ts";

export const LEAD_TIMEOUT_MS = 1500;
export const AUTONOMY_FALLBACK =
  "Your lead settings couldn't be loaded for this turn. Don't hand off work, and don't merge, deploy, publish, send anything outside this box, delete data or spend money this turn.";
const FALLBACK = Symbol("autonomy-unreadable");
const MAX_TRACKED = 500;

type FetchFn = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface LeadDeps {
  fetch: FetchFn;
  base(): string;
  headers(body?: unknown): Record<string, string>;
  timeoutMs?: number;
}

export function createLead(deps: LeadDeps) {
  const timeoutMs = deps.timeoutMs ?? LEAD_TIMEOUT_MS;
  const cache = new Map<string, string>(); // sessionID → the brief ("" = deliberately not led)
  const inflight = new Map<string, Promise<string | typeof FALLBACK | null>>();
  let forgets = 0; // bumped by every forget: an answer fetched across one is not cached (it may be stale)

  async function fetchText(sessionID: string): Promise<string | typeof FALLBACK | null> {
    try {
      const res = await deps.fetch(`${deps.base()}/api/agents/lead-brief?${new URLSearchParams({ sessionID })}`, {
        method: "GET",
        headers: deps.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // 503 = the box couldn't classify the chat right now: ask again next time. One that names the autonomy settings
        // means the chat IS led but its rules couldn't be read: the turn gets the fallback block instead
        if (res.status === 503) {
          try {
            if ((await res.json())?.autonomy === "unreadable") return FALLBACK;
          } catch {
            /* an unreadable body is an ordinary 503 */
          }
        }
        return null;
      }
      const json = await res.json();
      return typeof json?.text === "string" ? json.text : null;
    } catch {
      return null;
    }
  }

  function forget(sessionID: unknown): void {
    if (typeof sessionID !== "string") return;
    forgets++;
    cache.delete(sessionID);
    inflight.delete(sessionID);
  }

  return {
    /** The `context` hook. Mutates `event.system`; never throws. */
    async onContext(event: any): Promise<void> {
      try {
        const sessionID = event?.sessionID;
        const system = event?.system;
        if (typeof sessionID !== "string" || !sessionID || !Array.isArray(system)) return;
        let text = cache.get(sessionID);
        if (text === undefined) {
          const before = forgets;
          let p = inflight.get(sessionID);
          if (!p) {
            p = fetchText(sessionID).finally(() => {
              if (inflight.get(sessionID) === p) inflight.delete(sessionID);
            });
            inflight.set(sessionID, p);
          }
          const got = await p;
          if (got === null) return; // nothing cached, nothing appended
          if (got === FALLBACK) {
            append(system, AUTONOMY_FALLBACK); // this turn only: nothing is cached, the next request asks again
            return;
          }
          // a compaction / deletion that landed while we were asking may have made this answer stale: use it, don't keep it
          if (forgets === before) remember(cache, sessionID, got, MAX_TRACKED);
          text = got;
        } else {
          remember(cache, sessionID, text, MAX_TRACKED); // most recently used
        }
        if (text) append(system, text);
      } catch {
        /* fail open — a lead-brief bug must degrade to "no brief", never a broken turn */
      }
    },

    /** One event of the plugin's event stream. */
    onEvent(ev: any): void {
      if (ev?.type === "session.compacted" || ev?.type === "session.deleted") forget(ev?.data?.sessionID);
    },

    forget,
  };
}

/** The lead brief wired to the real manta-server. */
export function createDefaultLead() {
  return createLead({
    fetch: (url, init) => fetch(url, init as any) as any,
    base: () => serverUrl(),
    headers: (body) => authHeaders(body),
  });
}
