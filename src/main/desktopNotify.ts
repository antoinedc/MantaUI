// desktopNotify.ts — receive desktop OS-notification directives from bui-server.
//
// The notification router lives on bui-server (src/server/push.mjs). When it
// decides the DESKTOP should be notified (user at the desk, or away-but-app-open
// before mobile escalation), it publishes a `{kind:"desktopNotify", payload}`
// envelope on its in-process bus. This module subscribes to bui-server's
// `GET /events` SSE stream **over the already-open -L 18787 presence forward**
// (the same forward desktopPresence.ts POSTs to) and relays each `desktopNotify`
// payload to the renderer via IPC, where it's shown with the Notification API.
//
// Why consume bui-server's bus instead of deciding desktop notifications
// locally from the opencode stream: the router must see BOTH device presences
// to avoid duplicates, so it's the single arbiter. The desktop is a dumb sink
// here — the renderer only adds the final "am I literally viewing this session
// right now?" suppression (it knows its focused window + active session).
//
// We deliberately ignore every other bus `kind` (opencode firehose, status,
// etc.) — the desktop already gets opencode events from its own :4096 stream;
// re-consuming them here would double everything.

import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import type { AppConfig, DesktopNotifyPayload } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;
let deliver: ((payload: DesktopNotifyPayload) => void) | null = null;
let started = false;
let stopped = false;
let current: IncomingMessage | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

const RECONNECT_MS = 3000;

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
  reconnectTimer.unref?.();
}

function handleFrame(raw: string): void {
  // SSE frame: one or more `data: ...` lines per event (here always one).
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return;
  const json = line.slice(5).trim();
  if (!json) return;
  let envelope: { kind?: string; payload?: DesktopNotifyPayload };
  try {
    envelope = JSON.parse(json);
  } catch {
    return;
  }
  if (envelope?.kind !== "desktopNotify" || !envelope.payload) return;
  try {
    deliver?.(envelope.payload);
  } catch {
    /* renderer gone / window closed — ignore */
  }
}

function connect(): void {
  if (stopped) return;
  const cfg = getConfig?.();
  if (!cfg) {
    scheduleReconnect();
    return;
  }
  // Make sure the forward exists before connecting (idempotent; recovers after
  // sleep/network drop). Then open the long-lived SSE stream.
  void ensurePresenceForward(cfg)
    .then(() => {
      if (stopped) return;
      const req = request(
        {
          host: "127.0.0.1",
          port: PRESENCE_LOCAL_PORT,
          path: "/events",
          method: "GET",
          headers: { accept: "text/event-stream" },
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
            // SSE events are separated by a blank line.
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
        },
      );
      req.on("error", () => scheduleReconnect());
      req.end();
    })
    .catch(() => scheduleReconnect());
}

/**
 * Start relaying bui-server desktop-notification directives to the renderer.
 * `configGetter` returns the live AppConfig (for the SSH forward); `onPayload`
 * delivers a directive to the renderer (typically a webContents.send). Idempotent.
 */
export function startDesktopNotifications(
  configGetter: () => AppConfig,
  onPayload: (payload: DesktopNotifyPayload) => void,
): void {
  if (started) return;
  started = true;
  stopped = false;
  getConfig = configGetter;
  deliver = onPayload;
  connect();
}

export function stopDesktopNotifications(): void {
  stopped = true;
  started = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    current?.destroy();
  } catch {
    /* already gone */
  }
  current = null;
}
