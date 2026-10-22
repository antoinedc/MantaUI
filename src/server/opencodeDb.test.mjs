// Tests for opencodeDb.mjs — the shared read-only access layer for opencode's
// SQLite store. Pure: no real database is opened here. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDbPath, getDb, getDbOpenFailure, _resetDbHandle, _setSqliteModuleOverride, partIdFor, parsePartId, partExists, lookupProjectIdByDirectory } from "./opencodeDb.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "./fixtures/opencodeV2DbFixture.mjs";

test("resolveDbPath returns MANTA_OPENCODE_DB verbatim when set", () => {
  const override = "/custom/path/opencode.db";
  process.env.MANTA_OPENCODE_DB = override;
  try {
    assert.equal(resolveDbPath(), override);
  } finally {
    delete process.env.MANTA_OPENCODE_DB;
  }
});

test("resolveDbPath returns null when XDG_DATA_HOME is set but the file is absent", () => {
  process.env.XDG_DATA_HOME = "/nonexistent/xdg-data-home-for-test";
  try {
    assert.equal(resolveDbPath(), null);
  } finally {
    delete process.env.XDG_DATA_HOME;
  }
});

test("getDb() returns null (and does not throw) when resolveDbPath yields null", async () => {
  _resetDbHandle();
  process.env.XDG_DATA_HOME = "/nonexistent/xdg-data-home-for-test";
  delete process.env.MANTA_OPENCODE_DB;
  try {
    const db = await getDb();
    assert.equal(db, null);
  } finally {
    delete process.env.XDG_DATA_HOME;
    _resetDbHandle();
  }
});

// BET-1360: the shared read-only handle applies a bounded busy_timeout on
// open. These tests fake node:sqlite so no real opencode.db is ever opened.

function fakeHandle(execImpl) {
  return {
    isOpen: true,
    exec: execImpl,
  };
}

test("BET-1360: getDb issues PRAGMA busy_timeout = 5000 exactly once on open", async () => {
  _resetDbHandle();
  const execCalls = [];
  _setSqliteModuleOverride({
    DatabaseSync: function () { return fakeHandle((sql) => execCalls.push(sql)); },
  });
  process.env.MANTA_OPENCODE_DB = "/fake/db/opencode.db";
  try {
    const db = await getDb();
    assert.ok(db, "a handle must be returned on open");
    assert.deepEqual(execCalls, ["PRAGMA busy_timeout = 5000"]);
    // Second call hits the cached handle → the pragma is not re-issued.
    await getDb();
    assert.equal(execCalls.length, 1, "the pragma runs only on open");
  } finally {
    _resetDbHandle();
    _setSqliteModuleOverride(null);
    delete process.env.MANTA_OPENCODE_DB;
  }
});

test("BET-1360: a failing busy_timeout pragma is non-fatal (handle returned, warns once)", async () => {
  _resetDbHandle();
  _setSqliteModuleOverride({
    DatabaseSync: function () { return fakeHandle(() => { throw new Error("pragma boom"); }); },
  });
  process.env.MANTA_OPENCODE_DB = "/fake/db/opencode.db";
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const db = await getDb();
    assert.ok(db, "a failing pragma must still yield a usable handle, not null");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /busy_timeout pragma failed/);
    // Cached handle on the next call → no re-open, no second warn.
    await getDb();
    assert.equal(warns.length, 1, "warn only on the (single) open");
  } finally {
    console.warn = origWarn;
    _resetDbHandle();
    _setSqliteModuleOverride(null);
    delete process.env.MANTA_OPENCODE_DB;
  }
});

// ---------------------------------------------------------------------------
// OPENCODE_DB — the variable opencode itself reads. The V1→V2 migration points a
// freshly started V2 at a COPY of the V1 database with it, so manta-server's
// readers must follow.
// ---------------------------------------------------------------------------

test("resolveDbPath honours OPENCODE_DB; MANTA_OPENCODE_DB still wins; ':memory:' is ignored", () => {
  const savedM = process.env.MANTA_OPENCODE_DB;
  const savedO = process.env.OPENCODE_DB;
  try {
    delete process.env.MANTA_OPENCODE_DB;
    process.env.OPENCODE_DB = "/migrated/copy/opencode.db";
    assert.equal(resolveDbPath(), "/migrated/copy/opencode.db");
    process.env.MANTA_OPENCODE_DB = "/test/override.db";
    assert.equal(resolveDbPath(), "/test/override.db", "the test hook beats the opencode variable");
    delete process.env.MANTA_OPENCODE_DB;
    process.env.OPENCODE_DB = ":memory:";
    assert.notEqual(resolveDbPath(), ":memory:", "an in-memory database is not a readable store");
  } finally {
    if (savedM === undefined) delete process.env.MANTA_OPENCODE_DB; else process.env.MANTA_OPENCODE_DB = savedM;
    if (savedO === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = savedO;
  }
});

const hasSqlite = await sqliteAvailable();

test("a cached handle follows OPENCODE_DB when it changes (migration cutover), closing the old one", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const a = await createFixtureDb({ sessions: [{ id: "s_a", directory: "/a" }] });
  const b = await createFixtureDb({ sessions: [{ id: "s_b", directory: "/b" }] });
  const savedM = process.env.MANTA_OPENCODE_DB;
  const savedO = process.env.OPENCODE_DB;
  try {
    delete process.env.MANTA_OPENCODE_DB;
    _resetDbHandle();
    process.env.OPENCODE_DB = a.dbPath;
    const dbA = await getDb();
    assert.deepEqual(dbA.prepare("SELECT id FROM session_v2").all().map((r) => r.id), ["s_a"]);
    process.env.OPENCODE_DB = b.dbPath;
    const dbB = await getDb();
    assert.notEqual(dbB, dbA);
    assert.deepEqual(dbB.prepare("SELECT id FROM session_v2").all().map((r) => r.id), ["s_b"]);
    assert.equal(dbA.isOpen, false, "the handle on the old path is closed, not leaked");
    assert.equal(await getDb(), dbB, "an unchanged path keeps the cached handle");
  } finally {
    const h = (await getDb().catch(() => null));
    try { h?.close(); } catch { /* ignore */ }
    _resetDbHandle();
    if (savedM === undefined) delete process.env.MANTA_OPENCODE_DB; else process.env.MANTA_OPENCODE_DB = savedM;
    if (savedO === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = savedO;
    a.close();
    b.close();
  }
});

test("a database without the V2 schema (an unmigrated V1 file) degrades to null with a reason", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "manta-v1db-"));
  const path = join(dir, "opencode.db");
  const d = new DatabaseSync(path);
  d.exec("CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT)");
  d.close();
  const saved = process.env.MANTA_OPENCODE_DB;
  try {
    process.env.MANTA_OPENCODE_DB = path;
    _resetDbHandle();
    assert.equal(await getDb(), null);
    const why = getDbOpenFailure();
    assert.equal(why.reason, "source_unavailable");
    assert.match(why.detail, /no V2 schema/);
  } finally {
    if (saved === undefined) delete process.env.MANTA_OPENCODE_DB; else process.env.MANTA_OPENCODE_DB = saved;
    _resetDbHandle();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("part ids are derived from the message id and content index, and round-trip", () => {
  assert.equal(partIdFor("msg_145abcDEF", 3), "part_145abcDEFx0003");
  assert.match(partIdFor("msg_145abcDEF", 3), /^part_[A-Za-z0-9]+$/, "matches the part_/msg_/ses_ reference pattern");
  assert.deepEqual(parsePartId("part_145abcDEFx0003"), { messageIds: ["msg_145abcDEF", "145abcDEF"], idx: 3 });
  assert.equal(parsePartId("prt_abc"), null);
  assert.equal(parsePartId("part_abcx12"), null, "the index is exactly four digits");
  // ordering: zero-padded so a lexicographic sort is content order
  assert.ok(partIdFor("msg_m", 2) < partIdFor("msg_m", 10));
});

test("partExists: assistant content index in range; user/synthetic/system only index 0; unknown message false", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb({
    sessions: [{ id: "s1" }],
    messages: [
      { id: "msg_asst", sessionId: "s1", timeCreated: 1, data: { role: "assistant" } },
      { id: "msg_user", sessionId: "s1", timeCreated: 2, data: { role: "user" } },
    ],
    parts: [
      { id: "a0", messageId: "msg_asst", sessionId: "s1", timeCreated: 1, data: { type: "text", text: "x" } },
      { id: "a1", messageId: "msg_asst", sessionId: "s1", timeCreated: 2, data: { type: "text", text: "y" } },
      { id: "u0", messageId: "msg_user", sessionId: "s1", timeCreated: 2, data: { type: "text", text: "hi" } },
    ],
  });
  try {
    await withFixtureDb(fixture, async () => {
      const db = await getDb();
      assert.equal(partExists(db, partIdFor("msg_asst", 0)), true);
      assert.equal(partExists(db, partIdFor("msg_asst", 1)), true);
      assert.equal(partExists(db, partIdFor("msg_asst", 2)), false, "past the end of the content");
      assert.equal(partExists(db, partIdFor("msg_user", 0)), true);
      assert.equal(partExists(db, partIdFor("msg_user", 1)), false);
      assert.equal(partExists(db, partIdFor("msg_nope", 0)), false);
      assert.equal(partExists(db, "not-a-part-id"), false);
    });
  } finally {
    fixture.close();
  }
});

test("lookupProjectIdByDirectory reads project_directory, project.worktree and session_v2; 'global' never; freshest session breaks a fork", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb({
    projects: [{ id: "prj_wt", worktree: "/work/wt" }],
    projectDirectories: [{ projectId: "prj_pd", directory: "/work/pd" }],
    sessions: [
      { id: "s_only", projectId: "prj_s", directory: "/work/s", timeCreated: 5 },
      { id: "s_glob", projectId: "global", directory: "/work/g", timeCreated: 5 },
      { id: "s_old", projectId: "prj_dead", directory: "/work/fork", timeCreated: 100 },
      { id: "s_new", projectId: "prj_live", directory: "/work/fork", timeCreated: 900 },
    ],
  });
  try {
    await withFixtureDb(fixture, async () => {
      assert.equal(await lookupProjectIdByDirectory("/work/wt"), "prj_wt");
      assert.equal(await lookupProjectIdByDirectory("/work/pd"), "prj_pd");
      assert.equal(await lookupProjectIdByDirectory("/work/s"), "prj_s", "a migrated V1 history has only the session link");
      assert.equal(await lookupProjectIdByDirectory("/work/g"), null, "the global pseudo-project is never an identity");
      assert.equal(await lookupProjectIdByDirectory("/work/fork"), "prj_live");
      assert.equal(await lookupProjectIdByDirectory("/nowhere"), null);
    });
  } finally {
    fixture.close();
  }
});
