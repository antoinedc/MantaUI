// bui-native `notify` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs bui-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/notify.ts ~/.config/opencode/tools/notify.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It POSTs the notification to bui-server
// (127.0.0.1:8787, same box — no SSH hop), which runs it through the
// cross-device router (desktop OS notification and/or mobile Web Push, with
// desktop-first escalation). execute() returns promptly; bui-server owns the
// routing + delivery + any escalation timer.
//
// See docs/bui-tools-notify.md for the routing design and
// docs/bui-tools-scheduler.md for the general "bui tools" pattern.

import { tool } from "@opencode-ai/plugin";

const BUI_SERVER = process.env.BUI_SERVER_URL || "http://127.0.0.1:8787";

const z = tool.schema;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BUI_SERVER}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
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
    throw new Error(json?.error || `bui-server ${res.status}`);
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
