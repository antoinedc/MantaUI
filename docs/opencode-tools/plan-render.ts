// manta-native `plan_render` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/plan-render.ts ~/.config/opencode/tools/plan-render.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// This tool is a THIN registrar (same contract as the other MantaUI tools). It
// POSTs the authored plan HTML bundle path to manta-server
// (127.0.0.1:8787, same box — no SSH hop), which renders and publishes the
// plan page through the existing serve-page subsystem. execute() must return
// promptly — no long-running work.

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

export const plan_render = tool({
  description: [
    "Publish the single-HTML plan bundle the plan agent authored: given the",
    "path to the plan HTML file, render it into a standalone plan page and",
    "return its public URL. The path must be inside the session's own",
    "directory (it is resolved and confined there). Call this AFTER writing",
    "the authored plan HTML bundle; the returned URL is the shareable plan",
    "page. Then invoke the plan_exit tool separately afterwards to complete",
    "the plan.",
  ].join(" "),
  args: {
    file: z
      .string()
      .describe(
        "Absolute (or session-relative) path to the authored plan HTML bundle. " +
          "Must resolve to a path inside the session directory.",
      ),
  },
  async execute(args, context) {
    const result = await call("POST", "/api/plan-render", {
      sessionID: context.sessionID,
      file: args.file,
    });
    return `Plan page published at ${result.url}`;
  },
});
