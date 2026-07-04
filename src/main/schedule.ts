// schedule.ts (desktop) — read/delete scheduled-prompt jobs that live on the
// bui mobile server (the always-on Linux box). Schedules are SERVER-OWNED: the
// store and the firing loop run in src/server/schedule.mjs, fired by the box's
// systemd process regardless of whether this Mac app is open. The desktop only
// needs to LIST and DELETE them for the ScheduledTasksCard UI.
//
// Transport: direct HTTPS to `${serverUrl}/api/schedule` with `Authorization:
// Bearer <boxToken>`. The server owns the store; this module only lists/deletes
// for the UI. If the server is unreachable, calls reject and the renderer
// surfaces an error toast.

import type { AppConfig, ScheduledJob } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;

export function initScheduleClient(deps: { getConfig: () => AppConfig }): void {
  getConfig = deps.getConfig;
}

// AUTH: the M1 auth gate (src/server/auth.mjs) gates /api/* routes, so we must
// send `Authorization: Bearer <box_token>`. The token is the boxToken persisted
// in config by the pairing claim (src/main/auth.ts). If absent (never paired),
// the request goes out header-less and the server answers 401 — surfaced to
// the user as the same "manage from desktop failed" error, which is correct:
// you must pair the box before you can manage it.
async function requestSchedule<T>(
  method: "GET" | "DELETE",
  search: string,
  boxToken?: string,
): Promise<T> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.serverUrl) throw new Error("schedule server unreachable");
  const url = `${cfg.serverUrl.replace(/\/+$/, "")}/api/schedule${search}`;
  const headers: Record<string, string> = {};
  if (boxToken) headers["authorization"] = `Bearer ${boxToken}`;
  const res = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`schedule server ${res.status}`);
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("schedule server returned bad JSON");
  }
}

export async function listSchedules(sessionId?: string): Promise<ScheduledJob[]> {
  const search = sessionId ? `?sessionID=${encodeURIComponent(sessionId)}` : "";
  const cfg = getConfig?.();
  const result = await requestSchedule<{ jobs: ScheduledJob[] }>(
    "GET",
    search,
    cfg?.boxToken,
  );
  return Array.isArray(result.jobs) ? result.jobs : [];
}

export async function deleteSchedule(id: string): Promise<{ deleted: boolean }> {
  const cfg = getConfig?.();
  return requestSchedule<{ deleted: boolean }>(
    "DELETE",
    `?id=${encodeURIComponent(id)}`,
    cfg?.boxToken,
  );
}
