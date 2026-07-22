// bui-native `webhook` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/webhook.ts ~/.config/opencode/tools/webhook.ts
// then: systemctl --user restart opencode-serve   (re-scans tools/).
// COPIED, not symlinked (the @opencode-ai/plugin import-resolution gotcha).
//
// This tool is a THIN registrar. It validates the request and POSTs it to
// manta-server (127.0.0.1:8787, same box — no SSH hop), which owns the durable
// hook registry and the public delivery route (src/server/webhooks.mjs).
//
// A webhook lets an EXTERNAL system (Multica, GitHub, CI, another box) wake THIS
// chat session by HTTP POST — the push alternative to polling with `schedule`.
// webhook_create returns a public delivery URL + an HMAC signing secret to hand
// to that system. When it POSTs an event, manta-server injects it into this
// session as a new turn. See docs/manta-tools-webhook.md for the full design.

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

export const create = tool({
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
  args: {
    label: z
      .string()
      .describe("Short human label for this hook, shown in the user's webhook list, e.g. 'multica CAPO-123 done'."),
    instructions: z
      .string()
      .optional()
      .describe(
        "Optional standing directive prepended to every delivery — what you should DO when this fires, " +
          "e.g. 'Pull the Multica run output and summarize it.' This is trusted text; the posted payload is not.",
      ),
    unsigned: z
      .boolean()
      .optional()
      .describe(
        "Set true ONLY if the external system cannot send an HMAC signature. Then the unguessable URL token " +
          "is the only guard (discouraged). Default false = require a valid X-Bui-Signature on every delivery.",
      ),
  },
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
          `X-Bui-Signature: sha256=HMAC_SHA256(secret, rawBody).`,
      `When it fires, the event arrives in this session as a new turn.`,
    ].join("\n");
  },
});

export const list = tool({
  description:
    "List the inbound webhooks for THIS chat session (id, label, delivery URL, " +
    "last-delivered time, delivery count). Use when the user asks 'what webhooks " +
    "are set up?' or before deleting one. Never shows the signing secret.",
  args: {},
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
});

export const remove = tool({
  description:
    "Delete (revoke) an inbound webhook by its id. Get ids from the webhook_list " +
    "tool or the id returned when the webhook was created. Further POSTs to its " +
    "URL will 404 after this.",
  args: {
    id: z.string().describe("The 8-character webhook id to delete."),
  },
  async execute(args) {
    const result = await call("DELETE", `/api/webhook?id=${encodeURIComponent(args.id)}`);
    return result.deleted ? `Deleted webhook ${args.id}.` : `No webhook with id ${args.id}.`;
  },
});
