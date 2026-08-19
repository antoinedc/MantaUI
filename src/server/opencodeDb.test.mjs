// Tests for opencodeDb.mjs — the shared read-only access layer for opencode's
// SQLite store. Pure: no real database is opened here. Run via `npm run
// test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDbPath, getDb, _resetDbHandle } from "./opencodeDb.mjs";

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
