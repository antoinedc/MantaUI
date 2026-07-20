// Tests for src/shared/pluginManifest.mjs — the YAML manifest core.
//
// Pure-function coverage: every validator path, every evalIf branch, every
// buildEnv/resolveCwd/validateSuppliedInputs/parseTimeout edge case the spec
// calls out. Mirrors voiceClassifier.test.ts style (vitest, no live fs /
// electron). resolveCwd is the only function that touches fs (existsSync);
// tests stub the path with a real dir under /tmp so the existence check
// passes naturally.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  parseManifest,
  validateManifest,
  evalIf,
  buildEnv,
  resolveCwd,
  validateSuppliedInputs,
  parseTimeout,
  NAME_RE,
  INPUT_ID_RE,
  INPUT_TYPES,
} from "./pluginManifest.mjs";

// Use a real temp dir for cwd existence checks; cleaned up at process exit.
const TMP_DIR = mkdtempSync(join(tmpdir(), "plugin-manifest-test-"));

// Type-narrowing helper for the discriminated-union success path from
// parseManifest — collapses `if (r.ok) { ... }` boilerplate.
const okManifest = <T extends { manifest?: unknown; errors?: unknown }>(r: T) => {
  if (!r.manifest) throw new Error("expected ok result, got errors");
  return r.manifest as NonNullable<T["manifest"]>;
};

// ---------------------------------------------------------------------------
// parseManifest — top-level
// ---------------------------------------------------------------------------

describe("parseManifest — top-level", () => {
  it("rejects non-string input", () => {
    expect(parseManifest(null as unknown as string)).toEqual({
      ok: false,
      manifest: undefined,
      errors: [{ path: "", message: "manifest must be a string" }],
    });
    expect(parseManifest(42 as unknown as string)).toEqual({
      ok: false,
      manifest: undefined,
      errors: [{ path: "", message: "manifest must be a string" }],
    });
  });

  it("surfaces a YAML parse error", () => {
    const r = parseManifest("foo: : bar\n  :\n bad: : yaml");
    expect(r.ok).toBe(false);
    expect(r.errors?.length).toBeGreaterThan(0);
    expect(r.errors![0].path).toBe("");
    expect(r.errors![0].message).toMatch(/yaml parse/);
  });

  it("rejects non-mapping roots (scalar, array)", () => {
    expect(parseManifest("foo").errors?.[0].message).toMatch(/must be a mapping/);
    expect(parseManifest("- 1\n- 2").errors?.[0].message).toMatch(/must be a mapping/);
  });

  it("flags unknown top-level keys", () => {
    const yaml = `
name: foo
description: hi
host: mac
steps: [{ run: "echo hi" }]
stranger: 1
`;
    const r = parseManifest(yaml);
    expect(r.errors).toContainEqual({
      path: "stranger",
      message: 'unknown key "stranger"',
    });
  });

  it("returns a clean manifest for the canonical happy path", () => {
    const yaml = `
name: lint-and-build
description: Lint then build a Node project
host: mac
inputs:
  - id: project
    description: project path
    type: string
    default: ~/proj
env:
  NODE_ENV: production
steps:
  - name: lint
    run: npm run lint
    cwd: ~/proj
  - run: npm run build
    cwd: ~/proj
    continue_on_error: false
`;
    const r = parseManifest(yaml);
    expect(r.errors).toBeUndefined();
    const m = okManifest(r);
    expect(m.name).toBe("lint-and-build");
    expect(m.description).toBe("Lint then build a Node project");
    expect(m.host).toBe("mac");
    expect(m.inputs).toEqual([
      {
        id: "project",
        description: "project path",
        type: "string",
        default: "~/proj",
        values: undefined,
      },
    ]);
    expect(m.env).toEqual({ NODE_ENV: "production" });
    expect(m.steps).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseManifest — name / description / host
// ---------------------------------------------------------------------------

describe("parseManifest — name validation", () => {
  it("requires name", () => {
    const r = parseManifest(`
description: x
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "name",
      message: "name is required",
    });
  });

  it("rejects names that violate the regex", () => {
    const cases = ["UPPER", "-leading-dash", "has space", "has/slash", "a".repeat(64)];
    for (const n of cases) {
      const r = parseManifest(`name: "${n}"\ndescription: x\nsteps: [{run: "echo"}]`);
      expect(r.errors).toContainEqual(
        expect.objectContaining({ path: "name" }),
      );
    }
  });

  it("accepts kebab-case names within length cap", () => {
    expect(NAME_RE.test("foo")).toBe(true);
    expect(NAME_RE.test("foo-bar")).toBe(true);
    expect(NAME_RE.test("foo-123")).toBe(true);
    expect(NAME_RE.test("a".repeat(63))).toBe(true);
  });
});

describe("parseManifest — description / host", () => {
  it("requires description (non-empty)", () => {
    const r = parseManifest(`
name: foo
description: "   "
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "description",
      message: "description is required",
    });
  });

  it("rejects host !== 'mac' with the canonical message", () => {
    const r = parseManifest(`
name: foo
description: x
host: linux
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "host",
      message: 'host: only "mac" is supported',
    });
  });

  it("defaults host to 'mac' when omitted", () => {
    const r = parseManifest(`
name: foo
description: x
steps: [{run: "echo"}]
`);
    expect(okManifest(r).host).toBe("mac");
  });
});

// ---------------------------------------------------------------------------
// parseManifest — inputs
// ---------------------------------------------------------------------------

describe("parseManifest — inputs", () => {
  it("rejects non-array inputs", () => {
    const r = parseManifest(`
name: foo
description: x
inputs: not-an-array
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "inputs",
      message: "inputs must be an array",
    });
  });

  it("flags a bad input id regex", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - id: "1leading-digit"
    description: x
    type: string
steps: [{run: "echo"}]
`);
    expect(r.errors?.some((e) => e.path === "inputs[0].id")).toBe(true);
  });

  it("accepts valid input id patterns", () => {
    expect(INPUT_ID_RE.test("foo")).toBe(true);
    expect(INPUT_ID_RE.test("fooBar")).toBe(true);
    expect(INPUT_ID_RE.test("foo_bar123")).toBe(true);
    expect(INPUT_ID_RE.test("Foo")).toBe(false);
    expect(INPUT_ID_RE.test("1foo")).toBe(false);
    expect(INPUT_ID_RE.test("foo-bar")).toBe(false);
  });

  it("requires each input to have a non-empty description", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - id: foo
    description: ""
    type: string
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "inputs[0].description",
      message: "description is required",
    });
  });

  it("rejects an unknown input type", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - id: foo
    description: x
    type: frobozz
steps: [{run: "echo"}]
`);
    expect(r.errors?.some((e) => /type/.test(e.message) && /must be one of/.test(e.message))).toBe(true);
  });

  it("requires values[] when type is enum", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - id: flavor
    description: x
    type: enum
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "inputs[0].values",
      message: "values is required for type:enum",
    });
  });

  it("forbids values[] when type is non-enum", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - id: foo
    description: x
    type: string
    values: [a, b]
steps: [{run: "echo"}]
`);
    expect(r.errors).toContainEqual({
      path: "inputs[0].values",
      message: "values is only allowed for type:enum",
    });
  });

  it("rejects a default whose type mismatches the declared type", () => {
    const cases = [
      { type: "string", bad: 5 },
      { type: "number", bad: "five" },
      { type: "boolean", bad: "true" },
    ];
    for (const c of cases) {
      const r = parseManifest(`
name: foo
description: x
inputs:
  - id: foo
    description: x
    type: ${c.type}
    default: ${JSON.stringify(c.bad)}
steps: [{run: "echo"}]
`);
      expect(r.errors?.some((e) => /inputs\[0\]\.default/.test(e.path))).toBe(true);
    }
  });

  it("accepts a default that matches the declared type", () => {
    const yaml = `
name: foo
description: x
inputs:
  - id: a
    description: x
    type: number
    default: 3
  - id: b
    description: x
    type: boolean
    default: true
  - id: c
    description: x
    type: string
    default: "x"
  - id: d
    description: x
    type: enum
    values: [red, blue]
    default: red
steps: [{run: "echo"}]
`;
    const r = parseManifest(yaml);
    expect(r.errors).toBeUndefined();
  });

  it("rejects an enum default not in values", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - id: color
    description: x
    type: enum
    values: [red, blue]
    default: green
steps: [{run: "echo"}]
`);
    expect(r.errors?.some((e) => /must be one of/.test(e.message))).toBe(true);
  });

  it("rejects duplicate input ids", () => {
    const r = parseManifest(`
name: foo
description: x
inputs:
  - {id: foo, description: x, type: string}
  - {id: foo, description: x, type: string}
steps: [{run: "echo"}]
`);
    expect(r.errors?.some((e) => /duplicate input id/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseManifest — timeout
// ---------------------------------------------------------------------------

describe("parseManifest — timeout", () => {
  it("accepts s + m units", () => {
    expect(typeof parseTimeout("5s")).toBe("number");
    expect(typeof parseTimeout("30m")).toBe("number");
  });

  it("rejects malformed timeouts", () => {
    const errs = (r: unknown) => (r as { error: string }).error;
    expect(errs(parseTimeout("5"))).toMatch(/must match/);
    expect(errs(parseTimeout("5x"))).toMatch(/must match/);
    expect(errs(parseTimeout("5 m"))).toMatch(/must match/);
    expect(errs(parseTimeout("5.5s"))).toMatch(/must match/);
  });

  it("rejects timeouts above the 30-minute cap", () => {
    const errs = (r: unknown) => (r as { error: string }).error;
    expect(errs(parseTimeout("31m"))).toMatch(/≤ 30m/);
    expect(errs(parseTimeout("60m"))).toMatch(/≤ 30m/);
    // Boundary — exactly 30m is fine.
    expect(typeof parseTimeout("30m")).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// parseManifest — steps
// ---------------------------------------------------------------------------

describe("parseManifest — steps", () => {
  it("rejects non-array steps", () => {
    const r = parseManifest(`
name: foo
description: x
steps: not-an-array
`);
    expect(r.errors?.some((e) => e.path === "steps")).toBe(true);
  });

  it("rejects an empty steps array", () => {
    const r = parseManifest(`
name: foo
description: x
steps: []
`);
    expect(r.errors?.some((e) => /at least one step/.test(e.message))).toBe(true);
  });

  it("requires step.run", () => {
    const r = parseManifest(`
name: foo
description: x
steps: [{}]
`);
    expect(r.errors?.some((e) => /steps\[0\]\.run/.test(e.path))).toBe(true);
  });

  it("flags unknown step keys", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    stranger: 1
`);
    expect(r.errors).toContainEqual({
      path: "steps[0].stranger",
      message: 'unknown key "stranger"',
    });
  });

  it("rejects a malformed if: expression (no `inputs.` prefix)", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    if: "true"
`);
    expect(r.errors?.some((e) => /steps\[0\]\.if/.test(e.path))).toBe(true);
  });

  it("rejects a ${{ }} templated if: expression", () => {
    const bad = "$" + "{{ inputs.foo }}";
    const yaml = [
      "name: foo",
      "description: x",
      "steps:",
      '  - run: "echo"',
      `    if: "${bad}"`,
      "",
    ].join("\n");
    const r = parseManifest(yaml);
    expect(r.errors?.some((e) => /steps\[0\]\.if/.test(e.path))).toBe(true);
  });

  it("rejects a two-token RHS (whitespace)", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    if: "inputs.flavor == hot dog"
`);
    expect(r.errors?.some((e) => /steps\[0\]\.if/.test(e.path))).toBe(true);
  });

  it("rejects a bare `==` with no RHS", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    if: "inputs.flavor =="
`);
    expect(r.errors?.some((e) => /steps\[0\]\.if/.test(e.path))).toBe(true);
  });

  it("accepts a well-formed if: expression", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    if: "inputs.flavor == hot"
`);
    expect(r.errors).toBeUndefined();
  });

  it("rejects a step.timeout that exceeds the cap", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    timeout: 60m
`);
    expect(r.errors?.some((e) => /steps\[0\]\.timeout/.test(e.path))).toBe(true);
  });

  it("accepts env overrides that aren't reserved", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    env:
      CUSTOM: "1"
`);
    expect(r.errors).toBeUndefined();
  });

  it("rejects reserved env names in step.env", () => {
    const r = parseManifest(`
name: foo
description: x
steps:
  - run: "echo"
    env:
      MANTA_PLUGIN: "evil"
`);
    expect(r.errors?.some((e) => /reserved/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evalIf
// ---------------------------------------------------------------------------

describe("evalIf", () => {
  const errOf = (r: unknown) => (r as { error?: string }).error;
  it("returns an error for non-string or empty", () => {
    expect(errOf(evalIf("", {}))).toBeDefined();
    expect(errOf(evalIf(undefined as unknown as string, {}))).toBeDefined();
  });

  it("returns an error for a non-`inputs.` expression", () => {
    expect(errOf(evalIf("foo", {}))).toMatch(/must be inputs/);
    expect(errOf(evalIf("inputs. ", {}))).toMatch(/must be inputs/);
  });

  it("bare inputs.<id> — true for boolean true", () => {
    expect(evalIf("inputs.flag", { flag: true })).toBe(true);
  });

  it("bare inputs.<id> — false for boolean false", () => {
    expect(evalIf("inputs.flag", { flag: false })).toBe(false);
  });

  it("bare inputs.<id> — true for non-empty string", () => {
    expect(evalIf("inputs.flavor", { flavor: "hot" })).toBe(true);
  });

  it("bare inputs.<id> — false for empty string", () => {
    expect(evalIf("inputs.flavor", { flavor: "" })).toBe(false);
  });

  it("bare inputs.<id> — false for missing input", () => {
    expect(evalIf("inputs.flag", {})).toBe(false);
  });

  it("bare inputs.<id> — false for null/undefined", () => {
    expect(evalIf("inputs.flag", { flag: null })).toBe(false);
    expect(evalIf("inputs.flag", { flag: undefined })).toBe(false);
  });

  it("== matches after bool→'true'/'false' coercion", () => {
    expect(evalIf("inputs.flag == true", { flag: true })).toBe(true);
    expect(evalIf("inputs.flag == false", { flag: false })).toBe(true);
    expect(evalIf("inputs.flag == true", { flag: false })).toBe(false);
  });

  it("== matches strings case-sensitively", () => {
    expect(evalIf("inputs.flavor == hot", { flavor: "hot" })).toBe(true);
    expect(evalIf("inputs.flavor == Hot", { flavor: "hot" })).toBe(false);
  });

  it("!= is the logical inverse of ==", () => {
    expect(evalIf("inputs.flavor != cold", { flavor: "hot" })).toBe(true);
    expect(evalIf("inputs.flavor != hot", { flavor: "hot" })).toBe(false);
  });

  it("rejects a RHS with whitespace", () => {
    expect(errOf(evalIf("inputs.flavor == hot dog", { flavor: "hot dog" }))).toMatch(/whitespace/);
  });

  it("rejects an empty RHS (bare ==)", () => {
    expect(errOf(evalIf("inputs.flavor == ", { flavor: "hot" }))).toMatch(/non-empty/);
  });

  it("rejects an unknown operator", () => {
    expect(errOf(evalIf("inputs.flag > 1", { flag: true }))).toMatch(/unknown operator|must be inputs/);
  });
});

// ---------------------------------------------------------------------------
// buildEnv
// ---------------------------------------------------------------------------

describe("buildEnv", () => {
  const minimal = {
    name: "demo",
    description: "x",
    host: "mac" as const,
    inputs: [
      { id: "foo", description: "x", type: "string" as const, default: "def-foo" },
      { id: "bar", description: "x", type: "boolean" as const },
      { id: "baz", description: "x", type: "number" as const },
    ],
    env: { CUSTOM: "1" },
    timeoutMs: null as number | null,
    steps: [],
  };

  it("includes process.env keys", () => {
    const orig = process.env.PATH;
    process.env.PATH = "/usr/bin";
    try {
      const out = buildEnv(minimal, {}, { jobId: "j1" });
      expect(out.PATH).toBe("/usr/bin");
    } finally {
      process.env.PATH = orig;
    }
  });

  it("overlays manifest.env (with tilde expansion)", () => {
    const out = buildEnv(
      { ...minimal, env: { HOME_DIR: "~/proj" } },
      {},
      { jobId: "j1" },
    );
    expect(out.HOME_DIR).toMatch(/proj$/);
    expect(out.HOME_DIR.startsWith("/")).toBe(true);
  });

  it("sets MANTA_INPUT_<ID> for supplied values", () => {
    const out = buildEnv(
      minimal,
      { foo: "supplied", bar: true, baz: 3 },
      { jobId: "j1" },
    );
    expect(out.MANTA_INPUT_FOO).toBe("supplied");
    expect(out.MANTA_INPUT_BAR).toBe("true");
    expect(out.MANTA_INPUT_BAZ).toBe("3");
  });

  it("falls back to defaults when no supplied value", () => {
    const out = buildEnv(minimal, {}, { jobId: "j1" });
    expect(out.MANTA_INPUT_FOO).toBe("def-foo");
    expect(out.MANTA_INPUT_BAR).toBeUndefined();
  });

  it("absent when no value AND no default", () => {
    const out = buildEnv(minimal, {}, { jobId: "j1" });
    expect(out.MANTA_INPUT_BAR).toBeUndefined();
    expect(out.MANTA_INPUT_BAZ).toBeUndefined();
  });

  it("stringifies booleans to 'true' / 'false'", () => {
    const out = buildEnv(minimal, { bar: false }, { jobId: "j1" });
    expect(out.MANTA_INPUT_BAR).toBe("false");
  });

  it("sets MANTA_PLUGIN and MANTA_JOB_ID", () => {
    const out = buildEnv(minimal, {}, { jobId: "abc123" });
    expect(out.MANTA_PLUGIN).toBe("demo");
    expect(out.MANTA_JOB_ID).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// resolveCwd
// ---------------------------------------------------------------------------

describe("resolveCwd", () => {
  it("substitutes $KEY and ${KEY} from env map", () => {
    // TMP_DIR exists; `${PROJ}/src` does NOT (no `src` subdir under the
    // mkdtemp root). Use TMP_DIR itself as the target so existsSync passes.
    const r = resolveCwd("$PROJ", { PROJ: TMP_DIR });
    expect(typeof r === "string").toBe(true);
    expect(r as string).toBe(TMP_DIR);
    const r2 = resolveCwd("${PROJ}", { PROJ: TMP_DIR });
    expect(typeof r2 === "string").toBe(true);
    expect(r2 as string).toBe(TMP_DIR);
  });

  it("expands a leading ~", () => {
    const r = resolveCwd("~", {});
    expect(typeof r === "string").toBe(true);
    expect((r as string).length).toBeGreaterThan(1);
  });

  it("returns error for non-existent dir", () => {
    const r = resolveCwd("/this/does/not/exist/xyzzy", {});
    expect(typeof r === "object" && (r as { error: string }).error).toMatch(/does not exist/);
  });

  it("returns error for non-string cwd", () => {
    const a = resolveCwd("", {}) as { error: string };
    expect(a.error).toMatch(/non-empty/);
    const b = resolveCwd(null as unknown as string, {}) as { error: string };
    expect(b.error).toMatch(/non-empty/);
  });

  it("substitutes only keys present in env (unknown $KEY stays empty)", () => {
    // bare $KEY with no word chars after → empty → cwd becomes empty → err
    const r = resolveCwd("$MISSING", {}) as { error: string };
    expect(r.error).toMatch(/does not exist|cwd/);
  });
});

// ---------------------------------------------------------------------------
// validateSuppliedInputs
// ---------------------------------------------------------------------------

describe("validateSuppliedInputs", () => {
  const manifest = {
    name: "x",
    description: "x",
    host: "mac" as const,
    inputs: [
      { id: "foo", description: "x", type: "string" as const },
      { id: "bar", description: "x", type: "number" as const },
      { id: "opt", description: "x", type: "boolean" as const, default: false },
      { id: "flavor", description: "x", type: "enum" as const, values: ["hot", "cold"] },
    ],
    env: {},
    timeoutMs: null as number | null,
    steps: [],
  };

  it("flags unknown id", () => {
    const r = validateSuppliedInputs(manifest, { unknown: 1 });
    expect(r.errors?.some((e) => /unknown/.test(e.message))).toBe(true);
  });

  it("flags type mismatch", () => {
    const r = validateSuppliedInputs(manifest, { foo: 5 });
    expect(r.errors?.some((e) => /foo/.test(e.path) && /string/.test(e.message))).toBe(true);
  });

  it("flags enum value not in values[]", () => {
    const r = validateSuppliedInputs(manifest, { flavor: "warm" });
    expect(r.errors?.some((e) => /flavor/.test(e.path))).toBe(true);
  });

  it("flags missing required with no default", () => {
    const r = validateSuppliedInputs(manifest, {});
    expect(r.errors?.some((e) => /foo/.test(e.path) || /bar/.test(e.path))).toBe(true);
  });

  it("accepts an input whose default fills in", () => {
    const r = validateSuppliedInputs(manifest, { foo: "x", bar: 1, flavor: "hot" });
    expect(r.errors).toEqual([]);
  });

  it("accepts an enum value in the list", () => {
    const r = validateSuppliedInputs(manifest, { foo: "x", bar: 1, flavor: "hot" });
    expect(r.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateManifest — round-trip
// ---------------------------------------------------------------------------

describe("validateManifest", () => {
  it("returns errors for non-object input", () => {
    expect(validateManifest(null).errors.length).toBeGreaterThan(0);
    expect(validateManifest("x").errors.length).toBeGreaterThan(0);
  });

  it("returns empty errors for a valid object", () => {
    const obj = {
      name: "demo",
      description: "x",
      host: "mac",
      steps: [{ run: "echo" }],
    };
    expect(validateManifest(obj).errors).toEqual([]);
  });

  it("returns errors for invalid object", () => {
    const obj = { name: "BAD NAME", description: "" };
    expect(validateManifest(obj).errors.length).toBeGreaterThan(0);
  });
});

// Quick sanity — the supported-types list should not regress without
// updating the docs in BET-189 §"Validation rules".
describe("INPUT_TYPES", () => {
  it("contains the four canonical types", () => {
    expect(INPUT_TYPES).toEqual(["string", "number", "boolean", "enum"]);
  });
});
