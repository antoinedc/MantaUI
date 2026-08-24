// Tests for modelLedger.mjs — the read-only spend/latency ledger.
// Pure: all fixtures run against `aggregate`, never a real database. Run via
// `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, aggregateEndpointStats, aggregateBySession, aggregateDailySeries, endpointSummary } from "./modelLedger.mjs";
import { _resetDbHandle } from "./opencodeDb.mjs";

// Fixture builder. Fill only the fields a test cares about.
function row(over = {}) {
  return {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    agent: "build",
    parentId: null,
    directory: "/work/proj",
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    startedMs: 0,
    completedMs: 0,
    ...over,
  };
}

const closeTo = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} !≈ ${expected} (±${tol})`);

// Assert every numeric field in the ledger is finite (no NaN/Infinity).
function assertFinite(ledger) {
  const nums = [ledger.totals, ledger.cacheShare, ...ledger.byModel, ...ledger.byAgent, ...ledger.byProject];
  for (const obj of nums) {
    for (const v of Object.values(obj)) {
      if (typeof v === "number") assert.ok(Number.isFinite(v), `non-finite value: ${v}`);
    }
  }
}

test("cache-share fractions sum to 1 and match a hand-computed fixture", () => {
  const ledger = aggregate([
    row({ cost: 1, input: 100, output: 10, cacheRead: 50, cacheWrite: 40 }),
  ]);
  // proxy = 100 + 10 + 50 + 40 = 200
  closeTo(ledger.cacheShare.output, 10 / 200, 1e-9, "output");
  closeTo(ledger.cacheShare.cacheRead, 50 / 200, 1e-9, "cacheRead");
  closeTo(ledger.cacheShare.cacheWrite, 40 / 200, 1e-9, "cacheWrite");
  closeTo(ledger.cacheShare.input, 100 / 200, 1e-9, "input");
  const sum =
    ledger.cacheShare.output + ledger.cacheShare.cacheRead + ledger.cacheShare.cacheWrite + ledger.cacheShare.input;
  closeTo(sum, 1, 1e-3, "sum");
});

test("costPerTurn and tokensPerSec correct on a 3-row fixture", () => {
  const ledger = aggregate([
    row({ providerID: "p", modelID: "m", cost: 6, output: 200, startedMs: 1000, completedMs: 3000 }),
    row({ providerID: "p", modelID: "m", cost: 4, output: 100, startedMs: 2000, completedMs: 4000 }),
    row({ providerID: "p", modelID: "m", cost: 2, output: 300, startedMs: 500, completedMs: 1500 }),
  ]);
  const model = ledger.byModel[0];
  assert.equal(model.key, "p/m");
  assert.equal(model.turns, 3);
  // cost 6+4+2 = 12, / 3 turns
  closeTo(model.costPerTurn, 4, 1e-9, "costPerTurn");
  closeTo(model.outPerTurn, 200, 1e-9, "outPerTurn");
  // output 200+100+300 = 600; durations 2000+2000+1000 ms = 5s → 600/5 = 120
  closeTo(model.tokensPerSec, 120, 1e-9, "tokensPerSec");
  assertFinite(ledger);
});

test("missing/zero/oversize durations are excluded from timing but included in cost", () => {
  const validMs = 5000; // 5s, in budget
  const ledger = aggregate([
    row({ cost: 10, output: 100, startedMs: 100, completedMs: 100 + validMs }), // valid
    row({ cost: 20, output: 100, startedMs: 1000, completedMs: undefined }), // completed missing
    row({ cost: 30, output: 100, startedMs: 1000, completedMs: 1000 }), // zero-length
    row({ cost: 40, output: 100, startedMs: 1000, completedMs: 1000 + 601_000 }), // > 600s
  ]);
  // All four still count for cost.
  assert.equal(ledger.totals.turns, 4);
  closeTo(ledger.totals.cost, 100, 1e-9, "cost");
  const model = ledger.byModel[0];
  closeTo(model.costPerTurn, 25, 1e-9, "costPerTurn");
  // Timing uses only the single valid row: output 100, duration 5s → 20 tok/s.
  closeTo(model.tokensPerSec, 100 / 5, 1e-9, "tokensPerSec");
  // 1 timed turn < 5 → percentiles null.
  assert.equal(model.p50Ms, null);
  assert.equal(model.p90Ms, null);
  assertFinite(ledger);
});

test("p50/p90 are null below 5 timed turns, finite above", () => {
  const few = aggregate([
    row({ startedMs: 0, completedMs: 100 }),
    row({ startedMs: 0, completedMs: 200 }),
  ]);
  assert.equal(few.byModel[0].p50Ms, null);
  assert.equal(few.byModel[0].p90Ms, null);

  const five = aggregate([
    row({ startedMs: 1000, completedMs: 1100 }),
    row({ startedMs: 1000, completedMs: 1200 }),
    row({ startedMs: 1000, completedMs: 1300 }),
    row({ startedMs: 1000, completedMs: 1400 }),
    row({ startedMs: 1000, completedMs: 1500 }),
  ]);
  assert.equal(typeof five.byModel[0].p50Ms, "number");
  assert.equal(typeof five.byModel[0].p90Ms, "number");
  assertFinite(five);
});

test("empty input yields all zeros and no NaN", () => {
  const ledger = aggregate([]);
  assert.equal(ledger.totals.turns, 0);
  assert.equal(ledger.totals.cost, 0);
  assert.equal(ledger.totals.input, 0);
  assert.equal(ledger.totals.output, 0);
  assert.equal(ledger.totals.cacheRead, 0);
  assert.equal(ledger.totals.cacheWrite, 0);
  assert.equal(ledger.byModel.length, 0);
  assert.equal(ledger.byAgent.length, 0);
  assert.equal(ledger.byProject.length, 0);
  // Explicit NaN/Infinity assertion (test 5).
  for (const v of Object.values(ledger.totals)) assert.ok(Number.isFinite(v));
  for (const v of Object.values(ledger.cacheShare)) assert.ok(Number.isFinite(v));
});

test("byAgent marks isChild correctly from parentId", () => {
  const ledger = aggregate([
    row({ agent: "explore", parentId: "ses-child" }), // subagent session
    row({ agent: "explore", parentId: "ses-child" }),
    row({ agent: "build", parentId: null }), // top-level session
    row({ agent: "general", providerID: "x", modelID: "y", parentId: "ses-2" }),
  ]);
  const byAgent = Object.fromEntries(ledger.byAgent.map((a) => [a.agent, a]));
  assert.equal(byAgent.explore.isChild, true);
  assert.equal(byAgent.build.isChild, false);
  assert.equal(byAgent.general.isChild, true);
  assertFinite(ledger);
});

test("every array is sorted by cost descending", () => {
  const ledger = aggregate([
    row({ providerID: "a", modelID: "a", cost: 5, agent: "one", directory: "/x", startedMs: 0, completedMs: 100 }),
    row({ providerID: "a", modelID: "b", cost: 9, agent: "two", directory: "/y", startedMs: 0, completedMs: 100 }),
    row({ providerID: "a", modelID: "c", cost: 2, agent: "three", directory: "/z", startedMs: 0, completedMs: 100 }),
  ]);
  const desc = (arr, get) => arr.every((v, i) => i === 0 || get(arr[i - 1]) >= get(v));
  assert.ok(desc(ledger.byModel, (m) => m.cost));
  assert.ok(desc(ledger.byAgent, (a) => a.cost));
  assert.ok(desc(ledger.byProject, (p) => p.cost));
  assert.equal(ledger.byModel[0].key, "a/b");
});

// ---- aggregateBySession (Optimizer P1.1) ----
// Rows are the flat ledger rows from fetchLedgerRows (sessionID + tokens).

function srow(over = {}) {
  return {
    sessionID: "s1",
    cost: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    startedMs: 0,
    ...over,
  };
}

test("aggregateBySession orders by cost descending and caps at the top 20", () => {
  // 25 sessions, all cost 1 except the first two (higher cost) — expect the
  // highest-cost one first, then exactly 20 entries.
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push(srow({ sessionID: `s${String(i).padStart(2, "0")}`, cost: 1 }));
  }
  rows.push(srow({ sessionID: "hot", cost: 50 }));
  rows.push(srow({ sessionID: "warm", cost: 30 }));

  const out = aggregateBySession(rows);
  assert.equal(out.length, 20);
  assert.equal(out[0].sessionID, "hot");
  assert.equal(out[1].sessionID, "warm");
  // The rest are descending by cost, all equal (1).
  for (let i = 1; i < out.length - 1; i++) {
    assert.ok(out[i].cost >= out[i + 1].cost, "cost must be non-increasing");
  }
});

test("aggregateBySession folds tokensSent = input + cacheRead + cacheWrite + output and collapses null session", () => {
  const out = aggregateBySession([
    srow({ sessionID: "a", input: 1, cacheRead: 2, cacheWrite: 3, output: 4, cost: 5 }),
    srow({ sessionID: "a", input: 10, cacheRead: 0, cacheWrite: 0, output: 0, cost: 1 }),
    srow({ sessionID: null, input: 100, cacheRead: 0, cacheWrite: 0, output: 0, cost: 2 }),
    srow({ sessionID: null, input: 0, cacheRead: 0, cacheWrite: 0, output: 50, cost: 2 }),
  ]);
  const a = out.find((e) => e.sessionID === "a");
  const nul = out.find((e) => e.sessionID === null);
  assert.deepEqual(a, { sessionID: "a", turns: 2, cost: 6, tokensSent: 20 });
  // null sessions collapse into ONE bucket so spend is never dropped.
  assert.deepEqual(nul, { sessionID: null, turns: 2, cost: 4, tokensSent: 150 });
});

// ---- aggregateDailySeries (Optimizer P1.1) ----

test("aggregateDailySeries zero-fills days with no rows, oldest→newest", () => {
  // now = a known local date; put one row on today and one 2 days ago.
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime(); // Aug 24 2026
  const twoDaysAgo = new Date(2026, 7, 22, 12, 0, 0).getTime();
  const out = aggregateDailySeries(
    [
      srow({ startedMs: now, input: 1, cacheRead: 0, cacheWrite: 0, output: 9 }),
      srow({ startedMs: twoDaysAgo, input: 5, cacheRead: 5, cacheWrite: 5, output: 5 }),
    ],
    5,
    now,
  );
  assert.equal(out.length, 5);
  assert.equal(out[0].day, "2026-08-20");
  assert.equal(out[0].tokensSent, 0); // no row
  assert.equal(out[2].day, "2026-08-22");
  assert.equal(out[2].tokensSent, 20); // 5+5+5+5
  assert.equal(out[4].day, "2026-08-24");
  assert.equal(out[4].tokensSent, 10); // 1+9
  // oldest→newest
  for (let i = 0; i < out.length - 1; i++) assert.ok(out[i].day < out[i + 1].day);
});

test("aggregateDailySeries default window is 30 days", () => {
  const now = new Date(2026, 0, 5).getTime();
  const out = aggregateDailySeries([], 30, now);
  assert.equal(out.length, 30);
  assert.equal(out[0].day, "2025-12-07");
  assert.equal(out[29].day, "2026-01-05");
});

test("aggregateDailySeries tokensSent formula: input=1,cacheRead=2,cacheWrite=3,output=4 → 10", () => {
  const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
  const out = aggregateDailySeries(
    [srow({ startedMs: now, input: 1, cacheRead: 2, cacheWrite: 3, output: 4 })],
    1,
    now,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].tokensSent, 10);
});

// ---- aggregateEndpointStats (per-endpoint reliability/speed/latency/mix) ----

const readTool = {
  name: "read",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

test("aggregateEndpointStats produces the per-endpoint shape over fixture rows", () => {
  const stats = aggregateEndpointStats([
    // Endpoint A, request 1 — one clean tool call, 200 output tokens in 1s.
    {
      providerID: "anthropic", modelID: "claude-sonnet",
      input: 100, output: 200, cacheRead: 50, cacheWrite: 40,
      startedMs: 1000, completedMs: 2000,
      toolCalls: [{ name: "read", arguments: { path: "/a" } }], tools: [readTool],
    },
    // Endpoint A, request 2 — two calls, one bogus → the WHOLE request errors.
    {
      providerID: "anthropic", modelID: "claude-sonnet",
      input: 50, output: 300, cacheRead: 0, cacheWrite: 0,
      startedMs: 1000, completedMs: 2000,
      toolCalls: [
        { name: "read", arguments: { path: "/b" } },
        { name: "bogus", arguments: {} },
      ],
      tools: [readTool],
    },
    // Endpoint B — a single clean request, distinct model.
    {
      providerID: "anthropic", modelID: "claude-opus",
      input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
      startedMs: 1000, completedMs: 2000,
      toolCalls: [{ name: "read", arguments: { path: "/c" } }], tools: [readTool],
    },
  ]);

  const sonnet = stats["anthropic/claude-sonnet"];
  // Two tool-ending requests; the second is errored → requests 2, errored 1.
  assert.deepEqual(sonnet.reliability, { requests: 2, errored: 1, rate: 0.5 });
  // mix: raw token-count sums.
  assert.deepEqual(sonnet.mix, { input: 150, output: 500, cacheRead: 50, cacheWrite: 40 });
  // Timing reflects two 1s timed turns.
  assert.equal(typeof sonnet.latency.p50Ms, "number");
  assert.equal(typeof sonnet.latency.p90Ms, "number");
  assert.equal(typeof sonnet.speed.p50TokensPerSec, "number");
  assert.equal(typeof sonnet.speed.p90TokensPerSec, "number");

  const opus = stats["anthropic/claude-opus"];
  assert.deepEqual(opus.reliability, { requests: 1, errored: 0, rate: 0 });

  // Rows without tool calls do not inflate reliability.
  const clean = aggregateEndpointStats([
    { providerID: "p", modelID: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolCalls: [], tools: [] },
    { providerID: "p", modelID: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ]);
  assert.deepEqual(clean["p/m"].reliability, { requests: 0, errored: 0, rate: 0 });
  assert.equal(clean["p/m"].latency.p50Ms, null); // no timed turns
});

test("endpointSummary returns { supported:false } with no zeros when the DB is unavailable", async () => {
  const prev = process.env.MANTA_OPENCODE_DB;
  process.env.MANTA_OPENCODE_DB = "/nonexistent/opencode.db";
  _resetDbHandle();
  try {
    const res = await endpointSummary();
    // A `supported:false` card must not look like "perfect reliability" — no
    // zeros smuggled in, no per-endpoint numbers at all.
    assert.deepEqual(res, { supported: false });
    assert.equal("reliability" in res, false);
  } finally {
    if (prev === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prev;
    _resetDbHandle();
  }
});

test("endpointSummary reads tool calls from the part table so reliability is measured, not uniformly 0 (BET-1297)", async (t) => {
  // opencode stores a message's tool parts in the separate `part` table, not
  // in `message.data` (which has no `parts` array). Before this fix the ledger
  // read `data.parts`, measured zero tool-call requests on every endpoint, and
  // every reliability rate came back 0. This seeds a real DB with tool parts
  // and asserts they reach aggregateReliability. It needs node:sqlite (Node
  // 22.5+); on the CI runtime (Node 20) node:sqlite is absent and the ledger
  // correctly degrades to { supported:false } — nothing to assert, so skip.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite unavailable on this runtime — endpointSummary degrades to unsupported");
    return;
  }
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "manta-ledger-"));
  const dbPath = join(dir, "opencode.db");
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE session (id TEXT, parent_id TEXT, agent TEXT, directory TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    const now = Date.now();
    seed.prepare("INSERT INTO session (id, parent_id, agent, directory) VALUES (?,?,?,?)").run("s1", null, "build", "/w");
    const insMsg = seed.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)");
    const insPart = seed.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)");
    const msgMeta = { role: "assistant", providerID: "anthropic", modelID: "claude-sonnet", tokens: { input: 10, output: 20, cache: { read: 0, write: 0 } }, time: { created: now - 2000, completed: now - 1000 } };
    insMsg.run("a1", "s1", now, now, JSON.stringify({ ...msgMeta }));
    insMsg.run("a2", "s1", now, now, JSON.stringify({ ...msgMeta }));
    // Request 1: clean object arguments -> valid.
    insPart.run("p1", "a1", "s1", now, now, JSON.stringify({ type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { path: "/a" } } }));
    // Request 2: arguments are a string that fails JSON.parse -> invalid-json,
    // an errored request (its whole request errors per aggregateReliability).
    insPart.run("p2", "a2", "s1", now, now, JSON.stringify({ type: "tool", tool: "read", callID: "c2", state: { status: "completed", input: "{not json}" } }));
    seed.close();

    const prev = process.env.MANTA_OPENCODE_DB;
    process.env.MANTA_OPENCODE_DB = dbPath;
    _resetDbHandle();
    try {
      const res = await endpointSummary({ sinceMs: now - 60_000 });
      assert.equal(res.supported, true);
      const ep = res.endpoints?.["anthropic/claude-sonnet"];
      assert.ok(ep, "expected the endpoint to be measured");
      // Two tool-ending requests, one malformed -> requests 2, errored 1.
      assert.deepEqual(ep.reliability, { requests: 2, errored: 1, rate: 0.5 });
    } finally {
      if (prev === undefined) delete process.env.MANTA_OPENCODE_DB;
      else process.env.MANTA_OPENCODE_DB = prev;
      _resetDbHandle();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
