// manta-native `progress_report` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/progress.ts ~/.config/opencode/tools/progress.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar. It POSTs a durable, session-scoped progress
// record to manta-server (127.0.0.1:8787, same box — no SSH hop), which stores
// it replace-never-append and publishes a progress.updated bus event.
// execute() returns promptly; no long-lived work. See src/server/progress.mjs
// and the design spec §6.1-6.3.
//
// THE DESCRIPTION IS LOAD-BEARING AND ANTI-REFLEX. A model handed a progress
// tool will call it constantly and turn it into narration; the description
// deliberately forbids that. Do not soften it.

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

export const progress_report = tool({
  description: [
    "Report at **plan boundaries**, not per action. Each call **replaces** the",
    "previous state — this is a status, not a log. Do not call more than roughly",
    "once a minute. This does NOT notify the user; use `notify` for that. Set",
    "`state:\"blocked\"` only when you have genuinely stopped and need a human",
    "decision.",
  ].join(" "),
  args: {
    label: z
      .string()
      .optional()
      .describe("A one-line, in your own words description of where you are now (e.g. \"step 3 of 5: wiring the REST handler\")."),
    step: z
      .number()
      .optional()
      .describe("The current step (1-based). Monotonic: a lower value than the last report is clamped."),
    total: z
      .number()
      .optional()
      .describe("Total steps in the plan. May change freely as the plan evolves."),
    state: z
      .enum(["working", "blocked", "done", "failed"])
      .optional()
      .describe("working = in progress; blocked = you have stopped and need a human decision; done/failed = finished."),
    detail: z
      .string()
      .optional()
      .describe("Optional free-form detail (obstacle, what's next, etc.)."),
    sinks: z
      .array(z.enum(["ui"]))
      .optional()
      .describe("Where to send the progress signal. Only \"ui\" is implemented; unknown sinks are ignored."),
  },
  async execute(args, context) {
    const body: Record<string, unknown> = { sessionID: context.sessionID };
    if (args.label !== undefined) body.label = args.label;
    if (args.step !== undefined) body.step = args.step;
    if (args.total !== undefined) body.total = args.total;
    if (args.state !== undefined) body.state = args.state;
    if (args.detail !== undefined) body.detail = args.detail;
    if (args.sinks !== undefined) body.sinks = args.sinks;
    const result = await call("POST", "/api/progress", body);
    return result?.ok ? "Progress recorded." : "Progress failed to record.";
  },
});
