// ctoBudgetWiring.test.mjs — BET-1422 wiring gate. index.mjs cannot be
// imported (it boots the server on import), so the singleton's deps are
// asserted by a brace-balanced source scan: the two BET-1422 forge seams
// MUST sit inside the `createCtoBudget({...})` construction — the only thing
// that runs `refreshRoi()` — and MUST NOT sit in any other deps literal
// (they were once stranded in the computeHealthStats deps, which silently
// ignores them: the feature stayed dead in production behind green unit
// tests). Plus one behavioral canary: a createCtoBudget with the unwired
// defaults never counts a squash-merged job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createCtoBudget, defaultBudgetPayload } from "./ctoBudget.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "index.mjs"), "utf8");

// Walks the deps object literal that opens at `openMarker` (the first `{`
// after the marker's call site) and returns its source, balancing braces
// with quote AND comment awareness. Returns "" when the marker is absent.
// The comment awareness matters: an apostrophe inside a deps comment (e.g.
// "the poller's pct observation") used to open a phantom quote and derail
// the brace walk across the rest of the file — any unrelated edit after the
// block could flip this gate (BET-1464).
function depsBlock(source, openMarker) {
  const call = source.indexOf(openMarker);
  if (call === -1) return "";
  const open = source.indexOf("{", call);
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const prev = i > 0 ? source[i - 1] : "";
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      // line comment — skip to the newline (apostrophes inside are text)
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

const SEAMS = ["discoverJobPr:", "probeForgePrMerged:"];

test("wiring: both BET-1422 forge seams are passed to the createCtoBudget singleton", () => {
  const block = depsBlock(indexSource, "ctoBudget.createCtoBudget(");
  assert.notEqual(block, "", "index.mjs must construct the budget singleton");
  for (const seam of SEAMS) {
    assert.ok(
      block.includes(seam),
      `${seam} must be wired into the createCtoBudget deps — it only takes effect where refreshRoi() runs`,
    );
  }
});

test("wiring: the forge seams are stranded in no other deps literal", () => {
  const block = depsBlock(indexSource, "computeHealthStats({");
  if (block === "") return; // the health handler moved elsewhere — nothing to assert here
  for (const seam of SEAMS) {
    assert.ok(
      !block.includes(seam),
      `${seam} must not sit in the computeHealthStats deps — that object ignores it (the BET-1422 review Block)`,
    );
  }
});

test("wiring: a budget with the unwired defaults never counts a squash-merged job", async () => {
  let payload = defaultBudgetPayload();
  const store = { load: async () => payload, save: async (p) => (payload = p) };
  const budget = createCtoBudget({
    store,
    // Production-shaped: jobs + git probe wired, the two forge seams left at
    // their unwired defaults — exactly what a singleton without the seams
    // looks like from refreshRoi's seat.
    jobsRead: async () => [
      { id: "j1", actor: "cto", status: "done", branch: "cto/j1", cwd: "/proj", finishedAt: Date.now() },
    ],
    gitProbe: async () => ({ exists: true, isAncestor: false }), // the squash-merge fingerprint
    now: () => Date.now(),
  });
  const snapshot = await budget.refreshRoi();
  const key = Object.keys(snapshot.months)[0];
  assert.equal(snapshot.months[key]?.merged ?? 0, 0, "unwired seams must never count — this is how the Block hid behind green tests");
});
