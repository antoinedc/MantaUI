// manta-server client for the Manta tools. One shared module — the V1 tools
// each carried their own copy of `call` plus a sibling-copied manta-auth.ts;
// a V2 plugin is an ordinary module graph so none of that is needed.
//
// Rules are unchanged from V1 (docs/opencode-tools/manta-auth.ts + the per-tool
// `call` helper):
//   - base URL: MANTA_SERVER_URL or http://127.0.0.1:8787
//   - every /api route needs `Authorization: Bearer <box_token>`; the token is
//     MANTA_BOX_TOKEN or `box_token` in ~/.manta/auth.json (0600, same user,
//     same box), RE-READ on every call so a rotation never needs a restart
//   - non-2xx → throw Error(json.error || `manta-server <status>`)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read per call (not at import) so tests / a changed env take effect. */
export function serverUrl(): string {
  return process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";
}

export function boxToken(): string | null {
  const fromEnv = process.env.MANTA_BOX_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8");
    const tok = JSON.parse(raw)?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null; // no store yet (auth disabled / first run) → send no header
  }
}

export function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  const tok = boxToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  return headers;
}

/** JSON request to manta-server; same error semantics as the V1 `call`. */
export async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${serverUrl()}${path}`, {
    method,
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `manta-server ${res.status}`);
  }
  return json;
}
