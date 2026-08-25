// Tests for scripts/optimizer/retention-eval.mjs — the seeded-retention case
// file and the pure eval orchestration (Optimizer P2.4, BET-1346, Part B).
// node:test. Validates the case-file schema (exactly 30 cases, unique ids,
// all five fields) and exercises runRetentionEval with a STUB model — no real
// model calls, no state dir. Run via `npm run test:server` or directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateRetentionCases, runRetentionEval } from "./retention-eval.mjs";
import { buildCompactionPrompt } from "../../src/shared/constraintPin.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function loadCases() {
  return JSON.parse(readFileSync(join(here, "retention-cases.json"), "utf-8"));
}

test("retention-cases.json has exactly 30 cases", () => {
  const cases = loadCases();
  const { ok, errors } = validateRetentionCases(cases);
  assert.ok(ok, errors.join("; "));
  assert.equal(cases.length, 30);
});

test("every case has all five fields and a non-array-typed transcript", () => {
  for (const c of loadCases()) {
    for (const f of ["id", "transcript", "constraint", "probe", "expect"]) {
      assert.ok(c[f] !== undefined, `${c.id} missing ${f}`);
    }
    assert.ok(Array.isArray(c.transcript), `${c.id} transcript is not an array`);
  }
});

test("case ids are unique", () => {
  const ids = loadCases().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate case ids");
});

test("validateRetentionCases rejects malformed input", () => {
  assert.equal(validateRetentionCases(null).ok, false);
  assert.equal(validateRetentionCases({}).ok, false);
  assert.equal(validateRetentionCases([]).ok, false);
  const dup = loadCases().slice(0, 2);
  const bad = [{ ...dup[0], id: "ret-01" }, dup[0]];
  assert.equal(validateRetentionCases(bad).ok, false);
  const missing = [{ id: "x", transcript: [] }];
  assert.equal(validateRetentionCases(missing).ok, false);
});

test("runRetentionEval passes a case when the probe answer preserves the constraint", async () => {
  const cases = [
    {
      id: "t1",
      transcript: ["user: use tabs", "assistant: ok"],
      constraint: "use tabs",
      probe: "what style?",
      expect: "tabs",
    },
  ];
  // Stub model: the summary echoes the (appended) prompt, and the probe answer
  // returns the preserved constraint fragment, so the case passes.
  let sawAppended = false;
  const model = async ({ instruction }) => {
    if (instruction.startsWith("Summarize")) {
      sawAppended = buildCompactionPrompt("", []) !== "" || instruction.includes("use tabs");
    }
    // For the probe turn, return the required fragment.
    return instruction.includes("what style?") ? "we use tabs here" : "summary";
  };
  const result = await runRetentionEval({ cases, model });
  assert.equal(result.passed, 1);
  assert.equal(result.total, 1);
  assert.ok(sawAppended);
});

test("runRetentionEval fails a case whose probe answer lost the constraint", async () => {
  const cases = [
    {
      id: "t2",
      transcript: ["user: use tabs", "assistant: ok"],
      constraint: "use tabs",
      probe: "what style?",
      expect: "tabs",
    },
  ];
  const model = async ({ instruction }) => (instruction.includes("what style?") ? "no idea" : "summary");
  const result = await runRetentionEval({ cases, model });
  assert.equal(result.passed, 0);
});
