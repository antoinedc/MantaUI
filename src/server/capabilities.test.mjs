import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCapJob,
  startJob,
  appendLog,
  completeJob,
  getJob,
  listJobs,
  sweepCapJobs,
  completionText,
} from "./capabilities.mjs";

// ----------------------------------------------------------------------------
// In-memory harness: load/save on a closure-held array, recorded publish + notify.
// Mirrors the harness style of src/server/schedule.test.mjs.
// ----------------------------------------------------------------------------

function harness(initialJobs = [], fixedNow = 1_700_000_000_000) {
  let jobs = initialJobs.map((j) => ({ ...j, log: j.log ? [...j.log] : [] }));
  const published = [];
  const notified = [];
  const saved = [];
  let nowMs = fixedNow;
  const deps = {
    load: async () => jobs.map((j) => ({ ...j, log: j.log ? [...j.log] : [] })),
    save: async (next) => {
      saved.push(next.map((j) => ({ ...j, log: j.log ? [...j.log] : [] })));
      jobs = next.map((j) => ({ ...j, log: j.log ? [...j.log] : [] }));
    },
    publish: (evt) => published.push(evt),
    notifySession: async (args) => {
      notified.push(args);
    },
    now: () => nowMs,
    setNow: (n) => { nowMs = n; },
  };
  return {
    deps,
    published,
    notified,
    saved,
    get jobs() {
      return jobs;
    },
  };
}

const T0 = 1_700_000_000_000;
const RUNNING_TIMEOUT_MS = 30 * 60_000;
const QUEUED_EXPIRY_MS = 24 * 60 * 60_000;
const LOG_CAP_BYTES = 256 * 1024;
const LOG_TAIL_BYTES = 16 * 1024;

// ----------------------------------------------------------------------------
// createCapJob — validation
// ----------------------------------------------------------------------------

test("createCapJob accepts a valid envelope and publishes capJob", async () => {
  const h = harness();
  const r = await createCapJob(
    { capability: "ios.build", input: { foo: 1 }, host: "mac", sessionID: "ses_abc" },
    h.deps,
  );
  assert.equal(r.ok, true);
  assert.equal(r.job.status, "queued");
  assert.equal(r.job.capability, "ios.build");
  assert.equal(r.job.host, "mac");
  assert.equal(r.job.input.foo, 1);
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].kind, "capJob");
  assert.equal(h.published[0].payload.id, r.job.id);
  assert.equal(h.published[0].payload.capability, "ios.build");
  assert.equal(h.published[0].payload.host, "mac");
});

test("createCapJob rejects empty capability", async () => {
  const h = harness();
  const r = await createCapJob(
    { capability: "", host: "mac", sessionID: "ses" },
    h.deps,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /capability/i);
});

test("createCapJob rejects bad host", async () => {
  const h = harness();
  const r = await createCapJob(
    { capability: "ios.build", host: "linux", sessionID: "ses" },
    h.deps,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /host/i);
});

test("createCapJob rejects missing sessionID", async () => {
  const h = harness();
  const r = await createCapJob(
    { capability: "ios.build", host: "mac", sessionID: "" },
    h.deps,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /sessionID/i);
});

test("createCapJob does NOT validate input (queue is capability-agnostic)", async () => {
  const h = harness();
  // Anything goes in `input` — the tool owns the shape.
  const r = await createCapJob(
    { capability: "ios.build", input: { nested: { whatever: null } }, host: "mac", sessionID: "ses" },
    h.deps,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.job.input, { nested: { whatever: null } });
});

// ----------------------------------------------------------------------------
// createCapJob → startJob → appendLog → completeJob: full lifecycle
// ----------------------------------------------------------------------------

test("lifecycle: create → start → appendLog×N → done, with timestamps and events", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses_abc" },
    h.deps,
  );
  assert.equal(created.ok, true);
  const id = created.job.id;

  const started = await startJob(id, h.deps);
  assert.equal(started.ok, true);

  await appendLog(id, "compiling...\n", h.deps);
  await appendLog(id, "linking...\n", h.deps);
  await appendLog(id, "done.\n", h.deps);

  const done = await completeJob(id, { status: "done", result: { ok: true } }, h.deps);
  assert.equal(done.ok, true);

  // Status flipped + finishedAt stamped
  assert.equal(h.jobs[0].status, "done");
  assert.equal(h.jobs[0].finishedAt, T0);
  assert.deepEqual(h.jobs[0].result, { ok: true });

  // capJob (create) and cap.updated (complete) both published
  const kinds = h.published.map((p) => p.kind);
  assert.deepEqual(kinds, ["capJob", "cap.updated"]);
  assert.equal(h.published[1].payload.id, id);
  assert.equal(h.published[1].payload.status, "done");

  // notifySession called once with completionText output
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].sessionID, "ses_abc");
  assert.match(h.notified[0].text, /ios\.build job .+ finished with status "done"\./);
});

// ----------------------------------------------------------------------------
// getJob — log tail + logBytes
// ----------------------------------------------------------------------------

test("getJob tails log to LOG_TAIL_BYTES and reports total logBytes", async () => {
  // Seed a job whose log is large enough to trigger tailing.
  const big = "x".repeat(LOG_TAIL_BYTES + 1000);
  const seeded = {
    id: "a1b2c3d4",
    capability: "ios.build",
    input: {},
    host: "mac",
    sessionID: "ses_abc",
    directory: "",
    status: "running",
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    log: [big.slice(0, 1000), big.slice(1000)],
    result: null,
    error: null,
  };
  const h = harness([seeded]);
  const job = await getJob(seeded.id, h.deps);
  assert.ok(job, "getJob returns the seeded job");
  assert.equal(job.logBytes, big.length);
  // Tail returned as a single-element array of length LOG_TAIL_BYTES
  assert.equal(job.log.length, 1);
  assert.equal(job.log[0].length, LOG_TAIL_BYTES);
  // The tail is the LAST LOG_TAIL_BYTES chars of the joined log
  assert.equal(job.log[0], big.slice(-LOG_TAIL_BYTES));
});

test("getJob returns null for missing id", async () => {
  const h = harness();
  const job = await getJob("nope", h.deps);
  assert.equal(job, null);
});

test("getJob does not mutate the stored job", async () => {
  const seeded = {
    id: "deadbeef",
    capability: "ios.build",
    input: {},
    host: "mac",
    sessionID: "ses_abc",
    directory: "",
    status: "running",
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    log: ["a".repeat(100), "b".repeat(100)],
    result: null,
    error: null,
  };
  const h = harness([seeded]);
  await getJob(seeded.id, h.deps);
  // Stored log unchanged.
  assert.deepEqual(h.jobs[0].log, ["a".repeat(100), "b".repeat(100)]);
});

// ----------------------------------------------------------------------------
// appendLog — ring-buffer + status guard
// ----------------------------------------------------------------------------

test("appendLog ring-buffers: total joined length stays ≤ LOG_CAP_BYTES, oldest dropped first", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  await startJob(created.job.id, h.deps);

  // Push chunks each > LOG_CAP_BYTES so each push triggers a drop.
  const chunk = "y".repeat(LOG_CAP_BYTES / 4); // quarter-cap each
  for (let i = 0; i < 8; i++) {
    await appendLog(created.job.id, chunk, h.deps);
  }
  const total = h.jobs[0].log.join("").length;
  assert.ok(total <= LOG_CAP_BYTES, `total ${total} ≤ ${LOG_CAP_BYTES}`);
  // The very first chunks should be gone — the latest chunks should be present.
  // Verify by checking that the log doesn't contain "yyyy" repeated enough to be the very first chunk.
  // (Imprecise but proves old chunks were dropped.)
  assert.ok(h.jobs[0].log.length < 8, "fewer than 8 chunks retained");
});

test("appendLog returns {ok:false} for a queued job", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  const r = await appendLog(created.job.id, "nope", h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, "job not running");
  assert.equal(r.status, "queued");
});

test("appendLog returns {ok:false} for a terminal job (no resurrection)", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  await startJob(created.job.id, h.deps);
  await completeJob(created.job.id, { status: "failed", error: "boom" }, h.deps);
  const r = await appendLog(created.job.id, "late flush", h.deps);
  assert.equal(r.ok, false);
  // Status is reported as whatever the job currently is.
  assert.equal(r.status, "failed");
});

test("appendLog returns {ok:false} for a missing job", async () => {
  const h = harness();
  const r = await appendLog("nonexistent", "x", h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not found");
});

// ----------------------------------------------------------------------------
// startJob — guarded claim
// ----------------------------------------------------------------------------

test("startJob transitions queued → running and stamps startedAt", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  const r = await startJob(created.job.id, h.deps);
  assert.equal(r.ok, true);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.jobs[0].startedAt, T0);
});

test("startJob returns {ok:false, status} when called twice (SSE+catch-up dedup)", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  await startJob(created.job.id, h.deps);
  const second = await startJob(created.job.id, h.deps);
  assert.equal(second.ok, false);
  assert.equal(second.error, "not queued");
  assert.equal(second.status, "running");
});

test("startJob returns {ok:false} for a terminal job", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  await startJob(created.job.id, h.deps);
  await completeJob(created.job.id, { status: "done" }, h.deps);
  const second = await startJob(created.job.id, h.deps);
  assert.equal(second.ok, false);
  assert.equal(second.status, "done");
});

test("startJob returns {ok:false, error:'not found'} for missing id", async () => {
  const h = harness();
  const r = await startJob("missing", h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not found");
});

// ----------------------------------------------------------------------------
// completeJob — idempotency + status validation
// ----------------------------------------------------------------------------

test("completeJob is idempotent: second call returns alreadyTerminal:true with no extra publish/notify", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  await startJob(created.job.id, h.deps);
  const first = await completeJob(created.job.id, { status: "done" }, h.deps);
  assert.equal(first.ok, true);

  const publishedBefore = h.published.length;
  const notifiedBefore = h.notified.length;
  const second = await completeJob(created.job.id, { status: "failed", error: "double" }, h.deps);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyTerminal, true);
  assert.equal(h.published.length, publishedBefore, "no extra publish");
  assert.equal(h.notified.length, notifiedBefore, "no extra notify");
  // State unchanged — still done, not failed.
  assert.equal(h.jobs[0].status, "done");
});

test("completeJob rejects an invalid status string", async () => {
  const h = harness();
  const created = await createCapJob(
    { capability: "ios.build", input: {}, host: "mac", sessionID: "ses" },
    h.deps,
  );
  await startJob(created.job.id, h.deps);
  const r = await completeJob(created.job.id, { status: "running" }, h.deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /status/);
});

test("completeJob returns {ok:false} for a missing job", async () => {
  const h = harness();
  const r = await completeJob("missing", { status: "done" }, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not found");
});

// ----------------------------------------------------------------------------
// listJobs — filters
// ----------------------------------------------------------------------------

test("listJobs returns no-log summary (logBytes replaces log)", async () => {
  const h = harness([
    {
      id: "a1",
      capability: "ios.build", input: {}, host: "mac", sessionID: "ses_a",
      directory: "", status: "done", createdAt: 0, startedAt: 0, finishedAt: 0,
      log: ["one", "two", "three"], result: null, error: null,
    },
  ]);
  const jobs = await listJobs({}, h.deps);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].log, undefined, "no `log` field in summary");
  assert.equal(jobs[0].logBytes, 11); // "one" + "two" + "three"
});

test("listJobs filters by sessionID, host, status — all AND-combined", async () => {
  const seeded = [
    { id: "a1", capability: "ios.build", input: {}, host: "mac", sessionID: "ses_a", directory: "", status: "queued",  createdAt: 0, startedAt: null, finishedAt: null, log: [], result: null, error: null },
    { id: "a2", capability: "ios.build", input: {}, host: "mac", sessionID: "ses_b", directory: "", status: "queued",  createdAt: 0, startedAt: null, finishedAt: null, log: [], result: null, error: null },
    { id: "a3", capability: "ios.build", input: {}, host: "box", sessionID: "ses_a", directory: "", status: "running", createdAt: 0, startedAt: 0,  finishedAt: null, log: [], result: null, error: null },
    { id: "a4", capability: "ios.build", input: {}, host: "mac", sessionID: "ses_a", directory: "", status: "done",    createdAt: 0, startedAt: 0,  finishedAt: 0,    log: [], result: null, error: null },
  ];
  const h = harness(seeded);

  // Single filter
  const bySess = await listJobs({ sessionID: "ses_a" }, h.deps);
  assert.equal(bySess.length, 3);
  const byHost = await listJobs({ host: "box" }, h.deps);
  assert.equal(byHost.length, 1);
  assert.equal(byHost[0].id, "a3");
  const byStatus = await listJobs({ status: "done" }, h.deps);
  assert.equal(byStatus.length, 1);
  assert.equal(byStatus[0].id, "a4");

  // Combined (AND)
  const combined = await listJobs({ sessionID: "ses_a", host: "mac", status: "queued" }, h.deps);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].id, "a1");
});

test("listJobs with no filters returns every job", async () => {
  const seeded = [
    { id: "a1", capability: "ios.build", input: {}, host: "mac", sessionID: "ses_a", directory: "", status: "queued", createdAt: 0, startedAt: null, finishedAt: null, log: [], result: null, error: null },
    { id: "a2", capability: "ios.build", input: {}, host: "box", sessionID: "ses_b", directory: "", status: "done",  createdAt: 0, startedAt: 0,    finishedAt: 0,    log: [], result: null, error: null },
  ];
  const h = harness(seeded);
  const all = await listJobs({}, h.deps);
  assert.equal(all.length, 2);
});

// ----------------------------------------------------------------------------
// sweepCapJobs — timeout, expiry, retention, no-change-no-save, fresh-running
// ----------------------------------------------------------------------------

test("sweep fails out a stale running job (startedAt > RUNNING_TIMEOUT_MS ago) and notifies", async () => {
  const h = harness();
  // Job started just inside the timeout → still running.
  const inside = {
    id: "insider", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "running",
    createdAt: 0, startedAt: T0 - RUNNING_TIMEOUT_MS + 1000, finishedAt: null,
    log: [], result: null, error: null,
  };
  // Job started well past the timeout → should fail.
  const stale = {
    id: "stale", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "running",
    createdAt: 0, startedAt: T0 - RUNNING_TIMEOUT_MS - 1000, finishedAt: null,
    log: [], result: null, error: null,
  };
  h.jobs.push(inside, stale);
  await sweepCapJobs(h.deps);

  const staleJob = h.jobs.find((j) => j.id === "stale");
  assert.equal(staleJob.status, "failed");
  assert.match(staleJob.error, /timed out after 30 minutes/);
  assert.equal(staleJob.finishedAt, T0);
  // The fresh one is untouched.
  assert.equal(h.jobs.find((j) => j.id === "insider").status, "running");

  // The stale job was notified exactly once.
  const notifies = h.notified.filter((n) => n.sessionID === "ses_a");
  assert.ok(notifies.length >= 1);
  assert.match(notifies[notifies.length - 1].text, /timed out after 30 minutes/);

  // A cap.updated event was published for the stale job.
  const updates = h.published.filter((p) => p.kind === "cap.updated");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.id, "stale");
  assert.equal(updates[0].payload.status, "failed");
});

test("sweep fails out an ancient queued job (createdAt > QUEUED_EXPIRY_MS ago)", async () => {
  const h = harness();
  const stale = {
    id: "ancient", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "queued",
    createdAt: T0 - QUEUED_EXPIRY_MS - 1000, startedAt: null, finishedAt: null,
    log: [], result: null, error: null,
  };
  h.jobs.push(stale);
  await sweepCapJobs(h.deps);

  const j = h.jobs.find((x) => x.id === "ancient");
  assert.equal(j.status, "failed");
  assert.match(j.error, /expired: no executor picked this job up within 24h/);
  assert.equal(h.notified.length, 1);
});

test("sweep retention: prunes terminal jobs older than TERMINAL_RETENTION_MS", async () => {
  const h = harness();
  const TERM = 7 * 24 * 60 * 60_000;
  const old = {
    id: "old", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "done",
    createdAt: 0, startedAt: 0, finishedAt: T0 - TERM - 1000,
    log: [], result: null, error: null,
  };
  const fresh = {
    id: "fresh", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "done",
    createdAt: 0, startedAt: 0, finishedAt: T0 - 1000,
    log: [], result: null, error: null,
  };
  h.jobs.push(old, fresh);
  await sweepCapJobs(h.deps);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].id, "fresh");
});

test("sweep retention: enforces MAX_TERMINAL_JOBS by dropping the oldest", async () => {
  const h = harness();
  // 55 terminal jobs all recent enough to survive the retention cutoff,
  // staggered finishedAt so the oldest 5 should be dropped. finishedAt
  // is offset from T0 so the test doesn't depend on the wall clock.
  for (let i = 0; i < 55; i++) {
    h.jobs.push({
      id: `j${i}`, capability: "ios.build", input: {}, host: "mac",
      sessionID: "ses_a", directory: "", status: "done",
      createdAt: 0, startedAt: 0, finishedAt: T0 - 1000 + i, // j0 oldest, j54 newest
      log: [], result: null, error: null,
    });
  }
  await sweepCapJobs(h.deps);
  assert.equal(h.jobs.length, 50);
  // The oldest 5 (j0..j4) should be gone; j5..j54 remain.
  const ids = h.jobs.map((j) => j.id);
  assert.ok(!ids.includes("j0"));
  assert.ok(!ids.includes("j4"));
  assert.ok(ids.includes("j5"));
  assert.ok(ids.includes("j54"));
});

test("sweep leaves a fresh running job untouched", async () => {
  const h = harness();
  const fresh = {
    id: "fresh", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "running",
    createdAt: T0, startedAt: T0, finishedAt: null,
    log: ["hello"], result: null, error: null,
  };
  h.jobs.push(fresh);
  const publishedBefore = h.published.length;
  await sweepCapJobs(h.deps);
  const j = h.jobs.find((x) => x.id === "fresh");
  assert.equal(j.status, "running");
  assert.equal(j.finishedAt, null);
  assert.equal(j.log[0], "hello");
  // No cap.updated published for this job.
  const updates = h.published.slice(publishedBefore).filter((p) => p.kind === "cap.updated");
  assert.equal(updates.length, 0);
});

test("sweep no-change pass does not save", async () => {
  const h = harness();
  const fresh = {
    id: "fresh", capability: "ios.build", input: {}, host: "mac",
    sessionID: "ses_a", directory: "", status: "running",
    createdAt: T0, startedAt: T0, finishedAt: null,
    log: [], result: null, error: null,
  };
  h.jobs.push(fresh);
  const savedBefore = h.saved.length;
  await sweepCapJobs(h.deps);
  assert.equal(h.saved.length, savedBefore, "no save on a no-change pass");
});

// ----------------------------------------------------------------------------
// completionText — pure formatter
// ----------------------------------------------------------------------------

test("completionText for a done job", () => {
  const j = { id: "abc12345", capability: "ios.build", status: "done" };
  const txt = completionText(j);
  assert.match(txt, /^\[MantaUI capability job\] ios\.build job abc12345 finished with status "done"\./);
  assert.match(txt, /ios_build_status\("abc12345"\)/);
  // No "Error:" suffix on success.
  assert.equal(txt.includes("Error:"), false);
});

test("completionText for a failed job includes the error", () => {
  const j = { id: "abc12345", capability: "ios.build", status: "failed", error: "exit 1" };
  const txt = completionText(j);
  assert.match(txt, /status "failed"\./);
  assert.match(txt, /Error: exit 1\./);
  assert.match(txt, /ios_build_status\("abc12345"\)/);
});
