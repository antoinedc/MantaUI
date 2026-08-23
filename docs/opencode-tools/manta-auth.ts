// Shared boxToken() / authHeaders() helpers for the MantaUI opencode tools
// (docs/opencode-tools/*.ts). One source of truth — every tool imports these
// by relative path (`./manta-auth`) instead of re-declaring box-identical
// copies (BET-1330).
//
// Install constraint: opencode resolves a tool's imports relative to the
// file's REAL path under ~/.config/opencode/tools/ (which has no
// node_modules). So this module is COPIED alongside each tool that imports
// it:
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// It must be installed as a sibling of the tool importing it or that tool
// silently fails to register with `Cannot find module './manta-auth'`.
//
// manta-server enforces `Authorization: Bearer <box_token>` on every /api
// route (M1 auth gate — src/server/auth.mjs). These tools run on the SAME
// box as the same user as manta-server, so they read the token straight from
// the server's own auth store (~/.manta/auth.json, 0600). Re-read on every
// call (one tiny local file) so a token rotation never requires an
// opencode-serve restart. MANTA_BOX_TOKEN env overrides for tests/dev.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
