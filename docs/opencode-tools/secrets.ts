// bui-native `secrets` tools — global opencode custom tools.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/secrets.ts ~/.config/opencode/tools/secrets.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// DO NOT symlink — opencode resolves a tool's imports relative to the file's
// REAL path, so a symlink back into the repo fails to find @opencode-ai/plugin.
//
// PURPOSE: let the user hand a secret (a GitHub PAT, an API key…) to THIS agent
// WITHOUT the value ever entering the transcript. The human stores the secret
// in the bui UI; the value lives only on the box. These tools are THIN
// registrars hitting manta-server (127.0.0.1:8787/api/secrets, same box, no SSH
// hop). See src/server/secrets.mjs.
//
// THE GOLDEN RULE (why there is no `secret_get`):
//   A secret leaks the instant its VALUE appears in your context — in a tool
//   result, in a command you type, or in command OUTPUT you read back. So:
//     - `secret_list`    returns only NAMES + hints, never values.
//     - `secret_provide` writes the value to a 0600 file on the box and returns
//        ONLY the file PATH. Use it BY REFERENCE — never `cat`/print it:
//          git push https://x-access-token:$(cat <path>)@github.com/owner/repo
//          curl -H "Authorization: Bearer $(cat <path>)" https://api...
//        The $(cat …) is substituted by the shell; the value is never echoed.
//   NEVER run `cat <path>` on its own, never echo the value, never paste it
//   into a message — that would defeat the entire point and leak the secret.

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

export const list = tool({
  description: [
    "List the secrets the user has made available to THIS session (shared",
    "secrets + this session's own scoped secrets). Returns only secret NAMES,",
    "their scope, and an optional usage hint — NEVER the values. Use this to",
    "discover what credentials you can use (e.g. a github_pat). To actually use",
    "one, call secret_provide to get a file path, then reference it without",
    "printing it.",
  ].join(" "),
  args: {},
  async execute(_args, context) {
    const params = new URLSearchParams();
    if (context.sessionID) params.set("sessionID", context.sessionID);
    if (context.directory) params.set("directory", context.directory);
    const result = await call("GET", `/api/secrets?${params.toString()}`);
    const secrets = result.secrets ?? [];
    if (secrets.length === 0) {
      return "No secrets are available to this session. Ask the user to add one in the bui Secrets card.";
    }
    return secrets
      .map((s: any) => {
        const where =
          s.scope === "project" ? `project:${s.project}` : s.scope; // shared | session | project:<name>
        return `• ${s.key} (${where})${s.hint ? ` — ${s.hint}` : ""}`;
      })
      .join("\n");
  },
});

export const provide = tool({
  description: [
    "Make a stored secret usable WITHOUT exposing its value. bui writes the",
    "secret's value to a 0600 file on this box and returns ONLY the file path.",
    "Use the secret strictly BY REFERENCE — never cat/echo/print the file, never",
    "put the value in a message. Examples:",
    "  git push https://x-access-token:$(cat <path>)@github.com/owner/repo",
    "  curl -H \"Authorization: Bearer $(cat <path>)\" https://api.example.com",
    "The $(cat <path>) is expanded by the shell at run time; the value never",
    "appears in your output. Get the key name from secret_list.",
  ].join(" "),
  args: {
    key: z.string().describe("The secret's name (key), as shown by secret_list."),
  },
  async execute(args, context) {
    const result = await call("POST", "/api/secrets/provide", {
      key: args.key,
      sessionID: context.sessionID,
      directory: context.directory,
    });
    const hint = result.hint ? `\nHint: ${result.hint}` : "";
    return [
      `Secret "${result.key}" is available at:`,
      `  ${result.path}`,
      "Use it BY REFERENCE only, e.g. $(cat " + result.path + ") inside a command.",
      "Do NOT cat, echo, or print this file on its own — that would leak the secret.",
      hint,
    ]
      .filter(Boolean)
      .join("\n");
  },
});
