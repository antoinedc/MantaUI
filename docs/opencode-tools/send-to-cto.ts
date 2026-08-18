// manta-native `send_to_cto` tool — global opencode custom tool (BET-1165).
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/send-to-cto.ts ~/.config/opencode/tools/send-to-cto.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// A copy, never a symlink — opencode resolves a tool's imports relative to the
// file's REAL path, so a symlink back into the repo (no node_modules) fails
// with `Cannot find module '@opencode-ai/plugin'` and the tool silently never
// registers.
//
// PURPOSE: let ANY session report something to the on-call CTO. This is a THIN
// registrar: `execute` POSTs `{surface:"session", sessionID, message, ...opts}`
// to manta-server's /api/cto/inbound (same box, no SSH hop) and returns
// immediately. manta-server owns the routing (dedupe + live-vs-parked), NOT
// this tool. See src/server/cto.mjs (createCtoInbound).
//
// When no "call is live" flag is set (this issue), the message routes to the
// PARKED path and the user gets a push/notify. Once Issue 3 flips the live
// flag, the message is injected into the CTO session as a turn instead.

import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one
// tiny local file) so a token rotation never requires an opencode-serve
// restart. MANTA_BOX_TOKEN env overrides for tests/dev.
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

export const send_to_cto = tool({
  description: [
    "Send a message to the on-call CTO. Any session can call this: it reports a",
    "note up to the CTO, who has a read-only tool belt over what's running, the",
    "Multica board, usage, and more. The message is surfaced to the user: when",
    "the CTO call is not live it arrives as a push/notify; once the call-window",
    "feature ships it is injected into the CTO conversation as a turn. Use this",
    "to flag something the CTO should know (a new P0, a blocker, a request to",
    "call you back). It returns immediately — the box owns routing.",
  ].join(" "),
  args: {
    message: z
      .string()
      .describe("What to report to the CTO. Be concrete: the fact, not the process."),
    title: z
      .string()
      .optional()
      .describe(
        "Optional short title for the surfaced notification. Defaults to the sender's " +
          "session label.",
      ),
    urgent: z
      .boolean()
      .optional()
      .describe(
        "If true, deliver to every device immediately (blocking tier). Use sparingly — " +
          "only for something the CTO must see right now.",
      ),
  },
  async execute(args, context) {
    const result = await call("POST", "/api/cto/inbound", {
      surface: "session",
      sessionID: context.sessionID,
      message: args.message,
      title: args.title,
      urgent: !!args.urgent,
    });
    return result.parked
      ? "Reported to the CTO (no live call — surfaced as a notification)."
      : "Reported to the CTO.";
  },
});
