// A search-only (`readOnly`) ctoSearchIndex instance over an index another instance writes — the
// shape the knowledge subsystem runs across two threads (transcriptIndex.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCtoSearchIndex } from "./ctoSearchIndex.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "./fixtures/opencodeV2DbFixture.mjs";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const hasSqlite = DatabaseSync != null && (await sqliteAvailable());
const NO_FILTER = async () => [];
const NOW = 1_700_000_000_000;
const SEED = {
  sessions: [{ id: "s1", parentId: null, agent: "build", directory: "/repo-a", projectId: "p", title: "one", timeCreated: NOW - 10, timeUpdated: NOW - 10 }],
  messages: [{ id: "m1", sessionId: "s1", timeCreated: NOW - 10, timeUpdated: NOW - 10, data: { role: "assistant" } }],
  parts: [{ id: "pA", messageId: "m1", sessionId: "s1", timeCreated: NOW - 10, timeUpdated: NOW - 10, data: { type: "text", text: "release the widget with pnpm" } }],
};

test("a read-only instance never creates the index, never syncs, and answers once the writer has built it (WAL)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const dir = mkdtempSync(join(tmpdir(), "manta-ro-index-"));
  const path = join(dir, "idx.sqlite");
  const fixture = await createFixtureDb(SEED);
  const reader = createCtoSearchIndex({ path, readOnly: true, provenanceFilter: NO_FILTER });
  const writer = createCtoSearchIndex({ path, wal: true, busyTimeoutMs: 1000, provenanceFilter: NO_FILTER });
  try {
    await withFixtureDb(fixture, async () => {
      const early = await reader.search({ query: "pnpm" });
      assert.equal(early.status, "index_error");
      assert.match(early.detail, /not been built/);
      await assert.rejects(import("node:fs/promises").then((fs) => fs.access(path)), "the reader must not have created the file");

      assert.equal((await writer.sync({ limit: 100 })).status, "ok");
      const hit = await reader.search({ query: "pnpm", directories: ["/repo-a"] });
      assert.equal(hit.status, "ok");
      assert.equal(hit.hits.length, 1);
      assert.equal(hit.hits[0].sessionId, "s1");

      const refused = await reader.sync({ limit: 10 });
      assert.equal(refused.status, "invalid_input");
      assert.match(refused.detail, /read-only/);
      // The reader never writes: its connection is read-only.
      const probe = new DatabaseSync(path, { readOnly: true });
      assert.equal(probe.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      probe.close();
    });
  } finally {
    reader.close();
    writer.close();
    fixture.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a foreign database at the path is never opened by a read-only instance either", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const dir = mkdtempSync(join(tmpdir(), "manta-ro-foreign-"));
  const path = join(dir, "foreign.sqlite");
  const f = new DatabaseSync(path);
  f.exec("CREATE TABLE x (a); INSERT INTO x VALUES (1)");
  f.close();
  const reader = createCtoSearchIndex({ path, readOnly: true, provenanceFilter: NO_FILTER });
  try {
    const r = await reader.search({ query: "anything" });
    assert.equal(r.status, "unowned_index");
  } finally {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
