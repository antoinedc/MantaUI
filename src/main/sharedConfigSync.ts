// sharedConfigSync.ts — two-way (last-write-wins) sync of the device-independent
// config subset between the desktop Electron app (Mac) and the mobile server
// (the Linux box). Set your Groq STT key (or any shareable field) on either
// device and the other picks it up.
//
// Transport: the SAME best-effort SSH -L 18787 → box:8787 forward that
// desktop-presence already uses (ensurePresenceForward in opencode.ts). We hit
// the server's GET/POST /api/shared-config. If the forward isn't up or the
// mobile server isn't running, every call fails silently — sync is a
// nice-to-have, never load-bearing for desktop operation.
//
// Direction & timing (per the locked design):
//   - PUSH on every desktop save: configUpdate stamps configUpdatedAt locally,
//     then POSTs the shared snapshot to the box. The server LWW-merges it.
//   - PULL on desktop startup: GET the box snapshot and LWW-merge it into the
//     desktop config (a mobile edit made while desktop was closed lands here).
//   - The server's POST response is ALSO the post-merge snapshot, so a single
//     push doubles as a pull when the box happened to be newer (e.g. a mobile
//     edit raced a desktop save).
//
// LWW comparison lives in the pure mergeSharedConfig (src/shared/sharedConfig.mjs)
// shared with the server, so both sides agree on "newer wins".

import { request } from "node:http";
import { ensureForward, ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import {
  extractSharedConfig,
  mergeSharedConfig,
  type SharedConfigSnapshot,
} from "../shared/sharedConfig.mjs";
import type { AppConfig } from "../shared/types.js";

// Wired by index.ts so this module can read the live config and persist a pulled
// snapshot through the SAME commit path the IPC handler uses (keeps the renderer
// in step and saves to disk).
let getConfig: (() => AppConfig) | null = null;
let applyPulled: ((snap: SharedConfigSnapshot) => void) | null = null;

export function initSharedConfigSync(deps: {
  getConfig: () => AppConfig;
  applyPulled: (snap: SharedConfigSnapshot) => void;
}): void {
  getConfig = deps.getConfig;
  applyPulled = deps.applyPulled;
}

// Low-level: one JSON request to the box's /api/shared-config over the forward.
// Resolves null on any failure (forward down, server down, bad JSON, non-2xx).
function requestSharedConfig(
  method: "GET" | "POST",
  payload?: SharedConfigSnapshot,
): Promise<SharedConfigSnapshot | null> {
  return new Promise((resolve) => {
    const body = method === "POST" ? JSON.stringify(payload ?? {}) : undefined;
    const req = request(
      {
        host: "127.0.0.1",
        port: PRESENCE_LOCAL_PORT,
        path: "/api/shared-config",
        method,
        headers: {
          "content-type": "application/json",
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
        timeout: 4000,
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw) as SharedConfigSnapshot);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (body) req.write(body);
    req.end();
  });
}

// Make sure the -L forward exists, then run `fn` against it. Mirrors how
// desktopPresence gates its POSTs. Swallows everything.
//
// GOTCHA: ensurePresenceForward() assumes the shared SSH ControlMaster is
// ALREADY up (it just adds an -L channel to it) — it does NOT boot the master
// itself. The opencode path normally calls ensureForward() first, but a
// shared-config push can fire before any chat window opened the tunnel (e.g.
// the user changes the Groq model on a fresh launch). Without the master,
// `ssh -O forward` fails, the POST never reaches the box, and the edit silently
// never syncs to mobile. So bring the master up here first. Both calls are
// best-effort and swallow their own errors.
async function withForward<T>(fn: () => Promise<T>): Promise<T | null> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.host) return null;
  try {
    await ensureForward(cfg).catch(() => {});
    await ensurePresenceForward(cfg);
    return await fn();
  } catch {
    return null;
  }
}

// PUSH: send our current shared snapshot to the box. The server LWW-merges and
// returns the post-merge snapshot; if THAT is newer than ours (a racing mobile
// edit), we pull it back in. Call after every desktop configUpdate that touched
// a shareable field.
export async function pushSharedConfig(): Promise<void> {
  // One retry: the very first push after launch may race the ControlMaster /
  // -L forward coming up, so the POST lands on a not-yet-open port and returns
  // null. A short backoff lets the forward settle, then we try once more. If it
  // still fails, the desktop's next save (or startup pull) reconciles — sync is
  // eventually-consistent, never load-bearing.
  const attempt = (): Promise<boolean> =>
    withForward(async () => {
      const cfg = getConfig?.();
      if (!cfg) return false;
      const ours = extractSharedConfig(cfg);
      const serverSnap = await requestSharedConfig("POST", ours);
      if (!serverSnap) return false;
      maybeApplyPulled(serverSnap);
      return true;
    }).then((r) => r === true);

  if (await attempt()) return;
  await new Promise((r) => setTimeout(r, 1500));
  await attempt();
}

// PULL: fetch the box snapshot and LWW-merge into desktop config. Call on
// startup (and any time you want to reconcile, e.g. host change).
export async function pullSharedConfig(): Promise<void> {
  await withForward(async () => {
    const serverSnap = await requestSharedConfig("GET");
    if (serverSnap) maybeApplyPulled(serverSnap);
  });
}

// Apply an incoming snapshot iff LWW says it's newer than our local config.
function maybeApplyPulled(snap: SharedConfigSnapshot): void {
  const cfg = getConfig?.();
  if (!cfg) return;
  const { changed } = mergeSharedConfig(cfg, snap);
  if (changed && applyPulled) applyPulled(snap);
}
