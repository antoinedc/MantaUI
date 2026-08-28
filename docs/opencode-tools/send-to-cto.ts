// manta-native `send_to_cto` tool — global opencode custom tool (BET-1165).
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/send-to-cto.ts ~/.config/opencode/tools/send-to-cto.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// A copy, never a symlink — opencode resolves a tool's imports relative to the
// file's REAL path, so a symlink back into the repo (no node_modules) fails
// with `Cannot find module '@opencode-ai/plugin'` and the tool silently never
// registers.
//
// PURPOSE: let ANY session report something to the on-call CTO. This is a THIN
// registrar: `execute` POSTs `{surface:"session", sessionID, kind?, message,
// refs?, tag?, title?}` to manta-server's /api/cto/inbound (same box, no SSH
// hop) and returns immediately. manta-server owns the routing (dedupe +
// live-vs-parked + the inbox store, spec §4.4), NOT this tool. See
// src/server/cto.mjs (createCtoInbound).
//
// BET-1397 supersession: the note lands in the durable CTR inbox (sender
// identity, dedupe by tag, kind, TTL); a bare {message} maps to `blocker`.
// Only `blocker` kinds fire the immediate blocking-tier notification. When no
// "call is live" flag is set (this issue), the note persists to the inbox and
// the CTO reads it via the `read_inbox` verb.

import { tool } from "@opencode-ai/plugin";
import { boxToken, authHeaders } from "./manta-auth";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// manta-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as manta-server, so they read the token straight from the server's
// own auth store (~/.manta/auth.json, 0600). Re-read on every call (one
// tiny local file) so a token rotation never requires an opencode-serve
// restart. MANTA_BOX_TOKEN env overrides for tests/dev.

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
    "Report a note to the on-call CTO. Any session can call this: it appends a",
    "note to the durable CTO inbox (the CTO reads it via the read_inbox verb).",
    "One verb, one routing rule: a bare {message} is treated as a blocker and",
    "fires the immediate blocking-tier notification the same way a question",
    "waiting does; a non-blocker kind is silent — it sits in the inbox until the",
    "CTO drains it. You should give the message some context (what happened, why",
    "it matters), and pass refs (a new P0 issue, a blocker, a failing check) so",
    "the CTO can jump to it. This supersedes every earlier send_to_cto spelling.",
  ].join(" "),
  args: {
    message: z
      .string()
      .describe("What to report. Be concrete: the fact, the impact, what the CTO should know."),
    kind: z
      .enum(["fyi", "finding", "blocker", "handoff", "anomaly"])
      .optional()
      .describe(
        "The note's kind. Default (and bare {message}) is `blocker`, which is the only " +
          "kind that fires the immediate blocking-tier notification. fyi/finding/handoff/" +
          "anomaly are silent — they land in the inbox unread and surface via read_inbox.",
      ),
    refs: z
      .array(z.string())
      .optional()
      .describe("Optional refs for the note — issue/PR keys, check names, surface ids — so the CTO can jump to them."),
    tag: z
      .string()
      .optional()
      .describe(
        "Optional dedupe tag: two notes with the same tag coalesce into one inbox entry " +
          "(refs union, timestamp refreshed, count bumped) instead of creating a duplicate.",
      ),
    title: z
      .string()
      .optional()
      .describe("Optional short title for the surfaced notification. Defaults to the sender's session label."),
  },
  async execute(args, context) {
    const result = await call("POST", "/api/cto/inbound", {
      surface: "session",
      sessionID: context.sessionID,
      kind: args.kind,
      message: args.message,
      refs: args.refs,
      tag: args.tag,
      title: args.title,
    });
    const blocker = result.parked && args.kind !== "fyi" && args.kind !== "finding" &&
      args.kind !== "handoff" && args.kind !== "anomaly" && (args.kind === "blocker" || !args.kind);
    return blocker
      ? "Flagged to the CTO as a blocker (immediate notification + inbox note)."
      : "Reported to the CTO inbox (silent — surfaces via read_inbox).";
  },
});
