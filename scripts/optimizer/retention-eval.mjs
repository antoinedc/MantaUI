#!/usr/bin/env node
// retention-eval.mjs — the seeded-retention eval for BET-1346's compaction
// constraint pinning.
//
// WHY: appending the user's standing instructions to the compaction prompt is
// only worth shipping if a summariser that is TOLD the constraints actually
// keeps them. This script runs each seeded case through the REAL compaction
// prompt path (buildCompactionPrompt from src/shared/constraintPin.mjs) and a
// model turn, then asks the probe and checks the required fragment survived.
// It reports `passed/30`.
//
// GATE: the constraint-injection is enabled ONLY at 30/30. Anything less and
// the prompt change does not ship — the PR body and the comment at the top of
// the plugin's `experimental.session.compacting` hook both say so.
//
// RUN BY HAND (it costs real model calls). It is NOT part of `npm test` and
// must NOT run in CI. Its pure parts (validateRetentionCases, runRetentionEval)
// ARE unit-tested in retention-eval.test.mjs (node:test).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
// Pure helpers — the real compaction prompt path under test. Always
// importable (no heavy server deps), even for the unit test.
import { parseConstraints, buildCompactionPrompt } from "../../src/shared/constraintPin.mjs";

const BASE_SUMMARIZE_PROMPT =
  "Summarize this conversation so it can continue in fewer tokens. Keep the changes the user asked to keep.";

// The bare instruction the extraction model would be asked to pull out; in the
// seeded cases the `constraint` field stands in for the extraction result.
function constraintsFor(c) {
  return parseConstraints(typeof c?.constraint === "string" ? c.constraint : "");
}

/**
 * PURE. Validate a retention-cases file. Returns { ok, errors, cases }.
 * Errors (each a human string): not an array; not exactly 30 cases; duplicate
 * ids; a case missing any of the five fields (id, transcript, constraint,
 * probe, expect) or with a non-array transcript.
 */
export function validateRetentionCases(raw) {
  const errors = [];
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["retention-cases must be an array"], cases: [] };
  }
  if (raw.length !== 30) {
    errors.push(`expected exactly 30 cases, got ${raw.length}`);
  }
  const seen = new Set();
  const FIELDS = ["id", "transcript", "constraint", "probe", "expect"];
  raw.forEach((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`case ${i}: not an object`);
      return;
    }
    for (const f of FIELDS) {
      if (c[f] === undefined) errors.push(`case ${i} (${c.id ?? "?"}) missing field "${f}"`);
    }
    if (!Array.isArray(c.transcript)) errors.push(`case ${i} (${c.id ?? "?"}) transcript must be an array`);
    if (typeof c.id !== "string" || c.id === "") errors.push(`case ${i} has a non-string empty id`);
    else if (seen.has(c.id)) errors.push(`duplicate case id "${c.id}"`);
    else seen.add(c.id);
  });
  return { ok: errors.length === 0, errors, cases: errors.length === 0 ? raw : [] };
}

/**
 * PURE(ish — I/O is the injected `model`). Run every case through the REAL
 * compaction prompt path and score retention. `model({ instruction }) ->
 * Promise<string>` is the cheap-agent turn. Passes when the model's probe
 * answer contains the case's required `expect` fragment (case-insensitive);
 * an empty `expect` always passes. Returns { passed, total, results }.
 */
export async function runRetentionEval({ cases, model }) {
  const list = Array.isArray(cases) ? cases : [];
  const results = [];
  let passed = 0;
  for (const c of list) {
    const constraints = constraintsFor(c);
    // The REAL path: extraction result (here: the seeded constraint) is
    // appended to the base prompt — never replacing it.
    const prompt = buildCompactionPrompt(BASE_SUMMARIZE_PROMPT, constraints) +
      "\n\nTranscript:\n" + (Array.isArray(c.transcript) ? c.transcript.join("\n") : "");
    const summary = await model({ instruction: prompt });
    const answer = await model({
      instruction: `${c.probe}\n\nUsing only the summarized conversation, answer concretely.`,
      prior: summary,
    });
    const ok = retentionOk(c.expect, answer);
    if (ok) passed++;
    results.push({ id: c.id, ok, expect: c.expect, answer });
  }
  return { passed, total: list.length, results };
}

// A pass needs the required fragment to survive into the probe answer. Empty
// expect → trivially passes (no assertion).
function retentionOk(expect, answer) {
  const needle = String(expect ?? "").toLowerCase().trim();
  if (needle === "") return true;
  return String(answer ?? "").toLowerCase().includes(needle);
}

function loadCasesFile() {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(here, "retention-cases.json"), "utf-8"));
  const { ok, errors, cases } = validateRetentionCases(raw);
  if (!ok) {
    console.error("retention-cases.json is invalid:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(2);
  }
  return cases;
}

// By-hand model client: reuse the box's throwaway-session cheap-agent path
// (runThrowawayAgent) so the eval exercises a real summary+probe model turn.
function makeModel() {
  const directory = process.env.MANTA_EVAL_DIR ?? process.env.HOME ?? "/root";
  let oc = null;
  return async ({ instruction }) => {
    if (!oc) oc = await import("../../src/server/opencode.mjs");
    return oc.runThrowawayAgent({ directory, instruction, agent: "title" });
  };
}

async function main() {
  const cases = loadCasesFile();
  const { passed, total, results } = await runRetentionEval({ cases, model: makeModel() });
  for (const r of results) {
    if (r.ok) console.log(`${r.id} PASS`);
    else console.log(`${r.id} FAIL — expect "${r.expect}" in answer: ${r.answer}`);
  }
  console.log(`\nRETENTION ${passed}/${total}`);
  process.exit(passed === total ? 0 : 1);
}

// Run only when executed directly (not when imported by the unit test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
