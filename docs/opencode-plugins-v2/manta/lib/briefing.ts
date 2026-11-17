// Shared-knowledge briefing delivery (spec docs/superpowers/specs/2026-11-16-shared-knowledge.md §7.1).
//
//   session.created  → prefetch GET /api/knowledge/briefing (warm before the first request)
//   context hook     → await the prefetch ≤ waitMs, APPEND the text after the existing system
//                      blocks (manta-claude-max keeps its identity first), ack once
//   later requests   → append the SAME text again (byte-stable for the prompt cache)
//   compaction       → the `compaction` hook only NOTES that a compaction began; once it has COMPLETED
//                      (the `session.compaction.ended` event) → POST /briefing/reset and forget the cached
//                      text (one fresh start allowed). A compaction that fails (`session.compaction.failed`)
//                      resets nothing. Without the event stream the fallback is documented in onContext:
//                      reset on the first request after the compaction hook ran.
//
// Fail-open everywhere: nothing here may delay a request beyond waitMs or break it.
// Only the `context` and `compaction` hook kinds are registered, so title / generate
// requests never see it.

import { authHeaders, serverUrl } from "./server.ts";

export const BRIEFING_WAIT_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const RESET_TIMEOUT_MS = 2000;
const MAX_TRACKED = 500;

type FetchFn = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface BriefingDeps {
  fetch: FetchFn;
  base(): string;
  headers(body?: unknown): Record<string, string>;
  /** The session's directory: sync sources first, then (async) the session record. */
  directory(sessionID: string): string | undefined | Promise<string | undefined>;
  waitMs?: number;
  requestTimeoutMs?: number;
}

interface Fetched {
  text: string;
  token: string | null;
}

interface Applied {
  text: string;
  token: string;
  ack: "no" | "inflight" | "done";
}

const TIMEOUT = Symbol("timeout");

/** A set that keeps at most `max` members, forgetting the least recently used (no unbounded growth over a long-lived server). */
function lruSet(max: number) {
  const m = new Map<string, true>();
  return {
    has(k: string): boolean {
      if (!m.has(k)) return false;
      m.delete(k);
      m.set(k, true);
      return true;
    },
    add(k: string): void {
      m.delete(k);
      m.set(k, true);
      if (m.size > max) m.delete(m.keys().next().value as string);
    },
    delete(k: string): void {
      m.delete(k);
    },
  };
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string);
}

function countAssistants(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) if (m?.role === "assistant") n++;
  return n;
}

function append(system: any[], text: string): void {
  if (system.some((b) => b?.text === text)) return;
  system.push({ type: "text", text });
}

async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    (timer as any)?.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createBriefing(deps: BriefingDeps) {
  const waitMs = deps.waitMs ?? BRIEFING_WAIT_MS;
  const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const applied = new Map<string, Applied>();
  const empty = lruSet(MAX_TRACKED); // the server deliberately answered "" — no briefing for this start
  const missed = lruSet(MAX_TRACKED); // abandoned after waitMs — no briefing for this start
  const compacting = lruSet(MAX_TRACKED); // a compaction began and has not ended/failed yet
  let eventsLive = false; // the plugin's event stream is subscribed, so `compaction.ended` will be seen
  const prefetches = new Map<string, { directory: string | undefined; promise: Promise<Fetched | null> }>();
  const pending = new Map<string, Promise<Applied | null>>();
  const acks = new Set<Promise<void>>();

  async function fetchBriefing(sessionID: string, directory: string | undefined, assistantMessages: number): Promise<Fetched | null> {
    try {
      const qs = new URLSearchParams({ sessionID, assistantMessages: String(assistantMessages) });
      if (directory) qs.set("directory", directory);
      const res = await deps.fetch(`${deps.base()}/api/knowledge/briefing?${qs}`, {
        method: "GET",
        headers: deps.headers(),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!res.ok) return null;
      const json = await res.json();
      return {
        text: typeof json?.text === "string" ? json.text : "",
        token: typeof json?.token === "string" && json.token !== "" ? json.token : null,
      };
    } catch {
      return null;
    }
  }

  function post(path: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number } | null> {
    return Promise.resolve()
      .then(() =>
        deps.fetch(`${deps.base()}${path}`, {
          method: "POST",
          headers: deps.headers(body),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      )
      .catch(() => null);
  }

  function ack(sessionID: string, entry: Applied): void {
    if (entry.ack !== "no") return;
    entry.ack = "inflight";
    const p = post("/api/knowledge/briefing/ack", { sessionID, token: entry.token }, requestTimeoutMs).then((res) => {
      // 409 stale-token: the server holds other bytes; ours stay cached for this session, nothing to retry
      entry.ack = res && (res.ok || res.status === 409) ? "done" : "no";
    });
    acks.add(p);
    void p.finally(() => acks.delete(p));
  }

  /** Start (or reuse) the fetch for a session's first briefing. */
  async function fetchFor(sessionID: string, assistants: number): Promise<Fetched | null> {
    const current = await deps.directory(sessionID);
    const pf = prefetches.get(sessionID);
    prefetches.delete(sessionID);
    // A prefetch assumed a brand-new session in the directory it was created in.
    if (pf && assistants <= 1 && !(pf.directory && current && pf.directory !== current)) return pf.promise;
    return fetchBriefing(sessionID, current, assistants);
  }

  async function run(sessionID: string, assistants: number): Promise<Applied | null> {
    const got = await raceTimeout(fetchFor(sessionID, assistants), waitMs);
    if (got === TIMEOUT) {
      missed.add(sessionID);
      return null;
    }
    if (!got) return null; // transport / HTTP failure: try again on the next request
    if (got.text === "") {
      // A 2xx with no text is the server's deliberate "none" (an excluded session, the feature off, nothing
      // known): remember it for this start rather than asking again on every request.
      empty.add(sessionID);
      return null;
    }
    if (got.token === null) return null; // text without a token cannot be acknowledged: treat as a failure
    const entry: Applied = { text: got.text, token: got.token, ack: "no" };
    remember(applied, sessionID, entry);
    ack(sessionID, entry);
    return entry;
  }

  function forget(sessionID: string): void {
    applied.delete(sessionID);
    empty.delete(sessionID);
    missed.delete(sessionID);
    compacting.delete(sessionID);
    prefetches.delete(sessionID);
    pending.delete(sessionID);
  }

  async function finishCompaction(sessionID: string): Promise<void> {
    forget(sessionID);
    await post("/api/knowledge/briefing/reset", { sessionID }, RESET_TIMEOUT_MS);
  }

  return {
    /** `session.created` event data: warm the briefing before the first request. */
    onSessionCreated(data: any): void {
      try {
        const sessionID = data?.sessionID;
        if (typeof sessionID !== "string" || !sessionID) return;
        if (applied.has(sessionID) || prefetches.has(sessionID)) return;
        const directory = typeof data?.location?.directory === "string" ? data.location.directory : undefined;
        remember(prefetches, sessionID, { directory, promise: fetchBriefing(sessionID, directory, 0) });
      } catch {
        /* fail open */
      }
    },

    onSessionDeleted(sessionID: unknown): void {
      if (typeof sessionID === "string") forget(sessionID);
    },

    /** The `context` hook. Mutates `event.system`; never throws. */
    async onContext(event: any): Promise<void> {
      try {
        const sessionID = event?.sessionID;
        const system = event?.system;
        if (typeof sessionID !== "string" || !sessionID || !Array.isArray(system)) return;
        // Fallback when the event stream is not available (so `compaction.ended` can never arrive): the first
        // request after the compaction hook ran is the earliest point we can call the compaction over. If that
        // compaction in fact failed this starts one extra briefing — harmless, and only without the stream.
        if (!eventsLive && compacting.has(sessionID)) await finishCompaction(sessionID);
        let entry = applied.get(sessionID) ?? null;
        if (!entry) {
          if (empty.has(sessionID) || missed.has(sessionID)) return;
          let p = pending.get(sessionID);
          if (!p) {
            p = run(sessionID, countAssistants(event.messages)).finally(() => pending.delete(sessionID));
            pending.set(sessionID, p);
          }
          entry = await p;
          if (!entry) return;
        }
        append(system, entry.text);
        ack(sessionID, entry); // no-op unless an earlier ack did not land
      } catch {
        /* fail open — a briefing bug must degrade to "no briefing", never a broken turn */
      }
    },

    /**
     * The `compaction` hook: a compaction is BEGINNING. Nothing is reset yet — it may still fail, and a reset
     * would let a fresh briefing in after a conversation that was never compacted.
     */
    async onCompaction(event: any): Promise<void> {
      try {
        const sessionID = event?.sessionID;
        if (typeof sessionID === "string" && sessionID) compacting.add(sessionID);
      } catch {
        /* fail open */
      }
    },

    /** `session.compaction.ended`: the conversation WAS compacted — the next request may start a fresh briefing. */
    async onCompactionEnded(sessionID: unknown): Promise<void> {
      try {
        if (typeof sessionID === "string" && sessionID) await finishCompaction(sessionID);
      } catch {
        /* fail open */
      }
    },

    /** `session.compaction.failed`: nothing changed, nothing to reset. */
    onCompactionFailed(sessionID: unknown): void {
      if (typeof sessionID === "string") compacting.delete(sessionID);
    },

    /** The plugin's event stream is up: `compaction.ended` is authoritative from now on. */
    setEventsLive(live: boolean): void {
      eventsLive = live;
    },

    /** Test seam: resolves once every in-flight ack has settled. */
    async flush(): Promise<void> {
      while (acks.size) await Promise.all([...acks]);
    },
  };
}

/** Wire the briefing into a plugin context: the two hooks + the session event stream. */
export async function installBriefing(ctx: any, overrides: Partial<BriefingDeps> = {}) {
  const learned = new Map<string, string>();
  const directory = async (sessionID: string): Promise<string | undefined> => {
    const own = ctx?.location?.directory;
    if (typeof own === "string" && own !== "") return own;
    const seen = learned.get(sessionID);
    if (seen) return seen;
    try {
      const r = await ctx.session.get({ sessionID });
      const d = (r?.data ?? r)?.location?.directory;
      return typeof d === "string" && d !== "" ? d : undefined;
    } catch {
      return undefined;
    }
  };
  const briefing = createBriefing({
    fetch: (url, init) => fetch(url, init as any) as any,
    base: () => serverUrl(),
    headers: (body) => authHeaders(body),
    directory,
    ...overrides,
  });

  await ctx.session.hook("context", (event: any) => briefing.onContext(event));
  await ctx.session.hook("compaction", (event: any) => briefing.onCompaction(event));

  // The prefetch is an optimisation: without the stream the hook still fetches within its wait.
  const subscribe = ctx?.event?.subscribe;
  if (typeof subscribe === "function") {
    void (async () => {
      try {
        const stream = await subscribe.call(ctx.event);
        briefing.setEventsLive(true);
        const mine = ctx?.location?.directory;
        for await (const ev of stream) {
          if (ev?.type === "session.created") {
            const d = ev?.data?.location?.directory;
            if (typeof mine === "string" && mine !== "" && typeof d === "string" && d !== "" && d !== mine) continue;
            if (typeof ev?.data?.sessionID === "string" && typeof d === "string" && d !== "") remember(learned, ev.data.sessionID, d);
            briefing.onSessionCreated(ev.data);
          } else if (ev?.type === "session.deleted") {
            briefing.onSessionDeleted(ev?.data?.sessionID);
          } else if (ev?.type === "session.compaction.ended") {
            void briefing.onCompactionEnded(ev?.data?.sessionID);
          } else if (ev?.type === "session.compaction.failed") {
            briefing.onCompactionFailed(ev?.data?.sessionID);
          }
        }
      } catch {
        /* stream unavailable — fail open */
      }
      // The stream ended or never came up: `compaction.ended` can no longer be relied on.
      briefing.setEventsLive(false);
    })();
  }
  return briefing;
}
