// stoppedReconcile.test.mjs — the stale-entry sweep for the usage-stopped
// record. Pure decision + injected I/O; no disk, tmux or opencode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { staleReason, providerRecoveredSince, createStoppedReconciler } from "./stoppedReconcile.mjs";
import { removeStopped, stampStoppedLastLooked, armStopped, upsertStopped } from "./stoppedStore.mjs";
import { createUsageResumeEngine } from "./usageResume.mjs";

const REC = { conversation: "ses_a", provider: "codex", window: null, stoppedAt: 1000, armed: false, attempts: 1 };
const recovered = [{ provider: "codex", fetchedAt: 2000, windows: [{ kind: "session", pct: 4 }] }];
const stillLimited = [{ provider: "codex", fetchedAt: 2000, windows: [{ kind: "session", pct: 100 }] }];
const visibleA = new Set(["ses_a"]);

test("a deleted session is gone", () => {
  assert.equal(staleReason(REC, { exists: false, visible: visibleA, snapshots: [] }), "gone");
});

test("a session with no sidebar window is hidden", () => {
  assert.equal(staleReason(REC, { exists: true, visible: new Set(["ses_other"]), snapshots: [] }), "hidden");
});

test("unknown window set never hides", () => {
  assert.equal(staleReason(REC, { exists: true, visible: null, snapshots: [] }), null);
});

test("an unarmed entry clears once its provider recovers after the stop", () => {
  assert.equal(staleReason(REC, { exists: true, visible: visibleA, snapshots: recovered }), "recovered");
});

test("an armed entry is left to the resume engine on recovery", () => {
  assert.equal(staleReason({ ...REC, armed: true }, { exists: true, visible: visibleA, snapshots: recovered }), null);
});

test("still at the limit → kept", () => {
  assert.equal(staleReason(REC, { exists: true, visible: visibleA, snapshots: stillLimited }), null);
});

test("a reading taken before the stop never counts as recovered", () => {
  assert.equal(providerRecoveredSince(REC, [{ ...recovered[0], fetchedAt: 900 }]), false);
});

test("no reading / empty windows / other provider → not recovered", () => {
  assert.equal(providerRecoveredSince(REC, []), false);
  assert.equal(providerRecoveredSince(REC, [{ provider: "codex", fetchedAt: 2000, windows: [] }]), false);
  assert.equal(providerRecoveredSince(REC, [{ provider: "claude", fetchedAt: 2000, windows: [{ pct: 0 }] }]), false);
});

function memStore(records) {
  let state = { lastLooked: null, records };
  return { load: () => state, save: async (s) => { state = s; }, get: () => state };
}

test("reconciler removes stale entries in one write and keeps the rest", async () => {
  const store = memStore([
    { ...REC, conversation: "ses_gone" },
    { ...REC, conversation: "ses_hidden" },
    { ...REC, conversation: "ses_keep", armed: true },
    { ...REC, conversation: "ses_back" },
  ]);
  const events = [];
  const rec = createStoppedReconciler({
    load: store.load,
    remove: (input) => removeStopped(input, { load: store.load, save: store.save, publish: (e) => events.push(e) }),
    sessionExists: async (sid) => sid !== "ses_gone",
    visibleSessionIds: async () => new Set(["ses_keep", "ses_back", "ses_gone"]),
    snapshots: () => recovered,
  });
  const removed = await rec.run();
  assert.deepEqual(removed.sort(), ["ses_back", "ses_gone", "ses_hidden"]);
  assert.deepEqual(store.get().records.map((r) => r.conversation), ["ses_keep"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "usage-stopped.updated");
});

test("an empty or failing window listing is treated as unknown, not as 'all hidden'", async () => {
  for (const visibleSessionIds of [async () => new Set(), async () => { throw new Error("tmux down"); }]) {
    const store = memStore([{ ...REC }]);
    const rec = createStoppedReconciler({
      load: store.load,
      remove: (input) => removeStopped(input, { load: store.load, save: store.save }),
      sessionExists: async () => true,
      visibleSessionIds,
      snapshots: () => stillLimited,
    });
    assert.deepEqual(await rec.run(), []);
    assert.equal(store.get().records.length, 1);
  }
});

test("a throwing existence check never drops", async () => {
  const store = memStore([{ ...REC }]);
  const rec = createStoppedReconciler({
    load: store.load,
    remove: (input) => removeStopped(input, { load: store.load, save: store.save }),
    sessionExists: async () => { throw new Error("blip"); },
    visibleSessionIds: async () => visibleA,
    snapshots: () => [],
  });
  assert.deepEqual(await rec.run(), []);
  assert.equal(store.get().records.length, 1);
});

test("removeStopped with nothing matching writes nothing", async () => {
  let saves = 0;
  const store = memStore([{ ...REC }]);
  const out = await removeStopped({ entries: [{ conversation: "nope", stoppedAt: 1000 }] }, { load: store.load, save: async () => { saves++; } });
  assert.deepEqual(out, []);
  assert.equal(saves, 0);
});

test("stampStoppedLastLooked works with no injected clock (the RPC calls it with {})", async () => {
  const store = memStore([]);
  const before = Date.now();
  await stampStoppedLastLooked({}, { load: store.load, save: store.save });
  assert.ok(store.get().lastLooked >= before);
});

test("an entry armed while the sweep was deciding survives the removal", async () => {
  const store = memStore([{ ...REC }]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const rec = createStoppedReconciler({
    load: store.load,
    remove: (input) => removeStopped(input, { load: store.load, save: store.save }),
    sessionExists: async () => { await gate; return true; },
    visibleSessionIds: async () => visibleA,
    snapshots: () => recovered,
  });
  const running = rec.run();
  await new Promise((r) => setImmediate(r));
  await armStopped({ conversation: "ses_a" }, { load: store.load, save: store.save });
  release();
  assert.deepEqual(await running, []);
  assert.equal(store.get().records[0].armed, true);
});

test("an entry re-enrolled while the sweep was deciding survives the removal", async () => {
  const store = memStore([{ ...REC }]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const rec = createStoppedReconciler({
    load: store.load,
    remove: (input) => removeStopped(input, { load: store.load, save: store.save }),
    sessionExists: async () => { await gate; return false; },
    visibleSessionIds: async () => visibleA,
    snapshots: () => [],
  });
  const running = rec.run();
  await new Promise((r) => setImmediate(r));
  await upsertStopped({ ...REC, stoppedAt: 5000 }, { load: store.load, save: store.save });
  release();
  assert.deepEqual(await running, []);
  assert.equal(store.get().records[0].stoppedAt, 5000);
});

test("concurrent store mutations never drop each other's change", async () => {
  // A deliberately slow, read-copy-write store: without serialization the
  // second writer would overwrite the first.
  let disk = { lastLooked: null, records: [{ ...REC, conversation: "ses_x" }] };
  const load = () => structuredClone(disk);
  const save = async (s) => { await new Promise((r) => setTimeout(r, 5)); disk = structuredClone(s); };
  await Promise.all([
    removeStopped({ entries: [{ conversation: "ses_x", stoppedAt: 1000, armed: false }] }, { load, save }),
    upsertStopped({ ...REC, conversation: "ses_y" }, { load, save }),
    upsertStopped({ ...REC, conversation: "ses_z" }, { load, save }),
  ]);
  assert.deepEqual(disk.records.map((r) => r.conversation).sort(), ["ses_y", "ses_z"]);
});

test("a staggered resume is skipped if its entry left the record before the send", async () => {
  let records = [
    { ...REC, conversation: "ses_1", armed: true, stoppedAt: 1 },
    { ...REC, conversation: "ses_2", armed: true, stoppedAt: 2 },
  ];
  const timers = [];
  const delivered = [];
  const engine = createUsageResumeEngine({
    load: async () => ({ records, lastLooked: null }),
    deliver: async ({ sessionId }) => { delivered.push(sessionId); },
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
    now: () => 3000,
  });
  await engine.deliverSnapshots(recovered);
  // ses_2 is cleared (e.g. its window closed) between planning and its send.
  records = records.filter((r) => r.conversation !== "ses_2");
  for (const fn of timers) fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(delivered, ["ses_1"]);
});

test("existence checks are capped at a few in flight", async () => {
  const store = memStore(Array.from({ length: 12 }, (_, i) => ({ ...REC, conversation: `ses_${i}` })));
  let inFlight = 0;
  let peak = 0;
  const rec = createStoppedReconciler({
    load: store.load,
    remove: (input) => removeStopped(input, { load: store.load, save: store.save }),
    sessionExists: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return false;
    },
    visibleSessionIds: async () => null,
    snapshots: () => [],
  });
  assert.equal((await rec.run()).length, 12);
  assert.ok(peak <= 4, `peak ${peak}`);
});
