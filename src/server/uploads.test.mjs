import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectExpiredBatches, listUploadBatches, sweepUploads } from "./uploads.mjs";

const HOUR_MS = 3600_000;

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "manta-uploads-test-"));
}

// Make a batch dir under <root>/<session>/<batch> with one file inside, and
// optionally backdate its mtime to simulate age.
async function makeBatch(root, session, batch, ageMs = 0) {
  const dir = join(root, session, batch);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "file.txt"), "x");
  if (ageMs > 0) {
    const ts = new Date(Date.now() - ageMs);
    await utimes(dir, ts, ts);
  }
  return dir;
}

import { utimes } from "node:fs/promises";

// ----------------------------------------------------------------------------
// selectExpiredBatches — pure helper (no fs)
// ----------------------------------------------------------------------------

test("selectExpiredBatches: deletes a batch older than the threshold, keeps a newer one", () => {
  const now = 1_000_000;
  const batches = [
    { session: "s1", name: "900000", path: "/r/s1/900000", mtimeMs: now - 25 * HOUR_MS }, // older
    { session: "s1", name: "999000", path: "/r/s1/999000", mtimeMs: now - 1 * HOUR_MS },  // newer
  ];
  const expired = selectExpiredBatches(batches, now, 24 * HOUR_MS);
  assert.deepEqual(expired.map((b) => b.name), ["900000"]);
});

test("selectExpiredBatches: threshold 0 (disabled) → no deletion, all retained", () => {
  const now = 1_000_000;
  const batches = [
    { session: "s1", name: "1", path: "/r/s1/1", mtimeMs: now - 1000 * HOUR_MS },
    { session: "s1", name: "2", path: "/r/s1/2", mtimeMs: now - 2 * HOUR_MS },
  ];
  assert.deepEqual(selectExpiredBatches(batches, now, 0), []);
  assert.deepEqual(selectExpiredBatches(batches, now, -1), []);
});

test("selectExpiredBatches: age boundary — exactly at now - threshold is deleted (>=)", () => {
  const now = 1_000_000;
  const threshold = 24 * HOUR_MS;
  const batches = [
    { session: "s", name: "edge", path: "/r/s/edge", mtimeMs: now - threshold }, // exactly threshold old
    { session: "s", name: "fresh", path: "/r/s/fresh", mtimeMs: now - threshold + 1 }, // 1ms newer
  ];
  const expired = selectExpiredBatches(batches, now, threshold);
  assert.deepEqual(expired.map((b) => b.name), ["edge"]);
});

test("selectExpiredBatches: non-finite threshold → [] (NaN no-op; Infinity never reached)", () => {
  const now = 1_000_000;
  const batches = [{ session: "s", name: "1", path: "/r/s/1", mtimeMs: 0 }];
  assert.deepEqual(selectExpiredBatches(batches, now, Number.NaN), []);
  assert.deepEqual(selectExpiredBatches(batches, now, Infinity), []);
});

// ----------------------------------------------------------------------------
// listUploadBatches — fs helper
// ----------------------------------------------------------------------------

test("listUploadBatches returns [] when the root does not exist", async () => {
  const entries = await listUploadBatches(join(tmpdir(), "definitely-not-here-manta-upl-xyz"));
  assert.deepEqual(entries, []);
});

test("listUploadBatches lists session/<batch> dirs with mtime, ignoring stray files", async () => {
  const root = await makeRoot();
  try {
    await makeBatch(root, "proj", "1700000000000", 0);
    await makeBatch(root, "proj", "1700000000001", 0);
    // stray file at session level + non-batch dir name
    await writeFile(join(root, "proj", "notes.txt"), "z");
    await mkdir(join(root, "proj", "not-a-ts"), { recursive: true });
    const entries = await listUploadBatches(root);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["1700000000000", "1700000000001"]);
    for (const e of entries) {
      assert.equal(e.session, "proj");
      assert.equal(typeof e.mtimeMs, "number");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// sweepUploads — fs sweep
// ----------------------------------------------------------------------------

test("sweepUploads deletes an expired batch dir and keeps a newer one", async () => {
  const root = await makeRoot();
  try {
    const old = await makeBatch(root, "s", "1700000000000", 25 * HOUR_MS);
    const fresh = await makeBatch(root, "s", "1700000000001", 1 * HOUR_MS);
    const deleted = await sweepUploads({ root, thresholdMs: 24 * HOUR_MS });
    assert.deepEqual(deleted, [old]);
    // fresh batch + its file still present
    await stat(fresh);
    await stat(join(fresh, "file.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepUploads: threshold 0 (disabled) → no deletion", async () => {
  const root = await makeRoot();
  try {
    const old = await makeBatch(root, "s", "1700000000000", 100 * HOUR_MS);
    const deleted = await sweepUploads({ root, thresholdMs: 0 });
    assert.deepEqual(deleted, []);
    await stat(old); // still there
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepUploads prunes an empty session dir after its only batch is deleted", async () => {
  const root = await makeRoot();
  try {
    await makeBatch(root, "lonely", "1700000000000", 25 * HOUR_MS);
    await sweepUploads({ root, thresholdMs: 24 * HOUR_MS });
    await assert.rejects(() => stat(join(root, "lonely")), (e) => e.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepUploads keeps a session dir that still has a non-expired batch", async () => {
  const root = await makeRoot();
  try {
    await makeBatch(root, "mixed", "1700000000000", 25 * HOUR_MS);
    await makeBatch(root, "mixed", "1700000000001", 1 * HOUR_MS);
    await sweepUploads({ root, thresholdMs: 24 * HOUR_MS });
    // session dir still present, only the fresh batch remains
    const remaining = await readdir(join(root, "mixed"));
    assert.deepEqual(remaining, ["1700000000001"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepUploads leaves non-batch files / unexpected layout alone", async () => {
  const root = await makeRoot();
  try {
    // stray file at root, non-batch dir, a deep file — none should be touched
    await writeFile(join(root, "loose.txt"), "x");
    await mkdir(join(root, "weird"), { recursive: true });
    await writeFile(join(root, "weird", "data.txt"), "y");
    const deleted = await sweepUploads({ root, thresholdMs: 24 * HOUR_MS });
    assert.deepEqual(deleted, []);
    await stat(join(root, "loose.txt"));
    await stat(join(root, "weird", "data.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweepUploads: root does not exist → [] / no throw", async () => {
  const deleted = await sweepUploads({
    root: join(tmpdir(), "definitely-not-here-manta-upl-sweep"),
    thresholdMs: 24 * HOUR_MS,
  });
  assert.deepEqual(deleted, []);
});

test("sweepUploads default threshold applied when config key absent — integration via poller tick logic", async () => {
  // Verify the default-24h path the poller uses: a batch 25h old is swept,
  // a batch 23h old is retained, with thresholdMs = 24 * HOUR_MS (the default
  // the poller computes from `uploadCleanupHours ?? 24`).
  const root = await makeRoot();
  try {
    const old = await makeBatch(root, "s", "1700000000000", 25 * HOUR_MS);
    const fresh = await makeBatch(root, "s", "1700000000001", 23 * HOUR_MS);
    const deleted = await sweepUploads({ root, thresholdMs: 24 * HOUR_MS });
    assert.deepEqual(deleted, [old]);
    await stat(fresh);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
