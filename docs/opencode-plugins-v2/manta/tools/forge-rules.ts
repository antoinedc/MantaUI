// V2 twin of docs/opencode-tools/forge-rules.ts → forge_rules_save /
// forge_rules_get / forge_rules_list / forge_rules_docs. Thin registrars over
// /api/forge-rules (manta-server owns the box-side rules store + validator).

import { call } from "../lib/server.ts";
import { input, noInput, str } from "../lib/schema.ts";
import type { ToolDef } from "../lib/types.ts";

export const tools: ToolDef[] = [
  {
    name: "forge_rules_save",
    description: [
      "Write (or replace) the box-side forge rules for a repository. Validates the",
      "YAML against the shared rules validator, writes ~/.manta/forge-rules/",
      "<host>/<owner>/<repo>.yaml, registers or updates the per-repo webhook on",
      'the forge, and hot-reloads. Returns "saved and valid" on success, or the',
      "validator's errors VERBATIM with nothing written when the file is invalid.",
      "Rules live on the box (never in the repo) and are gated by one global",
      "toggle — call forge_rules_docs() for the grammar before authoring.",
    ].join(" "),
    input: input({
      repo: str(
        'The canonical repository identity as host/owner/repo, e.g. "github.com/anomalyco/manta".',
      ),
      yaml: str(
        "Full rules YAML. Grammar: an `on:` block keyed by issue.labeled / checks.failed / review.requested, each with do: delegate | notify | inbox. See forge_rules_docs().",
      ),
    }),
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
  },
  {
    name: "forge_rules_get",
    description: [
      "Return the current box-side forge rules source for a repository, for",
      "editing. Use before forge_rules_save when you need to extend the existing",
      "rules. Unknown repo → error.",
    ].join(" "),
    input: input({
      repo: str('Repository identity as host/owner/repo, e.g. "github.com/anomalyco/manta".'),
    }),
    async execute(args) {
      const r = await call("GET", `/api/forge-rules?repo=${encodeURIComponent(args.repo)}`);
      if (r.yaml === undefined) {
        throw new Error(`no rules stored for ${args.repo}`);
      }
      return `Forge rules for ${args.repo}:\n\n${r.yaml}`;
    },
  },
  {
    name: "forge_rules_list",
    description: [
      "List every repository with box-side forge rules, INCLUDING invalid ones",
      "with their validation reason. A rules file that silently fails to load is",
      "far worse than one that loudly refuses. Use this to see what's configured",
      "and what's broken across repos.",
    ].join(" "),
    input: noInput(),
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
  },
  {
    name: "forge_rules_docs",
    description: [
      "Return the full forge-rules authoring guide — the grammar (three verbs, no",
      "others), the allowed conditions, the placeholders, the box-side storage",
      "rationale, and the authoring loop. Reach for this whenever you are writing",
      "or editing a rules file, especially the first time.",
    ].join(" "),
    input: noInput(),
    async execute() {
      const r = await call("GET", "/api/forge-rules/docs");
      return r.docs ?? "";
    },
  },
];
