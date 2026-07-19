// busConsumer.ts — shared SSE consumer for bui-server's `/events` stream.
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

import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../shared/types.js";

const RECONNECT_MS = 3000;

export type BusEnvelope = {
  kind?: string;
  payload?: unknown;
};

export type BusConsumer = { stop(): void };

export function createBusConsumer(
  configGetter: () => AppConfig,
  onEnvelope: (env: BusEnvelope) => void,
  onConnect?: () => void,
): { stop(): void } {
  let stopped = false;
  let current: IncomingMessage | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
    reconnectTimer.unref?.();
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
    const req = request(
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
      try {
        current?.destroy();
      } catch {
        /* already gone */
      }
      current = null;
    },
  };
}
