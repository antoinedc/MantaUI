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
  // OPENCODE_DB is inherited from the opencode service when the suite runs inside an agent session.
  const savedO = process.env.OPENCODE_DB;
  delete process.env.OPENCODE_DB;
  process.env.XDG_DATA_HOME = "/nonexistent/xdg-data-home-for-test";
  try {
    assert.equal(resolveDbPath(), null);
  } finally {
    delete process.env.XDG_DATA_HOME;
    if (savedO !== undefined) process.env.OPENCODE_DB = savedO;
  }
});

test("getDb() returns null (and does not throw) when resolveDbPath yields null", async () => {
  _resetDbHandle();
  const savedO = process.env.OPENCODE_DB;
  delete process.env.OPENCODE_DB;
  process.env.XDG_DATA_HOME = "/nonexistent/xdg-data-home-for-test";
  delete process.env.MANTA_OPENCODE_DB;
  try {
    const db = await getDb();
    assert.equal(db, null);
  } finally {
    delete process.env.XDG_DATA_HOME;
    if (savedO !== undefined) process.env.OPENCODE_DB = savedO;
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

// ---------------------------------------------------------------------------
// Copy-mode migration: opencode-serve gets OPENCODE_DB, manta-server does not.
// The upgrade state file is how the readers find the migrated copy.
// ---------------------------------------------------------------------------

async function withStateSandbox(fn) {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "manta-dbstate-"));
  const saved = {};
  for (const k of ["MANTA_STATE_HOME", "MANTA_OPENCODE_DB", "OPENCODE_DB", "XDG_DATA_HOME"]) saved[k] = process.env[k];
  try {
    process.env.MANTA_STATE_HOME = dir;
    delete process.env.MANTA_OPENCODE_DB;
    delete process.env.OPENCODE_DB;
    // An empty XDG home: the "default" is a known-absent file, never the real box's DB.
    process.env.XDG_DATA_HOME = join(dir, "xdg");
    mkdirSync(join(dir, ".manta"), { recursive: true });
    const writeState = (st) => writeFileSync(join(dir, ".manta", "v2-migration.json"), typeof st === "string" ? st : JSON.stringify(st));
    _resetDbHandle();
    return await fn({ dir, join, writeState, writeFileSync, mkdirSync });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetDbHandle();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a completed copy-mode migration points the readers at targetDb (manta-server never sees OPENCODE_DB)", async () => {
  await withStateSandbox(async ({ dir, join, writeState, writeFileSync }) => {
    const target = join(dir, "opencode-v2.db");
    writeFileSync(target, "");
    writeState({ state: "completed", mode: "copy", targetDb: target });
    assert.equal(resolveDbPath(), target);
  });
});

test("only a completed copy-mode migration counts: absent / running / failed / rolled back / in-place / missing target → default", async () => {
  await withStateSandbox(async ({ dir, join, writeState, writeFileSync, mkdirSync }) => {
    const target = join(dir, "opencode-v2.db");
    writeFileSync(target, "");
    assert.equal(resolveDbPath(), null, "no state file: the (absent) default");
    for (const st of [
      { state: "running", mode: "copy", targetDb: target },
      { state: "failed", mode: "copy", targetDb: target },
      { state: "rolled_back", mode: "copy", targetDb: target },
      { state: "idle", mode: null, targetDb: null },
      { state: "completed", mode: "in-place", targetDb: target },
      { state: "completed", mode: "copy", targetDb: join(dir, "gone.db") },
      { state: "completed", mode: "copy", targetDb: "" },
      { state: "completed", mode: "copy" },
    ]) {
      writeState(st);
      assert.equal(resolveDbPath(), null, JSON.stringify(st));
    }
    writeState("{ not json");
    assert.equal(resolveDbPath(), null, "an unreadable state file has no opinion");
    // With a real default present, the default is what an in-place box resolves to.
    const def = join(dir, "xdg", "opencode", "opencode.db");
    mkdirSync(join(dir, "xdg", "opencode"), { recursive: true });
    writeFileSync(def, "");
    writeState({ state: "completed", mode: "in-place", targetDb: def });
    assert.equal(resolveDbPath(), def);
  });
});

test("env overrides still beat the migration state; the state beats the default", async () => {
  await withStateSandbox(async ({ dir, join, writeState, writeFileSync, mkdirSync }) => {
    const target = join(dir, "opencode-v2.db");
    writeFileSync(target, "");
    const def = join(dir, "xdg", "opencode", "opencode.db");
    mkdirSync(join(dir, "xdg", "opencode"), { recursive: true });
    writeFileSync(def, "");
    writeState({ state: "completed", mode: "copy", targetDb: target });
    assert.equal(resolveDbPath(), target, "state beats the V1 default");
    process.env.OPENCODE_DB = "/env/opencode.db";
    assert.equal(resolveDbPath(), "/env/opencode.db");
    process.env.MANTA_OPENCODE_DB = "/test/hook.db";
    assert.equal(resolveDbPath(), "/test/hook.db");
  });
});

test("the state is re-read on change: an upgrade that completes while the server runs is picked up without a restart", async () => {
  await withStateSandbox(async ({ dir, join, writeState, writeFileSync }) => {
    const target = join(dir, "opencode-v2.db");
    writeFileSync(target, "");
    writeState({ state: "running", mode: "copy", targetDb: target });
    assert.equal(resolveDbPath(), null);
    writeState({ state: "completed", mode: "copy", targetDb: target }); // different size → cache invalidated
    assert.equal(resolveDbPath(), target);
    writeState({ state: "rolled_back", mode: "copy", targetDb: target });
    assert.equal(resolveDbPath(), null);
  });
});

test("getDb on a copy-mode box: a V1 default is rejected, then the migrated copy opens once the state says completed, and the handle follows it", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const { DatabaseSync } = await import("node:sqlite");
  const v2 = await createFixtureDb({ sessions: [{ id: "s_v2", directory: "/v2" }] });
  try {
    await withStateSandbox(async ({ dir, join, writeState, mkdirSync }) => {
      // the untouched V1 file at the default path
      mkdirSync(join(dir, "xdg", "opencode"), { recursive: true });
      const v1 = new DatabaseSync(join(dir, "xdg", "opencode", "opencode.db"));
      v1.exec("CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT)");
      v1.close();

      assert.equal(await getDb(), null, "the V1 file fails the V2 schema guard");
      assert.equal(getDbOpenFailure().reason, "source_unavailable");

      writeState({ state: "completed", mode: "copy", targetDb: v2.dbPath });
      const db = await getDb();
      assert.ok(db, "the migrated copy opens without any env override");
      assert.deepEqual(db.prepare("SELECT id FROM session_v2").all().map((r) => r.id), ["s_v2"]);
      assert.equal(await getDb(), db, "unchanged path keeps the handle");

      writeState({ state: "rolled_back", mode: "copy", targetDb: v2.dbPath });
      assert.equal(await getDb(), null, "path went back to the V1 default → old handle dropped, schema guard rejects it");
      assert.equal(db.isOpen, false);
    });
  } finally {
    v2.close();
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
