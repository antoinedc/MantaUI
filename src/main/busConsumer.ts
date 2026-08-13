// busConsumer.ts — shared SSE consumer for manta-server's `/events` stream.
//
// Extracted from src/main/desktopNotify.ts so the SSE plumbing (Bearer-authed
// long-lived GET, 3-second auto-reconnect, `\n\n` frame split, `data:` parse)
// exists in ONE place. Two thin consumers build on it:
//
//   - src/main/desktopNotify.ts → filter on kind === "desktopNotify"
//   - src/main/capExecutor.ts  → filter on kind === "capJob" + catch-up
//
// Instance state (no module-level singletons): each `createBusConsumer` call
// owns its own stream, reconnect timer, and frame buffer. The returned `stop()`
// destroys the active response and cancels any pending reconnect.
//
// `onConnect?` fires on every status-200 stream open — both the initial
// connect AND every reconnect — so the executor can run its SSE-replay
// catch-up list. desktopNotify doesn't need it.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../shared/types.js";

const RECONNECT_MS = 3000;

// M8: stale-frame liveness watchdog. The server heartbeats /events every 15s
// (`kind:"heartbeat"` frames), but a half-open stream (laptop sleep/wake, NAT
// idle timeout) emits neither `end` nor `error` — the reconnect path below
// never fires and the bus silently dies until app restart. So stamp
// `lastFrameAt` on every received frame and, if nothing arrives for STALE_MS,
// destroy the response and let the existing reconnect path run.
const STALE_MS = 45_000; // 3 missed 15s heartbeats
const WATCHDOG_INTERVAL_MS = 15_000;

export { STALE_MS };

export type BusEnvelope = {
  kind?: string;
  payload?: unknown;
};

export type BusConsumer = { stop(): void };

// M8: pure liveness decision — has no frame arrived within STALE_MS? Extracted
// so the constant + threshold are pinned by a unit test.
export function isStale(lastFrameAt: number, now: number, staleMs: number): boolean {
  return now - lastFrameAt > staleMs;
}

export function createBusConsumer(
  configGetter: () => AppConfig,
  onEnvelope: (env: BusEnvelope) => void,
  onConnect?: () => void,
): { stop(): void } {
  let stopped = false;
  let current: IncomingMessage | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let lastFrameAt = Date.now();

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
    reconnectTimer.unref?.();
  }

  // The watchdog shares the existing reconnect scheduling — there is no second
  // reconnect implementation. On a stale stream it just tears the active
  // response down (which, like `end`/`error`, lets the reconnect path run) and
  // schedules the same reconnect the `end` handler would.
  function startWatchdog(): void {
    if (stopped || watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (isStale(lastFrameAt, Date.now(), STALE_MS)) {
        console.error("[bus] stale stream (no frames for 45s) — reconnecting");
        const res = current;
        current = null;
        try {
          res?.destroy();
        } catch {
          /* already gone */
        }
        scheduleReconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdogTimer.unref?.();
  }

  function handleFrame(raw: string): void {
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    const json = line.slice(5).trim();
    if (!json) return;
    let envelope: BusEnvelope;
    try {
      envelope = JSON.parse(json);
    } catch {
      return;
    }
    try {
      onEnvelope(envelope);
    } catch {
      /* consumer threw — don't kill the stream over it */
    }
  }

  function connect(): void {
    if (stopped) return;
    // (Re)connect resets the liveness clock so the watchdog doesn't fire while
    // the fresh stream is still warming toward its first heartbeat (≤15s away).
    lastFrameAt = Date.now();
    startWatchdog();
    const cfg = configGetter?.();
    if (!cfg || !cfg.serverUrl) {
      scheduleReconnect();
      return;
    }
    const serverUrl = cfg.serverUrl.replace(/\/+$/, "");
    const url = new URL("/events", serverUrl);
    const headers: Record<string, string> = {
      accept: "text/event-stream",
    };
    if (cfg.boxToken) {
      headers["authorization"] = `Bearer ${cfg.boxToken}`;
    }
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }
        current = res;
        res.setEncoding("utf-8");
        let buf = "";
        res.on("data", (chunk: string) => {
          lastFrameAt = Date.now(); // any data counts as liveness (heartbeats included)
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleFrame(frame);
          }
        });
        res.on("end", () => {
          current = null;
          scheduleReconnect();
        });
        res.on("error", () => {
          current = null;
          scheduleReconnect();
        });
        // Stream is open (status 200). Fire the catch-up hook so consumers
        // like capExecutor can re-claim jobs an offline/sleeping Mac missed.
        try {
          onConnect?.();
        } catch {
          /* consumer threw — don't kill the stream */
        }
      },
    );
    req.on("error", () => scheduleReconnect());
    req.end();
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
      try {
        current?.destroy();
      } catch {
        /* already gone */
      }
      current = null;
    },
  };
}
