// manta-server access for the optimizer: loopback only (the box token is sent),
// every call bounded to 1.5 s and never awaited on the hot path.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SERVER = "http://127.0.0.1:8787";
export const CALL_TIMEOUT_MS = 1500;

function loopbackBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Test seam: MANTA_SERVER_URL, accepted only when it is loopback. */
export function serverBase(env: Record<string, string | undefined> = process.env): string {
  return loopbackBase(env.MANTA_SERVER_URL) ?? DEFAULT_SERVER;
}

// copied from the shared manta-auth helper — an installed plugin cannot resolve the tools dir
export function boxToken(env: Record<string, string | undefined> = process.env): string | null {
  if (env.MANTA_BOX_TOKEN) return env.MANTA_BOX_TOKEN;
  try {
    const tok = JSON.parse(readFileSync(join(homedir(), ".manta", "auth.json"), "utf-8"))?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null;
  }
}

export function authHeaders(body?: unknown, token: string | null = boxToken()): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  return headers;
}
