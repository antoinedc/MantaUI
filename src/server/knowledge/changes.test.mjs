import { test } from "node:test";
import assert from "node:assert/strict";
import { createChangeLog } from "./changes.mjs";
import { memState } from "./testHelpers.mjs";

async function rig() {
  const state = await memState();
  let t = 1000;
  return createChangeLog({ state, now: () => (t += 10) });
}

test("add + list: newest first, pinned wire shape, undoable only while not undone", async () => {
  const log = await rig();
  const a = log.add({ kind: "applied", summary: "Add gotchas", reason: "seen twice", area: "project", slug: "p-0123456789", undoable: true, commitSha: "abc1234", decisionId: "d_1" });
  const b = log.add({ kind: "waiting", summary: "Waiting for a capable model", reason: "none connected" });
  const { items, nextCursor } = log.list();
  assert.deepEqual(items.map((i) => i.id), [b, a]);
  assert.equal(nextCursor, null);
  assert.deepEqual(items[1], { id: a, at: 1010, kind: "applied", summary: "Add gotchas", reason: "seen twice", area: "project", undoable: true, slug: "p-0123456789" });
  assert.equal(items[0].undoable, false);
  log.markUndone(a);
  const after = log.list().items.find((i) => i.id === a);
  assert.equal(after.undoable, false);
  assert.ok(after.undoneAt > 0);
});

test("paging by cursor", async () => {
  const log = await rig();
  const ids = Array.from({ length: 5 }, (_, i) => log.add({ summary: `s${i}` }));
  const p1 = log.list({ limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = log.list({ limit: 2, cursor: p1.nextCursor });
  const p3 = log.list({ limit: 2, cursor: p2.nextCursor });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i) => i.id), [...ids].reverse());
  assert.equal(p3.nextCursor, null);
});

test("get returns internals (commit, decision, batch, data); setError is visible on the wire", async () => {
  const log = await rig();
  const id = log.add({ kind: "applied", summary: "x", undoable: true, commitSha: "deadbee", decisionId: "d_2", batchId: "b_1", data: { k: 1 } });
  const c = log.get(id);
  assert.equal(c.commitSha, "deadbee");
  assert.deepEqual(c.data, { k: 1 });
  log.setError(id, "conflicts with a later change");
  assert.equal(log.list().items[0].error, "conflicts with a later change");
  assert.equal(log.get("nope"), null);
});

test("unknown kinds fall back to notice; countsSince groups by kind", async () => {
  const log = await rig();
  log.add({ kind: "weird", summary: "x" });
  log.add({ kind: "dropped", summary: "y" });
  log.add({ kind: "dropped", summary: "z" });
  assert.deepEqual(log.countsSince(0), { notice: 1, dropped: 2 });
});
