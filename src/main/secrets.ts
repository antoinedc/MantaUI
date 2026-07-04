// secrets.ts (desktop) — read/write the secure secret store that lives on the
// bui mobile server (the always-on Linux box). Secrets are SERVER-OWNED: the
// store (~/.bui-mobile/secrets.json) and the materialize-to-file path that the
// AI uses both run on the box. The desktop only needs to LIST / SET / DELETE
// secrets for the SecretsCard UI — the AI never goes through here.
//
// Transport: direct HTTPS to `${serverUrl}/api/secrets` with `Authorization:
// Bearer <boxToken>`. If the server is unreachable, calls reject and the
// renderer surfaces an error toast — but the store still works for the AI
// (server-owned). NOTE: list returns METADATA ONLY (no values); the value
// travels Mac → box on set and never comes back.

import type { AppConfig, SecretMeta, SecretInput } from "../shared/types.js";

let getConfig: (() => AppConfig) | null = null;

export function initSecretsClient(deps: { getConfig: () => AppConfig }): void {
  getConfig = deps.getConfig;
}

// AUTH: like schedule.ts, the M1 auth gate (src/server/auth.mjs) gates /api/*,
// so we must send `Authorization: Bearer <box_token>`. The token is the
// boxToken persisted in config by the pairing claim (src/main/auth.ts); absent
// (never paired) → header-less request → server 401 → error toast, which is the
// correct signal to pair the box first.
async function requestSecrets<T>(
  method: "GET" | "POST" | "DELETE",
  search: string,
  body?: unknown,
  boxToken?: string,
): Promise<T> {
  const cfg = getConfig?.();
  if (!cfg || !cfg.serverUrl) throw new Error("secrets server unreachable");
  const url = `${cfg.serverUrl.replace(/\/+$/, "")}/api/secrets${search}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (boxToken) headers["authorization"] = `Bearer ${boxToken}`;
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) {
    let msg = `secrets server ${res.status}`;
    try {
      const raw = await res.text();
      const j = JSON.parse(raw);
      if (j?.error) msg = j.error;
    } catch {
      /* keep generic */
    }
    throw new Error(msg);
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("secrets server returned bad JSON");
  }
}

export async function listSecrets(sessionId?: string, all?: boolean): Promise<SecretMeta[]> {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionID", sessionId);
  if (all) params.set("all", "1");
  const search = params.toString() ? `?${params.toString()}` : "";
  const cfg = getConfig?.();
  const result = await requestSecrets<{ secrets: SecretMeta[] }>(
    "GET",
    search,
    undefined,
    cfg?.boxToken,
  );
  return Array.isArray(result.secrets) ? result.secrets : [];
}

export async function setSecret(
  input: SecretInput,
): Promise<{ ok: boolean; meta?: SecretMeta; error?: string }> {
  // The server returns { meta } with 200 on success, or { error } with 400 (→
  // requestSecrets rejects). So a resolved value always means success.
  const cfg = getConfig?.();
  return requestSecrets<{ meta?: SecretMeta }>("POST", "", input, cfg?.boxToken).then((r) => ({
    ok: true as const,
    meta: r.meta,
  }));
}

export async function deleteSecret(id: string): Promise<{ deleted: boolean }> {
  const cfg = getConfig?.();
  return requestSecrets<{ deleted: boolean }>(
    "DELETE",
    `?id=${encodeURIComponent(id)}`,
    undefined,
    cfg?.boxToken,
  );
}
