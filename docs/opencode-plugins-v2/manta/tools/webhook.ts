// V2 twin of docs/opencode-tools/webhook.ts → webhook_create / webhook_list /
// webhook_remove. manta-server owns the hook registry + the public delivery
// route (src/server/webhooks.mjs).

import { call } from "../lib/server.ts";
import { bool, input, noInput, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "webhook_create",
    description: [
      "Create an inbound webhook that wakes THIS chat session when an EXTERNAL",
      "system POSTs to it — the push alternative to polling with schedule_create.",
      "Use when the user wants to be triggered by an outside event instead of",
      "looping, e.g. 'have Multica ping this session when the task finishes',",
      "'wake me here when CI goes green', 'let GitHub notify this chat on a new",
      "issue'. Returns a public delivery URL and an HMAC signing secret to",
      "configure in the external system. When that system POSTs an event, it",
      "arrives here as a new turn (payload wrapped as untrusted data). Give the",
      "URL + secret to the user/system; the secret is shown only once.",
    ].join(" "),
    input: input(
      {
        label: str(
          "Short human label for this hook, shown in the user's webhook list, e.g. 'multica CAPO-123 done'.",
        ),
        instructions: str(
          "Optional standing directive prepended to every delivery — what you should DO when this fires, " +
            "e.g. 'Pull the Multica run output and summarize it.' This is trusted text; the posted payload is not.",
        ),
        unsigned: bool(
          "Set true ONLY if the external system cannot send an HMAC signature. Then the unguessable URL token " +
            "is the only guard (discouraged). Default false = require a valid X-Manta-Signature on every delivery.",
        ),
      },
      ["instructions", "unsigned"],
    ),
    async execute(args, context) {
      const result = await call("POST", "/api/webhook", {
        label: args.label,
        instructions: args.instructions ?? "",
        unsigned: !!args.unsigned,
        sessionID: context.sessionID,
        directory: context.directory,
      });
      return [
        `Webhook created (id ${result.id}).`,
        `Delivery URL: ${result.url}`,
        args.unsigned
          ? `This hook is UNSIGNED — anyone with the URL can trigger it.`
          : `Signing secret (shown ONCE — store it now): ${result.secret}`,
        args.unsigned
          ? `Configure the external system to POST its event JSON to that URL.`
          : `Configure the external system to POST event JSON with header ` +
            `X-Manta-Signature: sha256=HMAC_SHA256(secret, rawBody).`,
        `When it fires, the event arrives in this session as a new turn.`,
      ].join("\n");
    },
  },
  {
    name: "webhook_list",
    description:
      "List the inbound webhooks for THIS chat session (id, label, delivery URL, " +
      "last-delivered time, delivery count). Use when the user asks 'what webhooks " +
      "are set up?' or before deleting one. Never shows the signing secret.",
    input: noInput(),
    async execute(_args, context) {
      const result = await call(
        "GET",
        `/api/webhook?sessionID=${encodeURIComponent(context.sessionID)}`,
      );
      const hooks = result.hooks ?? [];
      if (hooks.length === 0) return "No webhooks in this session.";
      return hooks
        .map((h: any) => {
          const last = h.lastDeliveredAt
            ? `last fired ${new Date(h.lastDeliveredAt).toISOString()}, ${h.deliveries} total`
            : "never fired";
          return `• [${h.id}] ${h.label}${h.unsigned ? " (UNSIGNED)" : ""} — ${h.url} (${last})`;
        })
        .join("\n");
    },
  },
  {
    name: "webhook_remove",
    description:
      "Delete (revoke) an inbound webhook by its id. Get ids from the webhook_list " +
      "tool or the id returned when the webhook was created. Further POSTs to its " +
      "URL will 404 after this.",
    input: input({ id: str("The 8-character webhook id to delete.") }),
    async execute(args) {
      const result = await call("DELETE", `/api/webhook?id=${encodeURIComponent(args.id)}`);
      return result.deleted ? `Deleted webhook ${args.id}.` : `No webhook with id ${args.id}.`;
    },
  },
];
