import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReport,
  reportProgress,
  readProgressRecord,
  clearProgress,
  pruneRecords,
  sweepProgress,
  PROGRESS_RETENTION_MS,
} from "./progress.mjs";

// Injected store helpers — an in-memory map that mimics loadRecords/saveRecords
// so tests never touch the filesystem (sandbox or otherwise).
function memStore() {
  const records = {};
  return {
    records,
    load: async () => ({ ...records }),
    save: async (r) => {
      for (const k of Object.keys(records)) delete records[k];
      Object.assign(records, r);
    },
    reset: async () => {
      for (const k of Object.keys(records)) delete records[k];
    },
  };
}

let t = 1_000_000;
const clock = () => t; // mutable fake clock

// ---------------------------------------------------------------------------
// applyReport — the merge rule (replace label/detail/state; monotonic step;
// total free; updatedAt advances)
// ---------------------------------------------------------------------------

test("applyReport builds a full record from a first report", () => {
  const r = applyReport(undefined, { sessionID: "s1", label: "step 1", step: 1, total: 5, state: "working", detail: "hi" }, clock);
  assert.equal(r.ok, true);
  assert.deepEqual(r.record, {
    sessionID: "s1",
    label: "step 1",
    step: 1,
    total: 5,
    state: "working",
    detail: "hi",
    updatedAt: t,
  });
});

test("applyReport replaces label/detail/state but keeps monotonic step", () => {
  const prev = applyReport(undefined, { sessionID: "s1", label: "start", step: 1, total: 5, state: "working", detail: "" }, clock).record;
  t += 1000;
  const next = applyReport(prev, { label: "later", step: 2, total: 6, state: "working", detail: "moved on" }, clock).record;
  assert.equal(next.label, "later");
  assert.equal(next.detail, "moved on");
  assert.equal(next.state, "working");
  assert.equal(next.step, 2);
  assert.equal(next.total, 6); // total free to change
  assert.equal(next.updatedAt, t);
});

test("monotonic guard: step 4 then step 2 keeps 4", () => {
  let rec = applyReport(undefined, { sessionID: "s1", step: 4, total: 4 }, clock).record;
  t += 1000;
  rec = applyReport(rec, { step: 2, total: 4 }, clock).record;
  assert.equal(rec.step, 4); // a bar going 4/5 → 2/5 reads as a bug — clamp it
});

test("partial reports inherit fields they do not set", () => {
  const first = applyReport(undefined, { sessionID: "s1", label: "A", step: 1, total: 3, state: "working" }, clock).record;
  const second = applyReport(first, { state: "blocked", detail: "stuck" }, clock).record;
  assert.equal(second.label, "A");
  assert.equal(second.step, 1);
  assert.equal(second.total, 3);
  assert.equal(second.state, "blocked");
  assert.equal(second.detail, "stuck");
});

test("state validation: an unknown value is rejected", () => {
  const r = applyReport(undefined, { sessionID: "s1", state: "narrating" }, clock);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid state/);
});

test("invalid step/total are rejected", () => {
  assert.equal(applyReport(undefined, { step: "two" }, clock).ok, false);
  assert.equal(applyReport(undefined, { total: 0 }, clock).ok, false);
  assert.equal(applyReport(undefined, { step: -1 }, clock).ok, false);
});

// ---------------------------------------------------------------------------
// reportProgress — replace, never append; unknown sinks ignored; publishes
// ---------------------------------------------------------------------------

test("calling reportProgress three times leaves exactly one record", async () => {
  const store = memStore();
  const published = [];
  for (let i = 1; i <= 3; i += 1) {
    await reportProgress({ sessionID: "s1", label: `report ${i}`, step: i, total: 3 }, {
      load: store.load, save: store.save, publish: (e) => published.push(e), now: clock,
    });
    t += 1;
  }
  const recs = await readProgressRecord("s1", { load: store.load });
  assert.equal(recs.label, "report 3");
  assert.equal(recs.step, 3);
  // Exactly one record for the session in the store.
  const all = await store.load();
  assert.equal(Object.keys(all).length, 1);
  // Exactly one bus event per call.
  assert.equal(published.length, 3);
  assert.deepEqual(published[0], { kind: "progress.updated", payload: { sessionID: "s1" } });
});

test("unknown sink names are ignored, not fatal", async () => {
  const store = memStore();
  const r = await reportProgress(
    { sessionID: "s1", label: "x", sinks: ["ui", "forge", "tracker"] },
    { load: store.load, save: store.save, publish: () => {} },
  );
  assert.equal(r.ok, true); // unknown forge/tracker sinks must not fail the report
  const rec = await readProgressRecord("s1", { load: store.load });
  assert.equal(rec.label, "x");
});

test("reportProgress rejects a missing sessionID", async () => {
  const r = await reportProgress({ label: "no session" }, { load: () => ({}), save: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /sessionID/);
});

// ---------------------------------------------------------------------------
// Retention sweep
// ---------------------------------------------------------------------------

test("retention sweep drops records past the cutoff", async () => {
  const store = memStore();
  const now = 2_000_000;
  await reportProgress({ sessionID: "old", label: "old" }, { load: store.load, save: store.save, now: () => now - PROGRESS_RETENTION_MS - 1000 });
  await reportProgress({ sessionID: "fresh", label: "fresh" }, { load: store.load, save: store.save, now: () => now });
  await sweepProgress({ load: store.load, save: store.save, now: () => now });
  const all = await store.load();
  assert.equal(all.old, undefined);
  assert.equal(all.fresh.label, "fresh");
});

test("pruneRecords is pure and reports whether anything changed", () => {
  const now = 1_000_000;
  const recs = {
    old: { updatedAt: now - PROGRESS_RETENTION_MS - 1 },
    new: { updatedAt: now },
  };
  const { records, changed } = pruneRecords(recs, now);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(records), ["new"]);
  const unchanged = pruneRecords({ only: { updatedAt: now } }, now);
  assert.equal(unchanged.changed, false);
});

// ---------------------------------------------------------------------------
// Round-trip through an injected store
// ---------------------------------------------------------------------------

test("round-trip through an injected store: report, read, clear", async () => {
  const store = memStore();
  await reportProgress({ sessionID: "s9", label: "hello", step: 1, total: 2 }, { load: store.load, save: store.save, publish: () => {}, now: clock });
  const rec = await readProgressRecord("s9", { load: store.load });
  assert.equal(rec.sessionID, "s9");
  assert.equal(rec.label, "hello");

  const del = await clearProgress("s9", { load: store.load, save: store.save });
  assert.deepEqual(del, { ok: true, deleted: true });
  assert.equal(await readProgressRecord("s9", { load: store.load }), null);
  // Clearing an absent session is a no-op (deleted:false).
  const again = await clearProgress("s9", { load: store.load, save: store.save });
  assert.deepEqual(again, { ok: true, deleted: false });
});
