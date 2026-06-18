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
// ACTIVE = (a bui window is focused) AND (the user actually touched the
// keyboard/mouse recently). Window focus ALONE is not enough: picking up your
// phone does NOT blur the desktop window (macOS only fires blur when another
// *Mac* app takes focus), so a focus-only signal would keep reporting "active"
// forever and permanently mute mobile. We therefore gate on
// powerMonitor.getSystemIdleTime() — exactly how Slack/Discord treat "away":
// no input for a while ⇒ not actually at the desktop, let mobile notify.
//
// We poll every POLL_MS and report:
//   - visible:true  while focused AND idleTime < IDLE_ACTIVE_THRESHOLD_S
//   - visible:false otherwise (blurred, OR focused-but-idle = you walked away)
// plus immediate visible:false on blur / lock / suspend, and a re-evaluate on
// unlock / resume. The poll doubles as the heartbeat that keeps the server's
// lastSeen fresh (TTL) while active, and lets it lapse once you go idle.

import { app, BrowserWindow, powerMonitor } from "electron";
import { request } from "node:http";
import { ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import type { AppConfig } from "../shared/types.js";

// How often to re-evaluate active-state and refresh the server's lastSeen.
// Must be comfortably under the server's DESKTOP_PRESENCE_TTL_MS (60s).
const POLL_MS = 10_000;

// No keyboard/mouse input for this long ⇒ treat the desktop as "away" even if a
// bui window is still the frontmost Mac window. Tuned so glancing at your phone
// for a moment doesn't immediately flip you away, but actually setting the Mac
// down does. Combined with the server's 30s grace window, the effective
// hand-off is ~IDLE_ACTIVE_THRESHOLD_S + 30s.
const IDLE_ACTIVE_THRESHOLD_S = 30;

let getConfig: (() => AppConfig) | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let started = false;
let lastReported: boolean | null = null;

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

function anyWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some(
    (w) => w.isFocused() && w.isVisible(),
  );
}

// True when the user is genuinely working at the desktop right now: a bui
// window is frontmost AND there's been recent keyboard/mouse input.
function isDesktopActive(): boolean {
  if (!anyWindowFocused()) return false;
  try {
    return powerMonitor.getSystemIdleTime() < IDLE_ACTIVE_THRESHOLD_S;
  } catch {
    // getSystemIdleTime can throw on some Linux setups without an idle backend;
    // fall back to focus alone there.
    return true;
  }
}

// Always POST while active (heartbeat keeps lastSeen fresh); when inactive,
// POST only on the active→inactive edge (one clean visible:false), then go
// quiet so the server's grace+TTL windows can lapse and mobile resumes.
function evaluateAndReport(): void {
  const active = isDesktopActive();
  if (active) {
    lastReported = true;
    postPresence(true);
  } else if (lastReported !== false) {
    lastReported = false;
    postPresence(false);
  }
}

// Force an immediate visible:false (blur / lock / suspend) without waiting for
// the next poll — promptly un-mutes mobile.
function reportInactiveNow(): void {
  lastReported = false;
  postPresence(false);
}

/**
 * Wire desktop-presence reporting. `configGetter` returns the live AppConfig
 * (host/user/identity) used to keep the SSH forward up. Idempotent.
 */
export function startDesktopPresence(configGetter: () => AppConfig): void {
  if (started) return;
  started = true;
  getConfig = configGetter;

  // Focus change → re-evaluate immediately (don't wait up to POLL_MS).
  app.on("browser-window-focus", () => evaluateAndReport());
  app.on("browser-window-blur", () => {
    if (!anyWindowFocused()) reportInactiveNow();
  });

  // System idle / lock / sleep → definitely away.
  powerMonitor.on("lock-screen", () => reportInactiveNow());
  powerMonitor.on("suspend", () => reportInactiveNow());
  // Coming back → re-evaluate from the real focus + idle state.
  powerMonitor.on("unlock-screen", () => evaluateAndReport());
  powerMonitor.on("resume", () => evaluateAndReport());

  // Initial state + periodic re-evaluation / heartbeat.
  evaluateAndReport();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(evaluateAndReport, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

export function stopDesktopPresence(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
  // Best-effort: tell the box we're gone so mobile pushes resume promptly.
  if (lastReported !== false) reportInactiveNow();
}
