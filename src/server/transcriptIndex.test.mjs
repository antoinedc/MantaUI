// transcriptIndex.test.mjs — the off-main-thread transcript index (shared-knowledge §7.2).
//
//   • host logic over fake workers: the engine adapter's shapes, every failure degrading to an empty
//     truncated answer, the internal-session ids sent with each call, the poller's gap choice, a stuck
//     call abandoning its worker;
//   • the REAL worker threads over a synthetic opencode V2 fixture: a sync on the writer thread makes the
//     reader thread's search answer — and the reader still answers while another connection holds a write
//     transaction on the index file (WAL), which is what keeps a running eviction from blocking a search.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptIndex, toEngineHits } from "./transcriptIndex.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "./fixtures/opencodeV2DbFixture.mjs";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
// The host's timers and its worker threads are unref'd (they must never hold a server open): keep the loop alive here.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const hasSqlite = DatabaseSync != null && (await sqliteAvailable());

class FakeWorker extends EventEmitter {
  constructor(role, handler) {
    super();
    this.role = role;
    this.handler = handler;
    this.terminated = false;
    this.messages = [];
  }
  postMessage(msg) {
    this.messages.push(msg);
    queueMicrotask(async () => {
      try {
        const result = await this.handler(msg, this);
        if (result !== HANG) this.emit("message", { id: msg.id, ok: true, result });
      } catch (e) {
        this.emit("message", { id: msg.id, ok: false, error: { message: e.message } });
      }
    });
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve();
  }
  unref() {}
}
const HANG = Symbol("hang");
const envelope = (hits, extra = {}) => ({ status: "ok", hits, truncated: false, ...extra });

function host(handlers, opts = {}) {
  const workers = [];
  const index = createTranscriptIndex({
    path: "/nonexistent/search-index.sqlite",
    log: () => {},
    workerFactory: (role) => {
      const w = new FakeWorker(role, handlers[role] ?? (() => envelope([])));
      workers.push(w);
      return w;
    },
    ...opts,
  });
  return { index, workers };
}

test("toEngineHits maps the index's camel-Id hits to the engine's shape", () => {
  assert.deepEqual(toEngineHits({ hits: [{ sessionId: "s", messageId: "m", partId: "p", snippet: "x", at: 5, directory: "/d" }] }), [{ sessionID: "s", messageID: "m", partID: "p", snippet: "x", at: 5 }]);
  assert.deepEqual(toEngineHits(null), []);
});

test("searchTranscripts: posts the query with the internal ids to the reader, maps hits, keeps `truncated`", async () => {
  const { index, workers } = host(
    { search: () => envelope([{ sessionId: "ses_a", messageId: "msg_1", partId: "prt_1", snippet: "use pnpm", at: 9 }], { truncated: true }) },
    { provenance: async () => new Set(["ses_internal"]) },
  );
  const r = await index.searchTranscripts({ query: "pnpm", directories: ["/repo"], anyTerms: true, limit: 12 });
  assert.deepEqual(r, { hits: [{ sessionID: "ses_a", messageID: "msg_1", partID: "prt_1", snippet: "use pnpm", at: 9 }], truncated: true, status: "ok" });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].role, "search");
  assert.deepEqual(workers[0].messages[0].args, { query: "pnpm", directories: ["/repo"], anyTerms: true, limit: 12, internalIds: ["ses_internal"] });
  await index.stop();
});

test("every search failure degrades to an empty, truncated answer — never a throw", async () => {
  for (const handlers of [
    { search: () => ({ status: "index_error", detail: "not built" }) },
    { search: () => ({ status: "index_busy" }) },
    { search: () => { throw new Error("boom"); } },
  ]) {
    const { index } = host(handlers);
    const r = await index.searchTranscripts({ query: "x", directories: ["/d"] });
    assert.deepEqual(r.hits, []);
    assert.equal(r.truncated, true);
    await index.stop();
  }
  const { index } = host({}, { provenance: async () => { throw new Error("registry down"); } });
  assert.deepEqual((await index.searchTranscripts({ query: "x" })).hits, []);
  await index.stop();
});

test("a stuck search abandons that worker; the next call starts a fresh one", async () => {
  let n = 0;
  const { index, workers } = host({ search: () => (n++ === 0 ? HANG : envelope([{ sessionId: "s", messageId: "m", partId: "p", snippet: "ok", at: 1 }])) }, { searchTimeoutMs: 30 });
  const first = await index.searchTranscripts({ query: "x" });
  assert.equal(first.truncated, true);
  assert.equal(workers[0].terminated, true);
  const second = await index.searchTranscripts({ query: "x" });
  assert.equal(second.hits.length, 1);
  assert.equal(workers.length, 2);
  await index.stop();
});

test("a worker that dies fails its pending call and is replaced on the next one", async () => {
  const { index, workers } = host({ search: (_m, w) => (queueMicrotask(() => w.emit("exit", 1)), HANG) });
  assert.equal((await index.searchTranscripts({ query: "x" })).truncated, true);
  assert.equal(workers.length, 1);
  assert.equal((await index.searchTranscripts({ query: "x" })).truncated, true);
  assert.equal(workers.length, 2, "the dead worker was replaced, not reused");
  await index.stop();
});

test("syncOnce: a batch that indexed something is followed soon, a quiet one slowly, errors and an unsupported runtime back off", async () => {
  const sync = (parts, status = "ok") => () => ({ status, scanned: { parts } });
  const gaps = {};
  for (const [name, h] of Object.entries({
    busy: sync({ indexed: 3, removed: 0 }),
    removed: sync({ indexed: 0, removed: 1 }),
    quiet: sync({ indexed: 0, removed: 0 }),
    unsupported: sync({}, "unsupported"),
    broken: sync({}, "index_busy"),
    thrown: () => { throw new Error("x"); },
  })) {
    const { index } = host({ sync: h }, { busyGapMs: 10, idleGapMs: 20, errorGapMs: 30, unsupportedGapMs: 40 });
    gaps[name] = (await index.syncOnce()).gapMs;
    await index.stop();
  }
  assert.deepEqual(gaps, { busy: 10, removed: 10, quiet: 20, unsupported: 40, broken: 30, thrown: 30 });
});

test("the sync poller runs on the writer, skips while disabled, and stop() terminates both threads", async () => {
  let enabled = false;
  const { index, workers } = host({ sync: () => ({ status: "ok", scanned: { parts: { indexed: 0 } } }), search: () => envelope([]) }, { isEnabled: () => enabled, idleGapMs: 15 });
  index.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(workers.length, 0, "no worker is even started while the feature is off");
  enabled = true;
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(workers.some((w) => w.role === "sync" && w.messages.length >= 1));
  assert.ok(workers.every((w) => w.role === "sync"));
  await index.searchTranscripts({ query: "x" });
  await index.stop();
  assert.ok(workers.every((w) => w.terminated));
  assert.equal((await index.syncOnce()).ok, false);
});

const NOW = 1_700_000_000_000;
const SEED = {
  sessions: [
    { id: "s1", parentId: null, agent: "build", directory: "/repo-a", projectId: "proj-a", title: "one", timeCreated: NOW - 4000, timeUpdated: NOW - 4000 },
    { id: "s2", parentId: null, agent: "build", directory: "/repo-b", projectId: "proj-b", title: "two", timeCreated: NOW - 3000, timeUpdated: NOW - 3000 },
  ],
  messages: [
    { id: "m1", sessionId: "s1", timeCreated: NOW - 4000, timeUpdated: NOW - 4000, data: { role: "assistant" } },
    { id: "m2", sessionId: "s2", timeCreated: NOW - 3000, timeUpdated: NOW - 3000, data: { role: "assistant" } },
  ],
  parts: [
    { id: "pA", messageId: "m1", sessionId: "s1", timeCreated: NOW - 4000, timeUpdated: NOW - 4000, data: { type: "text", text: "deploy the widget with pnpm release" } },
    { id: "pB", messageId: "m2", sessionId: "s2", timeCreated: NOW - 3000, timeUpdated: NOW - 3000, data: { type: "text", text: "the other project also uses pnpm" } },
  ],
};

test("real worker threads: a sync on the writer makes the reader answer, scoped by directory and internal ids — also during a write on the index file", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const dir = mkdtempSync(join(tmpdir(), "manta-tindex-"));
  const path = join(dir, "search-index.sqlite");
  const fixture = await createFixtureDb(SEED);
  let internal = [];
  const index = createTranscriptIndex({ path, provenance: async () => internal, log: () => {}, syncTimeoutMs: 60_000, searchTimeoutMs: 30_000 });
  try {
    await withFixtureDb(fixture, async () => {
      // before the writer has built the file the reader says so, honestly
      const early = await index.searchTranscripts({ query: "pnpm", directories: ["/repo-a", "/repo-b"] });
      assert.deepEqual(early.hits, []);
      assert.equal(early.truncated, true);

      const s = await index.syncOnce();
      assert.equal(s.ok, true, JSON.stringify(s));

      const both = await index.searchTranscripts({ query: "pnpm", directories: ["/repo-a", "/repo-b"] });
      assert.equal(both.status, "ok");
      assert.deepEqual(both.hits.map((h) => h.sessionID).sort(), ["s1", "s2"]);
      assert.ok(both.hits.every((h) => h.messageID && h.partID && h.snippet.length > 0));

      const onlyA = await index.searchTranscripts({ query: "pnpm", directories: ["/repo-a"] });
      assert.deepEqual(onlyA.hits.map((h) => h.sessionID), ["s1"]);

      internal = ["s1"];
      const filtered = await index.searchTranscripts({ query: "pnpm", directories: ["/repo-a", "/repo-b"] });
      assert.deepEqual(filtered.hits.map((h) => h.sessionID), ["s2"]);
      internal = [];

      const ro = new DatabaseSync(path, { readOnly: true });
      assert.equal(ro.prepare("PRAGMA journal_mode").get().journal_mode, "wal", "the writer put the index in WAL mode");
      ro.close();

      // Another connection sits in a write transaction (what an eviction's optimize is): WAL keeps the reader answering.
      const w = new DatabaseSync(path);
      w.exec("PRAGMA busy_timeout = 100");
      w.exec("BEGIN IMMEDIATE");
      w.exec("INSERT INTO index_meta (key, value) VALUES ('probe', 'x') ON CONFLICT(key) DO UPDATE SET value = 'x'");
      try {
        const t0 = Date.now();
        const during = await index.searchTranscripts({ query: "pnpm", directories: ["/repo-a"] });
        assert.equal(during.status, "ok");
        assert.equal(during.hits.length, 1);
        assert.ok(Date.now() - t0 < 5000);
      } finally {
        w.exec("ROLLBACK");
        w.close();
      }
    });
  } finally {
    await index.stop();
    fixture.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
