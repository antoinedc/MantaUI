// desktopPresence.ts — report "the user is active on desktop" to the mobile
// server so it can suppress redundant mobile "done" pushes (Discord's
// "active on desktop ⇒ no mobile push" rule).
//
// Transport: a best-effort HTTP POST to 127.0.0.1:PRESENCE_LOCAL_PORT, which
// the shared SSH ControlMaster forwards to the box's mobile server on 8787
// (see ensurePresenceForward in opencode.ts). If the mobile server isn't
// running, or the forward isn't up, the POST simply fails and we swallow it —
// presence is a nice-to-have, never load-bearing.
//
// We send a heartbeat:
//   - on BrowserWindow focus  → { visible: true }
//   - on BrowserWindow blur   → { visible: false }
//   - on system idle/lock     → { visible: false }
//   - on system resume        → re-evaluate from the window's current focus
//   - every HEARTBEAT_MS while focused (keeps lastSeen fresh so the box's TTL
//     doesn't expire mid-session and let mobile pushes leak through)
//
// The server measures a grace window from the last visible:true, so a quick
// window-switch on desktop won't immediately buzz the phone.

import { app, BrowserWindow, powerMonitor } from "electron";
import { request } from "node:http";
import { ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import type { AppConfig } from "../shared/types.js";

// Refresh lastSeen this often while focused. Must be comfortably under the
// server's DESKTOP_PRESENCE_TTL_MS (60s) so a live, focused desktop never
// looks "stale" to the box.
const HEARTBEAT_MS = 20_000;

let getConfig: (() => AppConfig) | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let started = false;
let lastVisible: boolean | null = null;

function postPresence(visible: boolean): void {
  const cfg = getConfig?.();
  if (!cfg) return;
  // Make sure the -L forward exists before we POST (cheap idempotent check;
  // recovers after sleep/network drop). Fire-and-forget.
  void ensurePresenceForward(cfg)
    .then(() => sendHeartbeat(visible))
    .catch(() => {});
}

function sendHeartbeat(visible: boolean): void {
  const body = JSON.stringify({ visible });
  const req = request(
    {
      host: "127.0.0.1",
      port: PRESENCE_LOCAL_PORT,
      path: "/push/desktop-presence",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
      timeout: 4000,
    },
    (res) => {
      // Drain so the socket frees; we don't care about the body.
      res.resume();
    },
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(body);
  req.end();
}

function report(visible: boolean): void {
  lastVisible = visible;
  postPresence(visible);
}

function currentlyFocused(): boolean {
  const win = BrowserWindow.getAllWindows()[0];
  return !!win && win.isFocused() && win.isVisible();
}

function restartHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    // Only keep the box "fresh" while we're actually focused; a blurred
    // desktop should let its grace window lapse.
    if (lastVisible) report(true);
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

/**
 * Wire desktop-presence reporting. `configGetter` returns the live AppConfig
 * (host/user/identity) used to keep the SSH forward up. Idempotent.
 */
export function startDesktopPresence(configGetter: () => AppConfig): void {
  if (started) return;
  started = true;
  getConfig = configGetter;

  app.on("browser-window-focus", () => report(true));
  app.on("browser-window-blur", () => {
    // Only report not-focused once ALL windows are blurred (multi-window
    // safety; today there's a single window but this keeps it correct).
    if (!currentlyFocused()) report(false);
  });

  // System idle / lock / sleep → definitely not actively at the desktop.
  powerMonitor.on("lock-screen", () => report(false));
  powerMonitor.on("suspend", () => report(false));
  // Coming back → re-evaluate from the real focus state.
  powerMonitor.on("unlock-screen", () => report(currentlyFocused()));
  powerMonitor.on("resume", () => report(currentlyFocused()));

  // Initial state + periodic refresh.
  report(currentlyFocused());
  restartHeartbeat();
}

export function stopDesktopPresence(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  started = false;
  // Best-effort: tell the box we're gone so mobile pushes resume promptly
  // (rather than waiting out the grace window).
  if (lastVisible !== false) report(false);
}
