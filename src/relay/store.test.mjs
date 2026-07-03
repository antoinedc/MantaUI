import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BOX_STATUS } from "./store.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef"; // 32 hex
const BOX_B = "fedcba9876543210fedcba9876543210";
const BOX_C = "aaaabbbbccccddddeeeeffff00001111";

// A fixed injectable clock so created_at/last_seen are deterministic.
function fixedClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  now.set = (ms) => (t = ms);
  return now;
}

// ---------------------------------------------------------------------------
// schema / migrations
// ---------------------------------------------------------------------------

test("schema is created idempotently — reopening the same file is a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-store-"));
  const path = join(dir, "relay.db");
  try {
    const s1 = openStore({ path });
    s1.upsertBox(BOX_A);
    s1.close();

    // Reopen: migration re-applies without error, prior data survives.
    const s2 = openStore({ path });
    const box = s2.getBox(BOX_A);
    assert.equal(box.box_id, BOX_A);
    s2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-memory DB leaves no fs artifacts", async () => {
  const before = await readdir(process.cwd());
  const s = openStore(); // ":memory:"
  s.upsertBox(BOX_A);
  s.bindBox(BOX_A, "acct-1");
  s.upsertReceipt({ originalTransactionId: "t1", boxId: BOX_A });
  s.close();
  const after = await readdir(process.cwd());
  assert.deepEqual(after.sort(), before.sort(), "no stray db files created");
});

// ---------------------------------------------------------------------------
// boxes
// ---------------------------------------------------------------------------

test("upsertBox: first sight sets created_at == last_seen; re-upsert bumps last_seen only", () => {
  const now = fixedClock();
  const s = openStore({ now });
  const first = s.upsertBox(BOX_A);
  assert.equal(first.box_id, BOX_A);
  assert.equal(first.status, BOX_STATUS.ONLINE);
  assert.equal(first.created_at, first.last_seen);
  const createdAt = first.created_at;

  now.advance(5000);
  const second = s.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE });
  assert.equal(second.created_at, createdAt, "created_at preserved");
  assert.equal(second.last_seen, createdAt + 5000, "last_seen bumped");
  s.close();
});

test("setBoxStatus flips status + bumps last_seen; returns false for unknown box", () => {
  const now = fixedClock();
  const s = openStore({ now });
  s.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE });
  now.advance(1000);
  assert.equal(s.setBoxStatus(BOX_A, BOX_STATUS.OFFLINE), true);
  const box = s.getBox(BOX_A);
  assert.equal(box.status, BOX_STATUS.OFFLINE);
  assert.equal(box.last_seen, now());
  assert.equal(s.setBoxStatus(BOX_B, BOX_STATUS.OFFLINE), false);
  s.close();
});

test("getBox returns null for unknown box; listBoxes orders by last_seen desc", () => {
  const now = fixedClock();
  const s = openStore({ now });
  assert.equal(s.getBox(BOX_A), null);
  s.upsertBox(BOX_A);
  now.advance(10);
  s.upsertBox(BOX_B);
  const list = s.listBoxes();
  assert.equal(list.length, 2);
  assert.equal(list[0].box_id, BOX_B, "most recently seen first");
  s.close();
});

test("upsertBox rejects a malformed box_id", () => {
  const s = openStore();
  assert.throws(() => s.upsertBox("not-hex"), /invalid box_id/);
  assert.throws(() => s.upsertBox(BOX_A + "ff"), /invalid box_id/);
  assert.throws(() => s.upsertBox(BOX_A, { status: "weird" }), /invalid box status/);
  s.close();
});

// ---------------------------------------------------------------------------
// bindings — one account ↔ many boxes
// ---------------------------------------------------------------------------

test("bindBox: one account owns many boxes; a box belongs to one account", () => {
  const s = openStore();
  // Boxes must exist first (FK).
  s.upsertBox(BOX_A);
  s.upsertBox(BOX_B);
  s.upsertBox(BOX_C);

  s.bindBox(BOX_A, "acct-1");
  s.bindBox(BOX_B, "acct-1");
  s.bindBox(BOX_C, "acct-2");

  const acct1 = s.listBoxesForAccount("acct-1").map((b) => b.box_id).sort();
  assert.deepEqual(acct1, [BOX_A, BOX_B].sort());

  const acct2 = s.listBoxesForAccount("acct-2").map((b) => b.box_id);
  assert.deepEqual(acct2, [BOX_C]);

  assert.equal(s.getBinding(BOX_A).account_id, "acct-1");
  s.close();
});

test("re-binding a box moves it to the new account (one account per box)", () => {
  const s = openStore();
  s.upsertBox(BOX_A);
  s.bindBox(BOX_A, "acct-1");
  s.bindBox(BOX_A, "acct-2");
  assert.equal(s.getBinding(BOX_A).account_id, "acct-2");
  assert.deepEqual(s.listBoxesForAccount("acct-1"), []);
  assert.equal(s.listBoxesForAccount("acct-2").length, 1);
  s.close();
});

test("unbindBox removes the binding; binding cascade-deletes when box removed", () => {
  const s = openStore();
  s.upsertBox(BOX_A);
  s.bindBox(BOX_A, "acct-1");
  assert.equal(s.unbindBox(BOX_A), true);
  assert.equal(s.getBinding(BOX_A), null);
  assert.equal(s.unbindBox(BOX_A), false);

  // FK cascade: deleting the box deletes any binding.
  s.bindBox(BOX_A, "acct-1");
  s._db.prepare("DELETE FROM boxes WHERE box_id = ?").run(BOX_A);
  assert.equal(s.getBinding(BOX_A), null, "binding cascade-deleted with box");
  s.close();
});

test("bindBox rejects malformed box_id / empty account_id", () => {
  const s = openStore();
  s.upsertBox(BOX_A);
  assert.throws(() => s.bindBox("bad", "acct-1"), /invalid box_id/);
  assert.throws(() => s.bindBox(BOX_A, ""), /invalid account_id/);
  assert.throws(() => s.bindBox(BOX_A, 123), /invalid account_id/);
  s.close();
});

// ---------------------------------------------------------------------------
// receipts — table + accessors only (validation is Stage 5)
// ---------------------------------------------------------------------------

test("upsertReceipt inserts + looks up; upsert on same original_transaction_id updates", () => {
  const now = fixedClock();
  const s = openStore({ now });
  s.upsertBox(BOX_A);

  const r1 = s.upsertReceipt({
    originalTransactionId: "otx-1",
    boxId: BOX_A,
    productId: "sub.monthly",
    expiresAt: now() + 30 * 86400_000,
    raw: { foo: "bar" },
  });
  assert.equal(r1.original_transaction_id, "otx-1");
  assert.equal(r1.box_id, BOX_A);
  assert.equal(r1.product_id, "sub.monthly");
  assert.equal(typeof r1.raw, "string");
  assert.deepEqual(JSON.parse(r1.raw), { foo: "bar" });

  // Renewal: same original_transaction_id, new expiry.
  const newExpiry = now() + 60 * 86400_000;
  const r2 = s.upsertReceipt({
    originalTransactionId: "otx-1",
    boxId: BOX_A,
    productId: "sub.monthly",
    expiresAt: newExpiry,
    raw: "raw-string-form",
  });
  assert.equal(r2.expires_at, newExpiry);
  assert.equal(r2.raw, "raw-string-form");
  assert.equal(s.listReceiptsForBox(BOX_A).length, 1, "upsert, not duplicate insert");
  s.close();
});

test("listReceiptsForBox returns all receipts bound to a box; getReceipt null when absent", () => {
  const s = openStore();
  s.upsertBox(BOX_A);
  s.upsertReceipt({ originalTransactionId: "a", boxId: BOX_A });
  s.upsertReceipt({ originalTransactionId: "b", boxId: BOX_A });
  assert.equal(s.listReceiptsForBox(BOX_A).length, 2);
  assert.equal(s.getReceipt("nope"), null);
  s.close();
});

test("upsertReceipt requires originalTransactionId + valid box_id", () => {
  const s = openStore();
  s.upsertBox(BOX_A);
  assert.throws(
    () => s.upsertReceipt({ originalTransactionId: "", boxId: BOX_A }),
    /originalTransactionId required/,
  );
  assert.throws(
    () => s.upsertReceipt({ originalTransactionId: "x", boxId: "bad" }),
    /invalid box_id/,
  );
  s.close();
});

// ---------------------------------------------------------------------------
// index smoke — the indexed reads actually hit their indexes
// ---------------------------------------------------------------------------

test("indexed queries use their indexes (EXPLAIN QUERY PLAN smoke)", () => {
  const s = openStore();
  s.upsertBox(BOX_A);
  s.bindBox(BOX_A, "acct-1");
  s.upsertReceipt({ originalTransactionId: "otx", boxId: BOX_A });

  const bindingPlan = s
    .explain("SELECT * FROM bindings WHERE account_id = ?", "acct-1")
    .join(" ");
  assert.match(bindingPlan, /USING (COVERING )?INDEX idx_bindings_account/);

  const receiptPlan = s
    .explain("SELECT * FROM receipts WHERE box_id = ?", BOX_A)
    .join(" ");
  assert.match(receiptPlan, /USING (COVERING )?INDEX idx_receipts_box/);

  // Primary-key lookups use the implicit rowid/PK index (no full scan).
  const boxPlan = s.explain("SELECT * FROM boxes WHERE box_id = ?", BOX_A).join(" ");
  assert.doesNotMatch(boxPlan, /\bSCAN boxes\b(?!.*INDEX)/);
  s.close();
});
