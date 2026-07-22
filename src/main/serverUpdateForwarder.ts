// serverUpdateForwarder.ts — relay server-update-available bus events from
// manta-server's /events SSE stream to the desktop renderer via IPC.
//
// Mirrors the desktopNotify pattern (src/main/desktopNotify.ts) one-for-one:
// the SSE plumbing (Bearer-authed long-lived GET, 3s auto-reconnect, frame
// parse) lives in src/main/busConsumer.ts and this file is just a one-kind
// filter. The server's server-update poller (src/server/serverUpdate.mjs)
// publishes `{kind:"serverUpdateAvailable", payload:{version, notesUrl}}`
// whenever a newer manifest version is detected; this module forwards the
// payload to the renderer so its UpdateBar component can render the
// "Server update available: {version}" bar.
//
// The renderer reaches the same wire via `window.api.onServerUpdateAvailable`
// (httpApi subscribes to the bus kind) — main → renderer is just the IPC
// leg on desktop because the desktop's renderer doesn't directly consume
// the /events stream (it goes through main so the renderer gets a typed
// IPC push, not a WS frame).

import { createBusConsumer, type BusConsumer } from "./busConsumer.js";
import type { AppConfig, ServerUpdateAvailablePayload } from "../shared/types.js";

let consumer: BusConsumer | null = null;

/**
 * Start forwarding server-update-available envelopes from manta-server's bus
 * to the renderer. `configGetter` returns the live AppConfig (serverUrl +
 * boxToken for HTTPS Bearer auth); `onPayload` delivers the parsed payload
 * to the renderer (typically a webContents.send). Idempotent.
 */
export function startServerUpdateForwarder(
  configGetter: () => AppConfig,
  onPayload: (payload: ServerUpdateAvailablePayload) => void,
): void {
  if (consumer) return;
  consumer = createBusConsumer(
    configGetter,
    (env) => {
      if (env.kind !== "serverUpdateAvailable" || !env.payload) return;
      const p = env.payload as Partial<ServerUpdateAvailablePayload>;
      if (typeof p.version !== "string" || !p.version) return;
      try {
        onPayload({
          version: p.version,
          notesUrl: typeof p.notesUrl === "string" ? p.notesUrl : null,
        });
      } catch {
        /* renderer gone / window closed — ignore */
      }
    },
  );
}

export function stopServerUpdateForwarder(): void {
  consumer?.stop();
  consumer = null;
}
