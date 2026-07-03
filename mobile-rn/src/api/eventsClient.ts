// eventsClient.ts — the impure /events WebSocket client for the RN app.
//
// Opens the box's `GET <base>/events` WebSocket with the box_token as a
// `?token=` query param (the server accepts `?token=` on /events + /pty ONLY —
// see src/server/index.mjs; RN/React-Native WebSocket, like browsers, can't set
// an Authorization header on the handshake). Parses each `{kind,payload}` frame,
// narrows it to an opencode event, filters to the viewed session, and hands it
// to the subscriber. Reconnects with exponential backoff on unexpected close;
// never permanently abandons a live session until the caller unsubscribes.
//
// ALL decision logic (envelope parse, session filter, backoff/reconnect) lives
// in the pure ../pure/events module and is unit-tested there; this file owns
// only the socket + timer side effects and stays deliberately thin.

import {
  DEFAULT_BACKOFF,
  eventMatchesSession,
  parseEnvelope,
  reconnectDecision,
  toOpencodeEvent,
  type BackoffConfig,
} from "../pure/events";
import type { OpencodeEventLike } from "../pure/transcript";

/** Strip trailing slashes so "http://box/" and "http://box" behave identically. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Build the /events WebSocket URL: http→ws / https→wss, `/events` path, and the
 * box_token as `?token=` (appended last so it survives any pre-existing query).
 */
export function eventsWsUrl(base: string, token: string): string {
  const ws = trimBase(base).replace(/^http/, "ws") + "/events";
  const sep = ws.includes("?") ? "&" : "?";
  return `${ws}${sep}token=${encodeURIComponent(token)}`;
}

/** Handle returned by {@link subscribeOpencodeEvents}; call to tear down. */
export interface EventsSubscription {
  close(): void;
}

interface SubscribeOptions {
  /** Override backoff (tests inject a fast/tiny config). */
  backoff?: BackoffConfig;
  /** WebSocket factory (tests inject a fake). Defaults to global WebSocket. */
  createSocket?: (url: string) => WebSocketLike;
  /** setTimeout override (tests inject a controllable timer). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  /** clearTimeout override matching setTimeoutFn's handle type. */
  clearTimeoutFn?: (handle: unknown) => void;
}

/** The subset of the WebSocket surface we touch (RN + DOM both satisfy this). */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data?: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  close(): void;
}

/**
 * Open the /events WS for `base`/`token` and deliver every opencode event for
 * `sessionID` to `onEvent`. Reconnects with backoff on unexpected drops; the
 * returned handle's `close()` stops reconnecting and tears the socket down.
 *
 * The pure helpers do the deciding: {@link parseEnvelope} +
 * {@link toOpencodeEvent} turn a frame into an event, {@link eventMatchesSession}
 * drops other sessions, and {@link reconnectDecision} says whether/when to retry.
 */
export function subscribeOpencodeEvents(
  base: string,
  token: string,
  sessionID: string,
  onEvent: (ev: OpencodeEventLike) => void,
  opts: SubscribeOptions = {},
): EventsSubscription {
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const createSocket =
    opts.createSocket ??
    ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;

  let closedByCaller = false;
  let attempt = 0;
  let socket: WebSocketLike | null = null;
  let retryHandle: unknown = null;

  function connect() {
    if (closedByCaller) return;
    const url = eventsWsUrl(base, token);
    let ws: WebSocketLike;
    try {
      ws = createSocket(url);
    } catch {
      // Constructor threw (bad URL) — treat as an unexpected close and retry.
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      // A successful open resets the backoff so a later drop retries fast.
      attempt = 0;
    };

    ws.onmessage = (frame) => {
      const ev = toOpencodeEvent(parseEnvelope(frame?.data));
      if (!ev) return;
      if (!eventMatchesSession(ev, sessionID)) return;
      try {
        onEvent(ev);
      } catch {
        /* subscriber threw — never let it break the socket loop */
      }
    };

    ws.onerror = () => {
      /* onclose follows an error; reconnect handled there */
    };

    ws.onclose = () => {
      socket = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closedByCaller) return;
    attempt += 1;
    const { reconnect, delayMs } = reconnectDecision(attempt, false, backoff);
    if (!reconnect) return;
    retryHandle = setTimeoutFn(() => {
      retryHandle = null;
      connect();
    }, delayMs);
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (retryHandle != null) {
        clearTimeoutFn(retryHandle);
        retryHandle = null;
      }
      if (socket) {
        // Detach handlers first so the intentional close doesn't trigger a
        // reconnect via onclose.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already closing / not-open — ignore */
        }
        socket = null;
      }
    },
  };
}
