// secrets.ts (desktop) — read/write the secure secret store that lives on the
// bui mobile server (the always-on Linux box). Secrets are SERVER-OWNED: the
// store (~/.bui-mobile/secrets.json) and the materialize-to-file path that the
// AI uses both run on the box. The desktop only needs to LIST / SET / DELETE
// secrets for the SecretsCard UI — the AI never goes through here.
//
// Transport: the SAME best-effort SSH -L 18787 → box:8787 forward that
// desktop-presence, sharedConfigSync, and schedule.ts already use
// (ensurePresenceForward in opencode.ts). If the forward isn't up the calls
// fail and the renderer surfaces an error toast — but the store still works
// for the AI (server-owned). NOTE: list returns METADATA ONLY (no values); the
// value travels Mac → box on set and never comes back.

import { request } from "node:http";
import { ensureForward, ensurePresenceForward, PRESENCE_LOCAL_PORT } from "./opencode.js";
import type { AppConfig, SecretMeta, SecretInput } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;

export function initSecretsClient(deps: { getConfig: () => AppConfig }): void {
  getConfig = deps.getConfig;
}

// One JSON request to the box's /api/secrets over the forward. Rejects on any
// failure so the IPC caller can surface an error to the renderer.
//
// AUTH: like schedule.ts, the M1 auth gate (src/server/auth.mjs) gates /api/*,
// so we must send `Authorization: Bearer <box_token>`. The token is the
// boxToken persisted in config by the pairing claim (src/main/auth.ts); absent
// (never paired) → header-less request → server 401 → error toast, which is the
// correct signal to pair the box first.
function requestSecrets<T>(
  method: "GET" | "POST" | "DELETE",
  search: string,
  body?: unknown,
  boxToken?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    if (boxToken) headers["authorization"] = `Bearer ${boxToken}`;
    const req = request(
      {
        host: "127.0.0.1",
        port: PRESENCE_LOCAL_PORT,
        path: `/api/secrets${search}`,
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
            // Surface the server's error message when present (e.g. bad key).
            let msg = `secrets server ${res.statusCode}`;
            try {
              const j = JSON.parse(raw);
              if (j?.error) msg = j.error;
            } catch {
              /* keep generic */
            }
            reject(new Error(msg));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error("secrets server returned bad JSON"));
          }
        });
      },
    );
    req.on("error", () => reject(new Error("secrets server unreachable")));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("secrets server timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function withForward<T>(fn: (cfg: AppConfig) => Promise<T>): Promise<T> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.host) throw new Error("secrets server unreachable");
  await ensureForward(cfg).catch(() => {});
  await ensurePresenceForward(cfg);
  return fn(cfg);
}

export async function listSecrets(sessionId?: string, all?: boolean): Promise<SecretMeta[]> {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionID", sessionId);
  if (all) params.set("all", "1");
  const search = params.toString() ? `?${params.toString()}` : "";
  const result = await withForward((cfg) =>
    requestSecrets<{ secrets: SecretMeta[] }>("GET", search, undefined, cfg.boxToken),
  );
  return Array.isArray(result.secrets) ? result.secrets : [];
}

export async function setSecret(
  input: SecretInput,
): Promise<{ ok: boolean; meta?: SecretMeta; error?: string }> {
  // The server returns { meta } with 200 on success, or { error } with 400 (→
  // requestSecrets rejects). So a resolved value always means success.
  return withForward((cfg) =>
    requestSecrets<{ meta?: SecretMeta }>("POST", "", input, cfg.boxToken).then((r) => ({
      ok: true as const,
      meta: r.meta,
    })),
  );
}

export async function deleteSecret(id: string): Promise<{ deleted: boolean }> {
  return withForward((cfg) =>
    requestSecrets<{ deleted: boolean }>(
      "DELETE",
      `?id=${encodeURIComponent(id)}`,
      undefined,
      cfg.boxToken,
    ),
  );
}
