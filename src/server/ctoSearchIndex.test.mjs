// ctoSearchIndex.test.mjs — P1b1 (RESCOPED) acceptance tests: safe index
// lifecycle + bounded cyclic refresh + FIRST-PAGE search only.
//
// Parent-review blockers pinned here: (1) internal part indexed BEFORE its
// session mirror row is still excluded — exclusion comes from the
// AUTHORITATIVE registry at search time, not mirror progress; (2) content
// edited WITHOUT moving time_updated (and late low-timestamp inserts) are
// still reflected — bounded cyclic sweep, coverage EVENTUAL not snapshot;
// (3) a `cursor` argument is rejected — bounded first page with honest
// `truncated`/`omittedCount`, no fake pagination; (4) locks are retryable
// `index_busy` and corruption is explicit `index_corrupt` with the file
// RETAINED — never unlinked; (5) exactly ONE owned connection with an
// explicit close lifecycle (injected connection-counting constructor);
// (6) extraction bounds are REPORTED omissions and persist as per-document
//     incompleteness surfaced index-wide (even on zero-hit searches);
// (7) Node 20 degrade is actually exercised and this file degrades without
//     a static import; (8) deletion verification ROTATES (keyset cursor per
//     table) — a part deleted past the first 64 is still eventually absent;
// (9) an index path that resolves to the source DB (or any foreign database
//     without the Manta marker) is never written — explicit `unowned_index`,
//     foreign bytes/rows preserved; (10) concurrent ops share ONE opening
//     promise and a close() during the await settles the handle exactly once.
//
// Runs under the suite's `MANTA_STATE_HOME` sandbox; every source is a
// synthetic fixture armed via `MANTA_OPENCODE_DB`
// (fixtures/opencodeV2DbFixture.mjs §14 canary).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePath } from "../shared/paths.mjs";
import {
  CTO_SEARCH_INDEX_LIMITS,
  createCtoSearchIndex,
  _defaultSearchIndexPath,
  _setSyncFault,
} from "./ctoSearchIndex.mjs";
import { ftsAnyTermExpression, ftsMatchExpression, FTS_ANY_TERM_MAX } from "./ftsQuery.mjs";
import {
  createFixtureDb,
  sqliteAvailable,
  withFixtureDb,
  partId as pid,
  editPart,
  addPart,
  dropTrailingParts,
  setMessage,
  deleteSession,
} from "./fixtures/opencodeV2DbFixture.mjs";

// Guarded dynamic import — the file must LOAD (and skip cleanly) on Node 20.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const hasSqlite = DatabaseSync != null && (await sqliteAvailable());

const NOW = 1_700_000_000_000;
const NO_FILTER = async () => [];
let pathCounter = 0;

function uniqueIndexPath() {
  return join(tmpdir(), `manta-p1b1-${process.pid}-${Date.now()}-${pathCounter++}.sqlite`);
}

// Writable handle on the TEST-OWNED fixture (never the shared read-only
// accessor): used to simulate source edits/deletions between syncs.
function editSource(fixture) {
  return new DatabaseSync(fixture.dbPath);
}

// Connection-counting wrapper around the REAL node:sqlite for lifecycle tests.
// Read counters LIVE via the returned object (destructuring would snapshot).
function makeCountingSqlite() {
  const counts = { opens: 0, closes: 0 };
  class CountingDatabaseSync extends DatabaseSync {
    constructor(...args) {
      counts.opens++;
      super(...args);
    }
    close() {
      counts.closes++;
      super.close();
    }
  }
  return { counts, DatabaseSync: CountingDatabaseSync };
}

function cleanupIndexPath(path) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(path + suffix, { force: true });
  }
}

// Arms a fresh synthetic source + a fresh index instance, runs `fn`, cleans
// up both. Extra per-test options (provenanceFilter, now, sqliteModule...)
// flow into the factory.
async function withIndexSource(seed, fn, instanceOpts = {}) {
  const fixture = await createFixtureDb(seed);
  const indexPath = instanceOpts.path ?? uniqueIndexPath();
  let instance = null;
  try {
    instance = createCtoSearchIndex({ path: indexPath, ...instanceOpts });
    return await withFixtureDb(fixture, () => fn(fixture, instance, indexPath));
  } finally {
    if (instance) instance.close();
    cleanupIndexPath(indexPath);
  }
}

// A linear corpus of `n` text parts with distinct ids/terms.
function linearParts(prefix, n, textOf) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`, messageId: "m1", sessionId: "s1", timeCreated: NOW - i, timeUpdated: NOW - i,
    data: { type: "text", text: textOf(i) },
  }));
}

// Throwing fetch spy at the process boundary (U04-shaped): proves sync and
// search touch NO live endpoints.
async function withFetchSpy(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("unexpected fetch during index sync/search");
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// Deterministic corpus: pText repeats "leasebot" so bm25 ranks it first; the
// tool part contributes name/input/output scalars; the archived (closed)
// session carries its own evidence; a synthetic text part and a reasoning
// part prove the eligibility rule (never evidence).
const BASE_SEED = {
  sessions: [
    { id: "s1", parentId: null, agent: "build", directory: "/repo-a", projectId: "proj-a", title: "worker one", timeCreated: NOW - 4000, timeUpdated: NOW - 4000 },
    { id: "s2", parentId: "s1", agent: "general", directory: "/repo-a", projectId: "proj-a", title: "child worker", timeCreated: NOW - 3000, timeUpdated: NOW - 3000 },
    { id: "sArch", parentId: null, agent: "build", directory: "/repo-b", projectId: "proj-b", title: "old closed chat", timeCreated: NOW - 9000, timeUpdated: NOW - 2000, timeArchived: NOW - 1000 },
  ],
  messages: [
    { id: "m1", sessionId: "s1", timeCreated: NOW - 4000, timeUpdated: NOW - 4000, data: { role: "assistant" } },
    // A tool call is assistant content in V2 (a user message holds only text).
    { id: "m2", sessionId: "s2", timeCreated: NOW - 3000, timeUpdated: NOW - 3000, data: { role: "assistant" } },
    { id: "mArch", sessionId: "sArch", timeCreated: NOW - 9000, timeUpdated: NOW - 9000, data: { role: "assistant" } },
    // V2 stores injected text as its own `synthetic` message, never as assistant content.
    { id: "mSynth", sessionId: "sArch", timeCreated: NOW - 8900, timeUpdated: NOW - 8900, data: { role: "assistant" } },
  ],
  parts: [
    {
      id: "pText", messageId: "m1", sessionId: "s1", timeCreated: NOW - 4000, timeUpdated: NOW - 4000,
      data: { type: "text", text: "leasebot leasebot leasebot leasebot leasebot leasebot leasebot leasebot deployed to staging verified v3" },
    },
    {
      id: "pTool", messageId: "m2", sessionId: "s2", timeCreated: NOW - 3000, timeUpdated: NOW - 3000,
      data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test --filter leasebot" }, output: "all green" } },
    },
    {
      id: "pRetro", messageId: "mArch", sessionId: "sArch", timeCreated: NOW - 9000, timeUpdated: NOW - 9000,
      data: { type: "text", text: "archived leasebot retro notes from the closed session" },
    },
    {
      id: "pSynth", messageId: "mSynth", sessionId: "sArch", timeCreated: NOW - 8900, timeUpdated: NOW - 8900,
      data: { type: "text", text: "synthetic staging filler", synthetic: true },
    },
    {
      id: "pReasoning", messageId: "mArch", sessionId: "sArch", timeCreated: NOW - 8800, timeUpdated: NOW - 8800,
      data: { type: "reasoning", text: "secret internal deliberation about staging" },
    },
  ],
};
const BASE_INDEXABLE = 3; // pText, pTool, pRetro

test("default index path resolves under the sandboxed Manta state home", () => {
  assert.equal(_defaultSearchIndexPath(), statePath("cto", "search-index.sqlite"));
});

test("sync indexes eligible evidence; first-page search ranks, enriches, keeps closed/child sessions, leaves the source untouched, never fetches", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx) => {
    const before = { session: fixture.rowCount("session_v2"), message: fixture.rowCount("session_message") };
    await withFetchSpy(async (calls) => {
      const sync = await idx.sync({ limit: 500 });
      assert.equal(sync.status, "ok");
      assert.equal(sync.coverage.indexedParts, BASE_INDEXABLE, "reasoning/synthetic parts carry no eligible evidence");
      assert.equal(sync.coverage.eventual, true, "coverage is honest about eventual refresh");

      // "staging" exists in pText (indexed), pSynth (synthetic → excluded)
      // and pReasoning (never evidence) — exactly one hit proves the rule.
      const staging = await idx.search({ query: "staging" });
      assert.equal(staging.status, "ok");
      assert.equal(staging.hits.length, 1, "only the eligible text part matches");
      const hit = staging.hits[0];
      assert.equal(hit.partId, pid("pText"));
      assert.equal(hit.sessionId, "s1");
      assert.equal(hit.role, "assistant");
      assert.equal(hit.kind, "text");
      assert.equal(hit.provenance, "unclassified");
      assert.ok(hit.timeUpdated > 0, "hit carries the source update timestamp");
      assert.ok(typeof hit.snippet === "string" && hit.snippet.length > 0);
      assert.ok(!("nextCursor" in staging), "no fake pagination on success");

      const leasebot = await idx.search({ query: "leasebot" });
      assert.equal(leasebot.status, "ok");
      assert.equal(leasebot.hits[0].partId, pid("pText"), "bm25 puts the higher-term-frequency part first");
      assert.ok(leasebot.hits.some((h) => h.partId === pid("pTool")), "tool input scalars are searchable");
      assert.equal(leasebot.hits.find((h) => h.partId === pid("pTool")).role, "assistant");
      assert.equal(calls.length, 0, "no fetch calls on sync or search");

      const tool = await idx.search({ query: "npm" });
      assert.equal(tool.hits.length, 1);
      assert.equal(tool.hits[0].partId, pid("pTool"));
      assert.equal(tool.hits[0].kind, "tool");

      // Closed (archived) session evidence stays searchable.
      const retro = await idx.search({ query: "retro" });
      assert.equal(retro.hits.length, 1);
      assert.equal(retro.hits[0].sessionId, "sArch", "archived/closed sessions are kept");
    });
    assert.equal(fixture.rowCount("session_v2"), before.session, "source untouched");
    assert.equal(fixture.rowCount("session_message"), before.message);
  });
});

test("same-timestamp edit and late low-timestamp insert are both reflected by the bounded cyclic sweep", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const seed = {
    sessions: BASE_SEED.sessions.slice(0, 1),
    messages: BASE_SEED.messages.slice(0, 1),
    parts: [{ id: "p1", messageId: "m1", sessionId: "s1", timeCreated: 100, timeUpdated: 100, data: { type: "text", text: "alpha oldterm" } }],
  };
  await withIndexSource(seed, async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 500 })).status, "ok");
    assert.equal((await idx.search({ query: "oldterm" })).hits.length, 1);

    // (a) content edited WITHOUT moving time_updated — the cyclic sweep re-reads it.
    const db = editSource(fixture);
    try {
      editPart(db, "p1", { type: "text", text: "alpha newterm" });
    } finally {
      db.close();
    }
    const sync = await idx.sync({ limit: 500 });
    assert.equal(sync.status, "ok");
    assert.equal(sync.coverage.indexedParts, 1);
    assert.equal((await idx.search({ query: "oldterm" })).hits.length, 0, "stale term gone despite unchanged timestamp");
    assert.equal((await idx.search({ query: "newterm" })).hits.length, 1, "new term found eventually");

    // (b) a row INSERTED with a timestamp OLDER than everything already swept.
    const db2 = editSource(fixture);
    try {
      addPart(db2, { id: "pEarly", messageId: "m1", data: { type: "text", text: "early backfilled" } });
    } finally {
      db2.close();
    }
    assert.equal((await idx.sync({ limit: 500 })).status, "ok");
    assert.equal((await idx.search({ query: "backfilled" })).hits.length, 1, "late low-timestamp row caught on the next cycle");
  });
});

test("internal part indexed BEFORE its session mirror row exists is still excluded (authoritative registry filter, not mirror)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // Adversarial ordering (the sweep is newest-first): the internal session's part
  // sorts into an EARLIER sweep batch than the internal session itself (part ts
  // 250 > ordinary part ts 200; ordinary session ts 300 > internal session ts
  // 100). After one limit-1 batch the internal part is indexed while its session
  // mirror row is absent.
  const seed = {
    sessions: [
      { id: "s1", parentId: null, directory: "/repo-a", projectId: "proj-a", timeCreated: 300, timeUpdated: 300 },
      { id: "sInt", parentId: null, directory: "/repo-a", projectId: "proj-a", timeCreated: 100, timeUpdated: 100 },
    ],
    messages: [
      { id: "mInt", sessionId: "sInt", timeCreated: 250, timeUpdated: 250, data: { role: "assistant" } },
      { id: "mO", sessionId: "s1", timeCreated: 200, timeUpdated: 200, data: { role: "assistant" } },
    ],
    parts: [
      { id: "pInt", messageId: "mInt", sessionId: "sInt", timeCreated: 250, timeUpdated: 250, data: { type: "text", text: "internal secret staging" } },
      { id: "pOther", messageId: "mO", sessionId: "s1", timeCreated: 200, timeUpdated: 200, data: { type: "text", text: "ordinary public staging" } },
    ],
  };
  await withIndexSource(seed, async (fixture, idx) => {
    const filter = async () => ["sInt"];
    const first = await idx.sync({ limit: 1, provenanceFilter: filter });
    assert.equal(first.status, "ok");
    const afterFirst = await idx.status();
    assert.equal(afterFirst.counts.parts, 1, "one part indexed");
    assert.equal(afterFirst.counts.sessions, 1, "and the internal session mirror row is NOT among them");

    const excluded = await idx.search({ query: "staging", provenanceFilter: filter });
    assert.equal(excluded.status, "ok");
    assert.equal(excluded.hits.length, 0, "internal part excluded despite missing mirror row");

    const included = await idx.search({ query: "staging", includeInternal: true, provenanceFilter: filter });
    assert.equal(included.hits.length, 1);
    assert.equal(included.hits[0].partId, pid("pInt"));
    assert.equal(included.hits[0].provenance, "internal", "display provenance follows the authoritative registry too");

    // Second batch: the internal session mirror lands and the ordinary part
    // is indexed; ordinary evidence becomes visible.
    assert.equal((await idx.sync({ limit: 1, provenanceFilter: filter })).status, "ok");
    const ordinary = await idx.search({ query: "staging", provenanceFilter: filter });
    assert.equal(ordinary.hits.length, 1);
    assert.equal(ordinary.hits[0].partId, pid("pOther"));
    assert.equal(ordinary.hits[0].provenance, "unclassified");
  });
});

test("registry failure fails sync AND search closed; deletion reconciles boundedly", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx) => {
    const failing = async () => {
      throw new Error("registry down");
    };
    const s = await idx.sync({ provenanceFilter: failing });
    assert.equal(s.status, "provenance_unavailable");
    const q = await idx.search({ query: "staging", provenanceFilter: failing });
    assert.equal(q.status, "provenance_unavailable", "search fails closed too — no unfiltered answers");
    assert.equal(q.hits.length, 0);

    assert.equal((await idx.sync({ provenanceFilter: NO_FILTER })).status, "ok");
    const db = editSource(fixture);
    try {
      dropTrailingParts(db, "m1", 1); // pText is m1's only part
    } finally {
      db.close();
    }
    const sync = await idx.sync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.ok(sync.scanned.parts.removed >= 1, "bounded reconcile removed the orphan");
    assert.ok(sync.scanned.verifiedParts <= CTO_SEARCH_INDEX_LIMITS.deleteReconcileMax + CTO_SEARCH_INDEX_LIMITS.sessionVerifyMax, "reconcile is bounded");
    assert.equal((await idx.search({ query: "leasebot" })).hits.filter((h) => h.partId === pid("pText")).length, 0);
  });
});

test("failed batch commits nothing: sweep position and counts unchanged, next sync completes", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx) => {
    assert.equal((await idx.sync({ provenanceFilter: NO_FILTER })).status, "ok");
    const settled = await idx.status();
    const settledSweep = JSON.stringify(settled.sweep);

    const db = editSource(fixture);
    try {
      addPart(db, { id: "pLater", messageId: "m1", data: { type: "text", text: "later addition" }, timeUpdated: NOW + 100 });
    } finally {
      db.close();
    }
    _setSyncFault(({ row }) => {
      if (row.id === pid("pLater")) throw new Error("injected fault");
    });
    const failing = await idx.sync({ provenanceFilter: NO_FILTER });
    assert.equal(failing.status, "index_error");
    const after = await idx.status();
    assert.equal(JSON.stringify(after.sweep), settledSweep, "sweep position did NOT advance");
    assert.equal(after.counts.parts, settled.counts.parts, "no partial rows committed");
    _setSyncFault(null);

    const recovered = await idx.sync({ provenanceFilter: NO_FILTER });
    assert.equal(recovered.status, "ok");
    assert.equal((await idx.status()).counts.parts, settled.counts.parts + 1);
  });
});

test("corrupt index is explicit and RETAINED: no auto-unlink, no destructive retry loop", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const path = uniqueIndexPath();
  const fixture = await createFixtureDb(BASE_SEED);
  try {
    await withFixtureDb(fixture, async () => {
      const idx = createCtoSearchIndex({ path, provenanceFilter: NO_FILTER });
      assert.equal((await idx.sync()).status, "ok");
      idx.close();

      writeFileSync(path, Buffer.from("garbage that is not a database ".repeat(40)));
      const bytes = readFileSync(path);

      const idx2 = createCtoSearchIndex({ path, provenanceFilter: NO_FILTER });
      try {
        const r1 = await idx2.sync();
        assert.equal(r1.status, "index_corrupt", "explicit status, not a silent rebuild");
        assert.match(r1.detail, /retained/);
        assert.deepEqual(readFileSync(path), bytes, "the corrupt file was NOT unlinked or rewritten");
        const r2 = await idx2.sync();
        assert.equal(r2.status, "index_corrupt", "no destructive retry loop");
        assert.deepEqual(readFileSync(path), bytes);
      } finally {
        idx2.close();
      }
    });
  } finally {
    cleanupIndexPath(path);
    fixture.close();
  }
});

test("busy index is retryable, not corruption: file bytes and data preserved", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx, path) => {
    assert.equal((await idx.sync({ provenanceFilter: NO_FILTER })).status, "ok");
    const countsBefore = (await idx.status()).counts;
    const bytesBefore = readFileSync(path);

    // Hold an exclusive lock on the index file from a second connection.
    const blocker = new DatabaseSync(path);
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      const busy = await idx.sync({ provenanceFilter: NO_FILTER });
      assert.equal(busy.status, "index_busy", "locks are retryable, never 'corrupt'");
      const busySearch = await idx.search({ query: "staging" });
      assert.equal(busySearch.status, "index_busy");
      assert.deepEqual(readFileSync(path), bytesBefore, "nothing deleted or rewritten while busy");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    // Retry after the lock releases: same data, fully usable.
    const retried = await idx.sync({ provenanceFilter: NO_FILTER });
    assert.equal(retried.status, "ok");
    const countsAfter = (await idx.status()).counts;
    assert.deepEqual(countsAfter, countsBefore, "index data survived the busy window intact");
    assert.equal((await idx.search({ query: "staging" })).hits.length, 1);
  });
});

test("one owned connection: reused across every operation, closed exactly once, ops after close fail closed", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const counted = makeCountingSqlite();
  const opens = () => counted.counts.opens;
  const closes = () => counted.counts.closes;
  await withIndexSource(
    BASE_SEED,
    async (fixture, idx, idxPath) => {
      assert.equal(opens(), 0, "nothing opened until the first operation (lazy, singleflight)");
      await idx.sync({ provenanceFilter: NO_FILTER });
      // First op on a FRESH path: writable open only (no existing file to probe).
      assert.equal(opens(), 1, "exactly one owned connection");
      await idx.sync({ provenanceFilter: NO_FILTER });
      await idx.search({ query: "staging" });
      await idx.status();
      assert.equal(opens(), 1, "operations REUSE the owned connection — no per-op leak");
      assert.equal(closes(), 0);
      idx.close();
      assert.equal(closes(), 1, "close() closes the owned handle exactly once");
      const after = await idx.search({ query: "staging" });
      assert.equal(after.status, "index_closed");
      const s2 = await idx.sync({ provenanceFilter: NO_FILTER });
      assert.equal(s2.status, "index_closed");
      assert.equal(opens(), 1);
      assert.equal(closes(), 1);

      // Reopening an EXISTING index validates ownership READ-ONLY first
      // (probe + writable), without growing handles per op.
      const reopened = createCtoSearchIndex({ path: idxPath, provenanceFilter: NO_FILTER, sqliteModule: counted });
      try {
        assert.equal((await reopened.sync({ provenanceFilter: NO_FILTER })).status, "ok");
        assert.equal(opens(), 3, "reopen = read-only ownership probe + owned writable");
        assert.equal(closes(), 2, "the probe was closed immediately after validation");
        await reopened.search({ query: "staging" });
        assert.equal(opens(), 3, "still no per-op leak");
      } finally {
        reopened.close();
      }
      assert.equal(closes(), 3);
    },
    {
      // NOTE: only the INDEX connection is counted (the source fixture keeps its own handles).
      sqliteModule: counted,
    },
  );
});

test("extraction bounds are reported, not silent: dropped scalars surface as omissions", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const input = {};
  for (let i = 0; i < 80; i++) input[`k${i}`] = `word${i} filler`;
  const seed = {
    sessions: BASE_SEED.sessions.slice(0, 1),
    messages: BASE_SEED.messages.slice(0, 1),
    parts: [{ id: "pBig", messageId: "m1", sessionId: "s1", timeCreated: NOW, timeUpdated: NOW, data: { type: "tool", tool: "bash", state: { status: "completed", input } } }],
  };
  await withIndexSource(seed, async (fixture, idx) => {
    const sync = await idx.sync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.ok(sync.scanned.parts.extractionOmitted >= 16, "the 33rd..80th scalars are REPORTED as omissions");
    const found = await idx.search({ query: "word63" });
    assert.equal(found.hits.length, 1, "the indexed prefix is searchable");
    const missing = await idx.search({ query: "word79" });
    assert.equal(missing.hits.length, 0, "dropped scalars are not searchable");
    assert.equal(missing.coverage.eventual, true);
    assert.ok(missing.coverage.indexedParts >= 1);
  });
});

test("cursor is explicitly rejected; results are bounded with honest truncation and byte budget (no fake pagination)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // 60 hits × ~620-byte snippets ≈ 31 KiB serialized — over the 24 KiB
  // budget, so the hit cap AND the byte budget both bind in one corpus.
  const seed = { sessions: BASE_SEED.sessions.slice(0, 1), messages: BASE_SEED.messages.slice(0, 1), parts: linearParts("p", 60, (i) => `pageword item ${i} ${"z".repeat(600)}`) };
  await withIndexSource(seed, async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 500, provenanceFilter: NO_FILTER })).coverage.indexedParts, 60);

    const rejected = await idx.search({ query: "pageword", cursor: "anything" });
    assert.equal(rejected.status, "invalid_input", "cursor explicitly rejected until P1b2");
    assert.ok(!("nextCursor" in rejected));

    const overLimit = await idx.search({ query: "pageword", limit: 9999, provenanceFilter: NO_FILTER });
    assert.ok(overLimit.hits.length <= CTO_SEARCH_INDEX_LIMITS.searchHitsMax, "search limit clamps to 50");
    assert.ok(overLimit.hits.length < 60, "the byte budget dropped tail hits before the cap");
    assert.equal(overLimit.truncated, true, "honest: more matches existed than returned");
    assert.equal(overLimit.omittedCount, 60 - overLimit.hits.length, "every unreturned match is counted, not hidden");
    assert.ok(Buffer.byteLength(JSON.stringify(overLimit)) <= CTO_SEARCH_INDEX_LIMITS.responseBudgetBytes, "serialized response honors the budget");
    assert.ok(!("nextCursor" in overLimit), "bounded results, not fake pagination");

    const bigSync = await idx.sync({ limit: 9999, provenanceFilter: NO_FILTER });
    assert.equal(bigSync.status, "ok");
    assert.ok(bigSync.scanned.parts.scanned <= CTO_SEARCH_INDEX_LIMITS.syncBatchMax, "sync limit clamps to 500/stream");
  });
});

test("query policy is literal: metacharacters never act as operators, unicode/punctuation are honest no-hits, empty input is invalid", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx) => {
    assert.equal((await idx.sync({ provenanceFilter: NO_FILTER })).status, "ok");

    const star = await idx.search({ query: "stagi*" });
    assert.equal(star.status, "ok");
    assert.equal(star.hits.length, 0, "quoted * is literal, not a prefix operator");

    const paren = await idx.search({ query: "(staging)" });
    assert.equal(paren.status, "ok");
    assert.equal(paren.hits.length, 1, "parens are literal; the token still matches");

    const unicode = await idx.search({ query: "café" });
    assert.equal(unicode.status, "ok", "unicode query never a syntax error");
    assert.equal(unicode.hits.length, 0);

    const punct = await idx.search({ query: "..." });
    assert.equal(punct.status, "ok", "punctuation-only query is a no-hit, never an error");
    assert.equal(punct.hits.length, 0);

    const multi = await idx.search({ query: "leasebot verified" });
    assert.equal(multi.status, "ok");
    assert.ok(multi.hits.some((h) => h.partId === pid("pText")), "whitespace terms AND together");

    const bad = await idx.search({ query: "   " });
    assert.equal(bad.status, "invalid_input");
    const nonString = await idx.search({ query: 42 });
    assert.equal(nonString.status, "invalid_input");
  });
});

test("evidence caps are bytes: oversized tail is not indexed (honest, never fetched whole)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const big = "headword " + "y".repeat(40_000) + " tailword";
  const seed = {
    sessions: BASE_SEED.sessions.slice(0, 1),
    messages: BASE_SEED.messages.slice(0, 1),
    parts: [{ id: "pBig", messageId: "m1", sessionId: "s1", timeCreated: NOW, timeUpdated: NOW, data: { type: "tool", tool: "bash", state: { status: "completed", output: big } } }],
  };
  await withIndexSource(seed, async (fixture, idx) => {
    const sync = await idx.sync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.equal(sync.scanned.parts.byteTruncated, 1, "the byte cap is reported");
    assert.equal((await idx.search({ query: "headword" })).hits.length, 1, "the capped prefix is indexed");
    assert.equal((await idx.search({ query: "tailword" })).hits.length, 0, "the byte-capped tail is honestly not searchable");
  });
});

test("message-data edits refresh role enrichment; identity filters constrain hits", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx) => {
    assert.equal((await idx.sync({ provenanceFilter: NO_FILTER })).status, "ok");

    const db = editSource(fixture);
    try {
      setMessage(db, "m1", { type: "user", data: { text: "leasebot deployed to staging verified v3", time: { created: NOW - 4000 } } });
    } finally {
      db.close();
    }
    assert.equal((await idx.sync({ provenanceFilter: NO_FILTER })).status, "ok");
    const hits = await idx.search({ query: "staging" });
    assert.equal(hits.hits.find((h) => h.partId === pid("pText")).role, "user", "role enrichment follows the message edit");

    const bySession = await idx.search({ query: "leasebot", sessionId: "s2" });
    assert.ok(bySession.hits.length >= 1);
    assert.ok(bySession.hits.every((h) => h.sessionId === "s2"));

    const otherProject = await idx.search({ query: "leasebot", projectId: "proj-zzz" });
    assert.equal(otherProject.hits.length, 0, "an unknown project never matches");

    const byDirectory = await idx.search({ query: "retro", directory: "/repo-b" });
    assert.equal(byDirectory.hits.length, 1);
    assert.equal(byDirectory.hits[0].sessionId, "sArch");
  });
});

test("deletion verification ROTATES: a part deleted past the first 64 is eventually absent (documented cycles)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const seed = { sessions: [...BASE_SEED.sessions.slice(0, 1), { id: "sGone", directory: "/repo-a", projectId: "proj-a", timeCreated: 100, timeUpdated: 100 }], messages: BASE_SEED.messages.slice(0, 1), parts: linearParts("p", 100, (i) => `term${i} filler text`) };
  await withIndexSource(seed, async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 500, provenanceFilter: NO_FILTER })).coverage.indexedParts, 100);
    // Delete two rows BEYOND the 64-row verification batch (p98, p99 — V2
    // content is append-only, so what can vanish from a message is its tail).
    const db = editSource(fixture);
    try {
      dropTrailingParts(db, "m1", 2);
      deleteSession(db, "sGone"); // a message-less session: a V2 session delete cascades its messages
    } finally {
      db.close();
    }
    // Verified budget per sync: 64 parts + 16 sessions. 100 indexed parts
    // ⇒ full coverage within ceil(100/64) = 2 cycles; 3 syncs is the
    // documented bound with margin.
    for (let i = 0; i < 3; i++) {
      assert.equal((await idx.sync({ limit: 500, provenanceFilter: NO_FILTER })).status, "ok");
    }
    const status = await idx.status();
    assert.equal(status.counts.parts, 98, "both late-orphan parts reconciled");
    assert.equal(status.counts.sessions, 1, "the deleted session mirror reconciled too");
    // linearParts timestamps descend with i, so content order is p99…p0: the tail is p1, p0.
    assert.equal((await idx.search({ query: "term1" })).hits.length, 0);
    assert.equal((await idx.search({ query: "term0" })).hits.length, 0);
    assert.equal((await idx.search({ query: "term42" })).hits.length, 1, "survivors untouched");
  });
});

test("source path (or any foreign database) as index path is NEVER written: explicit unowned_index, bytes and rows preserved", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(BASE_SEED);
  try {
    await withFixtureDb(fixture, async () => {
      const before = readFileSync(fixture.dbPath);
      const { DatabaseSync: DS } = await import("node:sqlite");
      const beforeRows = { session: fixture.rowCount("session_v2"), message: fixture.rowCount("session_message") };
      const beforeSchema = new DS(fixture.dbPath).prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();

      // (a) the SOURCE path itself as the index path
      const idx = createCtoSearchIndex({ path: fixture.dbPath, provenanceFilter: NO_FILTER });
      try {
        const r = await idx.sync();
        assert.equal(r.status, "unowned_index", "refuses to open the source writable");
        assert.match(r.detail, /source database/);
        const q = await idx.search({ query: "staging" });
        assert.equal(q.status, "unowned_index");
        idx.close();
      } finally {
        /* closed above */
      }

      // (b) an unrelated foreign database at the index path
      const foreignPath = join(tmpdir(), `manta-p1b1-foreign-${process.pid}-${Date.now()}.sqlite`);
      const fdb = new DS(foreignPath);
      fdb.exec("CREATE TABLE user_data (x INTEGER)");
      fdb.prepare("INSERT INTO user_data VALUES (42)").run();
      fdb.close();
      const foreignBefore = readFileSync(foreignPath);
      const idx2 = createCtoSearchIndex({ path: foreignPath, provenanceFilter: NO_FILTER });
      try {
        const r = await idx2.sync();
        assert.equal(r.status, "unowned_index", "foreign DB without the Manta marker is never written");
        assert.match(r.detail, /marker/);
        idx2.close();
      } finally {
        /* closed above */
      }
      assert.deepEqual(readFileSync(foreignPath), foreignBefore, "foreign bytes preserved");
      const fdb2 = new DS(foreignPath);
      assert.equal(fdb2.prepare("SELECT count(*) AS n FROM user_data").get().n, 1);
      assert.equal(fdb2.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'indexed%'").get().n, 0, "no index tables injected");
      fdb2.close();
      rmSync(foreignPath, { force: true });

      // Source untouched: bytes, row counts, and schema identical.
      assert.deepEqual(readFileSync(fixture.dbPath), before, "source bytes preserved");
      assert.equal(fixture.rowCount("session_v2"), beforeRows.session);
      assert.equal(fixture.rowCount("session_message"), beforeRows.message);
      const afterSchema = new DS(fixture.dbPath).prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
      assert.deepEqual(afterSchema, beforeSchema, "source schema identical (no injected index tables)");
    });
  } finally {
    fixture.close();
  }
});

test("singleflight init: concurrent ops share ONE handle; close during the await settles it exactly once", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const counted = makeCountingSqlite();
  const opens = () => counted.counts.opens;
  const closes = () => counted.counts.closes;
  // (a) three concurrent statuses → ONE flight, no 3x leak
  await withIndexSource(
    BASE_SEED,
    async (fixture, idx) => {
      const results = await Promise.all([idx.status(), idx.status(), idx.status()]);
      assert.ok(results.every((r) => r.status === "ok"));
      assert.equal(opens(), 1, "concurrent ops share the singleflight open (a naive impl would open 3)");
      idx.close();

      // (b) close() while the initialization is still in flight
      const counted2 = makeCountingSqlite();
      const opens2 = () => counted2.counts.opens;
      const closes2 = () => counted2.counts.closes;
      const slowPath = uniqueIndexPath();
      const slow = createCtoSearchIndex({
        path: slowPath,
        provenanceFilter: NO_FILTER,
        sqliteModule: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return counted2;
        },
      });
      try {
        const pending = slow.status();
        slow.close();
        const r = await pending;
        assert.equal(r.status, "index_closed", "close during the await prevents a late success");
        assert.equal(opens2(), 1, "the in-flight open completed exactly once");
        assert.equal(closes2(), 1, "the owned handle was closed exactly once at settlement");
      } finally {
        slow.close();
        cleanupIndexPath(slowPath);
      }
      assert.equal(opens(), 1, "no reopening after close");
      assert.equal(closes(), 1, "the closed instance's handle stayed closed");
    },
    { sqliteModule: counted },
  );
});

test("incompleteness persists per document and is reported index-wide (even on zero-hit searches); counters stay numeric", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // A scalar nested BEYOND the depth cap (6): its content is unsearchable and
  // the omission must be persisted + surfaced.
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: "deepsecret" } } } } } } } } } };
  const seed = {
    sessions: BASE_SEED.sessions.slice(0, 1),
    messages: BASE_SEED.messages.slice(0, 1),
    parts: [{ id: "pDeep", messageId: "m1", sessionId: "s1", timeCreated: NOW, timeUpdated: NOW, data: { type: "tool", tool: "bash", state: { status: "completed", output: "shallow visible", input: deep } } }],
  };
  const path = uniqueIndexPath();
  const fixture = await createFixtureDb(seed);
  try {
    await withFixtureDb(fixture, async () => {
      const idx = createCtoSearchIndex({ path, provenanceFilter: NO_FILTER });
      try {
        const sync = await idx.sync();
        assert.equal(sync.status, "ok");
        assert.ok(sync.scanned.parts.extractionOmitted >= 1, "depth-cap omission reported");
        assert.equal(sync.coverage.incompleteParts, 1, "index-wide incompleteness on sync");

        // Second sync: nothing changed → counters numeric zero, NOT NaN/undefined.
        const again = await idx.sync();
        assert.equal(again.scanned.parts.extractionOmitted, 0);
        assert.equal(again.scanned.parts.byteTruncated, 0);
        assert.equal(again.coverage.incompleteParts, 1, "incompleteness persists across unchanged batches");

        const hit = await idx.search({ query: "shallow" });
        assert.equal(hit.hits.length, 1);
        assert.equal(hit.coverage.incompleteParts, 1);

        // Zero-hit search STILL reports the incomplete coverage honestly.
        const none = await idx.search({ query: "zzzznotfound" });
        assert.equal(none.status, "ok");
        assert.equal(none.hits.length, 0);
        assert.equal(none.coverage.incompleteParts, 1, "incomplete coverage surfaced with zero hits");
        assert.equal((await idx.search({ query: "deepsecret" })).hits.length, 0, "depth-capped scalar is honestly unsearchable");

        const st = await idx.status();
        assert.equal(st.counts.incompleteParts, 1);
        idx.close();

        // New instance on the same path: metadata reloaded from disk.
        const idx2 = createCtoSearchIndex({ path, provenanceFilter: NO_FILTER });
        try {
          const st2 = await idx2.status();
          assert.equal(st2.counts.incompleteParts, 1, "per-document incompleteness survives reopen");
        } finally {
          idx2.close();
        }
      } finally {
        if (idx) idx.close();
      }
    });
  } finally {
    cleanupIndexPath(path);
    fixture.close();
  }
});

test("unsupported needs no fixture DB: injected null module (and a failing source) degrade distinctly", async (t) => {
  const missingDb = join(tmpdir(), `manta-p1b1-missing-${process.pid}-${Date.now()}.db`);
  const prev = process.env.MANTA_OPENCODE_DB;
  process.env.MANTA_OPENCODE_DB = missingDb; // §14 canary: never the live home DB
  const { _resetDbHandle } = await import("./opencodeDb.mjs");
  _resetDbHandle();
  const path = uniqueIndexPath();
  try {
    const idx = createCtoSearchIndex({ path, sqliteModule: null });
    try {
      const search = await idx.search({ query: "staging" });
      assert.equal(search.supported, false);
      assert.equal(search.status, "unsupported");
      const status = await idx.status();
      assert.equal(status.status, "unsupported");
      assert.equal(existsSync(path), false, "no index file created on an unsupported runtime");
    } finally {
      idx.close();
    }
    // A MISSING source degrades to source_unavailable (distinct from
    // unsupported) — on a runtime WITHOUT node:sqlite the whole stack is
    // unsupported first (the source check reports the same root cause).
    const idx2 = createCtoSearchIndex({ path: uniqueIndexPath(), provenanceFilter: NO_FILTER });
    try {
      const sync = await idx2.sync();
      assert.equal(sync.supported, false);
      assert.equal(sync.status, hasSqlite ? "source_unavailable" : "unsupported");
    } finally {
      idx2.close();
    }
  } finally {
    if (prev === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prev;
    _resetDbHandle();
    cleanupIndexPath(path);
  }
});

// ---------------------------------------------------------------------------
// Shared-knowledge §7.2: recent-first sync, directory sets, any-term ranking,
// the size cap.
// ---------------------------------------------------------------------------

// One session, one message per part: message ts == part ts (V2 parts carry their message's time).
function newestFirstSeed(n) {
  const seed = {
    sessions: [{ id: "s1", parentId: null, directory: "/repo-a", projectId: "proj-a", timeCreated: 1, timeUpdated: 1 }],
    messages: [{ id: "mNew", sessionId: "s1", timeCreated: 700, timeUpdated: 700, data: { role: "assistant" } }],
    parts: [],
  };
  for (let i = 1; i <= n; i++) {
    seed.messages.push({ id: `m${i}`, sessionId: "s1", timeCreated: i * 100, timeUpdated: i * 100, data: { role: "assistant" } });
    seed.parts.push({ id: `p${i}`, messageId: `m${i}`, sessionId: "s1", timeCreated: i * 100, timeUpdated: i * 100, data: { type: "text", text: `term${i} common` } });
  }
  return seed;
}

const found = async (idx, q) => (await idx.search({ query: q })).hits.length;

test("sync is recent-first: the newest rows are indexed before older ones, and new activity is read next sync via the head pass", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(newestFirstSeed(6), async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 2, provenanceFilter: NO_FILTER })).status, "ok");
    assert.equal(await found(idx, "term6"), 1, "the newest part is indexed first");
    assert.equal(await found(idx, "term5"), 1);
    assert.equal(await found(idx, "term4"), 0, "older parts wait for a later batch");
    assert.equal(await found(idx, "term1"), 0);

    // Fresh activity after the first batch: newer than anything seen so far.
    const db = editSource(fixture);
    try {
      addPart(db, { id: "pNew", messageId: "mNew", data: { type: "text", text: "brandnewterm" } });
    } finally {
      db.close();
    }
    assert.equal((await idx.sync({ limit: 2, provenanceFilter: NO_FILTER })).status, "ok");
    assert.equal(await found(idx, "brandnewterm"), 1, "read by the head pass, not a whole cycle later");
    assert.equal(await found(idx, "term4"), 1, "the cycle keeps moving down in the same batch");
    assert.equal(await found(idx, "term3"), 1);
    assert.equal(await found(idx, "term1"), 0, "the oldest part is still not reached");

    assert.equal((await idx.sync({ limit: 2, provenanceFilter: NO_FILTER })).status, "ok");
    assert.equal(await found(idx, "term1"), 1);
    assert.equal(await found(idx, "term2"), 1);
    const done = await idx.sync({ limit: 2, provenanceFilter: NO_FILTER });
    assert.equal(done.sweep.cycle.part.t, Number.MAX_SAFE_INTEGER, "a finished cycle starts again from the newest");
    assert.equal(done.coverage.indexedParts, 7);
  });
});

test("search takes a SET of directories; an empty set matches nothing; hits carry directory and at", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 500, provenanceFilter: NO_FILTER })).status, "ok");
    const dirs = async (directories) => {
      const r = await idx.search({ query: "leasebot", directories });
      assert.equal(r.status, "ok");
      return r.hits.map((h) => `${h.directory}`).sort();
    };
    assert.deepEqual(await dirs(["/repo-b"]), ["/repo-b"]);
    assert.deepEqual(await dirs(["/repo-a"]), ["/repo-a", "/repo-a"]);
    assert.deepEqual(await dirs(["/repo-a", "/repo-b", "/elsewhere"]), ["/repo-a", "/repo-a", "/repo-b"]);
    assert.deepEqual(await dirs(["/elsewhere"]), []);
    assert.deepEqual(await dirs([]), [], "an empty set is no access, not no filter");
    assert.equal((await idx.search({ query: "leasebot" })).hits.length, 3, "undefined = no directory filter");
    // The hit shape.
    const hit = (await idx.search({ query: "retro", directories: ["/repo-b"] })).hits[0];
    assert.equal(hit.sessionId, "sArch");
    assert.equal(hit.directory, "/repo-b");
    assert.equal(hit.at, hit.timeUpdated);
    assert.ok(hit.at > 0);
    // Anything but an array is rejected, and an injection-shaped path is just a literal.
    assert.equal((await idx.search({ query: "leasebot", directories: "/repo-a" })).status, "invalid_input");
    assert.deepEqual(await dirs(['/repo-a" OR 1=1 --']), []);
    assert.deepEqual(await dirs(["/repo-b", 7, null, ""]), ["/repo-b"], "non-string entries are ignored");
  });
});

test("any-term queries rank rows by how many (and how rare) terms match; the default still needs every term", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const texts = ["alpha beta gamma", "alpha only here", "delta zeta", "!!! ??? ..."];
  const seed = {
    sessions: [{ id: "s1", parentId: null, directory: "/repo-a", projectId: "proj-a", timeCreated: 1, timeUpdated: 1 }],
    messages: texts.map((_, i) => ({ id: `m${i}`, sessionId: "s1", timeCreated: 100 + i, timeUpdated: 100 + i, data: { role: "assistant" } })),
    parts: texts.map((text, i) => ({ id: `p${i}`, messageId: `m${i}`, sessionId: "s1", timeCreated: 100 + i, timeUpdated: 100 + i, data: { type: "text", text } })),
  };
  await withIndexSource(seed, async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 500, provenanceFilter: NO_FILTER })).status, "ok");
    const ids = (r) => r.hits.map((h) => h.partId);

    const any = await idx.search({ query: "alpha beta nothere", anyTerms: true });
    assert.equal(any.status, "ok");
    assert.deepEqual(ids(any), [pid("p0"), pid("p1")], "two matching terms outrank one");

    assert.equal((await idx.search({ query: "alpha beta nothere" })).hits.length, 0, "the all-terms default is unchanged");
    assert.equal((await idx.search({ query: "alpha beta nothere", anyTerms: false })).hits.length, 0);

    // A term with no tokens inside the OR matches nothing and breaks nothing; metacharacters stay literal.
    assert.deepEqual(ids(await idx.search({ query: "!!! alpha", anyTerms: true })).sort(), [pid("p0"), pid("p1")].sort());
    assert.equal((await idx.search({ query: "alpha* OR (beta", anyTerms: true })).status, "ok");
    assert.equal((await idx.search({ query: '"', anyTerms: true })).hits.length, 0);
    assert.equal((await idx.search({ query: "   ", anyTerms: true })).status, "invalid_input");
    assert.equal((await idx.search({ query: 7, anyTerms: true })).status, "invalid_input");

    // Together with a directory set.
    assert.equal((await idx.search({ query: "alpha delta", anyTerms: true, directories: ["/repo-a"] })).hits.length, 3);
    assert.equal((await idx.search({ query: "alpha delta", anyTerms: true, directories: ["/other"] })).hits.length, 0);
  });
});

test("ftsAnyTermExpression: quoted literals joined with OR, duplicates folded, term count capped", () => {
  const a = ftsAnyTermExpression('Alpha beta "gamma" alpha ALPHA');
  assert.deepEqual(a, { ok: true, expr: '"Alpha" OR "beta" OR """gamma"""', terms: ["Alpha", "beta", '"gamma"'], droppedTerms: 0 });
  const many = ftsAnyTermExpression(Array.from({ length: 40 }, (_, i) => `t${i}`).join(" "));
  assert.equal(many.terms.length, FTS_ANY_TERM_MAX);
  assert.equal(many.droppedTerms, 40 - FTS_ANY_TERM_MAX);
  assert.equal(ftsAnyTermExpression("a b c", { maxTerms: 2 }).expr, '"a" OR "b"');
  assert.equal(ftsAnyTermExpression("").ok, false);
  assert.equal(ftsAnyTermExpression(undefined).ok, false);
  assert.equal(ftsMatchExpression("a b").expr, '"a" AND "b"', "the all-terms builder is unchanged");
});

// A deterministic pseudo-random corpus: `n` sessions (one message / part each), the oldest has the smallest index.
function corpusSeed(n, wordsPerPart = 400) {
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const word = () => Array.from({ length: 4 + Math.floor(rnd() * 6) }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join("");
  const seed = { sessions: [], messages: [], parts: [] };
  for (let i = 0; i < n; i++) {
    const ts = 1000 + i * 10;
    seed.sessions.push({ id: `s${i}`, parentId: null, directory: "/repo-a", projectId: "proj-a", timeCreated: ts, timeUpdated: ts });
    seed.messages.push({ id: `m${i}`, sessionId: `s${i}`, timeCreated: ts, timeUpdated: ts, data: { role: "assistant" } });
    seed.parts.push({
      id: `p${i}`, messageId: `m${i}`, sessionId: `s${i}`, timeCreated: ts, timeUpdated: ts,
      data: { type: "text", text: `marker${i}x ${Array.from({ length: wordsPerPart }, word).join(" ")}` },
    });
  }
  return seed;
}

test("size cap: over the cap the OLDEST sessions are evicted, the index ends under the cap, and evicted history is not read back in", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const N = 40;
  const seed = corpusSeed(N);
  // Pass 1: no cap — how big is the full index?
  let full = 0;
  await withIndexSource(seed, async (fixture, idx) => {
    assert.equal((await idx.sync({ limit: 500, provenanceFilter: NO_FILTER })).status, "ok");
    const st = await idx.status();
    assert.equal(st.counts.sessions, N);
    full = st.size.liveBytes;
    assert.equal(st.size.evictionFloor, 0);
  }, { maxBytes: Infinity });
  assert.ok(full > 50_000, `fixture is big enough to measure (${full})`);

  // Pass 2: a cap well under it.
  const cap = Math.floor(full * 0.6);
  await withIndexSource(seed, async (fixture, idx) => {
    const sync = await idx.sync({ limit: 500, provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.ok(sync.size.evicted.sessions > 0 && sync.size.evicted.parts > 0, "an eviction round ran");
    assert.ok(sync.size.liveBytes <= cap, `back under the cap: ${sync.size.liveBytes} <= ${cap}`);
    assert.ok(sync.size.evictionFloor > 0);

    const present = [];
    for (let i = 0; i < N; i++) if ((await found(idx, `marker${i}x`)) > 0) present.push(i);
    assert.ok(present.length > 0 && present.length < N);
    assert.deepEqual(present, Array.from({ length: present.length }, (_, k) => N - present.length + k), "what survives is the NEWEST contiguous run");
    assert.ok(present.includes(N - 1) && !present.includes(0));
    const st = await idx.status();
    assert.equal(st.counts.sessions, present.length, "session rows went with their parts");
    assert.equal(st.counts.parts, present.length);
    assert.equal(st.counts.messages, present.length);

    // The sweep does not bring evicted history back, nor keep evicting once under the cap.
    for (let k = 0; k < 4; k++) {
      const again = await idx.sync({ limit: 500, provenanceFilter: NO_FILTER });
      assert.equal(again.status, "ok");
      assert.deepEqual(again.size.evicted, { sessions: 0, parts: 0 });
    }
    const after = await idx.status();
    assert.equal(after.counts.parts, present.length);
    assert.equal(await found(idx, "marker0x"), 0);
    assert.ok(after.size.liveBytes <= cap);
  }, { maxBytes: cap });
});
