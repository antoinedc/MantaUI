// Slash-command origin — the box-side record of which user messages were
// produced by a slash command (spec 2026-10-23-opencode-v2-cleanup §3).
//
// V2 stores a `/review HEAD~1` turn as a plain user message holding the expanded
// template, with no metadata saying it came from a command. The box therefore
// correlates it: `runCommand` is the single chokepoint every command goes
// through, and the pump sees every `session.inbox.enqueued` user item.
//
// WHY CORRELATION IS SOUND HERE — a closed set of writers. A `user` inbox item
// can only be created by an HTTP client holding the opencode password
// (loopback-only, known to manta-server and the opencode service). Subagent
// results arrive as `synthetic` items and are excluded. So every user enqueue on
// the box comes from manta-server, and manta-server knows the id of every one it
// creates — except the one a `/command` POST creates. That holds only while
// EVERY manta-server `/prompt` POST carries an id recorded here ("our prompt
// ids"); `commandOrigins.test.mjs` greps `src/server/**` for `/prompt` POST sites
// and fails if one appears outside the recording helper. KNOWN LIMIT: someone
// typing into opencode's own web UI with the password during a command window
// can be mis-tagged — accepted.
//
// The rule is "tag only when unambiguous, otherwise leave untagged": an untagged
// command message just shows its full text (the pre-existing behaviour).
//
// Two parts, both pure with injected I/O:
//   createOriginStore      the durable `messageID → {name, arguments, sessionId, at}` map
//   createCommandCorrelator  our prompt ids + command windows + eligibility

import { randomUUID } from "node:crypto";

export const ORIGIN_MAX_ENTRIES = 5000;
export const ORIGIN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A command window stays open this long after its POST returns. */
export const COMMAND_WINDOW_CLOSE_MS = 3000;
/** A prompt id whose enqueue is still unobserved after this long is retired. */
export const PROMPT_ID_RETIRE_MS = 10 * 60 * 1000;

/** V2 requires message ids to start with `msg_` (same generator the CTO admission path uses). */
export function mintPromptId(newId = randomUUID) {
  return `msg_${newId()}`;
}

/**
 * The durable origin map. `load()` returns the persisted object (sync, at
 * construction); `save(obj)` persists it (may be async — failures are logged,
 * never thrown into a caller). Capped at ORIGIN_MAX_ENTRIES and ORIGIN_MAX_AGE_MS,
 * oldest evicted first.
 *
 * @param {{ load?: () => Record<string, any>, save?: (obj: Record<string, any>) => unknown, now?: () => number, log?: (...a: any[]) => void }} [deps]
 */
export function createOriginStore({ load = () => ({}), save = () => {}, now = () => Date.now(), log = () => {} } = {}) {
  /** @type {Map<string, { name: string, arguments: string, sessionId: string, at: number }>} */
  const map = new Map();
  try {
    const raw = load();
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, v] of Object.entries(raw)) {
        if (v && typeof v.name === "string" && typeof v.at === "number") {
          map.set(id, { name: v.name, arguments: typeof v.arguments === "string" ? v.arguments : "", sessionId: String(v.sessionId ?? ""), at: v.at });
        }
      }
    }
  } catch (e) {
    log("[command-origins] load failed:", e?.message ?? e);
  }

  function prune() {
    const cutoff = now() - ORIGIN_MAX_AGE_MS;
    for (const [id, v] of map) if (v.at < cutoff) map.delete(id);
    if (map.size > ORIGIN_MAX_ENTRIES) {
      const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of oldest.slice(0, map.size - ORIGIN_MAX_ENTRIES)) map.delete(id);
    }
  }
  // Coalesced: a burst of records costs one write.
  let dirty = false;
  function persist() {
    if (dirty) return;
    dirty = true;
    queueMicrotask(() => {
      dirty = false;
      try {
        const r = save(Object.fromEntries(map));
        if (r && typeof r.catch === "function") r.catch((e) => log("[command-origins] save failed:", e?.message ?? e));
      } catch (e) {
        log("[command-origins] save failed:", e?.message ?? e);
      }
    });
  }

  return {
    record(messageID, { name, arguments: args, sessionId }) {
      map.set(messageID, { name, arguments: args ?? "", sessionId, at: now() });
      prune();
      persist();
    },
    /** `{name, arguments}` for a recorded command message, else null. */
    get(messageID) {
      const v = map.get(messageID);
      return v ? { name: v.name, arguments: v.arguments } : null;
    },
    size: () => map.size,
  };
}

/**
 * Stamp `info.command` onto the user messages (`{info, parts}[]`) whose id has
 * a recorded origin. Returns the same array when nothing matches; never mutates
 * a message (a stamped one is a shallow copy).
 */
export function stampCommandOrigins(messages, originOf) {
  if (!Array.isArray(messages) || typeof originOf !== "function") return messages;
  let out = null;
  messages.forEach((m, i) => {
    if (m?.info?.role !== "user" || typeof m.info.id !== "string") return;
    const command = originOf(m.info.id);
    if (!command) return;
    out ??= messages.slice();
    out[i] = { ...m, info: { ...m.info, command } };
  });
  return out ?? messages;
}

/**
 * @param {{
 *   origins: ReturnType<typeof createOriginStore>,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (h: unknown) => void,
 *   log?: (...a: any[]) => void,
 *   onTag?: (t: { sessionId: string, messageID: string, name: string, arguments: string }) => void,
 *   closeMs?: number,
 *   retireMs?: number,
 * }} deps
 */
export function createCommandCorrelator({
  origins,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimer = (h) => clearTimeout(h),
  log = () => {},
  onTag = () => {},
  closeMs = COMMAND_WINDOW_CLOSE_MS,
  retireMs = PROMPT_ID_RETIRE_MS,
} = {}) {
  /** @type {Map<string, { ours: Map<string, number>, windows: Set<any>, ineligible: boolean }>} */
  const sessions = new Map();
  const sess = (sid) => {
    let s = sessions.get(sid);
    if (!s) sessions.set(sid, (s = { ours: new Map(), windows: new Set(), ineligible: false }));
    return s;
  };

  // Retire prompt ids whose enqueue never showed up: lazily, whenever a window
  // opens or an enqueue arrives — nothing else reads the registry.
  function expire(s, sid) {
    const t = now();
    for (const [id, at] of s.ours) {
      if (t - at < retireMs) continue;
      s.ours.delete(id);
      s.ineligible = true;
      log(`[command-origins] prompt id ${id} on ${sid} never enqueued after ${Math.round(retireMs / 60000)} min — retired; command correlation paused until the session is idle`);
    }
  }

  function close(sid, win) {
    const s = sessions.get(sid);
    if (!s || win.closed) return;
    win.closed = true;
    s.windows.delete(win);
    const found = [...win.unexplained];
    const label = `${win.name} on ${sid}`;
    if (!win.ok) {
      // A definitive 4xx refusal proves nothing was enqueued; anything else
      // (network error, abort, 5xx) might have been accepted after all.
      if (!win.definitive) s.ineligible = true;
      log(`[command-origins] ${label}: POST failed — not tagged`);
      return;
    }
    if (win.overlapped || win.disconnected || !win.eligible) {
      s.ineligible = true;
      const why = win.overlapped ? "overlapping command windows" : win.disconnected ? "event stream disconnected" : "an earlier submission is unresolved";
      log(`[command-origins] ${label}: not tagged (${why})`);
      return;
    }
    if (found.length === 1) {
      const messageID = found[0];
      origins.record(messageID, { name: win.name, arguments: win.arguments, sessionId: sid });
      try {
        onTag({ sessionId: sid, messageID, name: win.name, arguments: win.arguments });
      } catch (e) {
        log("[command-origins] onTag failed:", e?.message ?? e);
      }
      return;
    }
    // Zero (a late enqueue may still land in a later window) or several:
    // record nothing and stay ineligible until the session next goes idle.
    s.ineligible = true;
    log(`[command-origins] ${label}: ${found.length} unexplained user enqueue(s) in the window — not tagged`);
  }

  return {
    /** Record a prompt id BEFORE its POST — "our prompt ids". */
    registerPromptId(sid, id) {
      const s = sess(sid);
      s.ours.set(id, now());
    },
    /** The POST failed definitively (4xx): the id never reached the inbox. */
    unregisterPromptId(sid, id) {
      sessions.get(sid)?.ours.delete(id);
    },
    isOurPromptId: (sid, id) => sessions.get(sid)?.ours.has(id) === true,
    /** Raw `session.inbox.enqueued` from the pump. Only `user` items matter. */
    observeEnqueued(sid, id, itemType) {
      if (itemType !== "user" || typeof id !== "string") return;
      const s = sess(sid);
      expire(s, sid);
      if (s.ours.delete(id)) return; // ours: retired
      for (const w of s.windows) w.unexplained.add(id);
    },
    /**
     * Open a command window for the POST about to start. The returned handle's
     * `finish({ok, status})` is called when the POST returns or fails; the
     * window then closes `closeMs` later.
     */
    openWindow(sid, { name, arguments: args = "" }) {
      const s = sess(sid);
      expire(s, sid);
      const win = {
        name,
        arguments: args,
        unexplained: new Set(),
        eligible: !s.ineligible && s.ours.size === 0,
        overlapped: s.windows.size > 0,
        disconnected: false,
        ok: false,
        definitive: false,
        closed: false,
        timer: null,
      };
      for (const other of s.windows) other.overlapped = true;
      s.windows.add(win);
      return {
        finish({ ok, status } = {}) {
          if (win.timer != null || win.closed) return;
          win.ok = ok === true;
          win.definitive = !win.ok && typeof status === "number" && status >= 400 && status < 500;
          win.timer = setTimer(() => close(sid, win), closeMs);
        },
      };
    },
    /** The session went idle: every earlier submission has been enqueued by now. */
    noteIdle(sid) {
      const s = sessions.get(sid);
      if (s) s.ineligible = false;
    },
    /** The event stream dropped: enqueues may have been missed in every open window. */
    noteDisconnect() {
      for (const s of sessions.values()) for (const w of s.windows) w.disconnected = true;
    },
    forgetSession(sid) {
      const s = sessions.get(sid);
      if (s) for (const w of s.windows) if (w.timer != null) clearTimer(w.timer);
      sessions.delete(sid);
    },
    originOf: (messageID) => origins.get(messageID),
    /** Test seam. */
    _session: (sid) => sessions.get(sid),
  };
}
