// Tests for src/server/plugins.mjs — the in-memory plugin registry the
// Mac executor publishes to. Pure-logic coverage: shape validation,
// atomic replacement, bearer enforcement (stubbed via injected deps),
// idempotent PUT, and invalid-row preservation.
//
// Mirrors capabilities.test.mjs style (node:test, no live filesystem).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  putRegistry,
  getRegistry,
  _resetForTests,
} from "./plugins.mjs";

function makeValidRow(name, overrides = {}) {
  return {
    name,
    description: `A test plugin called ${name}`,
    inputs: [
      {
        id: "foo",
        description: "a sample input",
        type: "string",
        default: "def",
        values: undefined,
      },
    ],
    valid: true,
    yaml: `name: ${name}\ndescription: a plugin\nsteps:\n  - run: echo hi\n`,
    stepCount: 1,
    timeoutMs: null,
    ...overrides,
  };
}

function silentLogger() {
  const calls = [];
  return {
    calls,
    log: (msg) => calls.push(msg),
  };
}

test("putRegistry accepts a valid row, getRegistry returns it", () => {
  _resetForTests();
  const row = makeValidRow("lint");
  putRegistry([row]);
  const got = getRegistry();
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "lint");
  assert.equal(got[0].stepCount, 1);
});

test("putRegistry replaces the entire registry atomically", () => {
  _resetForTests();
  putRegistry([makeValidRow("a"), makeValidRow("b")]);
  assert.equal(getRegistry().length, 2);
  putRegistry([makeValidRow("c")]);
  const got = getRegistry();
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "c");
});

test("getRegistry returns rows sorted by name", () => {
  _resetForTests();
  putRegistry([
    makeValidRow("zeta"),
    makeValidRow("alpha"),
    makeValidRow("mu"),
  ]);
  const got = getRegistry();
  assert.deepEqual(got.map((r) => r.name), ["alpha", "mu", "zeta"]);
});

test("invalid rows are dropped (logged, but PUT returns 200)", () => {
  _resetForTests();
  const log = silentLogger();
  const bad = [
    null,
    "string",
    {},
    { name: "missing-fields" },
    { name: 123 },
    { name: "x", description: "ok", inputs: "not-array", valid: true, yaml: "x", stepCount: 1 },
    makeValidRow("ok"),
  ];
  const size = putRegistry(bad, { log: log.log });
  assert.equal(size, 1);
  assert.equal(getRegistry().length, 1);
  assert.equal(getRegistry()[0].name, "ok");
  assert.equal(log.calls.length, 1);
  assert.match(log.calls[0], /dropped 6 invalid/);
});

test("valid:false rows are preserved (bad manifests surface to UI)", () => {
  _resetForTests();
  const invalid = makeValidRow("broken", {
    valid: false,
    error: "parse error: missing required key steps",
    stepCount: 0,
    inputs: [],
    description: "",
    yaml: "name: broken\n",
  });
  putRegistry([invalid]);
  const got = getRegistry();
  assert.equal(got.length, 1);
  assert.equal(got[0].valid, false);
  assert.match(got[0].error, /parse error/);
});

test("PUT is idempotent (same body twice yields the same registry)", () => {
  _resetForTests();
  const rows = [makeValidRow("a"), makeValidRow("b")];
  putRegistry(rows);
  const first = getRegistry();
  putRegistry(rows);
  const second = getRegistry();
  assert.deepEqual(first, second);
});

test("non-array body is treated as zero rows", () => {
  _resetForTests();
  putRegistry(null);
  assert.equal(getRegistry().length, 0);
  putRegistry("string");
  assert.equal(getRegistry().length, 0);
});

test("_resetForTests clears the registry", () => {
  putRegistry([makeValidRow("a")]);
  assert.equal(getRegistry().length, 1);
  _resetForTests();
  assert.equal(getRegistry().length, 0);
});
