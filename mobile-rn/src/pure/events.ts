// events.ts — the PURE logic behind the /events WebSocket client: envelope
// parsing, the viewed-session filter, and the reconnect-backoff decision.
//
// The impure socket glue (opening the WS, timers) lives in
// ../api/eventsClient.ts and stays thin; everything decision-shaped is here so
// it can be unit-tested without a socket. Mirrors the desktop's {kind,payload}
// envelope (src/renderer/api/httpApi.ts `dispatchFrame`) and its
// backoff/never-abandon reconnect intent (WsReconnectController), simplified
// for the RN read-only viewer.

import type { OpencodeEventLike } from "./transcript";

// ---- Envelope parsing ----

/** The server frames every stream event as `{ kind, payload }`. */
export interface Envelope {
  kind: string;
  payload: unknown;
}

/**
 * Parse a raw WS text frame into an Envelope, or null when it isn't a
 * well-formed `{ kind, payload }` JSON object (control frames, partial data,
 * non-JSON). Never throws. Pure.
 */
export function parseEnvelope(data: unknown): Envelope | null {
  if (typeof data !== "string") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const kind = (obj as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  return { kind, payload: (obj as { payload?: unknown }).payload };
}

/**
 * Narrow an envelope's payload to an OpencodeEventLike when `kind === "opencode"`
 * and the payload is a `{ type: string }` object; otherwise null. This is the
 * single choke point that turns a raw frame into a transcript event. Pure.
 */
export function toOpencodeEvent(env: Envelope | null): OpencodeEventLike | null {
  if (!env || env.kind !== "opencode") return null;
  const p = env.payload;
  if (!p || typeof p !== "object") return null;
  const type = (p as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const props = (p as { properties?: unknown }).properties;
  return {
    type,
    properties:
      props && typeof props === "object"
        ? (props as Record<string, unknown>)
        : {},
  };
}

// ---- Viewed-session filter ----

/**
 * Decide whether an opencode event belongs to the session the detail screen is
 * viewing. An event carries its session in `properties.sessionID`. Events for
 * OTHER sessions are dropped (the mobile detail view renders exactly one
 * session — unlike the desktop it has no subagent-child routing).
 *
 * Events with NO sessionID (synthetic resync pings, global lifecycle) are kept
 * — they carry no session scope and the caller's handlers self-filter. Pure.
 */
export function eventMatchesSession(
  ev: OpencodeEventLike,
  viewedSessionID: string,
): boolean {
  const sid = ev.properties?.sessionID;
  if (typeof sid !== "string" || sid.length === 0) return true;
  return sid === viewedSessionID;
}

// ---- Reconnect / backoff decision ----

/** Tunables for the reconnect backoff (mirrors the shared ExponentialBackoff). */
export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  maxMs: 15_000,
  factor: 2,
};

/**
 * The delay (ms) before the Nth reconnect attempt (attempt is 1-based:
 * attempt 1 is the first retry after a drop). Capped at `maxMs`. Deterministic
 * (no jitter) so it's testable; the socket glue may add small jitter on top if
 * desired. Pure.
 */
export function backoffDelay(
  attempt: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
): number {
  if (attempt <= 1) return cfg.baseMs;
  const raw = cfg.baseMs * Math.pow(cfg.factor, attempt - 1);
  return Math.min(raw, cfg.maxMs);
}

/**
 * Decide what to do when the socket closes. The mobile viewer NEVER permanently
 * abandons a live session (matching the desktop's "never abandon" intent) — a
 * clean close only happens when WE tear the screen down, which is signalled by
 * `intentional`. Any other close reconnects after a backoff delay. Pure.
 */
export function reconnectDecision(
  attempt: number,
  intentional: boolean,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
): { reconnect: boolean; delayMs: number } {
  if (intentional) return { reconnect: false, delayMs: 0 };
  return { reconnect: true, delayMs: backoffDelay(attempt, cfg) };
}
