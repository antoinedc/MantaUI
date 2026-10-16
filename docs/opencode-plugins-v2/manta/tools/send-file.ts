// V2 twin of docs/opencode-tools/send-file.ts → send_file. Thin registrar over
// POST /api/outbox/push; stamps the calling messageID on the artifact.

import { call } from "../lib/server.ts";
import { bool, input, num, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "send_file",
    description: [
      "Send a file from this box to the user's machine and record it as a",
      "durable artifact. Use when you generated or produced a file for the user",
      "to keep (a CSV export, a report, a generated image/document). The file is",
      "copied (your working copy is kept) into the workspace-linked mailbox and",
      "shows up in the app's Artifacts panel Files tab for this conversation.",
      "It is NOT announced to the user unless you set notify:true — do that ONLY",
      "when the user explicitly asked you to send / share / give them this file.",
      "Files you save on your own initiative (reports, notes, specs) must NOT",
      "notify; the user finds them in the Artifacts panel. It is NOT deleted",
      "when the user downloads it —",
      "it stays retrievable until it expires (default 7 days, which the user can",
      "override per call), then the box's sweep removes it. Pass the absolute",
      "path to an existing file.",
    ].join(" "),
    input: input(
      {
        path: str(
          "Absolute path to the file to send (e.g. '/tmp/export.csv'). Must be a " +
            "regular file that exists on this box. The basename is used as the " +
            "artifact name the user sees.",
        ),
        ttlHours: num(
          "Hours until the artifact expires (default 168 = 7 days). " +
            "Set to a higher value for longer-lived artifacts, or 0 to disable expiry.",
        ),
        notify: bool(
          "Pop an 'AI sent you a file' notification on the user's devices. " +
            "Default false. Set true ONLY when the user explicitly asked for this " +
            "file in this conversation (e.g. 'send me the CSV'). Never for files " +
            "you decided to produce yourself.",
        ),
      },
      ["ttlHours", "notify"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/outbox/push", {
        filePath: args.path,
        sessionID: context.sessionID,
        ttlHours: args.ttlHours,
        messageID: context.messageID,
        notify: args.notify === true,
      });
      const ttl =
        result.row?.expiresAt == null
          ? "no expiry"
          : `expires ${new Date(result.row.expiresAt).toISOString()}`;
      return `Sent ${result.row?.name ?? "file"} to the user's machine (${ttl}). It is in the Artifacts panel Files tab for this conversation.`;
    },
  },
];
