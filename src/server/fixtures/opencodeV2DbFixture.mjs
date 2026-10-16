// fixtures/opencodeV2DbFixture.mjs — the reusable synthetic opencode.db fixture
// (spec §14 P0 harness).
//
// WHY IT EXISTS: `MANTA_STATE_HOME` sandboxing redirects every Manta-owned
// store (`src/shared/paths.mjs`) but does NOT redirect opencode's own source
// database — `resolveDbPath()` (src/server/opencodeDb.mjs) only honors
// `MANTA_OPENCODE_DB` / `XDG_DATA_HOME` / `$HOME/.local/share/opencode`. A DB
// integration test that forgets to set `MANTA_OPENCODE_DB` therefore reads the
// maintainer's real opencode.db (and, since the OpenCode V2 cutover, also
// `OPENCODE_DB`). The unified-CTO spec
// (docs/unified-cto-spec.md §14) makes arming the env var BEFORE the shared
// handle opens, plus an explicit no-fallback-to-live-path assertion, a
// mandatory part of every database fixture.
//
// This helper makes those two steps impossible to forget: `withFixtureDb()`
// arms the env var and resets the module-cached handle before the callback
// runs, closes the fixture-owned connection and restores both afterwards, and
// exports `assertNoLiveDbFallback()` as the §14 canary. The seeded schema
// is the OpenCode V2 store (`session_v2`, `session_message`), as produced by a
// real V2 2.0.30 server. (It never closes a borrowed/live handle: the module handle is provably
// null at arm time, and an already-closed handle is skipped.)
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
import { partIdFor } from "../opencodeDb.mjs";

// The production path `resolveDbPath()` would pick with no env override and no
// XDG_DATA_HOME. The canary proves the fixture can never resolve here.
const LIVE_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

/**
 * The OpenCode V2 tables the readers query — copied from a real V2 2.0.30
 * `opencode.db` (the columns the readers touch are all present; the rest of the
 * real table's columns are omitted). `session_v2` carries the session identity
 * columns, `session_message` the conversation (one row per message, content
 * inlined into `data`). There is no `part` table in V2.
 */
const SCHEMA = `
  CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL DEFAULT '/');
  CREATE TABLE project_directory (project_id TEXT NOT NULL, directory TEXT NOT NULL, PRIMARY KEY (project_id, directory));
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'global', workspace_id TEXT, parent_id TEXT, directory TEXT NOT NULL DEFAULT '/', title TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL DEFAULT 0, time_updated INTEGER NOT NULL DEFAULT 0, time_archived INTEGER);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
  CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
  CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
`;

// seed part id → derived V2 part id. Filled by createFixtureDb; tests that
// assert on a hit's `partId` write `partId("p_decision")` instead of a literal,
// because V2 has no part ids of its own (opencodeDb.partIdFor derives them).
const PART_IDS = new Map();
export function partId(seedPartId) {
  const id = PART_IDS.get(seedPartId);
  if (!id) throw new Error(`fixture: no part seeded with id ${seedPartId}`);
  return id;
}

// A V1-shaped seed part → the V2 assistant content item it becomes.
function contentItem(part, idx) {
  const d = part.data ?? {};
  if (d.type === "text") return { type: "text", text: d.text ?? "" };
  if (d.type === "reasoning") return { type: "reasoning", text: d.text ?? "" };
  if (d.type === "tool") {
    const st = d.state ?? {};
    const out = st.output;
    const state = { status: st.status ?? "completed", input: st.input ?? {} };
    if (st.status === "error") state.error = { message: typeof out === "string" ? out : String(st.error ?? "error") };
    else if (out !== undefined) state.content = [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }];
    if (st.metadata !== undefined) state.metadata = st.metadata;
    return { type: "tool", id: `toolu_${idx}_${part.id}`, name: d.tool ?? "unknown", state, time: { created: part.timeCreated ?? 1 } };
  }
  return null; // step-start / file / … carry no readable evidence in V2
}

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
 * Build and seed a synthetic V2 opencode.db in a throwaway temp dir.
 *
 * The seed keeps the V1-era shape the suites were written in, and is converted
 * the way V2 stores it:
 *   sessions: [{ id, parentId?, agent?, directory?, projectId?, workspaceId?, title?, timeCreated?, timeUpdated?, timeArchived? }]
 *             → session_v2 rows
 *   messages: [{ id, sessionId, timeCreated?, timeUpdated?, data? }]
 *             data.role "user" → a `user` message {text} (the text of its seeded text parts);
 *             anything else   → an `assistant` message whose `content` is its seeded parts
 *             (data.providerID/modelID/cost/tokens/time/agent land in V2's fields).
 *             `v2: { type, data }` on a message writes that raw V2 row instead
 *             (idle, synthetic, system, shell, …).
 *   parts:    [{ id, messageId, sessionId, timeCreated?, timeUpdated?, data? }]
 *             text/reasoning/tool parts become content items (see contentItem).
 *   projectDirectories: [{ projectId, directory }], projects: [{ id, worktree }]
 * Returns { dbPath, dir, rowCount, close } — the caller owns cleanup via
 * `close()`. Part ids are derived: use `partId(seedId)` to assert on them.
 */
export async function createFixtureDb(seed = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "manta-cto-p0-fixture-"));
  const dbPath = join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    for (const p of seed.projects ?? []) db.prepare("INSERT INTO project (id, worktree) VALUES (?,?)").run(p.id, p.worktree ?? "/");
    for (const d of seed.projectDirectories ?? []) db.prepare("INSERT INTO project_directory (project_id, directory) VALUES (?,?)").run(d.projectId, d.directory);
    const insSession = db.prepare(
      "INSERT INTO session_v2 (id, project_id, workspace_id, parent_id, directory, title, agent, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (const s of seed.sessions ?? []) {
      insSession.run(s.id, s.projectId ?? "global", s.workspaceId ?? null, s.parentId ?? null, s.directory ?? "/", s.title ?? null, s.agent ?? null, s.timeCreated ?? 0, s.timeUpdated ?? 0, s.timeArchived ?? null);
    }

    const partsByMessage = new Map();
    for (const p of seed.parts ?? []) {
      if (!partsByMessage.has(p.messageId)) partsByMessage.set(p.messageId, []);
      partsByMessage.get(p.messageId).push(p);
    }
    const insMsg = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)");
    const seqBySession = new Map();
    const ordered = [...(seed.messages ?? [])].sort((a, b) => (a.timeCreated ?? 1) - (b.timeCreated ?? 1) || String(a.id).localeCompare(String(b.id)));
    for (const m of ordered) {
      const seq = seqBySession.get(m.sessionId) ?? 0;
      seqBySession.set(m.sessionId, seq + 1);
      const created = m.timeCreated ?? 1;
      const parts = [...(partsByMessage.get(m.id) ?? [])].sort((a, b) => (a.timeCreated ?? 1) - (b.timeCreated ?? 1) || String(a.id).localeCompare(String(b.id)));
      const updated = m.timeUpdated ?? Math.max(created, ...parts.map((p) => p.timeUpdated ?? p.timeCreated ?? 1));
      if (m.v2) {
        insMsg.run(m.id, m.sessionId, m.v2.type, seq, created, updated, JSON.stringify(m.v2.data ?? {}));
        continue;
      }
      const md = m.data ?? {};
      if (md.role === "user") {
        const text = parts.filter((p) => p.data?.type === "text").map((p) => p.data.text ?? "").join("\n") || (typeof md.text === "string" ? md.text : "");
        insMsg.run(m.id, m.sessionId, "user", seq, created, updated, JSON.stringify({ text, time: { created } }));
        parts.forEach((p) => PART_IDS.set(p.id, partIdFor(m.id, 0)));
        continue;
      }
      const content = [];
      parts.forEach((p) => {
        const item = contentItem(p, content.length);
        if (!item) return;
        PART_IDS.set(p.id, partIdFor(m.id, content.length));
        content.push(item);
      });
      const data = {
        agent: md.agent ?? "build",
        model: { providerID: md.providerID ?? undefined, id: md.modelID ?? undefined },
        content,
        finish: md.finish ?? "stop",
        time: md.time ?? { created },
      };
      if (md.cost !== undefined) data.cost = md.cost;
      if (md.tokens !== undefined) data.tokens = md.tokens;
      insMsg.run(m.id, m.sessionId, "assistant", seq, created, updated, JSON.stringify(data));
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
 * Cleanup closes the FIXTURE-OWNED connection: because the module handle was
 * null when the fixture armed, any handle present after the callback was
 * necessarily opened against THIS synthetic DB. That connection is closed
 * before `_resetDbHandle()` drops the reference (which only nulls the module
 * variable — it never closes the OS handle) so the fd is released and the temp
 * dir can be removed. A borrowed/live handle can never be closed here: there
 * is none at arm time, and a handle the callback already closed
 * (`isOpen === false`, e.g. messageSearch's own query-error recovery) is left
 * alone. Works under exception restoration too — the finally runs on throws.
 *
 * @template T
 * @param {{ dbPath: string }} fixture  the value returned by createFixtureDb()
 * @param {(fixture: { dbPath: string }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withFixtureDb(fixture, fn) {
  const { _getDbHandle, _resetDbHandle, resolveDbPath } = await import("../opencodeDb.mjs");
  const prev = process.env.MANTA_OPENCODE_DB;
  process.env.MANTA_OPENCODE_DB = fixture.dbPath;
  _resetDbHandle();
  try {
    // The canary runs while armed, before the callback touches the DB.
    assertNoLiveDbFallback(resolveDbPath(), fixture.dbPath);
    return await fn(fixture);
  } finally {
    // Close the connection the shared accessor opened against THIS fixture
    // (if it is still open) before dropping the module's reference. Never
    // close a handle that is not ours: at arm time the module handle was
    // null, so anything present now belongs to this fixture; an
    // already-closed handle (isOpen === false) is skipped, and a close error
    // must not mask the callback's own outcome.
    const handle = _getDbHandle();
    if (handle && handle.isOpen !== false && typeof handle.close === "function") {
      try {
        handle.close();
      } catch {
        /* best-effort: the reset below still drops the reference */
      }
    }
    _resetDbHandle();
    if (prev === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prev;
  }
}
