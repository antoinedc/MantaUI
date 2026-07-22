// desktopNotify.ts — receive desktop OS-notification directives from manta-server.
//
// The notification router lives on manta-server (src/server/push.mjs). When it
// decides the DESKTOP should be notified (user at the desk, or away-but-app-open
// before mobile escalation), it publishes a `{kind:"desktopNotify", payload}`
// envelope on its in-process bus. This module subscribes to manta-server's
// `GET /events` SSE stream **over direct HTTPS** (Bearer-authed) and forwards
// each `desktopNotify` payload to the renderer via IPC, where it's shown with
// the Notification API.
//
// Why consume manta-server's bus instead of deciding desktop notifications
// locally from the opencode stream: the router must see BOTH device presences
// to avoid duplicates, so it's the single arbiter. The desktop is a dumb sink
// here — the renderer only adds the final "am I literally viewing this session
// right now?" suppression (it knows its focused window + active session).
//
// The SSE plumbing (connect / reconnect / frame-parse) lives in
// src/main/busConsumer.ts — shared with capExecutor. This file is now just a
// one-kind filter: deliver `desktopNotify` payloads, ignore everything else.

import { createBusConsumer, type BusConsumer } from "./busConsumer.js";
import type { AppConfig, DesktopNotifyPayload } from "../shared/types.js";

let consumer: BusConsumer | null = null;

/**
 * Start forwarding manta-server desktop-notification directives to the renderer.
 * `configGetter` returns the live AppConfig (serverUrl + boxToken for HTTPS
 * Bearer auth); `onPayload` delivers a directive to the renderer (typically a
 * webContents.send). Idempotent.
 */
export function startDesktopNotifications(
  configGetter: () => AppConfig,
  onPayload: (payload: DesktopNotifyPayload) => void,
): void {
  if (consumer) return;
  consumer = createBusConsumer(
    configGetter,
    (env) => {
      if (env.kind !== "desktopNotify" || !env.payload) return;
      try {
        onPayload(env.payload as DesktopNotifyPayload);
      } catch {
        /* renderer gone / window closed — ignore */
      }
    },
  );
}

export function stopDesktopNotifications(): void {
  consumer?.stop();
  consumer = null;
}
