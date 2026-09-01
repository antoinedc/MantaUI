// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// Tests for ctoBackfill.mjs — the cold-start backfill (BET-1387, spec §10.6-4).
// Pure + injectable: guardrails (watermark exclusivity, spend-bound stop with a
// persisted reason, once-per-box marker, progress math) are tested against
// fakes and an in-memory SQLite fixture — never the real box stores.

import { test } from "node:test";
import assert from "node:assert/strict";
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
  db.exec(`
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session (id TEXT, parent_id TEXT, agent TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  return {
    db,
    insSession(id, { agent = "build", directory = "/w" } = {}) {
      db.prepare("INSERT INTO session (id, parent_id, agent, directory, time_created) VALUES (?,?,?,?,?)").run(id, null, agent, directory, 0);
    },
    insMessage(id, sessionId, { role, ts, cost = 0, text = "" }) {
      db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)").run(
        id,
        sessionId,
        ts,
        JSON.stringify({
          role,
          providerID: "anthropic",
          modelID: "claude-sonnet",
          cost,
          tokens: { input: 1, output: 1 },
          text,
        }),
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
