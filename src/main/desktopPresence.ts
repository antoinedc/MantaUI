// desktopPresence.ts — report the user's raw system state to the mobile server
// so it can decide when to push to the phone (and when not to).
//
// All policy lives on the server side now (computeAwayAt / desktopState in
// src/server/push.mjs). This file only measures and reports:
//   - idleSeconds:  system-wide input idle time (any keyboard/mouse input on
//                    the machine, in any application)
//   - lockedSeconds: how long the screen has been locked (or null when unlocked)
//
// and it does so EVERY 30s while the app runs, unconditionally. Reporting
// forever is the point: "app open but user idle" must never be
// indistinguishable from "app quit" — the server's presence TTL notices a quit
// within ~90s, and the idle/lock measurements let it decide "away" itself.
//
// Transport: direct HTTPS POST to `${serverUrl}/push/desktop-presence` with
// `Authorization: Bearer <boxToken>`. No SSH forward needed — the server IS the
// box. If the server isn't running, the POST simply fails and we swallow it —
// presence is a nice-to-have, never load-bearing.
//
// Window focus is deliberately NOT an input. Manta's normal working pattern is:
// start a turn, then work in another app on the same Mac while it runs. A
// focus-based rule would call that "away" and buzz the phone while the user is
// sitting in front of the machine — the exact spam this replaced. System-wide
// input idle correctly reports "present" in that case (Slack and Teams both
// measure system input, not their own window's focus).

import { powerMonitor } from "electron";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AppConfig } from "../shared/types.js";

// How often to report raw presence observations. Must stay comfortably under
// the server's PRESENCE_TTL_MS (90s) so a missed beat doesn't read as "gone".
const POLL_MS = 30_000;

let getConfig: (() => AppConfig) | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let started = false;
// Epoch-ms when the screen locked or the machine suspended; null when unlocked.
// Recorded here so a lock→heartbeat reflects the total time locked even between
// unlock edges, and cleared so an unlocked state reports lockedSeconds: null.
let lockedAt: number | null = null;

function postPresence(idleSeconds: number, lockedSeconds: number | null): void {
  const cfg = getConfig?.();
  if (!cfg) return;
  sendHeartbeatHttp(cfg, { idleSeconds, lockedSeconds });
}

function sendHeartbeatHttp(
  cfg: AppConfig,
  body: { idleSeconds: number; lockedSeconds: number | null },
): void {
  const serverUrl = (cfg.serverUrl || "").replace(/\/+$/, "");
  if (!serverUrl) return;
  const payload = JSON.stringify(body);
  const url = new URL("/push/desktop-presence", serverUrl);
  const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = doRequest(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(cfg.boxToken ? { authorization: `Bearer ${cfg.boxToken}` } : {}),
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
  req.write(payload);
  req.end();
}

// System-wide input idle seconds. On throw (some Linux setups lack an idle
// backend) report 0 — treat an unavailable idle backend as "user is present",
// the conservative choice, and it preserves the old fallback intent.
function currentIdleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0;
  }
}

function currentLockedSeconds(): number | null {
  if (lockedAt == null) return null;
  return (Date.now() - lockedAt) / 1000;
}

// Report raw observations, unconditionally. All away/present/gone policy is the
// server's (computeAwayAt / desktopState in push.mjs).
function report(): void {
  postPresence(currentIdleSeconds(), currentLockedSeconds());
}

/**
 * Wire desktop-presence reporting. `configGetter` returns the live AppConfig
 * (serverUrl + boxToken used for HTTPS Bearer auth). Idempotent.
 */
export function startDesktopPresence(configGetter: () => AppConfig): void {
  if (started) return;
  started = true;
  getConfig = configGetter;

  // Lock / suspend are PROOF the user left — record the instant and report
  // immediately so the server's lock-based away calculation starts from
  // (roughly) the lock, not the next poll.
  powerMonitor.on("lock-screen", () => {
    if (lockedAt == null) lockedAt = Date.now();
    report();
  });
  powerMonitor.on("suspend", () => {
    if (lockedAt == null) lockedAt = Date.now();
    report();
  });
  // Unlock / resume → clear the lock timestamp and report immediately.
  powerMonitor.on("unlock-screen", () => {
    lockedAt = null;
    report();
  });
  powerMonitor.on("resume", () => {
    lockedAt = null;
    report();
  });

  // Initial heartbeat + periodic raw reporting. Fires unconditionally —
  // never goes quiet while the app runs, so a quit (not an idle) is the only
  // thing that starves the server's TTL.
  report();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(report, POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

export function stopDesktopPresence(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
  // On quit the heartbeat simply stops and the server's PRESENCE_TTL_MS notices
  // within ~90s — that is the intended "gone" path, not a regression.
}
