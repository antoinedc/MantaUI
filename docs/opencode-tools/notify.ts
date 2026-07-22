// bui-native `notify` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/notify.ts ~/.config/opencode/tools/notify.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It POSTs the notification to manta-server
// (127.0.0.1:8787, same box — no SSH hop), which runs it through the
// cross-device router (desktop OS notification and/or mobile Web Push, with
// desktop-first escalation). execute() returns promptly; manta-server owns the
// routing + delivery + any escalation timer.
//
// See docs/manta-tools-notify.md for the routing design and
// docs/manta-tools-scheduler.md for the general "bui tools" pattern.

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

export const notify = tool({
  description: [
    "Send the user a notification (desktop OS notification and/or mobile push).",
    "Use when the user asks to be notified, pinged, or alerted that something",
    "happened — e.g. 'notify me when the build finishes', 'ping me when you're",
    "done', 'let me know if the tests fail'. Often paired with the schedule",
    "tool: schedule a recurring check, and call notify from that scheduled turn",
    "once the condition is met. bui decides which device(s) to deliver to based",
    "on where the user is active (desktop when at the desk, mobile when away,",
    "desktop-first with mobile escalation when idle) — you don't choose the",
    "device. Set urgent:true only for something the user must see right now",
    "(it fires on every device immediately).",
  ].join(" "),
  args: {
    message: z
      .string()
      .describe("The notification body — what happened / what the user should know."),
    title: z
      .string()
      .optional()
      .describe(
        "Optional short title. Defaults to the current chat's " +
          "'workspace / session-name' so the user can tell which chat it's from.",
      ),
    urgent: z
      .boolean()
      .optional()
      .describe(
        "If true, deliver to every device immediately with no escalation delay " +
          "(blocking tier). Use sparingly — only for things that need eyes now.",
      ),
  },
  async execute(args, context) {
    await call("POST", "/api/notify", {
      message: args.message,
      title: args.title,
      urgent: !!args.urgent,
      sessionID: context.sessionID,
    });
    return args.urgent
      ? "Notification sent to all your devices."
      : "Notification sent (desktop if you're here, mobile if you're away).";
  },
});
