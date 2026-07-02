// schedule.ts (desktop) — read/delete scheduled-prompt jobs that live on the
// bui mobile server (the always-on Linux box). Schedules are SERVER-OWNED: the
// store and the firing loop run in src/server/schedule.mjs, fired by the box's
// systemd process regardless of whether this Mac app is open. The desktop only
// needs to LIST and DELETE them for the ScheduledTasksCard UI.
//
// Transport: the SAME best-effort SSH -L 18787 → box:8787 forward that
// desktop-presence and sharedConfigSync already use (ensurePresenceForward in
// opencode.ts). We hit the server's GET/DELETE /api/schedule. If the forward
// isn't up or the mobile server isn't running, calls fail — but the jobs still
// FIRE (server-owned); the user just can't manage them from desktop until the
// forward heals. The renderer surfaces that as an error toast.

import { request } from "node:http";
import { ensureForward, ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import type { AppConfig, ScheduledJob } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;

export function initScheduleClient(deps: { getConfig: () => AppConfig }): void {
  getConfig = deps.getConfig;
}

// One JSON request to the box's /api/schedule over the forward. Rejects on any
// failure (forward down, server down, non-2xx) so the IPC caller can surface
// an error to the renderer (unlike shared-config sync, schedule management is
// user-initiated and the user should know it didn't work).
//
// AUTH: since the M1 auth gate (src/server/auth.mjs) the box's /api/* routes
// require `Authorization: Bearer <box_token>`. Even over the trusted SSH -L
// 18787 forward (which terminates on the box as a local-direct request), the
// gate exempts only /auth/pair + /auth/claim — /api/schedule is gated. We send
// the boxToken persisted in config by the pairing claim (src/main/auth.ts). If
// it's absent (never paired), the request goes out header-less and the server
// answers 401 — surfaced to the user as the same "manage from desktop failed"
// error, which is correct: you must pair the box before you can manage it.
function requestSchedule<T>(
  method: "GET" | "DELETE",
  search: string,
  boxToken?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (boxToken) headers["authorization"] = `Bearer ${boxToken}`;
    const req = request(
      {
        host: "127.0.0.1",
        port: PRESENCE_LOCAL_PORT,
        path: `/api/schedule${search}`,
        method,
        timeout: 4000,
        headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`schedule server ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error("schedule server returned bad JSON"));
          }
        });
      },
    );
    req.on("error", () => reject(new Error("schedule server unreachable")));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("schedule server timed out"));
    });
    req.end();
  });
}

// Bring the SSH ControlMaster + -L 18787 forward up, then run fn with the
// current config. Mirrors sharedConfigSync.withForward, but RETHROWS so the IPC
// handler can report failure to the renderer. Passes the resolved config into
// fn so callers can read the boxToken for the Bearer header.
async function withForward<T>(fn: (cfg: AppConfig) => Promise<T>): Promise<T> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.host) throw new Error("schedule server unreachable");
  await ensureForward(cfg).catch(() => {});
  await ensurePresenceForward(cfg);
  return fn(cfg);
}

export async function listSchedules(sessionId?: string): Promise<ScheduledJob[]> {
  const search = sessionId ? `?sessionID=${encodeURIComponent(sessionId)}` : "";
  const result = await withForward((cfg) =>
    requestSchedule<{ jobs: ScheduledJob[] }>("GET", search, cfg.boxToken),
  );
  return Array.isArray(result.jobs) ? result.jobs : [];
}

export async function deleteSchedule(id: string): Promise<{ deleted: boolean }> {
  return withForward((cfg) =>
    requestSchedule<{ deleted: boolean }>(
      "DELETE",
      `?id=${encodeURIComponent(id)}`,
      cfg.boxToken,
    ),
  );
}
