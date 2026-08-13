// Hand-written type declarations for forgeRules.mjs. The implementation is
// plain JS so server code imports it natively; TS consumers (the tests) import
// through the side-by-side .d.mts — TS maps `./forgeRules.mjs` to this file.
// Keep in sync with src/shared/forgeRules.mjs.

export type ForgeRuleVerb = "delegate" | "notify" | "inbox";

export type ForgeRuleEvent =
  | "issue.labeled"
  | "checks.failed"
  | "review.requested";

export type ForgeRule = {
  do: ForgeRuleVerb;
  label?: string;
  branch?: string;
  prompt?: string;
};

export type ForgeRules = {
  on: Partial<Record<ForgeRuleEvent, ForgeRule>>;
};

export type ForgeValidationError = { path: string; message: string };

export const RULE_EVENTS: ForgeRuleEvent[];
export const RULE_VERBS: ForgeRuleVerb[];
export const RULE_PLACEHOLDERS: Set<string>;

export function parseRules(
  yamlText: unknown,
): { ok: true; rules: ForgeRules; errors?: undefined } | { ok: false; errors: ForgeValidationError[]; rules?: undefined };

export function validateRules(parsed: unknown): { errors: ForgeValidationError[] };

export function matchRule(
  event: { type: string; label?: string; branch?: string; title?: string; url?: string } | null | undefined,
  rules?: ForgeRules | null,
): ForgeRule | null;

export function validateForgeRepoPath(repo: {
  host: unknown;
  owner: unknown;
  repo: unknown;
}): { ok: true } | { ok: false; error: string };
