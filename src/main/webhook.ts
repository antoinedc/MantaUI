// webhook.ts (desktop) — read/delete inbound webhooks that live on the bui
// mobile server (the always-on Linux box). Webhooks are SERVER-OWNED: the
// registry and the public delivery route run in src/server/webhooks.mjs, fired
// by external POSTs regardless of whether this Mac app is open. The desktop only
// needs to LIST and DELETE them for the WebhooksCard UI (creation is the AI's
// job via the global `webhook` opencode tool, which returns the signing secret).
//
// Transport: direct HTTPS to `${serverUrl}/api/webhook` with `Authorization:
// Bearer <boxToken>`. If the server is unreachable, calls reject — but
// deliveries still wake the session (server-owned); the user just can't manage
// hooks from desktop until the server is reachable. The renderer surfaces that
// as an error toast.

import type { AppConfig, WebhookMeta } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;

export function initWebhookClient(deps: { getConfig: () => AppConfig }): void {
  getConfig = deps.getConfig;
}

// One JSON request to the box's /api/webhook over HTTPS. Rejects on any failure
// so the IPC caller can surface an error to the renderer.
async function requestWebhook<T>(method: "GET" | "DELETE", search: string): Promise<T> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.serverUrl) throw new Error("webhook server unreachable");
  const url = `${cfg.serverUrl.replace(/\/+$/, "")}/api/webhook${search}`;
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    throw new Error(`webhook server ${res.status}`);
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("webhook server returned bad JSON");
  }
}

export async function listWebhooks(sessionId?: string): Promise<WebhookMeta[]> {
  const search = sessionId ? `?sessionID=${encodeURIComponent(sessionId)}` : "";
  const result = await requestWebhook<{ hooks: WebhookMeta[] }>("GET", search);
  return Array.isArray(result.hooks) ? result.hooks : [];
}

export async function deleteWebhook(id: string): Promise<{ deleted: boolean }> {
  return requestWebhook<{ deleted: boolean }>(
    "DELETE",
    `?id=${encodeURIComponent(id)}`,
  );
}
