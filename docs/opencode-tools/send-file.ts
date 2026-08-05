// manta-native `send_file` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/send-file.ts ~/.config/opencode/tools/send-file.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It validates the request and POSTs it to
// manta-server (127.0.0.1:8787, same box — no SSH hop). manta-server copies
// the file into ~/.manta-outbox/<sessionID>/ (the workspace-linked artifact
// mailbox) and the box's outbox scanner announces it with an "AI sent you a
// file" toast. The tool does NOT move or transform the file itself — the AI
// keeps its working copy; execute() must return promptly.
//
// Durable artifact semantics (reconciled with the old one-shot mailbox):
//   - Workspace-linked under the caller's opencode sessionID.
//   - TTL (default 7 days) — NOT deleted on download; swept when it expires.
//   - Re-downloadable until then.
//
// See docs/manta-tools-scheduler.md for the general "manta tools" pattern.

import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one tiny
// local file) so a token rotation never requires an opencode-serve restart.
// MANTA_BOX_TOKEN env overrides for tests/dev.
function boxToken(): string | null {
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

function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  const tok = boxToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  return headers;
}

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MANTA_SERVER}${path}`, {
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

export const send_file = tool({
  description: [
    "Send a file from this box to the user's machine and record it as a",
    "durable artifact. Use when you generated or produced a file for the user",
    "to keep (a CSV export, a report, a generated image/document). The file is",
    "copied (your working copy is kept) into the workspace-linked mailbox,",
    "announced with a toast, and shows up in the app's Artifacts panel Files",
    "tab for this conversation. It is NOT deleted when the user downloads it —",
    "it stays retrievable until it expires (default 7 days, which the user can",
    "override per call), then the box's sweep removes it. Pass the absolute",
    "path to an existing file.",
  ].join(" "),
  args: {
    path: z
      .string()
      .describe(
        "Absolute path to the file to send (e.g. '/tmp/export.csv'). Must be a " +
          "regular file that exists on this box. The basename is used as the " +
          "artifact name the user sees.",
      ),
    ttlHours: z
      .number()
      .optional()
      .describe(
        "Hours until the artifact expires (default 168 = 7 days). " +
          "Set to a higher value for longer-lived artifacts, or 0 to disable expiry.",
      ),
  },
  async execute(args, context) {
    const result = await call("POST", "/api/outbox/push", {
      filePath: args.path,
      sessionID: context.sessionID,
      ttlHours: args.ttlHours,
    });
    const ttl =
      result.row?.expiresAt == null
        ? "no expiry"
        : `expires ${new Date(result.row.expiresAt).toISOString()}`;
    return `Sent ${result.row?.name ?? "file"} to the user's machine (${ttl}). It is in the Artifacts panel Files tab for this conversation.`;
  },
});
