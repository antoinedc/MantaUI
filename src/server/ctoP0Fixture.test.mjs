// ctoP0Fixture.test.mjs — P0 acceptance-regression fixture tests for the
// EXISTING passive-read seams (unified-CTO spec §14/§15 P0; contract-only).
//
// What is pinned here, against the production accessors — no feature is
// asserted to exist (no CTO role session, no admission path, no headless
// delegate; those are P1a/P2a/P3a/P4):
//
//   1. Source isolation: with the fixture armed, `resolveDbPath()` is the
//      synthetic DB and can never fall back to the production home path
//      (spec §14 canary — `MANTA_STATE_HOME` does NOT redirect opencode's DB).
//   2. The production read path (`searchMessages`) answers correctly from the
//      synthetic DB — proving the fixture and the real accessor compose.
//   3. The read path cannot write: the shared handle is opened read-only
//      (a write through it raises SQLITE_READONLY) and a search leaves the
//      source row counts unchanged.
//   4. No prompt dispatch observed on read (U04-shaped): with a throwing
//      `fetch` spy at the process boundary, a search completes and the spy is
//      never called — the read path's only OBSERVED I/O is the read-only
//      SQLite handle; the fetch seam is what this test covers, not every
//      conceivable side-effect channel.
//   5. Fixture hygiene: `withFixtureDb` CLOSES the fixture-owned SQLite
//      connection before dropping the module's reference (which only nulls
//      it), on success and on callback exception, and never closes a handle
//      the callback already closed.
//
// Every case degrades to skip on runtimes without node:sqlite (spec §15.2:
// report unsupported rather than crash at import). Runs under the suite's
// `MANTA_STATE_HOME` sandbox (scripts/testSandbox.mjs) like every other
// server test.

import test from "node:test";
import assert from "node:assert/strict";
import { searchMessages } from "./messageSearch.mjs";
import { resolveDbPath, getDb, _resetDbHandle, _getDbHandle } from "./opencodeDb.mjs";
import {
  createFixtureDb,
  sqliteAvailable,
  assertNoLiveDbFallback,
  withFixtureDb,
} from "./fixtures/opencodeDbFixture.mjs";

const hasSqlite = await sqliteAvailable();

// A tiny deterministic corpus: two sessions, one text part each, one tool part
// (non-text — must be skipped by the search filter), newest-first ordering.
function seedRows() {
  const now = 1_700_000_000_000;
  return {
    sessions: [
      { id: "s1", parentId: null, agent: "build", directory: "/repo-a" },
      { id: "s2", parentId: "s1", agent: "general", directory: "/repo-a" },
    ],
    messages: [
      { id: "m1", sessionId: "s1", timeCreated: now - 2000, timeUpdated: now - 2000, data: { role: "assistant" } },
      { id: "m2", sessionId: "s2", timeCreated: now - 1000, timeUpdated: now - 1000, data: { role: "assistant" } },
    ],
    parts: [
      {
        id: "p1", messageId: "m1", sessionId: "s1", timeCreated: now - 2000, timeUpdated: now - 2000,
        data: { type: "text", text: "deployed leasebot to staging, release v3 verified" },
      },
      {
        id: "p2", messageId: "m2", sessionId: "s2", timeCreated: now - 1000, timeUpdated: now - 1000,
        data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" } } },
      },
    ],
  };
}

test("fixture: armed MANTA_OPENCODE_DB wins over every fallback and never resolves to the live DB", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  try {
    // Armed inside withFixtureDb: env override set + handle reset BEFORE any
    // getDb(), canary asserted while armed. Also assert the seam directly.
    await withFixtureDb(fixture, async ({ dbPath }) => {
      assert.equal(resolveDbPath(), dbPath);
      assertNoLiveDbFallback(resolveDbPath(), dbPath);
      const db = await getDb();
      assert.ok(db, "the production accessor must open the synthetic DB");
      // Belt: the opened handle really reads the fixture's rows.
      const n = db.prepare("SELECT count(*) AS n FROM message").get().n;
      assert.equal(n, 2);
    });
  } finally {
    fixture.close();
  }
});

test("fixture: the canary still holds with the MANTA_STATE_HOME sandbox unset", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  const prevSandbox = process.env.MANTA_STATE_HOME;
  const prevXdg = process.env.XDG_DATA_HOME;
  try {
    delete process.env.MANTA_STATE_HOME; // simulate a run without the sandbox
    delete process.env.XDG_DATA_HOME;
    await withFixtureDb(fixture, async ({ dbPath }) => {
      // Without the override, resolveDbPath would fall through to
      // $HOME/.local/share/opencode/opencode.db — the assertion exists to
      // catch exactly that regression, in both sandbox states.
      assertNoLiveDbFallback(resolveDbPath(), dbPath);
    });
  } finally {
    if (prevSandbox !== undefined) process.env.MANTA_STATE_HOME = prevSandbox;
    else delete process.env.MANTA_STATE_HOME;
    if (prevXdg !== undefined) process.env.XDG_DATA_HOME = prevXdg;
    else delete process.env.XDG_DATA_HOME;
  }
});

test("U04 (contract-only): searchMessages answers from the synthetic DB via the production read path", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  try {
    await withFixtureDb(fixture, async () => {
      const res = await searchMessages({ query: "staging", sessionIds: ["s1", "s2"] });
      assert.equal(res.supported, true);
      assert.equal(res.hits.length, 1, "text parts match; the s2 tool part must be skipped");
      assert.equal(res.hits[0].sessionId, "s1");
      assert.equal(res.hits[0].messageId, "m1");
      assert.match(res.hits[0].match, /staging/i);
    });
  } finally {
    fixture.close();
  }
});

test("U04 (contract-only): the shared handle is read-only — a write through the production accessor raises SQLITE_READONLY", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  try {
    await withFixtureDb(fixture, async () => {
      const db = await getDb();
      assert.ok(db);
      assert.throws(
        () => db.exec("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('x','s1',1,1,'{}')"),
        (e) => /readonly/i.test(String(e?.message ?? e)),
        "a write through the production handle must raise SQLITE_READONLY",
      );
    });
  } finally {
    fixture.close();
  }
});

test("U04 (contract-only): a search leaves row counts unchanged and the fetch spy is never called (no prompt dispatch observed)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("prompt dispatch attempted from the passive read path");
  };
  try {
    await withFixtureDb(fixture, async () => {
      const before = fixture.rowCount("message") + fixture.rowCount("part");
      const res = await searchMessages({ query: "staging", sessionIds: ["s1"] });
      assert.equal(res.supported, true);
      assert.ok(res.hits.length >= 1);
      const after = fixture.rowCount("message") + fixture.rowCount("part");
      assert.equal(after, before, "a passive read must leave the source row counts unchanged");
      assert.equal(fetchCalls, 0, "the fetch seam observed zero calls — no prompt dispatch on the read path");
    });
  } finally {
    globalThis.fetch = realFetch;
    fixture.close();
  }
});

test("U27 (contract-only): no DB at any resolved path degrades to supported:false, never a fake result", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const prevDb = process.env.MANTA_OPENCODE_DB;
  const prevXdg = process.env.XDG_DATA_HOME;
  _resetDbHandle();
  try {
    process.env.MANTA_OPENCODE_DB = "/nonexistent/cto-p0/opencode.db";
    _resetDbHandle();
    const res = await searchMessages({ query: "anything", sessionIds: ["s1"] });
    assert.deepEqual(res, { supported: false, hits: [] });
  } finally {
    if (prevDb === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prevDb;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    _resetDbHandle();
  }
});

test("fixture hygiene: withFixtureDb closes the fixture-owned connection on success", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  let handleDuringCallback = null;
  try {
    await withFixtureDb(fixture, async () => {
      const db = await getDb();
      assert.ok(db);
      handleDuringCallback = _getDbHandle();
      assert.equal(handleDuringCallback, db, "the accessor's cached handle is the one the callback opened");
      assert.equal(handleDuringCallback.isOpen, true);
    });
    // After the fixture ends the module reference is dropped AND the underlying
    // connection is closed — _resetDbHandle alone would only null it, leaking
    // the fd and pinning the temp dir.
    const handleAfter = _getDbHandle();
    assert.equal(handleAfter, null, "the module handle must be reset after the fixture");
    assert.equal(handleDuringCallback.isOpen, false, "the fixture-owned connection must be closed, not just unreferenced");
  } finally {
    fixture.close();
  }
});

test("fixture hygiene: withFixtureDb closes the fixture-owned connection when the callback throws, and restores the env", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  const prev = process.env.MANTA_OPENCODE_DB;
  let handleDuringCallback = null;
  const cbErr = new Error("callback exploded after opening the handle");
  let observedErr = null;
  try {
    await withFixtureDb(fixture, async () => {
      await getDb();
      handleDuringCallback = _getDbHandle();
      throw cbErr;
    });
  } catch (e) {
    observedErr = e;
  }
  assert.equal(observedErr, cbErr, "the callback's own error must propagate untouched");
  assert.equal(_getDbHandle(), null, "the module handle must be reset even on exception");
  assert.equal(handleDuringCallback.isOpen, false, "the connection must be closed even on exception (restoration)");
  assert.equal(
    process.env.MANTA_OPENCODE_DB,
    prev === undefined ? undefined : prev,
    "the env override must be restored even on exception",
  );
  fixture.close();
});

test("fixture hygiene: a handle the callback already closed is skipped, never closed twice", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb(seedRows());
  try {
    // The callback closes the handle itself — the same shape messageSearch's
    // query-error recovery uses. The fixture's cleanup must tolerate it.
    await withFixtureDb(fixture, async () => {
      const db = await getDb();
      db.close();
      assert.equal(db.isOpen, false);
    });
    assert.equal(_getDbHandle(), null);
  } finally {
    fixture.close();
  }
});
