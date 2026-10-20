// V2 twin of docs/opencode-tools/secrets.ts → secrets_list / secrets_provide.
//
// THE GOLDEN RULE (why there is no secret_get): a secret leaks the instant its
// VALUE appears in the model's context. `secrets_list` returns names + hints
// only; `secrets_provide` writes the value to a 0600 file on the box and
// returns ONLY the path, to be used by reference ($(cat <path>)).

import { call } from "../lib/server.ts";
import { input, noInput, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "secrets_list",
    description: [
      "List the secrets the user has made available to THIS session (shared",
      "secrets + this session's own scoped secrets). Returns only secret NAMES,",
      "their scope, and an optional usage hint — NEVER the values. Use this to",
      "discover what credentials you can use (e.g. a github_pat). To actually use",
      "one, call secret_provide to get a file path, then reference it without",
      "printing it.",
    ].join(" "),
    input: noInput(),
    async execute(_args, context) {
      const params = new URLSearchParams();
      if (context.sessionID) params.set("sessionID", context.sessionID);
      if (context.directory) params.set("directory", context.directory);
      const result = await call("GET", `/api/secrets?${params.toString()}`);
      const secrets = result.secrets ?? [];
      if (secrets.length === 0) {
        return "No secrets are available to this session. Ask the user to add one in the manta Secrets card.";
      }
      return secrets
        .map((s: any) => {
          const where = s.scope === "project" ? `project:${s.project}` : s.scope; // shared | session | project:<name>
          return `• ${s.key} (${where})${s.hint ? ` — ${s.hint}` : ""}`;
        })
        .join("\n");
    },
  },
  {
    name: "secrets_provide",
    description: [
      "Make a stored secret usable WITHOUT exposing its value. manta writes the",
      "secret's value to a 0600 file on this box and returns ONLY the file path.",
      "Use the secret strictly BY REFERENCE — never cat/echo/print the file, never",
      "put the value in a message. Examples:",
      "  git push https://x-access-token:$(cat <path>)@github.com/owner/repo",
      '  curl -H "Authorization: Bearer $(cat <path>)" https://api.example.com',
      "The $(cat <path>) is expanded by the shell at run time; the value never",
      "appears in your output. Get the key name from secret_list.",
    ].join(" "),
    input: input({ key: str("The secret's name (key), as shown by secret_list.") }),
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
  },
];
