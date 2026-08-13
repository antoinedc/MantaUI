// BET-770 — regression tests for the audit findings P2-1 / P2-2 / P2-3 / P3-1.
//
// Each store's read-modify-write is serialized behind a single-writer mutex
// (createMutex) shared by every writer of that store, and the jsonStore temp
// name is unique per call. These tests drive genuinely concurrent writers
// against a REAL temp-file store and assert the guarantees the serialization
// exists to provide: no lost update, no terminal-job resurrection, no false
// timeout, no cap overrun, and no temp-name collision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeJsonAtomic, readJsonSync } from "./jsonStore.mjs";
import * as cap from "./capabilities.mjs";
import * as del from "./delegate.mjs";

async function tmpDir() {
  return mkdtemp(join(tmpdir(), "manta-audit-jobs-"));
}

function runningJob(id, over = {}) {
  return {
    id,
    name: `job${id}`,
    prompt: "p",
    model: null,
    parentSessionID: `parent${id}`,
    parentDirectory: "/repo",
    childSessionID: `child${id}`,
    tmuxSession: "s",
    windowIndex: 0,
    worktree: null,
    branch: null,
    baseSha: null,
    status: "running",
    activity: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
    result: null,
    error: null,
    filesChanged: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// P3-1: two same-ms, same-path jsonStore writes both land (no ENOENT, no
// clobber, no temp left behind).
// ---------------------------------------------------------------------------
test("two concurrent same-path jsonStore writes both land (no ENOENT, no clobber)", async () => {
  const dir = await tmpDir();
  const path = join(dir, "store.json");
  const results = await Promise.all([
    writeJsonAtomic(path, JSON.stringify({ writer: "a", n: 1 })),
    writeJsonAtomic(path, JSON.stringify({ writer: "b", n: 2 })),
  ]);
  // Neither threw: a colliding temp rename would have surfaced as ENOENT.
  assert.deepEqual(results, [undefined, undefined]);
  const final = readJsonSync(path, null);
  // The final file is the full, valid payload of the last writer — never a
  // partial/clobbered value.
  assert.ok(final && typeof final === "object");
  assert.ok(final.writer === "a" || final.writer === "b");
  assert.equal(Object.keys(final).length, 2, "payload is intact, not interleaved/corrupt");
  const entries = await readdir(dir);
  assert.deepEqual(
    entries.filter((e) => e.startsWith("store.json.tmp")),
    [],
    "no temp file is left behind",
  );
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P2-3 (capabilities): two concurrent appendLog writers to the same job — no
// lost update; both chunks survive.
// ---------------------------------------------------------------------------
test("two concurrent appendLog writers to one job: no lost update", async () => {
  const dir = await tmpDir();
  const path = join(dir, "cap.json");
  const load = () => cap.loadJobs(path);
  const save = (jobs) => cap.saveJobs(jobs, path);
  const made = await cap.createCapJob(
    { capability: "cap", host: "desktop", sessionID: "s" },
    { load, save },
  );
  await cap.startJob(made.job.id, { load, save });
  await Promise.all([
    cap.appendLog(made.job.id, "AA", { load, save }),
    cap.appendLog(made.job.id, "BB", { load, save }),
  ]);
  const job = (await cap.loadJobs(path)).find((j) => j.id === made.job.id);
  const joined = job.log.join("");
  assert.ok(joined.includes("AA"), "first concurrent append survives");
  assert.ok(joined.includes("BB"), "second concurrent append survives");
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P2-2 (delegate): >MAX_RUNNING_JOBS concurrent delegate starts do not exceed
// the cap. The read-then-act cap check runs inside the jobs lock, so exactly
// MAX_RUNNING_JOBS succeed.
// ---------------------------------------------------------------------------
test("concurrent delegate starts never exceed MAX_RUNNING_JOBS", async () => {
  const dir = await tmpDir();
  const path = join(dir, "delegate.json");
  const load = () => del.loadJobs(path);
  const save = (jobs) => del.saveJobs(jobs, path);
  const parentWin = { index: 0, name: "p", opencodeSessionId: "PARENT", paneCurrentPath: "/repo" };
  const deps = {
    load,
    save,
    publish() {},
    deliver: async () => ({ delivered: true }),
    gitAddWorktree: async () => {
      throw new Error("not a git repository");
    },
    listProjects: async () => [{ tmuxSession: "proj", windows: [parentWin] }],
    newWindow: async (input) => ({
      sessionId: `child-${input.windowName}`,
      windowIndex: 1,
      projects: [{ tmuxSession: "proj", windows: [parentWin] }],
    }),
  };

  const N = del.MAX_RUNNING_JOBS + 3;
  const attempt = (i) =>
    del.startJob({ prompt: `job ${i}`, parentSessionID: "PARENT", parentDirectory: "/repo" }, deps);
  const results = await Promise.all(Array.from({ length: N }, (_, i) => attempt(i)));

  const okCount = results.filter((r) => r.ok).length;
  const running = (await del.loadJobs(path)).filter((j) => j.status === "running").length;
  const refused = results.filter((r) => !r.ok && r.error === del.CAP_ERROR).length;

  assert.equal(okCount, del.MAX_RUNNING_JOBS, "exactly MAX_RUNNING_JOBS starts succeed");
  assert.equal(running, del.MAX_RUNNING_JOBS, "never more than MAX_RUNNING_JOBS running");
  assert.equal(refused, N - del.MAX_RUNNING_JOBS, "the remainder are refused with the cap error");
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P2-1 (delegate): a completing job racing the timeout sweep is not flipped to
// "timed out" and is not notified of a false timeout. finishJob holds the lock
// through its delivery; the sweep queued behind it re-reads the now-done job
// and must leave it terminal.
// ---------------------------------------------------------------------------
test("a completing delegate job racing the timeout sweep is not flipped to timed out", async () => {
  const dir = await tmpDir();
  const path = join(dir, "delegate.json");
  const load = () => del.loadJobs(path);
  const save = (jobs) => del.saveJobs(jobs, path);
  // startedAt=1 → with the sweep's future `now`, a still-running job would time out.
  const job = runningJob("j1", { startedAt: 1 });
  await save([job]);

  const delivered = [];
  let doneDeliveredResolve;
  const doneDelivered = new Promise((r) => (doneDeliveredResolve = r));

  const finishDeps = {
    load,
    save,
    publish() {},
    deliver: async (m) => {
      delivered.push(m);
      doneDeliveredResolve();
      return { delivered: true };
    },
    listMessages: async () => [],
    now: () => 100,
  };
  const sweepDeps = {
    load,
    save,
    publish() {},
    deliver: async (m) => delivered.push(m),
    now: () => 2_000_000, // far past RUNNING_TIMEOUT_MS for a startedAt=1 running job
    sessionExists: async () => true,
    killWindow: async () => {},
    gitRemoveWorktree: async () => ({ removed: true }),
  };

  const pFinish = del.finishJob(job, "done", null, finishDeps, new Map());
  await doneDelivered; // finishJob has persisted "done" and still holds the lock
  const pSweep = del.sweepDelegateJobs(sweepDeps); // queued behind the lock
  await Promise.all([pFinish, pSweep]);

  const stored = (await load()).find((j) => j.id === "j1");
  assert.equal(stored.status, "done", "completed job is not flipped to 'timed out' by the racing sweep");
  const falseTimeouts = delivered.filter((m) => (m.text || "").includes("timed out"));
  assert.equal(falseTimeouts.length, 0, "no false timeout is notified for a completed job");
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P2-3 (capabilities): a completing job racing the timeout sweep is not flipped
// to "timed out" / not notified of a false timeout.
// ---------------------------------------------------------------------------
test("a completing cap job racing the timeout sweep is not flipped to timed out", async () => {
  const dir = await tmpDir();
  const path = join(dir, "cap.json");
  const load = () => cap.loadJobs(path);
  const save = (jobs) => cap.saveJobs(jobs, path);
  const made = await cap.createCapJob(
    { capability: "cap", host: "desktop", sessionID: "s" },
    { load, save },
  );
  // Back-date startedAt so a still-running job would time out under the sweep's `now`.
  await cap.startJob(made.job.id, { load, save, now: () => 1 });

  const notified = [];
  let doneNotifyResolve;
  const doneNotified = new Promise((r) => (doneNotifyResolve = r));

  const pDone = cap.completeJob(
    made.job.id,
    { status: "done", result: { ok: true } },
    {
      load,
      save,
      publish() {},
      notifySession: async (m) => {
        notified.push(m);
        doneNotifyResolve();
      },
      now: () => 100,
    },
  );
  await doneNotified; // inside markTerminal, still holding the lock, save not yet run
  const pSweep = cap.sweepCapJobs({
    load,
    save,
    publish() {},
    notifySession: async (m) => notified.push(m),
    now: () => 2_000_000,
  });
  await Promise.all([pDone, pSweep]);

  const job = (await load()).find((j) => j.id === made.job.id);
  assert.equal(job.status, "done", "completed job is not flipped to 'timed out' by the racing sweep");
  const falseTimeouts = notified.filter((m) => String(m).includes("timed out"));
  assert.equal(falseTimeouts.length, 0, "no false timeout is notified for a completed job");
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P2-2 (delegate): a terminal (done) job is not resurrected to running by a
// stale activity-poller write.
// ---------------------------------------------------------------------------
test("a done job is not resurrected to running by a stale activity-poller write", async () => {
  const dir = await tmpDir();
  const path = join(dir, "delegate.json");
  const load = () => del.loadJobs(path);
  const save = (jobs) => del.saveJobs(jobs, path);
  const job = runningJob("j1", { activity: "idle" });
  await save([job]);

  const finishDeps = {
    load,
    save,
    publish() {},
    deliver: async () => ({ delivered: true }),
    listMessages: async () => [],
    now: () => 100,
  };
  const pollDeps = { load, save, publish() {}, listMessages: async () => [], now: () => Date.now() };

  await Promise.all([
    del.finishJob(job, "done", null, finishDeps, new Map()),
    del.tickActivity(pollDeps),
  ]);

  const stored = (await load()).find((j) => j.id === "j1");
  assert.equal(stored.status, "done", "the activity poller cannot resurrect a done job to running");
  await rm(dir, { recursive: true, force: true });
});
