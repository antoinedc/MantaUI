// Tests for opencodeDb.mjs — the shared read-only access layer for opencode's
// SQLite store. Pure: no real database is opened here. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDbPath, getDb, _resetDbHandle, _setSqliteModuleOverride } from "./opencodeDb.mjs";

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
