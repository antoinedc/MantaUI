// V2 twin of docs/opencode-tools/notify.ts → notify. Thin registrar over
// POST /api/notify; manta-server's router owns device selection + delivery.

import { call } from "../lib/server.ts";
import { bool, input, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "notify",
    description: [
      "Send the user a notification (desktop OS notification and/or mobile push).",
      "Use when the user asks to be notified, pinged, or alerted that something",
      "happened — e.g. 'notify me when the build finishes', 'ping me when you're",
      "done', 'let me know if the tests fail'. Often paired with the schedule",
      "tool: schedule a recurring check, and call notify from that scheduled turn",
      "once the condition is met. manta decides which device(s) to deliver to based",
      "on where the user is active (desktop when at the desk, mobile when away,",
      "desktop-first with mobile escalation when idle) — you don't choose the",
      "device. Set urgent:true only for something the user must see right now",
      "(it fires on every device immediately).",
    ].join(" "),
    input: input(
      {
        message: str("The notification body — what happened / what the user should know."),
        title: str(
          "Optional short title. Defaults to the current chat's " +
            "'workspace / session-name' so the user can tell which chat it's from.",
        ),
        urgent: bool(
          "If true, deliver to every device immediately with no escalation delay " +
            "(blocking tier). Use sparingly — only for things that need eyes now.",
        ),
      },
      ["title", "urgent"],
    ),
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
  },
];
