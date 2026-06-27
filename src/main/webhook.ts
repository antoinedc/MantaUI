// webhook.ts (desktop) — read/delete inbound webhooks that live on the bui
// mobile server (the always-on Linux box). Webhooks are SERVER-OWNED: the
// registry and the public delivery route run in src/server/webhooks.mjs, fired
// by external POSTs regardless of whether this Mac app is open. The desktop only
// needs to LIST and DELETE them for the WebhooksCard UI (creation is the AI's
// job via the global `webhook` opencode tool, which returns the signing secret).
//
// Transport: the SAME best-effort SSH -L 18787 → box:8787 forward that
// desktop-presence / sharedConfigSync / schedule already use. We hit the
// server's GET/DELETE /api/webhook. If the forward isn't up the calls fail —
// but deliveries still wake the session (server-owned); the user just can't
// manage hooks from desktop until the forward heals. The renderer surfaces that
// as an error toast.

import { request } from "node:http";
import { ensureForward, ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import type { AppConfig, WebhookMeta } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;

export function initWebhookClient(deps: { getConfig: () => AppConfig }): void {
  getConfig = deps.getConfig;
}

// One JSON request to the box's /api/webhook over the forward. Rejects on any
// failure so the IPC caller can surface an error to the renderer.
function requestWebhook<T>(method: "GET" | "DELETE", search: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: PRESENCE_LOCAL_PORT,
        path: `/api/webhook${search}`,
        method,
        timeout: 4000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`webhook server ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error("webhook server returned bad JSON"));
          }
        });
      },
    );
    req.on("error", () => reject(new Error("webhook server unreachable")));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("webhook server timed out"));
    });
    req.end();
  });
}

async function withForward<T>(fn: () => Promise<T>): Promise<T> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.host) throw new Error("webhook server unreachable");
  await ensureForward(cfg).catch(() => {});
  await ensurePresenceForward(cfg);
  return fn();
}

export async function listWebhooks(sessionId?: string): Promise<WebhookMeta[]> {
  const search = sessionId ? `?sessionID=${encodeURIComponent(sessionId)}` : "";
  const result = await withForward(() =>
    requestWebhook<{ hooks: WebhookMeta[] }>("GET", search),
  );
  return Array.isArray(result.hooks) ? result.hooks : [];
}

export async function deleteWebhook(id: string): Promise<{ deleted: boolean }> {
  return withForward(() =>
    requestWebhook<{ deleted: boolean }>("DELETE", `?id=${encodeURIComponent(id)}`),
  );
}
