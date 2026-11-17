import { test } from "node:test";
import assert from "node:assert/strict";
import { listSessionsPage } from "./backfillSource.mjs";

async function db() {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, agent TEXT, title TEXT, metadata TEXT, time_created INTEGER)");
  const ins = d.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)");
  ins.run("s1", "P1", null, "/a", "build", "t", JSON.stringify({ manta: { routineId: "r" } }), 100);
  ins.run("s2", "P1", "s1", "/a", "build", "knowledge:curator-notes", null, 200);
  ins.run("s3", "P1", null, "/a", "build", null, "not json", 300);
  ins.run("s4", "P1", null, "/a", "build", null, null, 5_000);
  return d;
}

test("pages carry metadata, title, creation time and the internal flag; metadata is parsed, junk is null", async () => {
  const rows = await listSessionsPage({ db: await db(), internalIds: async () => new Set(["s3"]), limit: 10 });
  assert.deepEqual(rows.map((r) => r.id), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(rows[0].metadata, { manta: { routineId: "r" } });
  assert.equal(rows[1].title, "knowledge:curator-notes");
  assert.equal(rows[2].metadata, null);
  assert.deepEqual(rows.map((r) => r.internal), [false, false, true, false]);
  assert.deepEqual(rows.map((r) => r.createdAt), [100, 200, 300, 5_000]);
});

test("createdBefore bounds the page and the keyset cursor pages on", async () => {
  const d = await db();
  const internalIds = async () => new Set();
  assert.deepEqual((await listSessionsPage({ db: d, internalIds, createdBefore: 1_000, limit: 10 })).map((r) => r.id), ["s1", "s2", "s3"]);
  assert.deepEqual((await listSessionsPage({ db: d, internalIds, afterId: "s1", limit: 1 })).map((r) => r.id), ["s2"]);
  assert.deepEqual(await listSessionsPage({ db: d, internalIds: async () => assert.fail("not needed"), afterId: "s9" }), []);
});
