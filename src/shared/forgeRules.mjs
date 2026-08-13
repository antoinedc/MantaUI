// forgeRules.mjs — the L1 rules grammar for the MantaUI forge event loop
// (BET-797).
//
// One rule file per repo. The file is AUTHORED BY A TOOL (the forge_rules
// opencode tool), lives on the BOX at ~/.manta/forge-rules/<host>/<owner>/<repo>.yaml,
// and never travels with the repository — nothing a PR can edit changes what
// runs on a user's machine (design spec §5.1 / §5.2).
//
// This module is the SINGLE source of truth for what a valid rules file looks
// like — imported by the tool (docs/opencode-tools/forge-rules.ts) via the
// server's /api/forge-rules route, by the server's registry
// (src/server/forgeRules.mjs), and by the tests. Never a second copy. It is
// deliberately modelled on src/shared/pluginManifest.mjs: exported constants,
// exported pure functions, unknown keys rejected loudly by name, structured
// {path, message} errors the caller can display verbatim.
//
// Grammar, complete — one `on:` block, three verbs, nothing else:
//
//   on:
//     issue.labeled:
//       label: manta
//       do: delegate
//       prompt: "Complete {{url}}. Open a draft PR."
//     checks.failed:
//       branch: mine
//       do: notify
//     review.requested:
//       do: inbox
//
// Contract (design spec §5.1):
//   - 100% pure. No fs, no fetch, no spawn. The only global used is nothing —
//     pure string/YAML work, fully unit-testable.
//   - Named exports only. No default export, matching the rest of src/shared/.
//   - Unknown keys fail validation with `unknown key "<key>"`, exactly as the
//     plugin validator does — typo protection matters more than flexibility in
//     a file that can start an agent.
//   - Three verbs — delegate, notify, inbox. No others. No expressions, no
//     scripting, no shell, no interpolation beyond the fixed `{{url}}` and
//     `{{title}}` placeholders.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Grammar constants
// ---------------------------------------------------------------------------

// The three forge events a rule can key off. Adding a fourth is a MantaUI
// design change (the adapter + ingest must understand it), not a rules change.
export const RULE_EVENTS = ["issue.labeled", "checks.failed", "review.requested"];
export const RULE_EVENT_SET = new Set(RULE_EVENTS);

// The three verbs. `do` on an event entry must be one of these.
export const RULE_VERBS = ["delegate", "notify", "inbox"];
export const RULE_VERB_SET = new Set(RULE_VERBS);

// Condition keys per event. `do` is required on every event; any other key is
// an error so a typo'd `lable:` doesn't silently become a rule that never
// matches. `prompt` is only meaningful on a `delegate` event.
const EVENT_KEYS = Object.freeze({
  "issue.labeled": new Set(["do", "label", "prompt"]),
  "checks.failed": new Set(["do", "branch"]),
  "review.requested": new Set(["do"]),
});

// The ONLY placeholders a `prompt` may contain. Anything else `{{…}}` is
// rejected — no interpolation beyond these two fixed slots.
export const RULE_PLACEHOLDERS = new Set(["{{url}}", "{{title}}"]);
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

// Safe single path component for the box-side rules store. The rules live at
// ~/.manta/forge-rules/<host>/<owner>/<repo>.yaml, so a crafted repo name must
// not escape the directory. Modelled on the plugin name regex
// (^[a-z0-9][a-z0-9-]{0,62}$) and generalised ONLY to preserve the dot in a
// host/owner segment (github.com, anomalyco). Forbids leading/trailing dots
// (so "." and ".." are rejected), slashes, whitespace and any other char.
const SAFE_COMPONENT_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// parseRules — YAML text → { ok, rules, errors[] }
// ---------------------------------------------------------------------------

/**
 * Parse + validate a forge rules YAML string. Returns either `{ok:true,
 * rules:<object>}` or `{ok:false, errors:[{path, message}]}` describing every
 * validation failure (no short-circuit — the author wants to fix them all).
 *
 * Valid `rules` shape:
 *   { on: { "<event>": { do, label?, branch?, prompt? }, ... } }
 *
 * A bare `on: {}` (a file with no rules yet) is valid — it parses, matches
 * nothing, and lets the file serve as an editable shell.
 */
export function parseRules(yamlText) {
  const errors = [];
  if (typeof yamlText !== "string") {
    return {
      ok: false,
      rules: undefined,
      errors: [{ path: "", message: "rules must be a string" }],
    };
  }
  let raw;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return {
      ok: false,
      rules: undefined,
      errors: [{ path: "", message: `yaml parse: ${e?.message ?? String(e)}` }],
    };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      rules: undefined,
      errors: [{ path: "", message: "rules must be a mapping" }],
    };
  }

  // `on` is required and must be a mapping.
  const on = raw.on;
  if (on == null || typeof on !== "object" || Array.isArray(on)) {
    return {
      ok: false,
      rules: undefined,
      errors: [{ path: "on", message: "on must be a mapping" }],
    };
  }

  // Reject unknown TOP-LEVEL keys so a stray `off:` next to `on:` fails loudly.
  for (const k of Object.keys(raw)) {
    if (k !== "on") {
      errors.push({ path: k, message: `unknown key "${k}"` });
    }
  }

  const validated = {};
  for (const [eventName, entry] of Object.entries(on)) {
    const base = `on.${eventName}`;
    if (!RULE_EVENT_SET.has(eventName)) {
      errors.push({
        path: base,
        message: `unknown key "${eventName}"`,
      });
      continue;
    }
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ path: base, message: "rule must be a mapping" });
      continue;
    }
    const allowed = EVENT_KEYS[eventName];
    for (const k of Object.keys(entry)) {
      if (!allowed.has(k)) {
        errors.push({ path: `${base}.${k}`, message: `unknown key "${k}"` });
      }
    }

    // do — required verb.
    if (typeof entry.do !== "string" || !entry.do) {
      errors.push({ path: `${base}.do`, message: "do is required" });
    } else if (!RULE_VERB_SET.has(entry.do)) {
      errors.push({
        path: `${base}.do`,
        message: `do: must be one of ${RULE_VERBS.join(", ")}`,
      });
    }

    // label (issue.labeled condition) — non-empty string.
    if (entry.label !== undefined) {
      if (typeof entry.label !== "string" || !entry.label.trim()) {
        errors.push({ path: `${base}.label`, message: "label must be a non-empty string" });
      }
    }

    // branch (checks.failed condition) — non-empty string.
    if (entry.branch !== undefined) {
      if (typeof entry.branch !== "string" || !entry.branch.trim()) {
        errors.push({ path: `${base}.branch`, message: "branch must be a non-empty string" });
      }
    }

    // prompt — only on a `delegate` event; must only use the fixed
    // placeholders (no expressions, no shell, nothing else).
    if (entry.prompt !== undefined) {
      if (entry.do !== "delegate") {
        errors.push({
          path: `${base}.prompt`,
          message: "prompt is only allowed on a delegate rule",
        });
      } else if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
        errors.push({ path: `${base}.prompt`, message: "prompt must be a non-empty string" });
      } else {
        for (const m of entry.prompt.match(PLACEHOLDER_RE) ?? []) {
          if (!RULE_PLACEHOLDERS.has(m)) {
            errors.push({
              path: `${base}.prompt`,
              message: `prompt: unsupported placeholder ${JSON.stringify(m)} (only {{url}} and {{title}})`,
            });
          }
        }
      }
    }

    validated[eventName] = {
      do: entry.do,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
    };
  }

  if (errors.length > 0) return { ok: false, rules: undefined, errors };
  return { ok: true, rules: { on: validated }, errors: undefined };
}

// ---------------------------------------------------------------------------
// validateRules — full validation, accepting an already-parsed object
//
// Mirrors pluginManifest.validateManifest: round-trips through YAML so there
// is a single validation pipeline. Useful for the server registry when it
// holds an already-parsed structure.
// ---------------------------------------------------------------------------

export function validateRules(parsed) {
  if (parsed == null || typeof parsed !== "object") {
    return { errors: [{ path: "", message: "rules must be an object" }] };
  }
  try {
    const result = parseRules(stringifyYaml(parsed));
    return { errors: result.errors ?? [] };
  } catch (e) {
    return { errors: [{ path: "", message: e?.message ?? String(e) }] };
  }
}

// ---------------------------------------------------------------------------
// matchRule — pick the rule that fires for an event
//
// Pure. `event` is a NORMALISED forge event: { type, label?, branch?, title?,
// url? }. Returns the matching rule's config (`{do, label?, branch?, prompt?}`)
// or `null` when nothing matches (no rule for the type, or a condition fails).
//
// Conditions are conjunctive: a rule with `label:` matches only when the event
// carries that exact label; a rule with `branch:` matches only when the event
// carries that exact branch. A rule with no condition matches its event type.
// ---------------------------------------------------------------------------

export function matchRule(event, rules) {
  if (event == null || typeof event !== "object") return null;
  const type = event.type;
  if (typeof type !== "string") return null;
  const config = rules?.on?.[type];
  if (config == null || typeof config !== "object") return null;
  if (config.label !== undefined && config.label !== event.label) return null;
  if (config.branch !== undefined && config.branch !== event.branch) return null;
  return config;
}

// ---------------------------------------------------------------------------
// rulesPath — validate the <host>/<owner>/<repo> store path components
//
// The rules file lives at ~/.manta/forge-rules/<host>/<owner>/<repo>.yaml. The
// components are user/forge-controlled, so a crafted repo name must not be
// able to escape the directory. Each component is validated against a safe
// token class (the plugin name regex, generalised to preserve dots in a
// host/owner). `owner` may carry GitLab subgroup slashes — every segment is
// validated individually, and `.` / `..` are rejected outright.
// ---------------------------------------------------------------------------

/**
 * Validate host/owner/repo as safe path components for the rules store.
 * Returns `{ok:true}` or `{ok:false, error}`. Pure — the caller builds the
 * actual path with statePath() after this passes.
 *
 * @param {{host: unknown, owner: unknown, repo: unknown}} repo
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateForgeRepoPath({ host, owner, repo }) {
  if (typeof host !== "string" || !host) {
    return { ok: false, error: "host is required" };
  }
  if (typeof owner !== "string" || !owner) {
    return { ok: false, error: "owner is required" };
  }
  if (typeof repo !== "string" || !repo) {
    return { ok: false, error: "repo is required" };
  }
  const hostErr = checkComponents(host, "host");
  if (hostErr) return { ok: false, error: hostErr };
  const ownerErr = checkComponents(owner, "owner");
  if (ownerErr) return { ok: false, error: ownerErr };
  const repoErr = checkComponents(repo, "repo");
  if (repoErr) return { ok: false, error: repoErr };
  return { ok: true };
}

// Validate a path component (host, repo, or one segment of a subgroup owner).
// Returns an error string or null when safe.
function checkComponents(value, label) {
  for (const seg of value.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return `${label}: component ${JSON.stringify(seg)} is not allowed`;
    }
    if (!SAFE_COMPONENT_RE.test(seg)) {
      return `${label}: component ${JSON.stringify(seg)} contains unsafe characters`;
    }
  }
  return null;
}
