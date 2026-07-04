// sharedConfigSync.ts — two-way (last-write-wins) sync of the device-independent
// config subset between the desktop Electron app (Mac) and the mobile server
// (the Linux box). Set your Groq STT key (or any shareable field) on either
// device and the other picks it up.
//
// Transport: direct HTTPS to `${serverUrl}/api/shared-config`. If the server
// is unreachable, every call fails silently — sync is a nice-to-have, never
// load-bearing for desktop operation.
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

// Low-level: one JSON request to the box's /api/shared-config over HTTPS.
// Resolves null on any failure (server down, bad JSON, non-2xx).
async function requestSharedConfig(
  method: "GET" | "POST",
  payload?: SharedConfigSnapshot,
  boxToken?: string,
): Promise<SharedConfigSnapshot | null> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.serverUrl) return null;
  const url = `${cfg.serverUrl.replace(/\/+$/, "")}/api/shared-config`;
  const body = method === "POST" ? JSON.stringify(payload ?? {}) : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
  };
  if (boxToken) headers["authorization"] = `Bearer ${boxToken}`;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const raw = await res.text();
    try {
      return JSON.parse(raw) as SharedConfigSnapshot;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// PUSH: send our current shared snapshot to the box. The server LWW-merges and
// returns the post-merge snapshot; if THAT is newer than ours (a racing mobile
// edit), we pull it back in. Call after every desktop configUpdate that touched
// a shareable field.
export async function pushSharedConfig(): Promise<void> {
  // One retry: the very first push after launch may race the server coming up,
  // so the POST lands on a not-yet-open port and returns null. A short backoff
  // lets the server settle, then we try once more. If it still fails, the
  // desktop's next save (or startup pull) reconciles — sync is
  // eventually-consistent, never load-bearing.
  const attempt = async (): Promise<boolean> => {
    const cfg = getConfig?.();
    if (!cfg) return false;
    const ours = extractSharedConfig(cfg);
    const serverSnap = await requestSharedConfig("POST", ours, cfg.boxToken);
    if (!serverSnap) return false;
    maybeApplyPulled(serverSnap);
    return true;
  };

  if (await attempt()) return;
  await new Promise((r) => setTimeout(r, 1500));
  await attempt();
}

// PULL: fetch the box snapshot and LWW-merge into desktop config. Call on
// startup (and any time you want to reconcile, e.g. host change).
export async function pullSharedConfig(): Promise<void> {
  const cfg = getConfig?.();
  const serverSnap = await requestSharedConfig("GET", undefined, cfg?.boxToken);
  if (serverSnap) maybeApplyPulled(serverSnap);
}

// Apply an incoming snapshot iff LWW says it's newer than our local config.
function maybeApplyPulled(snap: SharedConfigSnapshot): void {
  const cfg = getConfig?.();
  if (!cfg) return;
  const { changed } = mergeSharedConfig(cfg, snap);
  if (changed && applyPulled) applyPulled(snap);
}
