// Tests for optimizer/activityLog.mjs — the activity log that is the
// optimizer's trust surface (Optimizer P2.5, BET-1347). Pure/injected
// throughout: `load`/`save` are in-memory and `now` is a controlled clock. Run
// via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivityLog, MAX_ENTRIES, RETAIN_DAYS } from "./activityLog.mjs";

const DAY_MS = 86_400_000;

function makeLog({ initial = [], now } = {}) {
  let state = initial;
  const saves = [];
  const log = createActivityLog({
    load: async () => state,
    save: async (s) => {
      state = s;
      saves.push(JSON.parse(JSON.stringify(s)));
    },
    now: () => now(),
  });
  return { log, saves, get: () => state };
}

function fixed(ms) {
  return () => ms;
}

const T0 = 1_700_000_000_000;

test("append: validates kind/verdict, drops unknown fields, stores counts-only evidence", async () => {
  const { log, get } = makeLog({ now: fixed(T0) });
  const res = await log.append({
    kind: "tune",
    subject: "trim threshold 16 -> 12 tool uses",
    from: 16,
    to: 12,
    verdict: "kept",
    evidence: { turns: 62, hit: 74.1, churn: 0.4, bogus: { nested: true }, flag: true, note: "held" },
    trailing: "dropped",
    text: "this must never be stored",
  });
  assert.equal(res.ok, true);
  const e = res.entry;
  assert.ok(e.id && typeof e.id === "string");
  assert.equal(e.ts, T0);
  assert.equal(e.kind, "tune");
  assert.equal(e.from, 16);
  assert.equal(e.to, 12);
  assert.equal(e.verdict, "kept");
  // Evidence is flat counts/measurements only — nested objects, booleans and
  // unknown entry fields are dropped.
  assert.deepEqual(e.evidence, { turns: 62, hit: 74.1, churn: 0.4, note: "held" });
  assert.equal(e.trailing, undefined);
  assert.equal(e.text, undefined);
  assert.equal(get().length, 1);
});

test("append: unknown kind / verdict is rejected", async () => {
  const { log } = makeLog({ now: fixed(T0) });
  const badKind = await log.append({ kind: "nope", verdict: "kept" });
  assert.equal(badKind.ok, false);
  const badVerdict = await log.append({ kind: "tune", verdict: "nope" });
  assert.equal(badVerdict.ok, false);
});

test("append: entries are newest-first", async () => {
  const { log } = makeLog({ now: fixed(T0) });
  await log.append({ kind: "tune", verdict: "kept", ts: T0 - 200 });
  await log.append({ kind: "guardrail", verdict: "rolled-back", ts: T0 - 100 });
  await log.append({ kind: "compaction", verdict: "applied", ts: T0 });
  const recent = await log.recent(10);
  assert.deepEqual(recent.map((e) => e.ts), [T0, T0 - 100, T0 - 200]);
});

test("markReverted stamps revertedAt on the named entry", async () => {
  const { log, get } = makeLog({ now: fixed(T0) });
  const a = await log.append({ kind: "tune", verdict: "kept", ts: T0 - 200 });
  const b = await log.append({ kind: "eco", verdict: "kept", ts: T0 - 100 });
  const res = await log.markReverted(a.entry.id, 5000);
  assert.equal(res.ok, true);
  const e = get().find((x) => x.id === a.entry.id);
  assert.equal(e.revertedAt, 5000);
  const untouched = get().find((x) => x.id === b.entry.id);
  assert.equal(untouched.revertedAt, undefined);
});

test("markReverted: unknown id is a no-op error, does not corrupt the log", async () => {
  const { log, get } = makeLog({ now: fixed(T0) });
  await log.append({ kind: "tune", verdict: "kept", ts: T0 });
  const res = await log.markReverted("does-not-exist", 5000);
  assert.equal(res.ok, false);
  assert.equal(get().length, 1);
});

test("retention: caps at MAX_ENTRIES, newest kept", async () => {
  const nowMs = T0;
  const { log, get } = makeLog({ now: fixed(nowMs), initial: [] });
  // Append chronologically (newest last) so storage is newest-first and the
  // cap keeps the newest MAX_ENTRIES.
  for (let i = 0; i < MAX_ENTRIES + 50; i++) {
    await log.append({ kind: "tune", verdict: "kept", ts: nowMs - 50_000 + i });
  }
  assert.equal(get().length, MAX_ENTRIES);
  assert.equal(get()[0].ts, nowMs - 50_000 + MAX_ENTRIES + 49); // newest kept
  assert.equal(get()[get().length - 1].ts, nowMs - 50_000 + 50); // oldest kept boundary (i=50..249)
  assert.ok(get().every((e) => e.ts >= nowMs - 50_000 + 50)); // the 50 oldest were dropped
});

test("retention: drops entries older than RETAIN_DAYS", async () => {
  const nowMs = T0;
  const old = nowMs - (RETAIN_DAYS + 5) * DAY_MS;
  const { log, get } = makeLog({ now: fixed(nowMs), initial: [] });
  await log.append({ kind: "tune", verdict: "kept", ts: nowMs - DAY_MS }); // recent
  await log.append({ kind: "tune", verdict: "kept", ts: nowMs - 2000 }); // recent
  await log.append({ kind: "tune", verdict: "applied", ts: old }); // too old
  assert.equal(get().length, 2);
  assert.ok(get().every((e) => e.ts >= nowMs - RETAIN_DAYS * DAY_MS));
});

test("recent(n) caps at n, snapshot returns a copy", async () => {
  const { log } = makeLog({ now: fixed(T0) });
  for (let i = 0; i < 5; i++) await log.append({ kind: "tune", verdict: "kept", ts: T0 - i });
  const recent = await log.recent(2);
  assert.equal(recent.length, 2);
  const snap = await log.snapshot();
  assert.equal(snap.length, 5);
  snap[0].id = "mutated";
  const snap2 = await log.snapshot();
  assert.notEqual(snap2[0].id, "mutated");
});

test("concurrent appends do not lose an entry (mutex serializes)", async () => {
  const { log, get } = makeLog({ now: fixed(T0) });
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => log.append({ kind: "tune", verdict: "kept", ts: T0 - i })),
  );
  assert.equal(get().length, 50);
  const ids = new Set(get().map((e) => e.id));
  assert.equal(ids.size, 50);
});
