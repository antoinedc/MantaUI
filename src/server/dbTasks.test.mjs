// dbTasks.test.mjs — the time-window scan primitives and the worker offload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowRanges, scanWindows, TASKS, WINDOW_TOKEN } from "./dbTasks.mjs";
import { runDbTask, runOnHandle, DbOffloadError, _setOffloadMode, _setWorkerFactory, _shutdownOffload, _stats } from "./dbOffload.mjs";
import { _resetDbHandle } from "./opencodeDb.mjs";

let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}
const SCHEMA = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'g', parent_id TEXT, directory TEXT DEFAULT '/', agent TEXT, title TEXT, time_created INTEGER DEFAULT 0, time_updated INTEGER);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
  CREATE INDEX session_message_time_created_idx ON session_message (time_created);
`;
function seedDb(path, nMessages = 30) {
  const db = new sqlite.DatabaseSync(path);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO session_v2 (id, time_updated) VALUES ('s1', 1000), ('s2', 1000)").run();
  for (let i = 1; i <= nMessages; i++) {
    const sid = i % 2 ? "s1" : "s2";
    const data = JSON.stringify({ model: { providerID: "p", id: "m" }, tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } }, time: { created: i * 10, completed: i * 10 + 5 }, content: [{ type: "text", text: `hello ${i}` }] });
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(`msg_${String(i).padStart(3, "0")}`, sid, "assistant", i, i * 10, i * 10, data);
  }
  return db;
}

test("windowRanges: covers [from..to] exactly once in both directions, ties stay in one window", { skip: !sqlite }, () => {
  const db = seedDb(":memory:", 30);
  // a tie: two messages at t=100
  db.prepare("INSERT INTO session_message VALUES ('msg_tie','s1','assistant',99,100,100,'{}')").run();
  for (const dir of ["desc", "asc"]) {
    const ws = [...windowRanges(db, { dir, from: dir === "desc" ? 300 : 10, to: dir === "desc" ? 10 : 300, windowMessages: 7 })];
    assert.ok(ws.length > 1, `${dir}: several windows`);
    const seen = [];
    for (const w of ws) {
      assert.ok(w.lo <= w.hi);
      for (const r of db.prepare("SELECT id FROM session_message WHERE time_created >= ? AND time_created <= ?").all(w.lo, w.hi)) seen.push(r.id);
    }
    const total = db.prepare("SELECT count(*) AS n FROM session_message WHERE time_created >= 10 AND time_created <= 300").get().n;
    assert.equal(seen.length, total, `${dir}: no row read twice or skipped`);
    assert.equal(new Set(seen).size, total);
  }
  db.close();
});

test("scanWindows: ordered rows across windows, limit stops early, deadline returns a resume edge", { skip: !sqlite }, () => {
  const db = seedDb(":memory:", 40);
  const sql = `SELECT id, time_created FROM session_message p WHERE p.type = 'assistant' ${WINDOW_TOKEN} ORDER BY p.time_created DESC, p.id DESC`;
  const all = scanWindows(db, { sql, windowMessages: 6, limit: 1000 });
  assert.equal(all.complete, true);
  assert.equal(all.rows.length, 40);
  assert.deepEqual(all.rows.map((r) => r.time_created), [...all.rows.map((r) => r.time_created)].sort((a, b) => b - a), "newest first across windows");

  const lim = scanWindows(db, { sql, windowMessages: 6, limit: 10 });
  assert.equal(lim.limited, true);
  assert.equal(lim.rows.length, 10);
  assert.equal(lim.rows[0].time_created, 400);

  // deadline already passed → nothing read, and the resume edge is where it would have started
  const dl = scanWindows(db, { sql, windowMessages: 6, deadlineAt: Date.now() - 1 });
  assert.equal(dl.complete, false);
  assert.equal(dl.limited, false);
  assert.equal(dl.rows.length, 0);
  assert.ok(Number.isFinite(dl.resumeAt));

  // resuming from a mid-point reads only older rows
  const half = scanWindows(db, { sql, windowMessages: 6, from: 200, limit: 1000 });
  assert.ok(half.rows.every((r) => r.time_created <= 200));
  assert.equal(half.rows.length, 20);

  // ascending + session-scoped
  const asc = scanWindows(db, {
    sql: `SELECT id, time_created FROM session_message p WHERE p.session_id = ? ${WINDOW_TOKEN} ORDER BY p.time_created ASC, p.id ASC`,
    params: ["s1"],
    sessionId: "s1",
    dir: "asc",
    from: 0,
    windowMessages: 4,
    limit: 1000,
  });
  assert.equal(asc.rows.length, 20);
  assert.ok(asc.rows.every((r, i) => i === 0 || r.time_created > asc.rows[i - 1].time_created));
  db.close();
});

test("sessionsInRange: sessions with messages in range, oldest first-message first, via per-session seeks", { skip: !sqlite }, () => {
  const db = seedDb(":memory:", 10);
  db.prepare("INSERT INTO session_v2 (id, time_updated) VALUES ('old', 5)").run();
  db.prepare("INSERT INTO session_message VALUES ('msg_old','old','assistant',1,3,3,'{}')").run();
  const r = TASKS.sessionsInRange(db, { start: 20, end: 90, slackMs: 0 });
  assert.deepEqual(r.map((x) => [x.sid, x.first_ts]), [["s2", 20], ["s1", 30]]);
  db.close();
});

test("endpointStats task: folds assistant rows into per-endpoint figures and reports completeness", { skip: !sqlite }, () => {
  const db = seedDb(":memory:", 12);
  const r = TASKS.endpointStats(db, { sinceMs: 0, windowMessages: 5 });
  assert.equal(r.complete, true);
  assert.deepEqual(Object.keys(r.endpoints), ["p/m"]);
  assert.equal(r.endpoints["p/m"].mix.input, 12);
  const dl = TASKS.endpointStats(db, { sinceMs: 0, budgetMs: -1 });
  assert.equal(dl.complete, false, "a spent budget is reported, not hidden");
  db.close();
});

// ---- the worker, for real ---------------------------------------------------

async function withDbFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "manta-dbworker-"));
  const path = join(dir, "opencode.db");
  const seed = seedDb(path, 20);
  seed.close();
  const prev = process.env.MANTA_OPENCODE_DB;
  process.env.MANTA_OPENCODE_DB = path;
  _resetDbHandle();
  try {
    return await fn(path);
  } finally {
    await _shutdownOffload();
    _setOffloadMode("worker");
    _setWorkerFactory(null);
    if (prev === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prev;
    _resetDbHandle();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runDbTask runs in a worker thread against the shared file and returns the task result", { skip: !sqlite }, async () => {
  await withDbFile(async () => {
    _setOffloadMode("worker");
    const r = await runDbTask("windowedRows", {
      sql: `SELECT id FROM session_message p WHERE p.type = 'assistant' ${WINDOW_TOKEN} ORDER BY p.time_created DESC`,
      limit: 5,
      windowMessages: 4,
    });
    assert.equal(r.rows.length, 5);
    assert.equal(r.limited, true);
    assert.equal(_stats().workers, 1, "a real worker was spawned");
    // same answer inline
    _setOffloadMode("inline");
    const inline = await runDbTask("windowedRows", { sql: `SELECT id FROM session_message p WHERE p.type = 'assistant' ${WINDOW_TOKEN} ORDER BY p.time_created DESC`, limit: 5, windowMessages: 4 });
    assert.deepEqual(JSON.parse(JSON.stringify(inline.rows)), JSON.parse(JSON.stringify(r.rows)));
  });
});

test("the main thread stays responsive while a worker task runs (the point of the offload)", { skip: !sqlite }, async () => {
  await withDbFile(async () => {
    _setOffloadMode("worker");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    // a deliberately heavy query: a 4-way self cross join (20^4 rows) in one synchronous call
    const r = await runDbTask("windowedRows", {
      sql: `SELECT count(*) AS n FROM session_message a, session_message b, session_message c, session_message d
            WHERE a.type = 'assistant' ${WINDOW_TOKEN}`,
      col: "a.time_created",
      limit: 5,
      windowMessages: 100000,
    });
    clearInterval(timer);
    assert.equal(r.rows[0].n, 20 ** 4);
    assert.ok(ticks >= 3, `the event loop kept ticking during the query (ticks=${ticks})`);
  });
});

test("a worker that never answers is abandoned at the timeout, the caller is released, and the next job still runs", { skip: !sqlite }, async () => {
  await withDbFile(async () => {
    _setOffloadMode("worker");
    const { Worker } = await import("node:worker_threads");
    let n = 0;
    // 1st worker: swallows every message (a wedged native call). Later ones are real.
    _setWorkerFactory(() => (n++ === 0 ? new Worker("process.stdin.resume(); require('node:worker_threads').parentPort.on('message', () => {});", { eval: true }) : new Worker(new URL("./dbWorker.mjs", import.meta.url))));
    const t0 = Date.now();
    await assert.rejects(runDbTask("windowedRows", { sql: `SELECT 1 AS x FROM session_message p WHERE 1=1 ${WINDOW_TOKEN} ORDER BY p.time_created`, budgetMs: 1 }, { timeoutMs: 150 }), (e) => e instanceof DbOffloadError && e.code === "timeout");
    assert.ok(Date.now() - t0 < 3000);
    const ok = await runDbTask("windowedRows", { sql: `SELECT id FROM session_message p WHERE 1=1 ${WINDOW_TOKEN} ORDER BY p.time_created`, limit: 3 });
    assert.equal(ok.rows.length, 3, "a fresh worker took over");
  });
});

test("runDbTask: no readable db → no_db; unknown task → task_failed; a failing query → task_failed (never an unhandled crash)", { skip: !sqlite }, async () => {
  await withDbFile(async () => {
    _setOffloadMode("worker");
    await assert.rejects(runDbTask("nope", {}), (e) => e.code === "task_failed");
    await assert.rejects(runDbTask("windowedRows", { sql: `SELECT * FROM no_such_table p ${WINDOW_TOKEN}`, limit: 1 }), (e) => e.code === "task_failed");
    process.env.MANTA_OPENCODE_DB = "/nonexistent/opencode.db";
    _resetDbHandle();
    await assert.rejects(runDbTask("windowedRows", { sql: "SELECT 1" }), (e) => e.code === "no_db");
  });
});

test("runOnHandle: a handle that is not the shared one runs inline against THAT handle", { skip: !sqlite }, async () => {
  const db = seedDb(":memory:", 6);
  const r = await runOnHandle(db, "windowedRows", { sql: `SELECT id FROM session_message p WHERE 1=1 ${WINDOW_TOKEN} ORDER BY p.time_created`, limit: 100 });
  assert.equal(r.rows.length, 6);
  db.close();
});
