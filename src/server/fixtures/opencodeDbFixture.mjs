// fixtures/opencodeDbFixture.mjs — the reusable synthetic opencode.db fixture
// (spec §14 P0 harness).
//
// WHY IT EXISTS: `MANTA_STATE_HOME` sandboxing redirects every Manta-owned
// store (`src/shared/paths.mjs`) but does NOT redirect opencode's own source
// database — `resolveDbPath()` (src/server/opencodeDb.mjs) only honors
// `MANTA_OPENCODE_DB` / `XDG_DATA_HOME` / `$HOME/.local/share/opencode`. A DB
// integration test that forgets to set `MANTA_OPENCODE_DB` therefore reads the
// maintainer's real opencode.db. The unified-CTO spec
// (docs/unified-cto-spec.md §14) makes arming the env var BEFORE the shared
// handle opens, plus an explicit no-fallback-to-live-path assertion, a
// mandatory part of every database fixture.
//
// This helper makes those two steps impossible to forget: `withFixtureDb()`
// arms the env var and resets the module-cached handle before the callback
// runs, restores both afterwards, and exports `assertNoLiveDbFallback()` as the
// §14 canary. The seeded schema mirrors the verified live table shapes
// (`message`, `part`, `session`) as read from opencode 1.18.29's own store —
// see docs/cto-implementation-map.md §5.
//
// Pure test infrastructure: no production imports besides the `opencodeDb`
// reset/resolve seam, no network, no fallback to the live DB path. Requires
// node:sqlite; callers degrade to skip when `sqliteAvailable()` is false
// (same contract as src/server/modelLedger.test.mjs).

import { strict as assert } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

// The production path `resolveDbPath()` would pick with no env override and no
// XDG_DATA_HOME. The canary proves the fixture can never resolve here.
const LIVE_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

/**
 * The minimal verified schema for read-only fixtures. Matches the live store's
 * legacy pair (`message` + `part` — the two tables `searchMessages` joins) and
 * the v2 `session` table's identity columns. `data` payloads are the JSON
 * strings opencode stores in those columns.
 */
const SCHEMA = `
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, directory TEXT);
  CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`;

/**
 * Is node:sqlite available on this runtime? Tests must degrade to skip, never
 * crash at import (spec §15.2).
 */
export async function sqliteAvailable() {
  try {
    const mod = await import("node:sqlite");
    return Boolean(mod?.DatabaseSync);
  } catch {
    return false;
  }
}

/**
 * Build and seed a synthetic opencode.db in a throwaway temp dir.
 * Seed shape (all optional):
 *   sessions: [{ id, parentId?, agent?, directory? }]
 *   messages: [{ id, sessionId, timeCreated?, timeUpdated?, data? }]
 *   parts:    [{ id, messageId, sessionId, timeCreated?, timeUpdated?, data? }]
 * Returns { dbPath, dir, rowCount, close } — the caller owns cleanup via
 * `close()`.
 */
export async function createFixtureDb(seed = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "manta-cto-p0-fixture-"));
  const dbPath = join(dir, "opencode.db");
  const inserts = {
    sessions: ["INSERT INTO session (id, parent_id, agent, directory) VALUES (?,?,?,?)", (s) => [s.id, s.parentId ?? null, s.agent ?? null, s.directory ?? null]],
    messages: ["INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)", (m) => [m.id, m.sessionId, m.timeCreated ?? 1, m.timeUpdated ?? 1, JSON.stringify(m.data ?? {})]],
    parts: ["INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)", (p) => [p.id, p.messageId, p.sessionId, p.timeCreated ?? 1, p.timeUpdated ?? 1, JSON.stringify(p.data ?? {})]],
  };
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    for (const [key, [sql, toParams]] of Object.entries(inserts)) {
      const stmt = db.prepare(sql);
      for (const row of seed[key] ?? []) stmt.run(...toParams(row));
    }
  } finally {
    db.close();
  }
  return {
    dbPath,
    dir,
    rowCount: (table) => {
      const d = new DatabaseSync(dbPath);
      try {
        return d.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      } finally {
        d.close();
      }
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Spec §14 canary: the fixture's resolved DB path must be the synthetic file
 * and can never fall back to the production home path — under MANTA_STATE_HOME
 * sandboxing OR with the sandbox unset (the env override wins verbatim in both
 * cases, but the assertion is what makes a future resolution-order change come
 * back RED instead of silently re-opening the live DB).
 *
 * @param {string} resolvedPath  what `resolveDbPath()` returned while armed
 * @param {string} fixturePath   the synthetic DB's path
 */
export function assertNoLiveDbFallback(resolvedPath, fixturePath) {
  assert.equal(resolvedPath, fixturePath, "the armed fixture path must win over every fallback");
  assert.notEqual(resolvedPath, LIVE_DB_PATH, "the fixture must never resolve to the live opencode.db");
}

/**
 * Arm the env override, reset the shared handle, run `fn`, restore everything.
 * Order is load-bearing: `MANTA_OPENCODE_DB` is set and `_resetDbHandle()` is
 * called BEFORE `fn` so the first `getDb()` inside the callback opens the
 * synthetic DB — never a handle cached against another path.
 *
 * @template T
 * @param {{ dbPath: string }} fixture  the value returned by createFixtureDb()
 * @param {(fixture: { dbPath: string }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFixtureDb(fixture, fn) {
  const { _resetDbHandle, resolveDbPath } = await import("../opencodeDb.mjs");
  const prev = process.env.MANTA_OPENCODE_DB;
  process.env.MANTA_OPENCODE_DB = fixture.dbPath;
  _resetDbHandle();
  try {
    // The canary runs while armed, before the callback touches the DB.
    assertNoLiveDbFallback(resolveDbPath(), fixture.dbPath);
    return await fn(fixture);
  } finally {
    _resetDbHandle();
    if (prev === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prev;
  }
}
