// pluginManifest.mjs — pure YAML-manifest core for MantaUI plugins.
//
// Consumed by BOTH the executor (src/main/capExecutor.ts, the Mac-side runner
// that reads manifests off disk) AND the server (src/server/plugins.mjs, the
// in-memory registry the renderer reads). Single source of truth for what a
// valid manifest looks like — adding a new validation rule here is reflected
// in every consumer and every test.
//
// Design contract (BET-189 / BET-190):
//   - Minimal deps: YAML parser + node:fs (only for resolveCwd existence
//     check). Pure functions everywhere else, no fs / spawn / electron —
//     testable in vitest without a Mac, no Electron needed.
//   - Every public function returns structured data. Errors are arrays of
//     {path, message} strings the caller can display verbatim; success
//     paths are plain JS objects/values. No exceptions thrown for expected
//     validation failures — the caller always wants the structured error.
//   - Unknown top-level keys + unknown per-step keys are errors. A typo
//     like `step[2].rnu` should NOT silently fall through to "no steps" —
//     the user gets a clear `unknown key "rnu"` at `steps[2].rnu`.
//
// Validation rules implemented (BET-189 §"Validation rules"):
//   - name         — `^[a-z0-9][a-z0-9-]{0,62}$` (one token, kebab-friendly)
//   - description  — non-empty
//   - host         — must be "mac" (else `host: only "mac" is supported`)
//   - inputs[]     — `id` regex `^[a-z][a-zA-Z0-9_]*$`; each input needs a
//                    non-empty `description`; `values` array ONLY when
//                    `type: enum`; `default` value type-matches the declared
//                    type.
//   - timeout      — `^\d+(s|m)$`, parsed ≤ 30 minutes (else
//                    `timeout: must be ≤ 30m`); missing = no per-step cap.
//   - env          — `Record<string,string>`; leading `~` expanded against
//                    `os.homedir()` by buildEnv, not here.
//   - steps[]      — `{name?, run, cwd?, env?, timeout?, if?, continue_on_error?}`
//                    — `run` required; unknown keys error.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Regex / constants
// ---------------------------------------------------------------------------

// Kebab-friendly plugin name (single token, no path separators, no
// whitespace). Capped at 63 chars so a manifest named `foo.yaml` always
// leaves room under typical fs name limits when joined with prefixes.
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// JS-identifier-ish input id: starts lowercase, then alnum + underscore. The
// renderer surfaces `inputs.<id>` in `if:` expressions, so the id MUST be
// safe to embed in a YAML/JavaScript context.
export const INPUT_ID_RE = /^[a-z][a-zA-Z0-9_]*$/;

// `^\d+(s|m)$` — no decimals, no whitespace. Parsed by parseTimeout below.
const TIMEOUT_RE = /^\d+(s|m)$/;

// Hard cap on a plugin's timeout. The Mac executor's own 25-min job timeout
// is below this on purpose (BET-183), but a plugin that runs forever would
// still wedge a single job. Cap so a typo can't make a step run for days.
const MAX_TIMEOUT_MS = 30 * 60_000;

// Whitelisted step keys. Anything else is an error so a typo like `steps[2].rnu`
// fails loudly instead of silently doing nothing.
const STEP_KEYS = new Set([
  "name",
  "run",
  "cwd",
  "env",
  "timeout",
  "if",
  "continue_on_error",
]);

// Top-level whitelisted keys.
const TOP_KEYS = new Set([
  "name",
  "description",
  "host",
  "inputs",
  "env",
  "timeout",
  "steps",
]);

// Supported input types.
export const INPUT_TYPES = ["string", "number", "boolean", "enum"];

// Reserved env names we never let a plugin clobber. `MANTA_PLUGIN` and
// `MANTA_JOB_ID` carry the executor's plumbing — if a user-supplied `env:`
// could overwrite them, the executor's own context would silently leak.
// Other MANTA_INPUT_<ID> is the user-supplied input namespace, so we don't
// reserve it generically; the user's own input IDs go there.
const RESERVED_ENV = new Set([
  "MANTA_PLUGIN",
  "MANTA_JOB_ID",
]);

// ---------------------------------------------------------------------------
// parseManifest — YAML text → { manifest | errors[] }
// ---------------------------------------------------------------------------

/**
 * Parse a YAML plugin manifest string. Returns either `{manifest: <object>}`
 * with the validated parsed structure (defaults filled in for optional keys),
 * or `{errors: [{path, message}]}` describing every validation failure
 * encountered (no short-circuit — the user wants to see them all).
 *
 * The manifest shape is:
 *   name:          string (required, matches NAME_RE)
 *   description:   string (required, non-empty)
 *   host:          "mac" (only allowed value today)
 *   inputs:        Array<{id, description, type, [default], [values]}>
 *   env:           Record<string,string>
 *   timeout:       string (parsed eagerly; absent = no per-step timeout)
 *   steps:         Array<{name?, run, cwd?, env?, timeout?, if?, continue_on_error?}>
 */
export function parseManifest(yamlText) {
  const errors = [];
  if (typeof yamlText !== "string") {
    return {
      ok: false,
      manifest: undefined,
      errors: [{ path: "", message: "manifest must be a string" }],
    };
  }
  let raw;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return {
      ok: false,
      manifest: undefined,
      errors: [{ path: "", message: `yaml parse: ${e?.message ?? String(e)}` }],
    };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      manifest: undefined,
      errors: [{ path: "", message: "manifest must be a mapping" }],
    };
  }

  // Reject unknown top-level keys up front so the user sees them in
  // context, not buried after the standard checks.
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.has(k)) {
      errors.push({ path: k, message: `unknown key "${k}"` });
    }
  }

  // name
  if (typeof raw.name !== "string" || !raw.name) {
    errors.push({ path: "name", message: "name is required" });
  } else if (!NAME_RE.test(raw.name)) {
    errors.push({
      path: "name",
      message: `name: must match ${NAME_RE.source}`,
    });
  }

  // description
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    errors.push({ path: "description", message: "description is required" });
  }

  // host — only "mac" is supported today.
  if (raw.host !== undefined && raw.host !== "mac") {
    errors.push({
      path: "host",
      message: 'host: only "mac" is supported',
    });
  }

  // inputs[]
  const inputs = [];
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs)) {
      errors.push({ path: "inputs", message: "inputs must be an array" });
    } else {
      const seenIds = new Set();
      raw.inputs.forEach((inp, i) => {
        const base = `inputs[${i}]`;
        if (inp == null || typeof inp !== "object" || Array.isArray(inp)) {
          errors.push({ path: base, message: "input must be a mapping" });
          return;
        }
        // id
        if (typeof inp.id !== "string" || !inp.id) {
          errors.push({ path: `${base}.id`, message: "id is required" });
        } else if (!INPUT_ID_RE.test(inp.id)) {
          errors.push({
            path: `${base}.id`,
            message: `id: must match ${INPUT_ID_RE.source}`,
          });
        } else if (seenIds.has(inp.id)) {
          errors.push({
            path: `${base}.id`,
            message: `duplicate input id "${inp.id}"`,
          });
        } else {
          seenIds.add(inp.id);
        }
        // description
        if (typeof inp.description !== "string" || !inp.description.trim()) {
          errors.push({
            path: `${base}.description`,
            message: "description is required",
          });
        }
        // type
        if (!INPUT_TYPES.includes(inp.type)) {
          errors.push({
            path: `${base}.type`,
            message: `type: must be one of ${INPUT_TYPES.join(", ")}`,
          });
        }
        // values iff type:enum
        if (inp.type === "enum") {
          if (!Array.isArray(inp.values) || inp.values.length === 0) {
            errors.push({
              path: `${base}.values`,
              message: "values is required for type:enum",
            });
          } else if (!inp.values.every((v) => typeof v === "string")) {
            errors.push({
              path: `${base}.values`,
              message: "values must be an array of strings",
            });
          }
        } else if (inp.values !== undefined) {
          errors.push({
            path: `${base}.values`,
            message: "values is only allowed for type:enum",
          });
        }
        // default type-matches
        if (inp.default !== undefined) {
          const err = checkDefaultTypeMatches(inp.default, inp.type, inp.values);
          if (err) errors.push({ path: `${base}.default`, message: err });
        }
        // timeout — disallowed on inputs (it's a step-level concept only)
        if (inp.timeout !== undefined) {
          errors.push({
            path: `${base}.timeout`,
            message: "timeout is not allowed on inputs",
          });
        }
        inputs.push({
          id: inp.id,
          description: inp.description,
          type: inp.type,
          default: inp.default,
          values: Array.isArray(inp.values) ? inp.values : undefined,
        });
      });
    }
  }

  // env map
  let env = {};
  if (raw.env !== undefined) {
    if (raw.env == null || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      errors.push({ path: "env", message: "env must be a mapping" });
    } else {
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v !== "string") {
          errors.push({
            path: `env.${k}`,
            message: "env values must be strings",
          });
        }
        if (RESERVED_ENV.has(k)) {
          errors.push({
            path: `env.${k}`,
            message: `env.${k} is reserved`,
          });
        }
      }
      env = raw.env;
    }
  }

  // top-level timeout (parsed eagerly so the error path is consistent)
  let topTimeoutMs = null;
  if (raw.timeout !== undefined) {
    const t = parseTimeout(raw.timeout);
    if (typeof t === "number") {
      topTimeoutMs = t;
    } else {
      errors.push({ path: "timeout", message: t.error });
    }
  }

  // steps[]
  const steps = [];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) {
      errors.push({ path: "steps", message: "steps must be an array" });
    } else if (raw.steps.length === 0) {
      errors.push({ path: "steps", message: "steps: at least one step is required" });
    } else {
      raw.steps.forEach((step, i) => {
        const base = `steps[${i}]`;
        if (step == null || typeof step !== "object" || Array.isArray(step)) {
          errors.push({ path: base, message: "step must be a mapping" });
          return;
        }
        for (const k of Object.keys(step)) {
          if (!STEP_KEYS.has(k)) {
            errors.push({ path: `${base}.${k}`, message: `unknown key "${k}"` });
          }
        }
        if (typeof step.run !== "string" || !step.run.trim()) {
          errors.push({ path: `${base}.run`, message: "run is required" });
        }
        // step.timeout
        if (step.timeout !== undefined) {
          const t = parseTimeout(step.timeout);
          if (typeof t !== "number") {
            errors.push({ path: `${base}.timeout`, message: t.error });
          }
        }
        // step.if — strict shape check at parse time (BET-189 §"`if:`
        // expression language" — three forms only, no `${{ }}`, no
        // operators, no whitespace in RHS). evalIf does the runtime
        // truthiness check at execution time; parseManifest just enforces
        // the SHAPE so a typo'd `${{ }}` doesn't silently become a step
        // that always runs. RHS must be a single whitespace-free literal,
        // NOT empty (`inputs.x ==` is malformed here, not "false-y").
        if (step.if !== undefined) {
          if (typeof step.if !== "string" || !step.if.trim()) {
            errors.push({ path: `${base}.if`, message: "if must be a string" });
          } else if (
            !/^inputs\.[a-z][a-zA-Z0-9_]*(\s+(==|!=)\s+\S+)?$/.test(step.if)
          ) {
            errors.push({
              path: `${base}.if`,
              message:
                "if: must be inputs.<id> or inputs.<id> == <token> or inputs.<id> != <token>",
            });
          }
        }
        // step.env — string map
        if (step.env !== undefined) {
          if (
            step.env == null ||
            typeof step.env !== "object" ||
            Array.isArray(step.env)
          ) {
            errors.push({ path: `${base}.env`, message: "env must be a mapping" });
          } else {
            for (const [k, v] of Object.entries(step.env)) {
              if (typeof v !== "string") {
                errors.push({
                  path: `${base}.env.${k}`,
                  message: "env values must be strings",
                });
              }
              if (RESERVED_ENV.has(k)) {
                errors.push({
                  path: `${base}.env.${k}`,
                  message: `env.${k} is reserved`,
                });
              }
            }
          }
        }
        // step.cwd — string
        if (step.cwd !== undefined && typeof step.cwd !== "string") {
          errors.push({ path: `${base}.cwd`, message: "cwd must be a string" });
        }
        // step.name — string
        if (step.name !== undefined && typeof step.name !== "string") {
          errors.push({ path: `${base}.name`, message: "name must be a string" });
        }
        // step.continue_on_error — boolean
        if (
          step.continue_on_error !== undefined &&
          typeof step.continue_on_error !== "boolean"
        ) {
          errors.push({
            path: `${base}.continue_on_error`,
            message: "continue_on_error must be a boolean",
          });
        }
        steps.push(step);
      });
    }
  }

  if (errors.length > 0) return { ok: false, manifest: undefined, errors };
  return {
    ok: true,
    manifest: {
      name: raw.name,
      description: raw.description,
      host: raw.host ?? "mac",
      inputs,
      env,
      timeoutMs: topTimeoutMs,
      steps,
    },
    errors: undefined,
  };
}

// Type-match check for `default:` against the declared input `type`. Strings
// must be string; booleans must be boolean; numbers must be number; enum
// values must be in the values[] list. Returns null when OK, else an error
// message.
function checkDefaultTypeMatches(value, type, values) {
  if (type === "string") {
    if (typeof value !== "string") return "default: expected string";
    return null;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return "default: expected number";
    return null;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") return "default: expected boolean";
    return null;
  }
  if (type === "enum") {
    if (typeof value !== "string") return "default: expected string (enum value)";
    if (Array.isArray(values) && !values.includes(value)) {
      return `default: must be one of [${values.join(", ")}]`;
    }
    return null;
  }
  return `default: unknown type "${type}"`;
}

// ---------------------------------------------------------------------------
// validateManifest — full validation, accepting an already-parsed object
//
// Useful when the caller already has the parsed structure (e.g. they read
// the file via their own YAML lib, or want to round-trip without re-YAML).
// Returns {errors[]} for any structural problems; on success returns
// {errors:[]}. Internally re-runs the structural validation through
// parseManifest — a small YAML round-trip cost that buys us a single
// validation pipeline.
// ---------------------------------------------------------------------------

export function validateManifest(parsed) {
  if (parsed == null || typeof parsed !== "object") {
    return { errors: [{ path: "", message: "manifest must be an object" }] };
  }
  try {
    const yamlText = stringifyYaml(parsed);
    const result = parseManifest(yamlText);
    // parseManifest returns {ok:true, manifest, errors:undefined} on
    // success — pin to [] here so the success shape is stable for callers
    // that diff against an empty array.
    return { errors: result.errors ?? [] };
  } catch (e) {
    return { errors: [{ path: "", message: e?.message ?? String(e) }] };
  }
}

// ---------------------------------------------------------------------------
// evalIf — pure evaluator for the `if:` expression language
//
// Three forms only (BET-189 §"`if:` expression language"):
//   1. inputs.<id>             → truthy if bool true OR non-empty string
//   2. inputs.<id> == <token>  → strict equality after string coercion
//   3. inputs.<id> != <token>  → strict inequality after string coercion
//
// <token> is a single whitespace-free literal. Booleans stringify to
// "true" / "false"; numbers stringify with no decimals ("3", not "3.0");
// strings are used as-is. NO `${{ }}`, NO operators beyond ==/!=, NO
// functions, NO function calls. Anything else → {error}.
//
// On error the caller MUST skip the step; the step must NOT run.
// ---------------------------------------------------------------------------

export function evalIf(expr, inputs) {
  if (typeof expr !== "string" || !expr.trim()) {
    return { error: "if: expression must be a non-empty string" };
  }
  // Permissive regex — accepts bare `inputs.X`, `inputs.X ==` with any
  // amount of whitespace around the operator, and an optional RHS. The
  // structural validation below catches empty / whitespace-bearing RHS.
  // Match groups: 1=id, 2=op, 3=rhs.
  const m = expr.match(
    /^inputs\.([a-z][a-zA-Z0-9_]*)(?:\s+(==|!=)\s*(\S*(\s+\S+)*))?$/,
  );
  if (!m) {
    return {
      error:
        "if: must be inputs.<id> or inputs.<id> == <token> or inputs.<id> != <token>",
    };
  }
  const id = m[1];
  const op = m[2];
  const rhs = m[3];
  if (op === undefined) {
    // Bare `inputs.<id>` — truthy per spec.
    return isTruthy(inputs?.[id]);
  }
  // Empty RHS (bare `==` or `!=`) → user forgot the value. We capture the
  // rhs as `(\S*(\s+\S+)*)` so an empty RHS stays empty even when the
  // input ends with `== ` (trailing space, no token after).
  if (rhs == null || rhs.length === 0) {
    return { error: "if: right-hand side must be a non-empty literal" };
  }
  // Whitespace check — token must be whitespace-free (BET-189). A
  // two-token RHS like `foo bar` is caught here. The regex above captures
  // multiple whitespace-separated tokens, so this is the only check.
  if (/\s/.test(rhs)) {
    return { error: "if: right-hand side must be whitespace-free" };
  }
  const lhs = stringify(inputs?.[id]);
  const lit = rhs;
  if (op === "==") return lhs === lit;
  if (op === "!=") return lhs !== lit;
  return { error: `if: unknown operator "${op}"` };
}

function isTruthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  return false;
}

function stringify(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v;
  return "";
}

// ---------------------------------------------------------------------------
// buildEnv — pure env-construction (no fs / spawn)
//
// Returns a NEW object that the caller can pass straight to spawn({env}).
// Order (per spec):
//   1. process.env keys as-is (live snapshot)
//   2. manifest.env (with leading `~` expanded against homedir)
//   3. MANTA_INPUT_<ID>=<value> for every input with a supplied value OR
//      default; absent when no value AND no default (callers can still set
//      MANTA_INPUT_<ID> via the manifest.env if they want it always-present)
//   4. MANTA_PLUGIN=<name>
//   5. MANTA_JOB_ID=<jobId>
//
// The executor's PATH patch is NOT applied here — that lives in capExecutor
// because it's a spawn-side concern, not a validator one.
// ---------------------------------------------------------------------------

export function buildEnv(manifest, suppliedInputs, opts) {
  const jobId = opts?.jobId ?? "";
  const out = { ...(process.env ?? {}) };
  // Manifest env — `~`/`~/foo` expanded.
  for (const [k, v] of Object.entries(manifest?.env ?? {})) {
    out[k] = expandTilde(v);
  }
  // MANTA_INPUT_<ID>
  const inputs = manifest?.inputs ?? [];
  for (const inp of inputs) {
    const v = suppliedInputs?.[inp.id];
    const value = v !== undefined ? v : inp.default;
    if (value === undefined) continue; // absent when no value AND no default
    out[`MANTA_INPUT_${inp.id.toUpperCase()}`] = stringifyEnvValue(value);
  }
  out.MANTA_PLUGIN = manifest?.name ?? "";
  out.MANTA_JOB_ID = jobId;
  return out;
}

function stringifyEnvValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// Leading `~` → `os.homedir()`; `~/foo` → `<homedir>/foo`. Other strings
// pass through unchanged.
export function expandTilde(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return homedir() + p.slice(1);
  }
  return p;
}

// ---------------------------------------------------------------------------
// resolveCwd — pure path substitution + tilde expansion + existence check
//
// `$KEY` / `${KEY}` are substituted from the `env` map only (no process.env —
// the manifest's cwd is user-authored, we don't want it to swallow unrelated
// env vars). Leading `~` expanded after substitution. Non-existent dir →
// `{error}`. fs.existsSync is the only I/O here — necessary because the
// spec demands we reject a cwd that doesn't exist BEFORE the first step
// runs (otherwise a typo'd cwd would only fail at the first step, leaving
// a partially-configured job in the user's log).
// ---------------------------------------------------------------------------

export function resolveCwd(cwd, env) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    return { error: "cwd: must be a non-empty string" };
  }
  let expanded = cwd.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, k) => {
      const v = env?.[k];
      return typeof v === "string" ? v : "";
    },
  );
  // Bare `$KEY` form — only when followed by a non-word char or end. We
  // use a word-boundary regex so `path$foo` (a literal `$foo` in a path)
  // isn't accidentally substituted.
  expanded = expanded.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g,
    (_, k) => {
      const v = env?.[k];
      return typeof v === "string" ? v : "";
    },
  );
  expanded = expandTilde(expanded);
  if (!existsSync(expanded)) {
    return { error: `cwd: ${expanded} does not exist` };
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// validateSuppliedInputs — runtime check of caller-supplied values against
// the manifest's declared inputs. Returns {errors[]} — every failing input,
// no short-circuit (the user wants to fix them all in one pass).
// ---------------------------------------------------------------------------

export function validateSuppliedInputs(manifest, supplied) {
  const errors = [];
  const suppliedObj = supplied ?? {};
  if (manifest?.inputs) {
    for (const inp of manifest.inputs) {
      const v = suppliedObj[inp.id];
      if (v === undefined) {
        if (inp.default === undefined) {
          errors.push({ path: inp.id, message: "required input is missing" });
        }
        continue;
      }
      if (inp.type === "string") {
        if (typeof v !== "string") {
          errors.push({ path: inp.id, message: "expected string" });
        }
      } else if (inp.type === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push({ path: inp.id, message: "expected number" });
        }
      } else if (inp.type === "boolean") {
        if (typeof v !== "boolean") {
          errors.push({ path: inp.id, message: "expected boolean" });
        }
      } else if (inp.type === "enum") {
        if (typeof v !== "string") {
          errors.push({ path: inp.id, message: "expected string (enum value)" });
        } else if (Array.isArray(inp.values) && !inp.values.includes(v)) {
          errors.push({
            path: inp.id,
            message: `must be one of [${inp.values.join(", ")}]`,
          });
        }
      }
    }
  }
  // Unknown input ids — a typo from the caller is more useful surfaced
  // than silently ignored.
  const known = new Set((manifest?.inputs ?? []).map((i) => i.id));
  for (const k of Object.keys(suppliedObj)) {
    if (!known.has(k)) {
      errors.push({ path: k, message: "unknown input" });
    }
  }
  return { errors };
}

// ---------------------------------------------------------------------------
// parseTimeout — accept `^\d+(s|m)$`, cap 30 min, return ms.
// ---------------------------------------------------------------------------

export function parseTimeout(s) {
  if (typeof s !== "string" || !TIMEOUT_RE.test(s)) {
    return { error: "must match ^\\d+(s|m)$ (e.g. 5s, 30m)" };
  }
  const n = Number.parseInt(s, 10);
  const unit = s.slice(-1);
  const ms = unit === "m" ? n * 60_000 : n * 1_000;
  if (ms <= 0) return { error: "must be > 0" };
  if (ms > MAX_TIMEOUT_MS) {
    return { error: `must be ≤ ${MAX_TIMEOUT_MS / 60_000}m` };
  }
  return ms;
}
