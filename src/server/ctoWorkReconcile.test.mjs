import test from "node:test";
import assert from "node:assert/strict";
import { createCtoWorkReconciler } from "./ctoWorkReconcile.mjs";

test("terminal correlated work jobs are reconciled and ordinary jobs are ignored", async () => {
  const seen = [];
  const reconciler = createCtoWorkReconciler({
    listJobs: async () => [
      { id: "done", status: "done", correlation: { kind: "work", workId: "w1" } },
      { id: "failed", status: "failed", correlation: { kind: "work", workId: "w2" } },
      { id: "stopped", status: "stopped", correlation: { kind: "work", workId: "w3" } },
      { id: "ordinary", status: "done", correlation: { kind: "delegate" } },
      { id: "live", status: "running", correlation: { kind: "work", workId: "w4" } },
    ],
    recordWorkerOutcome: async (job) => { seen.push(job.id); return { adopted: job.id === "done" }; },
  });
  assert.deepEqual(await reconciler.tick(), { ok: true, reconciled: 1 });
  assert.deepEqual(seen, ["done", "failed", "stopped"]);
});

test("reconciler joins an in-flight scan and retries transient adoption failures on a later tick", async () => {
  let release;
  let fail = true;
  let scans = 0;
  const errors = [];
  const reconciler = createCtoWorkReconciler({
    listJobs: async () => { scans += 1; return [{ id: "job", status: "failed", correlation: { kind: "work", workId: "w" } }]; },
    recordWorkerOutcome: async () => {
      await new Promise((resolve) => { release = resolve; });
      if (fail) throw new Error("disk temporarily unavailable");
      return { adopted: true };
    },
    onError: (message) => errors.push(message),
  });
  const first = reconciler.tick();
  const joined = reconciler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all([first, joined]), [{ ok: true, reconciled: 0 }, { ok: true, reconciled: 0 }]);
  assert.equal(scans, 1, "concurrent wakeups share one scan");
  assert.equal(errors.length, 1);
  fail = false;
  const second = reconciler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await second, { ok: true, reconciled: 1 });
  assert.equal(scans, 2, "a later tick retries transient failure");
});
