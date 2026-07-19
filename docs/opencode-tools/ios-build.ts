// MantaUI plugin tool: ios-build — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp docs/opencode-tools/ios-build.ts ~/.config/opencode/tools/ios-build.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// (CPY, never symlink — the `@opencode-ai/plugin` import-resolution gotcha in
// docs/bui-tools-scheduler.md §"DO NOT symlink".)
//
// This tool is a THIN registrar. It validates the request and POSTs it to
// manta-server (127.0.0.1:8787, same box — no SSH hop), which owns the durable
// job queue (src/server/capabilities.mjs). The tool does NOT block on the build;
// execute() returns immediately with the job id, and a completion turn is
// injected back into this session when the Mac executor finishes (or the
// server-side sweep times it out).
//
// First plugin of the MantaUI plugin system (docs/mantaui-plugins.md). The
// queue speaks the GENERIC {capability, input, host} envelope; the ONLY
// iOS-specific bits here are the "ios.build" capability id and host:"mac".

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

export const ios_build = tool({
  description: [
    "Compile the MantaUI iOS app on the connected Mac and boot it in the iOS",
    "Simulator. Use when the user asks to build/run/test the iOS app locally",
    "instead of on Codemagic. IMPORTANT — what gets built: the Mac's own git",
    "clone (tracking origin/main), NOT this session's working tree or branch.",
    "If the user wants their current changes built, they must be merged/pushed",
    "to origin/main first, then call with pull:true. The Mac must be awake",
    "with the MantaUI app running and the capability executor enabled in",
    "Settings. Returns a job id immediately. Do NOT poll in a loop: when the",
    "job finishes (or fails/times out), a completion message is injected into",
    "this session automatically as a new turn. Use ios_build_status only if",
    "the user asks for progress mid-build.",
  ].join(" "),
  args: {
    action: z
      .enum(["build-and-launch", "test", "compile-only"])
      .optional()
      .describe(
        "build-and-launch (default): compile + boot simulator + launch app; " +
          "test: run xcodebuild test; " +
          "compile-only: just compile, no simulator.",
      ),
    pull: z
      .boolean()
      .optional()
      .describe(
        "Run `git pull --ff-only origin main` in the Mac clone before " +
          "building (default false).",
      ),
  },
  async execute(args, context) {
    const r = await call("POST", "/api/cap", {
      capability: "ios.build",
      host: "mac",
      input: { action: args.action ?? "build-and-launch", pull: !!args.pull },
      sessionID: context.sessionID,
      directory: context.directory,
    });
    return `iOS build queued on the Mac (job ${r.id}). You will be notified in this session when it finishes — do not poll.`;
  },
});

export const ios_build_status = tool({
  description:
    "Check an iOS build job: status (queued/running/done/failed) + the tail of " +
    "the build log. Use the job id returned by ios_build. Prefer waiting for " +
    "the automatic completion message; use this only for mid-build progress " +
    "or after completion to inspect the log.",
  args: { id: z.string().describe("The job id from ios_build.") },
  async execute(args) {
    const j = await call("GET", `/api/cap/${encodeURIComponent(args.id)}`);
    const tail = (j.log?.join("") ?? "").split("\n").slice(-50).join("\n");
    const head =
      `Job ${j.id} (${j.capability}) — ${j.status}` +
      (j.error ? ` — ${j.error}` : "");
    return tail ? `${head}\n\n--- log tail ---\n${tail}` : head;
  },
});
