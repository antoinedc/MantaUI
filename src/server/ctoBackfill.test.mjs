// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// Tests for ctoBackfill.mjs — the cold-start backfill (BET-1387, spec §10.6-4).
// Pure + injectable: guardrails (watermark exclusivity, spend-bound stop with a
// persisted reason, once-per-box marker, progress math) are tested against
// fakes and an in-memory SQLite fixture — never the real box stores.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetState,
  computeProgress,
  createCtoBackfill,
  depthDaysAt,
  DEFAULT_BACKFILL_CAP_USD,
  DEFAULT_BACKFILL_DAYS,
  historyWindow,
  sessionInRange,
  sumCost,
} from "./ctoBackfill.mjs";

const DAY = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

function memStore(seed) {
  const data = { ...(seed ?? {}) };
  return {
    load: async () => ({ ...data }),
    save: async (next) => {
      Object.assign(data, next);
      return data;
    },
    _data: data,
  };
}

// DirJson-style file store (segments/rollups): save(id, value) / load(id).
function memFileStore() {
  const data = new Map();
  return {
    load: async (id) => data.get(id) ?? null,
    save: async (id, value) => {
      data.set(id, value);
      return value;
    },
    _data: data,
  };
}

const noopLedger = { append: async () => {} };

// A memory-backed SQLite fixture (node:sqlite). Returns { db, close } or null
// when node:sqlite is unavailable (degrade the whole test file to skip).
async function openFixture() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const db = new DatabaseSync(":memory:");
  // OpenCode V2 store: session_v2 + session_message (user | assistant rows).
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  let seq = 0;
  return {
    db,
    insSession(id, { agent = "build", directory = "/w" } = {}) {
      db.prepare("INSERT INTO session_v2 (id, parent_id, agent, directory, time_created) VALUES (?,?,?,?,?)").run(id, null, agent, directory, 0);
    },
    insMessage(id, sessionId, { role, ts, cost = 0, text = "" }) {
      // user → {text}; assistant → model/cost/tokens (a user message carries the text).
      const data = role === "user"
        ? { text, time: { created: ts } }
        : { agent: "build", model: { providerID: "anthropic", id: "claude-sonnet" }, cost, tokens: { input: 1, output: 1 }, time: { created: ts, completed: ts }, content: [] };
      db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)").run(
        id, sessionId, role, ++seq, ts, ts, JSON.stringify(data),
      );
    },
  };
}

// A valid segment-summary producer (returns a real summary, so the segmenter
// persists a non-degraded segment).
function validSummarize() {
  return async (data) => ({
    ok: true,
    summary: {
      v: 1,
      sessionID: data.sessionID,
      project: data.project,
      window: [data.start, data.end],
      intent: "task",
      outcome: "done",
      key_events: [],
      files_touched: [],
      prs: [],
      importance: 3,
      one_liner: (data.oneLiner || "work").slice(0, 140),
    },
  });
}

const PRESENT = async () => true;
const AWAY = async () => false;

// The standard replay backfill over the fixture db: cto enabled, quiet
// ledger/rollups, away-presence, in-memory engine state + segment files,
// `oneLiner` as the fake segmenter's one-liner.
function makeReplayBackfill(fx, { NOW, oneLiner }) {
  const engineState = memStore();
  const segments = memFileStore();
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    segments,
    rollups: { save: async () => {}, load: async () => null, dir: "/tmp/none" },
    summarize: validSummarize(),
    computeOneLiner: async () => oneLiner,
    getDb: async () => fx.db,
    presenceCheck: AWAY,
    now: () => NOW,
    maxSessionsPerStep: 100,
  });
  return { engineState, segments, backfill };
}

// ---------------------------------------------------------------------------
// Pure guardrail tests
// ---------------------------------------------------------------------------

test("historyWindow / sessionInRange: watermark exclusivity — only ts strictly < startInstant and >= historyStart is in range", () => {
  const startInstant = 10_000;
  const depth = 3;
  const win = historyWindow({ startInstant, depthDays: depth });
  assert.equal(win.start, startInstant - depth * DAY);
  assert.equal(win.end, startInstant);

  assert.equal(sessionInRange(startInstant - 1, win), true, "just under the watermark is owned by the backfill");
  assert.equal(sessionInRange(startInstant, win), false, "exactly the watermark belongs to LIVE ingestion — no overlap");
  assert.equal(sessionInRange(startInstant + 1, win), false, "after the watermark is live");
  assert.equal(sessionInRange(win.start, win), true, "depth boundary included");
  assert.equal(sessionInRange(win.start - 1, win), false, "older than the depth is out of range");
  assert.equal(sessionInRange(NaN, win), false);
});

test("budgetState: exceeded flips at spent >= cap and clamps negatives/NaN", () => {
  assert.equal(budgetState({ spentUsd: DEFAULT_BACKFILL_CAP_USD, capUsd: DEFAULT_BACKFILL_CAP_USD }).exceeded, true);
  assert.equal(budgetState({ spentUsd: DEFAULT_BACKFILL_CAP_USD - 0.01, capUsd: DEFAULT_BACKFILL_CAP_USD }).exceeded, false);
  assert.equal(budgetState({ spentUsd: -5, capUsd: 3 }).spentUsd, 0, "negative spent clamps to 0");
  assert.equal(budgetState({ spentUsd: NaN, capUsd: 3 }).exceeded, false);
  assert.equal(budgetState({ spentUsd: 1, capUsd: NaN }).exceeded, false, "NaN cap never trips");
  assert.deepEqual(budgetState({ spentUsd: 4, capUsd: 3 }).overBy, 1);
});

test("sumCost sums only finite numeric costs (missing/non-numeric ignored)", () => {
  assert.equal(sumCost([{ cost: 1 }, { cost: 0.5 }, { cost: null }, {}, { cost: NaN }]), 1.5);
  assert.equal(sumCost(undefined), 0);
  assert.equal(sumCost([]), 0);
});

test("computeProgress: math for pct + ETA from the observed rate", () => {
  const p = computeProgress({ done: 0, total: 10, startedAt: 1000, at: 1000 });
  assert.equal(p.pct, 0);
  assert.equal(p.etaMs, null, "no progress yet → no ETA");

  const done25 = computeProgress({ done: 2, total: 10, startedAt: 1000, at: 3000 });
  assert.ok(Math.abs(done25.pct - 0.2) < 1e-9);
  assert.equal(done25.etaMs, 8000, "rate = 1000 ms/item over 8 remaining → 8000");

  const all = computeProgress({ done: 10, total: 10, startedAt: 1000, at: 3000 });
  assert.equal(all.pct, 1);
  assert.equal(all.etaMs, null, "complete → no ETA");

  const empty = computeProgress({ done: 0, total: 0, startedAt: 1000, at: 2000 });
  assert.equal(empty.pct, 0);
  assert.equal(empty.total, 0);
});

test("depthDaysAt: stop depth is the days-ago of the newest processed ts, else the full requested depth", () => {
  const now = 1000 * DAY;
  assert.equal(depthDaysAt({ newestProcessedTs: null, now, depthDays: 30 }), 30, "nothing processed → full depth");
  assert.equal(depthDaysAt({ newestProcessedTs: now - 7 * DAY, now, depthDays: 30 }), 7);
  assert.equal(depthDaysAt({ newestProcessedTs: now - 90 * DAY, now, depthDays: 30 }), 30, "older than the window clamps to the requested depth");
});

// ---------------------------------------------------------------------------
// Engine-level guardrails (injected fakes + in-memory db)
// ---------------------------------------------------------------------------

test("bound stop: cumulative model-ledger cost at/over the cap stops backfill and persists {reason:'budget', stoppedAtDepthDays}", async () => {
  const fx = await openFixture();
  if (!fx) return; // node 24 lacks node:sqlite

  const NOW = 1000 * DAY;
  fx.insSession("s1", { agent: "build" });
  // An assistant message after the start instant carries the spend — the
  // ledger measures everything created since the backfill's start instant.
  fx.insMessage("m1", "s1", { role: "assistant", ts: NOW + 1000, cost: 2 });

  const engineState = memStore();
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    segments: { save: async () => {}, load: async () => null },
    rollups: { save: async () => {}, load: async () => null, dir: "/tmp/none" },
    summarize: validSummarize(),
    computeOneLiner: async () => "work",
    runEphemeral: async () => ({ ok: false, gated: true }),
    getDb: async () => fx.db,
    presenceCheck: AWAY,
    now: () => NOW,
    capUsd: 0.01, // any spend exceeds
  });

  const res = await backfill.step();
  assert.equal(res.stopped, true);
  assert.equal(res.reason, "budget");
  assert.equal(engineState._data.backfillDone, true, "once stopped, marked done");
  assert.equal(engineState._data.backfillStopped.reason, "budget");
  assert.equal(engineState._data.backfillStopped.stoppedAtDepthDays, DEFAULT_BACKFILL_DAYS, "nothing processed → full depth reported");
  assert.equal(engineState._data.backfillStopped.spentUsd, 2);
});

test("once-per-box marker: a completed backfill (backfillDone=true) never re-runs — getDb is not even called", async () => {
  const NOW = 1000 * DAY;
  let dbCalls = 0;
  // Pre-seed the marker: a re-enable of the engine starts with this.
  const engineState = memStore({ backfillDone: true, backfillStopped: { reason: "budget", stoppedAtDepthDays: 12 } });
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    getDb: async () => {
      dbCalls += 1;
      return null;
    },
    presenceCheck: AWAY,
    now: () => NOW,
  });
  const res = await backfill.step();
  assert.equal(res.done, true);
  assert.equal(dbCalls, 0, "the marker short-circuits before touching the db");
  assert.equal(res.progress.done, 0);
});

test("segments phase replays a session into a persisted segment and advances progress", async () => {
  const fx = await openFixture();
  if (!fx) return;
  const NOW = 1000 * DAY;
  fx.insSession("s1", { agent: "build", directory: "/work/proj" });
  fx.insMessage("u1", "s1", { role: "user", ts: NOW - 2000, text: "debug the login flow" });
  fx.insMessage("a1", "s1", { role: "assistant", ts: NOW - 1000, cost: 0 });

  const { engineState, segments, backfill } = makeReplayBackfill(fx, { NOW, oneLiner: "debug the login flow" });

  const res = await backfill.step();
  assert.equal(res.ok, true);
  assert.ok(engineState._data.backfillStartInstant, "watermark recorded at kick-off");
  // The session's messages are all < watermark → processed, progress advanced.
  assert.deepEqual(engineState._data.backfillProgress.processedSessions, ["s1"]);
  assert.equal(engineState._data.backfillProgress.total, 1);
  assert.equal(res.progress.done, 1);
  assert.equal(res.progress.total, 1);
  // A segment was persisted by the segmenter on close.
  const segmentsList = [...segments._data.values()];
  assert.ok(segmentsList.length >= 1, "expected >=1 persisted segment; got: " + segmentsList.length);
  const seg = segmentsList[0];
  assert.equal(seg.sessionID, "s1");
  assert.ok(seg.summary, "segment carries a summary");
});

test("a shared-budget refusal mid-step leaves the session unprocessed (no history lost); the next step replays it", async () => {
  const fx = await openFixture();
  if (!fx) return;
  const NOW = 1000 * DAY;
  for (const [sid, base] of [["s1", NOW - 9000], ["s2", NOW - 5000]]) {
    fx.insSession(sid, { agent: "build", directory: "/work/proj" });
    fx.insMessage(`u-${sid}`, sid, { role: "user", ts: base, text: `work ${sid}` });
    fx.insMessage(`a-${sid}`, sid, { role: "assistant", ts: base + 500, cost: 0 });
  }
  const engineState = memStore();
  const segments = memFileStore();
  let refuse = true;
  const calls = [];
  const valid = validSummarize();
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    segments,
    rollups: { save: async () => {}, load: async () => null, dir: "/tmp/none" },
    summarize: async (d) => {
      calls.push(d.sessionID);
      return refuse && d.sessionID === "s2" ? { ok: false, gated: true, code: "budget", error: "cto_cap_hit" } : valid(d);
    },
    computeOneLiner: async () => "work",
    getDb: async () => fx.db,
    presenceCheck: AWAY,
    now: () => NOW,
    maxSessionsPerStep: 100,
  });

  const first = await backfill.step();
  assert.equal(first.ok, true);
  assert.equal(first.deferred, "budget");
  assert.deepEqual(engineState._data.backfillProgress.processedSessions, ["s1"], "the refused session is NOT marked processed");
  assert.equal(engineState._data.backfillDone, undefined, "and the backfill is not stopped for good — the shared budget resumes");
  assert.equal(engineState._data.backfillPhase, "segments", "still in the segments phase");

  refuse = false;
  const second = await backfill.step();
  assert.equal(second.deferred, undefined);
  assert.deepEqual(engineState._data.backfillProgress.processedSessions, ["s1", "s2"]);
  assert.equal(calls.filter((c) => c === "s2").length, 2, "the refused session was replayed");
  const s2 = [...segments._data.values()].find((x) => x.sessionID === "s2");
  assert.equal(s2.summaryOutcome.ok, true, "its segment now carries a real summary, not the degraded one");
});

test("a deferred session re-uses the segments already summarized (the model is paid only for the rest), and calls no model after the first refusal in a step", async () => {
  const fx = await openFixture();
  if (!fx) return;
  const NOW = 1000 * DAY;
  const T = [NOW - 12 * DAY, NOW - 8 * DAY, NOW - 4 * DAY]; // three work episodes, days apart: three segments
  fx.insSession("s1", { agent: "build", directory: "/work/proj" });
  T.forEach((t, i) => {
    fx.insMessage(`u${i}`, "s1", { role: "user", ts: t, text: `task ${i}` });
    fx.insMessage(`a${i}`, "s1", { role: "assistant", ts: t + 500, cost: 0 });
  });
  const engineState = memStore();
  const segments = memFileStore();
  const valid = validSummarize();
  const modelCalls = [];
  let refuseFrom = 2; // the 2nd model call of the first step is refused
  let n = 0;
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    segments,
    rollups: { save: async () => {}, load: async () => null, dir: "/tmp/none" },
    summarize: async (d) => {
      modelCalls.push(d.start);
      n += 1;
      return refuseFrom && n >= refuseFrom ? { ok: false, gated: true, code: "budget", error: "cto_cap_hit" } : valid(d);
    },
    computeOneLiner: async () => "work",
    getDb: async () => fx.db,
    presenceCheck: AWAY,
    now: () => NOW,
    maxSessionsPerStep: 100,
  });

  const first = await backfill.step();
  assert.equal(first.deferred, "budget");
  assert.deepEqual(modelCalls, [T[0], T[1]], "the 3rd segment is never sent to the model after the refusal");
  assert.equal(segments._data.get(`s1-${T[0]}`).summaryOutcome.ok, true, "the first segment was summarized for real");
  assert.deepEqual(engineState._data.backfillProgress.processedSessions, []);

  refuseFrom = 0;
  modelCalls.length = 0;
  const second = await backfill.step();
  assert.equal(second.deferred, undefined);
  assert.deepEqual(modelCalls, [T[1], T[2]], "the segment summarized earlier is re-used, not paid for again");
  assert.deepEqual(engineState._data.backfillProgress.processedSessions, ["s1"]);
  for (const t of T) assert.equal(segments._data.get(`s1-${t}`).summaryOutcome.ok, true);
});

// ---- rollups phase: a budget refusal defers the window instead of saving a degraded (write-once) rollup ----

function rollupsFixture({ refuse }) {
  const NOW = 1000 * DAY;
  const h = Math.floor((NOW - 3 * 3600_000) / 3600_000) * 3600_000;
  const segDir = mkdtempSync(join(tmpdir(), "bf-seg-"));
  const segData = new Map();
  const seg = { window: [h + 1000, h + 2000], ts: h + 2000, summary: { one_liner: "work in the hour", intent: "x", outcome: "done" } };
  writeFileSync(join(segDir, "seg-1.json"), "{}");
  segData.set("seg-1", seg);
  const segments = { dir: segDir, load: async (id) => segData.get(id) ?? null, save: async () => {} };
  const saved = new Map();
  const rollups = {
    dirFor: () => mkdtempSync(join(tmpdir(), "bf-roll-")),
    load: async (level, id) => saved.get(`${level}/${id}`) ?? { v: 1 },
    save: async (level, id, data) => {
      saved.set(`${level}/${id}`, data);
    },
  };
  const engineState = memStore({
    backfillStartInstant: NOW,
    backfillPhase: "rollups",
    backfillRollup: { phase: "hour", cursorTs: h },
    backfillProgress: { processedSessions: [], total: 0, startedAt: NOW - 1000, newestProcessedTs: null },
  });
  const rows = [];
  const calls = { n: 0 };
  return { NOW, h, segments, rollups, saved, engineState, rows, calls, ctl: { refuse } };
}

test("backfill rollups: a budget refusal defers the window — nothing saved, cursor stays, logged; the next step reduces it", async () => {
  const fx = await openFixture();
  if (!fx) return;
  const r = rollupsFixture({ refuse: true });
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState: r.engineState,
    ledger: { append: async (row) => r.rows.push(row) },
    segments: r.segments,
    rollups: r.rollups,
    runEphemeral: async () => {
      r.calls.n += 1;
      return r.ctl.refuse ? { ok: false, gated: true, code: "budget", error: "cto_cap_hit" } : { ok: true, text: JSON.stringify({ bullets: [{ text: "real bullet", refs: ["seg-1"] }] }) };
    },
    getDb: async () => fx.db,
    presenceCheck: AWAY,
    now: () => r.NOW,
    capUsd: 100,
    maxRollupsPerStep: 50,
  });
  const first = await backfill.step();
  assert.equal(first.deferred, "budget");
  assert.equal(r.saved.size, 0, "no degraded rollup was written (rollups are write-once)");
  assert.deepEqual(r.engineState._data.backfillRollup, { phase: "hour", cursorTs: r.h }, "the cursor did not move past the window");
  assert.ok(r.rows.some((x) => x.kind === "cto.backfill_deferred" && x.reason === "budget"));
  assert.ok(!r.rows.some((x) => x.kind === "cto.rollup_degraded" || x.kind === "cto.rollup_written"));
  assert.equal(r.engineState._data.backfillDone, undefined);

  r.ctl.refuse = false;
  const second = await backfill.step();
  assert.equal(second.deferred, undefined);
  const real = r.saved.get(`hour/${r.h}`);
  assert.equal(real.bullets[0].text, "real bullet", "the window was reduced for real once the budget allowed");
  assert.ok(r.engineState._data.backfillRollup.cursorTs > r.h);
});

// A gated result that is not a budget refusal (e.g. the engine paused) keeps today's behaviour: degraded and processed.
test("a gated summary that is not a budget refusal still counts as processed (unchanged)", async () => {
  const fx = await openFixture();
  if (!fx) return;
  const NOW = 1000 * DAY;
  fx.insSession("s1", { agent: "build", directory: "/work/proj" });
  fx.insMessage("u1", "s1", { role: "user", ts: NOW - 2000, text: "work" });
  const engineState = memStore();
  const bf = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    segments: memFileStore(),
    rollups: { save: async () => {}, load: async () => null, dir: "/tmp/none" },
    summarize: async () => ({ ok: false, gated: true, error: "paused" }),
    computeOneLiner: async () => "work",
    getDb: async () => fx.db,
    presenceCheck: AWAY,
    now: () => NOW,
  });
  const res = await bf.step();
  assert.equal(res.deferred, undefined);
  assert.deepEqual(engineState._data.backfillProgress.processedSessions, ["s1"]);
});

test("watermark enforced during replay: a message at/after the watermark is NOT re-segmented", async () => {
  const fx = await openFixture();
  if (!fx) return;
  const NOW = 1000 * DAY;
  fx.insSession("s1", { agent: "build", directory: "/work/proj" });
  fx.insMessage("u1", "s1", { role: "user", ts: NOW - 2000, text: "old work" });
  fx.insMessage("w1", "s1", { role: "user", ts: NOW + 1000, text: "LIVE work after the watermark" });

  const { segments, backfill } = makeReplayBackfill(fx, { NOW, oneLiner: "old work" });

  await backfill.step();
  const seg = [...segments._data.values()][0];
  assert.ok(seg.window[1] < NOW, `segment end (${seg.window[1]}) stays strictly under the watermark — no overlap with live`);
});

test("batch-priority: while the user is present, the backfill yields and touches nothing", async () => {
  const NOW = 1000 * DAY;
  let dbCalls = 0;
  const engineState = memStore();
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    getDb: async () => {
      dbCalls += 1;
      return null;
    },
    presenceCheck: PRESENT,
    now: () => NOW,
  });
  const res = await backfill.step();
  assert.equal(res.reason, "present");
  assert.equal(dbCalls, 0, "present → yields before any work; no db read, no state write");
  assert.equal(engineState._data.backfillDone, undefined, "a present-yield is not a completion");
});

// BET-1466 item 8: the config-key indirection read spellings written by no
// UI, doc, or code path — deleted; only the explicit override or the fallback
// constants resolve cap/depth now.
test("dead ctoBackfillCapUsd/ctoBackfillDays config lookups are gone; overrides + constants remain", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./ctoBackfill.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("ctoBackfillCapUsd"), "the un-writable cap config key is deleted");
  assert.ok(!src.includes("ctoBackfillDays"), "the un-writable depth config key is deleted");
  assert.ok(src.includes("capUsd ?? DEFAULT_BACKFILL_CAP_USD"), "explicit override, else the fallback constant");
  assert.ok(src.includes("depthDays ?? DEFAULT_BACKFILL_DAYS"), "explicit override, else the fallback constant");
});

// ---------------------------------------------------------------------------
// Background work budget (spec 2026-11-17 §8): batch work starts only when the shared budget says so
// ---------------------------------------------------------------------------

test("startGate: a refused step does no work and stays due (since when is remembered); a passing gate lets it run", async () => {
  const NOW = 1000 * DAY;
  let dbCalls = 0;
  const gates = [];
  let verdict = { ok: false, reason: "usd-cap" };
  const engineState = memStore();
  const backfill = createCtoBackfill({
    configGet: async () => ({ ctoEnabled: true }),
    engineState,
    ledger: noopLedger,
    getDb: async () => {
      dbCalls += 1;
      return null;
    },
    startGate: async (a) => {
      gates.push(a);
      return verdict;
    },
    presenceCheck: AWAY,
    now: () => NOW,
  });
  const refused = await backfill.step();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "budget");
  assert.equal(refused.detail, "usd-cap");
  assert.equal(dbCalls, 0, "no work when the budget refuses");
  assert.equal(engineState._data.backfillStartInstant, undefined, "the watermark is not recorded until it may start");
  assert.equal(engineState._data.backfillDueSince, NOW);

  await backfill.step();
  assert.equal(gates[1].dueSince, NOW, "the due-since instant is kept across retries (the 48 h overdue rule)");

  verdict = { ok: true };
  await backfill.step();
  assert.equal(dbCalls, 1, "a passing gate lets the step proceed");
});
