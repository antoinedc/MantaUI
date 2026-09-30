// Tests for modelLedger.mjs — the read-only spend/latency ledger.
// Pure: all fixtures run against `aggregate`, never a real database. Run via
// `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, aggregateEndpointStats, aggregateBySession, aggregateDailySeries, aggregateHourlySeries, endpointSummary, fetchLedgerRows } from "./modelLedger.mjs";
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

// ---- aggregateHourlySeries (BET-1369) ----

test("aggregateHourlySeries zero-fills hours with no rows, oldest→newest", () => {
  // now = a known local time; put one row on the current hour and one 2h prior.
  const now = new Date(2026, 7, 24, 14, 30, 0).getTime(); // Aug 24 2026 14:30
  const twoHoursAgo = new Date(2026, 7, 24, 12, 45, 0).getTime();
  const out = aggregateHourlySeries(
    [
      srow({ startedMs: now, input: 1, cacheRead: 0, cacheWrite: 0, output: 9 }),
      srow({ startedMs: twoHoursAgo, input: 5, cacheRead: 5, cacheWrite: 5, output: 5 }),
    ],
    24,
    now,
  );
  assert.equal(out.length, 24);
  assert.equal(out[0].hour, "2026-08-23T15"); // oldest bucket is 23h before now
  assert.equal(out[0].tokensSent, 0); // no row in the oldest hour
  assert.equal(out[2].hour, "2026-08-23T17");
  assert.equal(out[2].tokensSent, 0); // no row
  assert.equal(out[23].hour, "2026-08-24T14"); // newest = the current hour
  assert.equal(out[23].tokensSent, 10); // 1+9
  assert.equal(out[21].hour, "2026-08-24T12");
  assert.equal(out[21].tokensSent, 20); // 5+5+5+5
  // oldest→newest
  for (let i = 0; i < out.length - 1; i++) assert.ok(out[i].hour < out[i + 1].hour);
});

test("aggregateHourlySeries default window is 24 hours", () => {
  const now = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const out = aggregateHourlySeries([], 24, now);
  assert.equal(out.length, 24);
  assert.equal(out[0].hour, "2026-01-04T10");
  assert.equal(out[23].hour, "2026-01-05T09");
});

test("aggregateHourlySeries bucket boundary: a row at a fractional minute lands in its own hour", () => {
  const now = new Date(2026, 0, 5, 12, 0, 0).getTime();
  const rowMs = new Date(2026, 0, 5, 10, 59, 0).getTime();
  const out = aggregateHourlySeries([srow({ startedMs: rowMs, input: 3 })], 24, now);
  // out[23] is the hour of `now` (12:00) → 11; the row at 10:59 belongs to the
  // 10:00 hour, which is 2 buckets before 12:00 → out[21].
  assert.equal(out[23].hour, "2026-01-05T12");
  assert.equal(out[22].hour, "2026-01-05T11");
  assert.equal(out[22].tokensSent, 0);
  assert.equal(out[21].hour, "2026-01-05T10");
  assert.equal(out[21].tokensSent, 3);
});

test("aggregateHourlySeries over a DST 'spring forward' day yields exactly 24 buckets", () => {
  // 2026-03-08 12:00 local (US DST spring-forward, a 23-hour day).
  // recentBucketKeys walks with setHours, so the 23-hour day neither duplicates
  // nor skips a bucket — it yields exactly 24 strictly-increasing hour keys.
  const now = new Date(2026, 2, 8, 12, 0, 0).getTime();
  const out = aggregateHourlySeries([], 24, now);
  assert.equal(out.length, 24);
  // i=0 → the hour of `now`; i=23 → setHours(12-23=-11) wraps to 2026-03-07T13
  // (23 real hours back across the 23-hour day).
  assert.equal(out[0].hour, "2026-03-07T13");
  assert.equal(out[23].hour, "2026-03-08T12");
  for (let i = 0; i < out.length - 1; i++) assert.ok(out[i].hour < out[i + 1].hour);
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

// ---- fetchLedgerRows projected-query parity (BET-1358) ----
//
// fetchLedgerRows was optimized from "stream full `data` blobs + JSON.parse +
// role-filter in JS" to a SQL json_extract projection. These DB-backed tests
// prove the projected rows are the exact same flat SHAPE the old JS-parse path
// produced (deep-compare on well-formed rows) and that aggregate() totals are
// byte-identical even with absent/null cost+token fields and missing time —
// while a non-assistant (and a malformed-JSON) message stays excluded.
//
// Reference: the pre-BET-1358 fetchLedgerRows (assistantRows + JSON.parse +
// role filter + JS shape mapping). Mirrors the removed implementation so the
// new SQL projection can be compared against "what it used to produce".
async function legacyFetchLedgerRows(db, sinceMs) {
  const sql = `
    SELECT m.id AS msg_id, m.data AS msg_data,
           s.id AS session_id, s.parent_id AS parent_id,
           s.agent AS agent, s.directory AS directory
    FROM message m JOIN session s ON s.id = m.session_id
    WHERE m.time_created >= ?`;
  const stmt = db.prepare(sql);
  const out = [];
  for (const row of stmt.all(sinceMs)) {
    let data;
    try {
      data = JSON.parse(row.msg_data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || data.role !== "assistant") continue;
    const tokens = data.tokens ?? {};
    const cache = tokens.cache ?? {};
    out.push({
      providerID: data.providerID ?? null,
      modelID: data.modelID ?? null,
      sessionID: row.session_id != null ? String(row.session_id) : null,
      agent: row.agent ?? null,
      parentId: row.parent_id != null ? String(row.parent_id) : null,
      directory: row.directory ?? null,
      cost: data.cost,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cacheRead: cache.read,
      cacheWrite: cache.write,
      startedMs: data.time?.created,
      completedMs: data.time?.completed,
    });
  }
  return out;
}

// Open an opencode-shaped read-only DB seeded from raw message `data` strings
// (so a test can plant genuinely malformed JSON, not just JSON-encoded values).
function openLedgerFixture(DatabaseSync, dbPath, messages, sessions) {
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session (id TEXT, parent_id TEXT, agent TEXT, directory TEXT);
  `);
  const insSess = seed.prepare("INSERT INTO session (id, parent_id, agent, directory) VALUES (?,?,?,?)");
  for (const s of sessions) insSess.run(s.id, s.parentId ?? null, s.agent ?? null, s.directory ?? null);
  const insMsg = seed.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)");
  for (const m of messages) insMsg.run(m.id, m.sessionId, m.ts, m.ts, m.data);
  seed.close();
  return new DatabaseSync(dbPath, { readOnly: true });
}

test("fetchLedgerRows projected query deep-compares to the legacy JS-parse shape on well-formed rows (BET-1358)", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite unavailable on this runtime");
    return;
  }
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "manta-ledger-shape-"));
  const now = Date.now();
  const messages = [
    { id: "a1", sessionId: "s1", ts: now - 5000, data: JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-sonnet", cost: 0.05, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 300 } }, time: { created: now - 4000, completed: now - 3900 } }) },
    { id: "a2", sessionId: "s2", ts: now - 3000, data: JSON.stringify({ role: "assistant", providerID: "openai", modelID: "gpt-4o", cost: 0.2, tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now - 2000, completed: now - 1800 } }) },
    { id: "u1", sessionId: "s1", ts: now - 2000, data: JSON.stringify({ role: "user", content: "hi" }) },
    { id: "bad", sessionId: "s1", ts: now - 1000, data: "{not json" },
  ];
  const sessions = [
    { id: "s1", parentId: null, agent: "build", directory: "/w1" },
    { id: "s2", parentId: "child-of-s1", agent: "build", directory: "/w2" },
  ];
  try {
    const db = openLedgerFixture(DatabaseSync, join(dir, "opencode.db"), messages, sessions);
    try {
      const projected = await fetchLedgerRows(db, now - 60_000);
      const legacy = await legacyFetchLedgerRows(db, now - 60_000);
      assert.deepEqual(projected, legacy);
      assert.equal(projected.length, 2);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchLedgerRows: absent/null cost+token fields aggregate to 0 exactly as today; non-assistant and malformed rows excluded (BET-1358)", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite unavailable on this runtime");
    return;
  }
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "manta-ledger-mixed-"));
  const now = Date.now();
  const messages = [
    // Full row: only this one carries cost and cache.
    { id: "a1", sessionId: "s1", ts: now - 5000, data: JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-sonnet", cost: 0.5, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 300 } }, time: { created: now - 4000, completed: now - 3900 } }) },
    // No cost, no tokens, only a start time (no completion).
    { id: "a2", sessionId: "s2", ts: now - 4000, data: JSON.stringify({ role: "assistant", providerID: "openai", modelID: "gpt-4o", time: { created: now - 3000 } }) },
    // No cache object, explicit null cost.
    { id: "a3", sessionId: "s2", ts: now - 3000, data: JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-haiku", cost: null, tokens: { input: 7, output: 8 } }) },
    // Non-assistant message in the window — must be excluded.
    { id: "u1", sessionId: "s1", ts: now - 2000, data: JSON.stringify({ role: "user", content: "hello" }) },
    // Malformed JSON — must be skipped, never throw.
    { id: "bad", sessionId: "s1", ts: now - 1000, data: "{not json" },
  ];
  const sessions = [
    { id: "s1", parentId: null, agent: "build", directory: "/w1" },
    { id: "s2", parentId: null, agent: "build", directory: "/w2" },
  ];
  try {
    const db = openLedgerFixture(DatabaseSync, join(dir, "opencode.db"), messages, sessions);
    try {
      const projected = await fetchLedgerRows(db, now - 60_000);
      const legacy = await legacyFetchLedgerRows(db, now - 60_000);
      assert.equal(projected.length, 3);
      assert.equal(legacy.length, 3);
      // Both implementations must fold to byte-identical aggregate totals
      // (absent/null cost+token leaves become 0 via num(), as they always did).
      assert.deepEqual(aggregate(projected), aggregate(legacy));
      const totals = aggregate(projected).totals;
      assert.equal(totals.turns, 3);
      assert.equal(totals.cost, 0.5);
      assert.equal(totals.input, 107); // 100 + 0 + 7
      assert.equal(totals.output, 58); // 50 + 0 + 8
      assert.equal(totals.cacheRead, 200);
      assert.equal(totals.cacheWrite, 300);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- incremental ledger row cache ----
//
// fetchLedgerRows is served from an in-memory cache that is warmed in small
// yielding pages and refreshed incrementally. These tests use a real in-memory
// SQLite with opencode's shape (incl. the (session_id,time_created,id) index and
// session.time_updated) and count queries by wrapping db.prepare.
{
  const { createLedgerRowCache, ledgerRescanFloor, selectSessionsToScan, mergeLedgerEntries } = await import("./modelLedger.mjs");
  let SqliteMod = null;
  try {
    SqliteMod = await import("node:sqlite");
  } catch {
    SqliteMod = null;
  }

  const asst = (o = {}) => JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-sonnet", cost: 0.1, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 30 } }, time: { created: o.created ?? 1, completed: o.completed }, ...(o.extra ?? {}) });

  function memDb() {
    const db = new SqliteMod.DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, directory TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
    `);
    const api = {
      db,
      session(id, { parentId = null, agent = "build", directory = "/w", updated = 1 } = {}) {
        db.prepare("INSERT OR REPLACE INTO session VALUES (?,?,?,?,?)").run(id, parentId, agent, directory, updated);
      },
      touch(id, updated) {
        db.prepare("UPDATE session SET time_updated=? WHERE id=?").run(updated, id);
      },
      msg(id, sid, ts, data) {
        db.prepare("INSERT OR REPLACE INTO message VALUES (?,?,?,?,?)").run(id, sid, ts, ts, data);
      },
    };
    return api;
  }

  // Wrap prepare() so a test can count message-table page queries.
  function spy(db) {
    const counts = { pages: 0, sessions: 0 };
    const orig = db.prepare.bind(db);
    db.prepare = (sql) => {
      const st = orig(sql);
      const kind = /FROM message/.test(sql) ? "pages" : /FROM session/.test(sql) ? "sessions" : null;
      if (!kind) return st;
      const all = st.all.bind(st);
      st.all = (...a) => {
        counts[kind]++;
        return all(...a);
      };
      return st;
    };
    return counts;
  }

  const skip = (t) => {
    if (!SqliteMod) {
      t.skip("node:sqlite unavailable on this runtime");
      return true;
    }
    return false;
  };
  const clockNow = () => {
    const c = { t: 1_000_000 };
    c.now = () => c.t;
    return c;
  };
  // The SQL json_extract projection (old and new) yields null for absent fields
  // where the legacy JS path yielded undefined; compare on the SQL convention.
  const nullify = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === undefined ? null : v])));
  const sortRows = (rows) => nullify([...rows]).sort((a, b) => String(a.sessionID + a.startedMs).localeCompare(String(b.sessionID + b.startedMs)));

  test("ledger cache: warm load returns the same rows as the legacy query (multi-page)", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    f.session("s1", { agent: "build", directory: "/w1" });
    f.session("s2", { parentId: "s1", agent: "plan", directory: "/w2" });
    for (let i = 0; i < 25; i++) f.msg(`a${i}`, "s1", 1000 + i, asst({ created: 1000 + i, completed: 1100 + i }));
    for (let i = 0; i < 7; i++) f.msg(`b${i}`, "s2", 2000 + i, asst({ created: 2000 + i, completed: 2100 + i }));
    f.msg("u1", "s1", 1500, JSON.stringify({ role: "user" }));
    f.msg("bad", "s1", 1501, "{not json");
    f.msg("orphan", "ghost", 1502, asst({ created: 1502 }));
    const clk = clockNow();
    const cache = createLedgerRowCache({ pageRows: 4, now: clk.now });
    const got = await cache.fetchRows(f.db, 0);
    const legacy = await legacyFetchLedgerRows(f.db, 0);
    assert.equal(got.length, 32);
    assert.deepEqual(sortRows(got), sortRows(legacy));
  });

  test("ledger cache: sinceMs filters on message time_created like the old query", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    f.session("s1");
    f.msg("m1", "s1", 100, asst({ created: 5000 })); // data.time.created deliberately unrelated
    f.msg("m2", "s1", 200, asst({ created: 1 }));
    f.msg("m3", "s1", 300, asst({ created: 2 }));
    const cache = createLedgerRowCache({ now: clockNow().now });
    for (const since of [0, 100, 101, 200, 300, 301]) {
      assert.deepEqual(sortRows(await cache.fetchRows(f.db, since)), sortRows(await legacyFetchLedgerRows(f.db, since)), `since=${since}`);
    }
  });

  test("ledger cache: TTL prevents re-querying inside the window; refresh after it picks up new + completed rows", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    const clk = clockNow();
    f.session("s1", { updated: 10 });
    f.msg("m1", "s1", clk.t - 5000, asst({ created: clk.t - 5000, completed: clk.t - 4000 }));
    f.msg("m2", "s1", clk.t - 100, asst({ created: clk.t - 100 })); // still running
    const counts = spy(f.db);
    const cache = createLedgerRowCache({ ttlMs: 25_000, now: clk.now });
    let rows = await cache.fetchRows(f.db, 0);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.startedMs === clk.t - 100).completedMs, null);
    const warmPages = counts.pages;
    const warmSessions = counts.sessions;
    assert.ok(warmPages >= 1);

    // Data changes, but inside the TTL nothing is re-read.
    f.msg("m2", "s1", clk.t - 100, asst({ created: clk.t - 100, completed: clk.t + 500 }));
    f.msg("m3", "s1", clk.t + 10, asst({ created: clk.t + 10, completed: clk.t + 20 }));
    clk.t += 10_000;
    rows = await cache.fetchRows(f.db, 0);
    assert.equal(rows.length, 2);
    assert.equal(counts.pages, warmPages);
    assert.equal(counts.sessions, warmSessions);

    // Past the TTL the session (still holding an unfinished row) is re-scanned.
    clk.t += 20_000;
    rows = await cache.fetchRows(f.db, 0);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => typeof r.completedMs === "number"), "the previously-incomplete row picked up its completion");
    assert.ok(counts.pages > warmPages);
  });

  test("ledger cache: refresh only re-reads sessions whose time_updated moved (no unfinished rows)", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    const clk = clockNow();
    f.session("s1", { updated: 10 });
    f.session("s2", { updated: 10 });
    f.msg("a", "s1", clk.t - 1000, asst({ created: 1, completed: 2 }));
    f.msg("b", "s2", clk.t - 1000, asst({ created: 1, completed: 2 }));
    const counts = spy(f.db);
    const cache = createLedgerRowCache({ ttlMs: 1000, now: clk.now });
    await cache.fetchRows(f.db, 0);
    const afterWarm = counts.pages;
    assert.equal(afterWarm, 2, "one page per session on warm");

    clk.t += 5000;
    await cache.fetchRows(f.db, 0);
    assert.equal(counts.pages, afterWarm, "nothing moved → no message queries");

    f.msg("c", "s2", clk.t - 10, asst({ created: 3, completed: 4 }));
    f.touch("s2", 20);
    clk.t += 5000;
    const rows = await cache.fetchRows(f.db, 0);
    assert.equal(rows.length, 3);
    assert.equal(counts.pages, afterWarm + 1, "only s2 re-scanned");
  });

  test("ledger cache: single-flight — concurrent callers during warm-up share one load", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    f.session("s1");
    f.session("s2");
    f.msg("a", "s1", 10, asst({ created: 1, completed: 2 }));
    f.msg("b", "s2", 10, asst({ created: 1, completed: 2 }));
    const counts = spy(f.db);
    const cache = createLedgerRowCache({ now: clockNow().now });
    const [r1, r2, r3] = await Promise.all([cache.fetchRows(f.db, 0), cache.fetchRows(f.db, 0), cache.latestBySession(f.db, ["s1"])]);
    assert.equal(r1.length, 2);
    assert.equal(r2.length, 2);
    assert.equal(r3.size, 1);
    assert.equal(counts.sessions, 1, "one session listing");
    assert.equal(counts.pages, 2, "each session paged once, not once per caller");
  });

  test("ledger cache: warm load yields to the event loop between pages", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    f.session("s1");
    for (let i = 0; i < 40; i++) f.msg(`a${i}`, "s1", 100 + i, asst({ created: i, completed: i + 1 }));
    let yields = 0;
    let tick = 0;
    const cache = createLedgerRowCache({
      pageRows: 5,
      yieldBudgetMs: 0,
      now: clockNow().now,
      clock: () => ++tick,
      yieldFn: async () => {
        yields++;
      },
    });
    const rows = await cache.fetchRows(f.db, 0);
    assert.equal(rows.length, 40);
    assert.ok(yields >= 7, `expected a yield per page, got ${yields}`);
  });

  test("ledger cache: deleted session and deleted message drop out after refresh; failed cold load throws then retries", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    const clk = clockNow();
    f.session("s1", { updated: 1 });
    f.session("s2", { updated: 1 });
    f.msg("a", "s1", clk.t - 10, asst({ created: 1, completed: 2 }));
    f.msg("b", "s1", clk.t - 5, asst({ created: 1, completed: 2 }));
    f.msg("c", "s2", clk.t - 10, asst({ created: 1, completed: 2 }));
    const cache = createLedgerRowCache({ ttlMs: 1000, now: clk.now });
    assert.equal((await cache.fetchRows(f.db, 0)).length, 3);
    f.db.prepare("DELETE FROM session WHERE id='s2'").run();
    f.db.prepare("DELETE FROM message WHERE id='b'").run();
    f.touch("s1", 5);
    clk.t += 5000;
    assert.deepEqual((await cache.fetchRows(f.db, 0)).map((r) => r.sessionID), ["s1"]);

    // Failed cold load: throws (callers' degrade path), leaves nothing half-loaded.
    const g = memDb();
    g.session("s1");
    g.msg("a", "s1", 10, asst({ created: 1, completed: 2 }));
    const origPrepare = g.db.prepare.bind(g.db);
    let fail = true;
    g.db.prepare = (sql) => {
      if (fail && /FROM message/.test(sql)) throw new Error("boom");
      return origPrepare(sql);
    };
    const c2 = createLedgerRowCache({ now: clockNow().now });
    await assert.rejects(() => c2.fetchRows(g.db, 0), /boom/);
    fail = false;
    assert.equal((await c2.fetchRows(g.db, 0)).length, 1);
  });

  test("ledger cache: a failed refresh keeps serving the cache", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    const clk = clockNow();
    f.session("s1", { updated: 1 });
    f.msg("a", "s1", 10, asst({ created: 1, completed: 2 }));
    const cache = createLedgerRowCache({ ttlMs: 1000, now: clk.now });
    assert.equal((await cache.fetchRows(f.db, 0)).length, 1);
    const orig = f.db.prepare.bind(f.db);
    f.db.prepare = () => {
      throw new Error("db gone");
    };
    clk.t += 5000;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await cache.fetchRows(f.db, 0)).length, 1);
    } finally {
      console.warn = warn;
      f.db.prepare = orig;
    }
  });

  test("ledger cache: latestBySession picks the newest completed row per session at any age", async (t) => {
    if (skip(t)) return;
    const f = memDb();
    f.session("s1");
    f.session("s2");
    f.msg("a", "s1", 10, asst({ created: 1, completed: 500, extra: { modelID: "old" } }));
    f.msg("b", "s1", 20, asst({ created: 2, completed: 900, extra: { modelID: "new" } }));
    f.msg("c", "s1", 30, asst({ created: 3, completed: 700, extra: { modelID: "mid" } }));
    f.msg("d", "s2", 40, asst({ created: 4, completed: 10 }));
    const cache = createLedgerRowCache({ now: clockNow().now });
    const m = await cache.latestBySession(f.db, ["s1", "nope"]);
    assert.equal(m.size, 1);
    assert.equal(m.get("s1").modelID, "new");
    assert.equal(m.get("s1").completedMs, 900);
  });

  test("ledger cache pure helpers: floor, selection, merge", () => {
    assert.equal(ledgerRescanFloor({ known: false, lastRefreshMs: 9e9 }), 0);
    assert.equal(ledgerRescanFloor({ known: true, lastRefreshMs: 10_000_000, overlapMs: 1000 }), 9_999_000);
    assert.equal(ledgerRescanFloor({ known: true, lastRefreshMs: 10_000_000, overlapMs: 1000, incompleteFromMs: 5 }), 5);
    assert.equal(ledgerRescanFloor({ known: true, lastRefreshMs: 100, overlapMs: 1000 }), 0);

    const cached = new Map([
      ["still", { timeUpdated: 5, incompleteFromMs: undefined }],
      ["moved", { timeUpdated: 5, incompleteFromMs: undefined }],
      ["live", { timeUpdated: 5, incompleteFromMs: 90_000 }],
      ["stale", { timeUpdated: 5, incompleteFromMs: 1 }],
    ]);
    const sel = selectSessionsToScan({
      sessionList: [
        { id: "still", timeUpdated: 5 },
        { id: "moved", timeUpdated: 6 },
        { id: "live", timeUpdated: 5 },
        { id: "stale", timeUpdated: 5 },
        { id: "new", timeUpdated: 1 },
      ],
      cached,
      lastRefreshMs: 100_000,
      nowMs: 100_000,
      overlapMs: 1000,
      abandonedMs: 50_000,
    });
    assert.deepEqual(sel.map((s) => s.id).sort(), ["live", "moved", "new"]);
    assert.equal(sel.find((s) => s.id === "new").floor, 0);
    assert.equal(sel.find((s) => s.id === "moved").floor, 99_000);
    assert.equal(sel.find((s) => s.id === "live").floor, 90_000);

    const rows = new Map([
      ["old", { createdMs: 1, row: { completedMs: 5 } }],
      ["gone", { createdMs: 50, row: { completedMs: 5 } }],
      ["run", { createdMs: 60, row: { completedMs: undefined } }],
    ]);
    const inc = mergeLedgerEntries(rows, [{ id: "run", createdMs: 60, row: { completedMs: 70 } }, { id: "new", createdMs: 80, row: {} }], 40);
    assert.deepEqual([...rows.keys()].sort(), ["new", "old", "run"], "deleted row in re-read range dropped; older row kept");
    assert.equal(inc, 80, "the only unfinished row is `new`");
  });
}
