// MantaUI forge-rules tools — global opencode custom tools for authoring the
// box-side forge rules that turn an inbound forge webhook into an action.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/forge-rules.ts ~/.config/opencode/tools/forge-rules.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// (COPY, never symlink — the `@opencode-ai/plugin` import-resolution gotcha in
// docs/manta-tools-scheduler.md §"DO NOT symlink".)
//
// These tools are THIN registrars. They validate inputs and POST to
// manta-server (127.0.0.1:8787, same box — no SSH hop), which owns the rules
// store (src/server/forgeRules.mjs at ~/.manta/forge-rules/) and the shared
// validator (src/shared/forgeRules.mjs). The server also registers/updates the
// per-repo webhook on the forge and hot-reloads.
//
// A "rules file" is one YAML file per repo, box-side, AI-authored. See
// forge_rules_docs() for the full authoring guide.
//
// This is a copy of docs/opencode-tools/plugins.ts with the payload changed —
// the boxToken()/authHeaders()/call() helpers are copied VERBATIM so every
// call authenticates (a rewritten helper returns `unauthorized`). Resist
// rewriting the plumbing.

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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const forge_rules_save = tool({
  description: [
    "Write (or replace) the box-side forge rules for a repository. Validates the",
    "YAML against the shared rules validator, writes ~/.manta/forge-rules/",
    "<host>/<owner>/<repo>.yaml, registers or updates the per-repo webhook on",
    "the forge, and hot-reloads. Returns \"saved and valid\" on success, or the",
    "validator's errors VERBATIM with nothing written when the file is invalid.",
    "Rules live on the box (never in the repo) and are gated by one global",
    "toggle — call forge_rules_docs() for the grammar before authoring.",
  ].join(" "),
  args: {
    repo: z
      .string()
      .describe(
        "The canonical repository identity as host/owner/repo, e.g. \"github.com/anomalyco/manta\".",
      ),
    yaml: z
      .string()
      .describe(
        "Full rules YAML. Grammar: an `on:` block keyed by issue.labeled / checks.failed / review.requested, each with do: delegate | notify | inbox. See forge_rules_docs().",
      ),
  },
  async execute(args) {
    const r = await call("POST", "/api/forge-rules", {
      repo: args.repo,
      yaml: args.yaml,
    });
    if (r.ok !== true) {
      const errs: Array<{ path?: string; message: string }> = r.errors ?? [];
      if (errs.length > 0) {
        const lines = errs.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
        throw new Error(`forge rules for ${args.repo} rejected:\n${lines.join("\n")}`);
      }
      throw new Error(r.error || "forge-rules save failed");
    }
    const base = `Forge rules for ${args.repo} saved and valid.`;
    const wh = r.webhook;
    if (wh?.registered) {
      return `${base}\nWebhook registered at ${wh.url}.`;
    }
    if (wh?.error) {
      return `${base}\nRules saved, but the webhook was NOT registered: ${wh.error}`;
    }
    return base;
  },
});

export const forge_rules_get = tool({
  description: [
    "Return the current box-side forge rules source for a repository, for",
    "editing. Use before forge_rules_save when you need to extend the existing",
    "rules. Unknown repo → error.",
  ].join(" "),
  args: {
    repo: z
      .string()
      .describe("Repository identity as host/owner/repo, e.g. \"github.com/anomalyco/manta\"."),
  },
  async execute(args) {
    const r = await call("GET", `/api/forge-rules?repo=${encodeURIComponent(args.repo)}`);
    if (r.yaml === undefined) {
      throw new Error(`no rules stored for ${args.repo}`);
    }
    return `Forge rules for ${args.repo}:\n\n${r.yaml}`;
  },
});

export const forge_rules_list = tool({
  description: [
    "List every repository with box-side forge rules, INCLUDING invalid ones",
    "with their validation reason. A rules file that silently fails to load is",
    "far worse than one that loudly refuses. Use this to see what's configured",
    "and what's broken across repos.",
  ].join(" "),
  args: {},
  async execute() {
    const r = await call("GET", "/api/forge-rules");
    const rows: Array<{ repoKey: string; valid: boolean; error?: string }> = r.rules ?? [];
    if (rows.length === 0) {
      return [
        "No forge rules configured on the box.",
        "Use forge_rules_save({ repo, yaml }) to author the first one, or call forge_rules_docs() for the grammar.",
      ].join("\n");
    }
    return [
      "Forge rules on the box:",
      ...rows.map((row) =>
        row.valid
          ? `• ${row.repoKey} — valid`
          : `• ${row.repoKey} — INVALID: ${row.error ?? "unknown error"}`,
      ),
    ].join("\n");
  },
});

export const forge_rules_docs = tool({
  description: [
    "Return the full forge-rules authoring guide — the grammar (three verbs, no",
    "others), the allowed conditions, the placeholders, the box-side storage",
    "rationale, and the authoring loop. Reach for this whenever you are writing",
    "or editing a rules file, especially the first time.",
  ].join(" "),
  args: {},
  async execute() {
    const r = await call("GET", "/api/forge-rules/docs");
    return r.docs ?? "";
  },
});
