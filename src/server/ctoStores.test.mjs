// ctoStores.test.mjs — BET-1375 stores + schema-version harness.
//
// Pure logic (migration harness, retention sweep math) + a wiring canary that
// asserts every store resolves under the MANTA_STATE_HOME sandbox. No live
// tmux/opencode/network; the only I/O is real fs against grand the sandboxed
// cto root (every path goes through ctoPath() → statePath()).

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { sep } from "node:path";
import {
  CURRENT_VERSION,
  migrateStore,
  RETENTION_MS,
  ARCHIVE_CAP,
  DIGESTS_KEEP,
  isExpired,
  expireRows,
  capArchive,
  ctoPath,
  verdictsStore,
  ledgerStore,
  factsArchiveStore,
  digestsStore,
  rollupsStore,
  probesStore,
  sweepAllStores,
  INBOX_KINDS,
  INBOX_TTL_MS,
  inboxExpiresAt,
  purgeExpiredInbox,
  engineStateStore,
  patchEngineState,
  patchStore,
  createLedgerStore,
  startCtoStoreSweeper,
} from "./ctoStores.mjs";
import { createStandingQueryEngine, WATCHER_MIGRATION_KEY } from "./ctoWatchers.mjs";

const NOW_MS = 1_000_000_000_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Schema versioning (§13.2)
// ---------------------------------------------------------------------------

test("migrateStore: a v1 payload loads clean and unchanged", () => {
  const payload = { v: 1, entries: [{ ts: 1 }] };
  const out = migrateStore("cards", payload);
  assert.deepEqual(out, payload);
});

test("migrateStore: a payload with no v is treated as v1", () => {
  const noV = { entries: [{ ts: 1 }] };
  const out = migrateStore("journal", noV);
  assert.deepEqual(out, noV);
});

test("migrateStore: v is the current version on defaults", () => {
  assert.equal(CURRENT_VERSION, 1);
});

test("migrateStore: a future v throws naming the store (never truncates)", () => {
  assert.throws(() => migrateStore("inbox", { v: 2, entries: [] }), /"inbox".*2/);
  assert.throws(() => migrateStore("verdicts", { v: 99 }), /"verdicts"/);
});

test("migrateStore: an invalid v throws naming the store", () => {
  assert.throws(() => migrateStore("budget", { v: 0 }), /"budget"/);
  assert.throws(() => migrateStore("budget", { v: -1 }), /"budget"/);
  assert.throws(() => migrateStore("budget", { v: 1.5 }), /"budget"/);
});

// ---------------------------------------------------------------------------
// Retention sweep math (§13.1) — boundary-exact
// ---------------------------------------------------------------------------

test("isExpired is boundary-exact at the retention cutoff", () => {
  const retentionMs = 180 * DAY;
  const cutoff = NOW_MS - retentionMs;
  // Exactly at the cutoff is kept (not expired).
  assert.equal(isExpired(cutoff, { nowMs: NOW_MS, retentionMs }), false);
  // Just before the cutoff is expired.
  assert.equal(isExpired(cutoff - 1, { nowMs: NOW_MS, retentionMs }), true);
  // Well inside the window is kept.
  assert.equal(isExpired(NOW_MS, { nowMs: NOW_MS, retentionMs }), false);
  assert.equal(isExpired(NOW_MS - retentionMs + 1, { nowMs: NOW_MS, retentionMs }), false);
});

test("expireRows splits keep vs dropped on the time field", () => {
  const retentionMs = 180 * DAY;
  const cutoff = NOW_MS - retentionMs;
  const rows = [
    { id: "old", ts: cutoff - 1 }, // expired
    { id: "at-cutoff", ts: cutoff }, // kept (boundary)
    { id: "fresh", ts: NOW_MS }, // kept
    { id: "no-ts", note: "x" }, // kept (unknown time -> never expire)
  ];
  const { keep, dropped } = expireRows(rows, { nowMs: NOW_MS, retentionMs });
  assert.deepEqual(
    dropped.map((r) => r.id),
    ["old"],
  );
  assert.deepEqual(
    keep.map((r) => r.id),
    ["at-cutoff", "fresh", "no-ts"],
  );
});

test("expireRows honor a custom time field", () => {
  const retentionMs = 30 * DAY;
  const cutoff = NOW_MS - retentionMs;
  const rows = [
    { id: "old", created: cutoff - 1 },
    { id: "fresh", created: NOW_MS },
  ];
  const { keep } = expireRows(rows, { nowMs: NOW_MS, retentionMs, timeField: "created" });
  assert.deepEqual(
    keep.map((r) => r.id),
    ["fresh"],
  );
});

test("retention constants match the spec table", () => {
  assert.equal(RETENTION_MS.ledger, 180 * DAY);
  assert.equal(RETENTION_MS.verdicts, 180 * DAY);
  assert.equal(RETENTION_MS["rollups/hour"], 14 * DAY);
  assert.equal(RETENTION_MS["rollups/day"], 120 * DAY);
  assert.equal(RETENTION_MS["rollups/week"], 2 * 365 * DAY);
  assert.equal(RETENTION_MS.segments, 30 * DAY);
});

test("rollups/week retention is two years", () => {
  const retentionMs = RETENTION_MS["rollups/week"];
  assert.equal(retentionMs, 2 * 365 * DAY);
  const cutoff = NOW_MS - retentionMs;
  assert.equal(isExpired(cutoff, { nowMs: NOW_MS, retentionMs }), false);
  assert.equal(isExpired(cutoff - 1, { nowMs: NOW_MS, retentionMs }), true);
});

test("archive cap: oldest dropped, cap retained, order preserved within the kept set", () => {
  const cap = 3;
  const entries = [
    { id: "a", ts: 100 },
    { id: "b", ts: 200 },
    { id: "c", ts: 300 },
    { id: "d", ts: 400 },
    { id: "e", ts: 500 },
  ];
  const kept = capArchive(entries, { cap });
  assert.deepEqual(
    kept.map((e) => e.id),
    ["c", "d", "e"],
  ); // oldest two dropped, target order preserved
});

test("archive cap: no-op when at or under the cap", () => {
  const entries = [
    { id: "a", ts: 1 },
    { id: "b", ts: 2 },
  ];
  assert.deepEqual(capArchive(entries, { cap: 2 }), entries);
});

test("archive cap defaults to 10x the 50-fact active cap (500)", () => {
  assert.equal(ARCHIVE_CAP, 10 * 50);
  const many = Array.from({ length: 520 }, (_, i) => ({ id: i, ts: i }));
  const kept = capArchive(many);
  assert.equal(kept.length, 500);
  // The 20 oldest (ts 0..19) were dropped.
  assert.equal(kept[0].ts, 20);
  assert.equal(kept[kept.length - 1].ts, 519);
});

test("digests keep count is 30", () => {
  assert.equal(DIGESTS_KEEP, 30);
});

// ---------------------------------------------------------------------------
// Sandbox canary — every store root must honor MANTA_STATE_HOME
// ---------------------------------------------------------------------------

test("the cto store root resolves inside the sandbox, not the live box", () => {
  const sandbox = process.env.MANTA_STATE_HOME;
  assert.ok(sandbox && sandbox.trim() !== "", "MANTA_STATE_HOME unset — run via `npm test`");
  assert.ok(
    ctoPath("inbox.json").startsWith(sandbox + sep),
    `inbox store resolved to ${ctoPath("inbox.json")}, outside the sandbox ${sandbox}`,
  );
  assert.ok(!ctoPath("inbox.json").startsWith(homedir() + sep + ".manta"));
  assert.ok(ctoPath("facts", "proj.json").startsWith(sandbox + sep));
  assert.ok(verdictsStore.path.startsWith(sandbox + sep));
  assert.ok(ledgerStore.path.startsWith(sandbox + sep));
});

// ---------------------------------------------------------------------------
// Wiring — accessors read/write through the sandbox, versioned
// ---------------------------------------------------------------------------

test("verdicts store round-trips a versioned payload through the sandbox", async () => {
  await verdictsStore.save({ entries: [{ ts: 1, verdict: "accept" }] });
  const loaded = await verdictsStore.load();
  assert.equal(loaded.v, CURRENT_VERSION);
  assert.equal(loaded.entries[0].verdict, "accept");
});

test("dir stores reject path-traversal ids", () => {
  assert.throws(() => factsArchiveStore.pathFor("../evil"), /facts-archive/);
  assert.throws(() => digestsStore.pathFor("a/b"), /digests/);
  assert.throws(() => rollupsStore.pathFor("week", "a/../b"), /rollups/);
  assert.throws(() => rollupsStore.dirFor("year"), /rollups level/);
  assert.throws(() => probesStore.pathFor("../../x"), /probes/);
});

test("probes store round-trips YAML through the sandbox", async () => {
  await probesStore.save("http-check", { name: "Http", timeout: "10s", steps: [] });
  const loaded = await probesStore.load("http-check");
  assert.equal(loaded.name, "Http");
  assert.equal(loaded.timeout, "10s");
  assert.deepEqual(loaded.steps, []);
});

// ---------------------------------------------------------------------------
// Sweep wiring (sandboxed fs)
// ---------------------------------------------------------------------------

test("sweepAllStores trims the ledger and caps the archive (integration)", async () => {
  const nowMs = NOW_MS;
  const cutoff = nowMs - RETENTION_MS.ledger;

  // Seed a ledger with an expired row and a fresh row.
  await ledgerStore.append({ kind: "old", ts: cutoff - 1 });
  await ledgerStore.append({ kind: "fresh", ts: nowMs });

  // Seed an archive over the cap.
  const many = Array.from({ length: ARCHIVE_CAP + 10 }, (_, i) => ({ id: i, ts: i }));
  await factsArchiveStore.save("proj", { entries: many });

  // Seed an expired rollup file and an in-window one.
  const staleRollup = rollupsStore.pathFor("hour", "stale");
  await rollupsStore.save("hour", "stale", { ts: nowMs - RETENTION_MS["rollups/hour"] - 1 });
  const freshRollup = rollupsStore.pathFor("hour", "fresh");
  await rollupsStore.save("hour", "fresh", { ts: nowMs });

  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(staleRollup), "stale rollup should exist before the sweep");

  await sweepAllStores({ nowMs });

  // Ledger: expired row gone.
  const rows = await ledgerStore.read();
  assert.deepEqual(rows.map((r) => r.kind), ["fresh"]);

  // Archive: capped at ARCHIVE_CAP.
  const archived = await factsArchiveStore.load("proj");
  assert.equal(archived.entries.length, ARCHIVE_CAP);

  // Rollup: expired file removed, fresh kept.
  assert.equal(existsSync(staleRollup), false);
  assert.equal(existsSync(freshRollup), true);

  const { rm } = await import("node:fs/promises");
  await rm(freshRollup);
});

test("inboxExpiresAt: fyi is 48h, every other kind (and unknown) is 7 days", () => {
  // TTL map is closed over every declared kind.
  for (const k of INBOX_KINDS) assert.ok(INBOX_TTL_MS[k] !== undefined, `TTL set for ${k}`);
  assert.equal(inboxExpiresAt("fyi", 1000) - 1000, 2 * DAY);
  assert.equal(inboxExpiresAt("blocker", 1000) - 1000, 7 * DAY);
  assert.equal(inboxExpiresAt("finding", 1000) - 1000, 7 * DAY);
  assert.equal(inboxExpiresAt("handoff", 1000) - 1000, 7 * DAY);
  assert.equal(inboxExpiresAt("anomaly", 1000) - 1000, 7 * DAY);
  assert.equal(inboxExpiresAt("weird", 1000) - 1000, 7 * DAY); // unknown → 7d general case
});

test("purgeExpiredInbox drops only expired entries, silently (no trace)", () => {
  const nowMs = 1000;
  const entries = [
    { id: "a", expires: 500 }, // expired
    { id: "b", expires: 1000 }, // boundary (<= now) → expired
    { id: "c", expires: 1500 }, // keep
    { id: "d" }, // no expires → keep
  ];
  const { keep, dropped } = purgeExpiredInbox(entries, { nowMs });
  assert.deepEqual(keep.map((e) => e.id), ["c", "d"]);
  assert.deepEqual(dropped.map((e) => e.id), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// BET-1425 engine-state write hygiene — per-key read-modify-write.
//
// The durability invariant (BET-1403 review, carried into BET-1425): a key's
// value must survive any concurrent writer that does not own that key. The
// pre-1425 writer shape — load once, then `save({ ...snapshot, myKey })` —
// spread the whole load-time snapshot back over the file, resurrecting or
// clobbering every other writer's keys. `patchEngineState` is the sanctioned
// per-key RMW: under a process-wide mutex it loads FRESH, merges only the
// patch keys, and atomically saves.
//
// Interleaving regressions reuse the mirrored-order pattern from
// ctoTrust.test.mjs ("stale full-engine-state save cannot revert trust
// keys"), applied to engine-state keys — including the real shared-sub-key
// collision on `watchers` (the engine's `lastAutoDay` day marker vs the
// standing-query engine's migration marker).
// ---------------------------------------------------------------------------

// Deep-copy at the boundary like the real jsonStore (a parsed clone per
// load/save) — aliasing the live object would fake both stale snapshots and
// clobbers. Same shape as the memoryStore fixture in ctoTrust.test.mjs.
function memoryStore(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial ?? {}));
  return {
    load: async () => JSON.parse(JSON.stringify(data)),
    save: async (p) => {
      data = JSON.parse(JSON.stringify(p));
    },
  };
}

async function seedEngineState(payload) {
  await engineStateStore.save({ v: 1, ...payload });
}

test("patchEngineState: a static patch merges only its keys — a concurrent writer's key survives (both orders)", async () => {
  // Order 1: A (owns X) lands first, then B — whose patch was computed from a
  // STALE snapshot still carrying old X — saves Y. The old spread shape would
  // resurrect old X; the per-key patch cannot.
  await seedEngineState({ X: "old" });
  const stale = await engineStateStore.load(); // B's stale snapshot: X=old
  await patchEngineState({ X: "new" }); // A commits X=new
  await patchEngineState({ Y: 42 }, { engineState: engineStateStore }); // B saves (stale-derived) Y
  const after1 = await engineStateStore.load();
  assert.equal(after1.X, "new", "X survived B's stale-snapshot save");
  assert.equal(after1.Y, 42, "Y landed");

  // Order 2 (mirrored): B's Y lands first, then A's X.
  await seedEngineState({ X: "old" });
  await patchEngineState({ Y: 42 });
  await patchEngineState({ X: "new" });
  const after2 = await engineStateStore.load();
  assert.equal(after2.X, "new");
  assert.equal(after2.Y, 42);
  assert.ok(stale, "the stale snapshot was taken (test hygiene)");
});

test("patchEngineState: parallel patches compose — every key lands (the mutex, not the rename, is the guard)", async () => {
  await seedEngineState({});
  // Without the RMW mutex all three would load the same fresh state and the
  // last atomic rename would win with a single key — two writers' keys lost.
  await Promise.all([
    patchEngineState({ a: 1 }),
    patchEngineState({ b: 2 }),
    patchEngineState({ c: 3 }),
  ]);
  const after = await engineStateStore.load();
  assert.equal(after.a, 1);
  assert.equal(after.b, 2);
  assert.equal(after.c, 3);
});

test("patchEngineState: a (fresh) => patch mutation derives from the state as of ITS save, so read-modify-writes compose", async () => {
  await seedEngineState({ count: 1 });
  // Two concurrent incrementers: each must read the other's committed value.
  await Promise.all([
    patchEngineState((fresh) => ({ count: (fresh.count ?? 0) + 1 })),
    patchEngineState((fresh) => ({ count: (fresh.count ?? 0) + 1 })),
  ]);
  const after = await engineStateStore.load();
  assert.equal(after.count, 3, "both increments landed on each other's committed state");
});

test("patchEngineState: setting a key to undefined deletes it; other keys survive", async () => {
  await seedEngineState({ keep: "yes", drop: "gone" });
  await patchEngineState({ drop: undefined });
  const after = await engineStateStore.load();
  assert.equal(after.keep, "yes");
  assert.equal("drop" in after, false);
});

test("patchEngineState: rejects a non-object, non-function mutation and a function resolving to one", async () => {
  await seedEngineState({});
  await assert.rejects(() => patchEngineState(null), /plain object/);
  await assert.rejects(() => patchEngineState([1, 2]), /plain object/);
  await assert.rejects(() => patchEngineState(() => [1, 2]), /plain object/);
  await assert.rejects(() => patchEngineState(() => null), /plain object/);
});

// Shared-sub-key regression: `watchers` is written by TWO engines (the
// engine's per-day auto-create marker and the standing-query engine's one-time
// migration marker). Pre-1425 each wrote the whole `watchers` object from its
// own stale snapshot, so whichever landed second resurrected/clobbered the
// other's sub-key. Both now merge their sub-key onto the FRESH object.

function makeWatchersHarness() {
  return createStandingQueryEngine({
    store: memoryStore({ watchers: [] }),
    ledger: { append: async () => {} },
    engineState: engineStateStore,
    now: () => 1_000_000,
  });
}

async function writeDayMarker() {
  // The engine's watcherTick write shape: `watchers.lastAutoDay` merged onto
  // the FRESH `watchers` object.
  await patchEngineState(
    (fresh) => ({ watchers: { ...(fresh?.watchers || {}), lastAutoDay: "2026-08-29" } }),
    { engineState: engineStateStore },
  );
}

test("durability: the watchers day marker and the migration marker coexist regardless of landing order", async () => {
  // Order 1: migration first, then the day marker.
  await seedEngineState({});
  const migA = await makeWatchersHarness().migrateLegacy([{ patternSignature: "sig-1" }]);
  assert.equal(migA.migrated, true);
  await writeDayMarker();
  const afterA = await engineStateStore.load();
  assert.equal(afterA.watchers.migrated, true, "migration marker survived the day marker");
  assert.equal(afterA.watchers.lastAutoDay, "2026-08-29", "day marker landed");

  // Order 2 (mirrored): day marker first, then migration — the pre-1425
  // migration save spread a stale `meta` snapshot and reverted lastAutoDay.
  await seedEngineState({});
  await writeDayMarker();
  const migB = await makeWatchersHarness().migrateLegacy([]);
  assert.equal(migB.migrated, true);
  const afterB = await engineStateStore.load();
  assert.equal(afterB.watchers.lastAutoDay, "2026-08-29", "day marker survived the migration save");
  assert.equal(afterB.watchers.migrated, true);
  assert.equal(WATCHER_MIGRATION_KEY, "watchers");
});

test("durability: an engine-state writer that does not own tonightQueue cannot revert it (the BET-1403 resurrect shape, engine-state keys)", async () => {
  // The original report: a tonight-queue removal resurrected by a late writer
  // spreading a pre-edit snapshot. With per-key writers the queue removal and
  // unrelated writers' patches compose in both orders.
  const queue = [{ id: "tq:1", name: "n" }];
  await seedEngineState({ tonightQueue: queue });
  await patchEngineState({ pendingBlockers: [{ id: "b1" }] }); // unrelated writer
  await patchEngineState({ tonightQueue: [] }); // the removal, from a stale read of the queue
  await patchEngineState({ segmentGMinutes: 7 }); // another unrelated writer, late
  const after = await engineStateStore.load();
  assert.deepEqual(after.tonightQueue, [], "the removal landed");
  assert.deepEqual(after.pendingBlockers, [{ id: "b1" }], "the blocker survived both saves");
  assert.equal(after.segmentGMinutes, 7, "the late writer's key landed");
});

// ---------------------------------------------------------------------------
// BET-1464 defect 3 — patchStore: the store-agnostic generalization of
// patchEngineState. ONE mutex PER STORE PATH, shared by every writer of the
// file; async mutators hold it across their whole body (the serialization the
// per-engine write chains used to give); an empty patch is a pure no-op (no
// save). All tests below use INJECTED stores — no shared singleton state.
// ---------------------------------------------------------------------------

test("patchStore: parallel patches compose — every key lands on the injected store", async () => {
  const store = memoryStore({});
  await Promise.all([
    patchStore(store, { a: 1 }),
    patchStore(store, (fresh) => ({ b: (fresh.b ?? 0) + 1 })),
    patchStore(store, (fresh) => ({ b: (fresh.b ?? 0) + 1 })),
  ]);
  const after = await store.load();
  assert.equal(after.a, 1);
  assert.equal(after.b, 2, "both increments landed on each other's committed state");
});

test("patchStore: a patch preserves keys it does not own — a stale-derived patch cannot erase a concurrent writer's key (scalars AND whole-array replacements)", async () => {
  const store = memoryStore({ X: "old" });
  await patchStore(store, { X: "new" }); // A commits X=new
  // B's patch was derived from a stale snapshot still carrying old X — the
  // old whole-payload save shape would resurrect old X (or drop X entirely
  // when the writer's shape no longer carries it). The per-key merge cannot.
  await patchStore(store, { Y: 42 });
  const after = await store.load();
  assert.equal(after.X, "new", "X survived B's save");
  assert.equal(after.Y, 42, "Y landed");

  // The card/watcher/trust-pending shape: a patch that REPLACES a whole
  // array. A commits a one-element array; B's stale-derived patch replaces a
  // different key; then C's mutator (derived FRESH under the mutex) appends
  // to the array it actually owns. A's rows survive all of it.
  await patchStore(store, { cards: [{ id: "c1" }] });
  await patchStore(store, { unrelated: true }); // a stale-derived whole-save would have reverted `cards`
  const afterArray = await patchStore(store, (fresh) => ({
    cards: [...(fresh.cards ?? []), { id: "c2" }],
  }));
  assert.deepEqual(
    afterArray.cards.map((c) => c.id),
    ["c1", "c2"],
    "the array replacement composed with the unrelated writer's key",
  );
});

test("patchStore: an async mutator holds the store mutex across its whole body", async () => {
  const store = memoryStore({ n: 0 });
  let releaseA;
  const gateA = new Promise((r) => {
    releaseA = r;
  });
  let bRan = false;
  const a = patchStore(store, async () => {
    await gateA; // A holds the mutex while suspended mid-body
    return { n: 1 };
  });
  const b = patchStore(store, async () => {
    bRan = true;
    return { n: 2 };
  });
  // Flush microtasks AND give the timer wheel real turns: B must still not
  // have started while A's gate is held.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(bRan, false, "B's mutator must wait for A's whole body");
  releaseA();
  const afterB = await b;
  await a;
  assert.equal(afterB.n, 2, "B re-derived from A's committed state");
  assert.equal((await store.load()).n, 2);
});

test("patchStore: an empty patch is a pure no-op — no save fires", async () => {
  let saves = 0;
  const store = {
    load: async () => ({ v: 1, n: 7 }),
    save: async () => {
      saves += 1;
    },
  };
  const out = await patchStore(store, {});
  assert.equal(saves, 0, "a static empty patch saves nothing");
  assert.equal(out.n, 7, "the fresh state is returned unchanged");
  await patchStore(store, () => ({})); // the BET-1463 card-writer no-op shape
  assert.equal(saves, 0, "a mutator resolving to an empty patch saves nothing");
});

test("patchStore: rejects a store without load/save and a non-object patch", async () => {
  await assert.rejects(() => patchStore({}, { a: 1 }), /load and save/);
  await assert.rejects(() => patchStore(memoryStore({}), null), /plain object/);
  await assert.rejects(() => patchStore(memoryStore({}), () => [1, 2]), /plain object/);
});

// ---------------------------------------------------------------------------
// BET-1464 defect 2 — the activity ledger's atomic rewrite. ONE write lock
// shared by the appender and the retention sweep; the rewrite goes through
// writeJsonAtomic (temp + rename). The invariant under test: an append
// concurrent with a sweep is never lost, and a rewrite never truncates the
// surviving ledger.
// ---------------------------------------------------------------------------

test("the ledger rewrite is atomic: an append concurrent with a sweep is not lost", async () => {
  const { rm } = await import("node:fs/promises");
  const path = ctoPath("ledger-1464-atomicity.jsonl");
  const store = createLedgerStore({ path, now: () => NOW_MS });
  const retentionMs = RETENTION_MS.ledger;
  const cutoff = NOW_MS - retentionMs;
  try {
    for (let i = 0; i < 12; i += 1) {
      await rm(path, { force: true });
      await store.append({ kind: "old", ts: cutoff - 1 });
      // Both ops fired in the same tick: the append either lands before the
      // sweep's locked read (the fresh row is kept — fresh rows are never
      // expired) or after its rewrite (the file already carries the rewritten
      // content). It can never land "between" — that window IS the lock.
      const freshKind = `fresh-${i}`;
      const sweepP = store.sweepExpired({ nowMs: NOW_MS, retentionMs });
      const appendP = store.append({ kind: freshKind, ts: NOW_MS });
      await Promise.all([sweepP, appendP]);
      const rows = await store.read();
      assert.ok(
        rows.some((r) => r.kind === freshKind),
        `the concurrent append (iter ${i}) must survive the sweep`,
      );
      assert.ok(!rows.some((r) => r.kind === "old"), "the expired row is dropped");
    }
  } finally {
    await rm(path, { force: true });
  }
});

test("the ledger rewrite never truncates a mid-sweep append (the lock is held across the whole sweep section)", async () => {
  const { rm } = await import("node:fs/promises");
  const path = ctoPath("ledger-1464-midflight.jsonl");
  const store = createLedgerStore({ path, now: () => NOW_MS });
  const retentionMs = RETENTION_MS.ledger;
  const cutoff = NOW_MS - retentionMs;
  try {
    // Seed the expired row plus enough fresh rows that the sweep's
    // read-filter-rewrite spans real time.
    await store.append({ kind: "old", ts: cutoff - 1 });
    for (let i = 0; i < 800; i += 1) {
      await store.append({ kind: `bulk-${i}`, ts: NOW_MS });
    }
    const sweepP = store.sweepExpired({ nowMs: NOW_MS, retentionMs });
    // Land while the sweep is provably in its locked section.
    await new Promise((r) => setTimeout(r, 2));
    await store.append({ kind: "mid-sweep", ts: NOW_MS });
    await sweepP;
    const rows = await store.read();
    assert.ok(rows.some((r) => r.kind === "mid-sweep"), "the mid-sweep append must not be lost");
    assert.ok(!rows.some((r) => r.kind === "old"), "the expired row is dropped");
    assert.equal(rows.filter((r) => r.kind?.startsWith("bulk-")).length, 800, "the kept set is intact (no truncation)");
  } finally {
    await rm(path, { force: true });
  }
});

// ---------------------------------------------------------------------------
// BET-1464 defect 1 — the retention sweeper actually starts. The poller is
// real (immediate first tick + the given interval); the assertion is that its
// sweep removes an expired ledger row from the sandboxed store.
// ---------------------------------------------------------------------------

test("startCtoStoreSweeper starts a poller that sweeps the stores on its interval", async () => {
  const { rm } = await import("node:fs/promises");
  const cutoff = Date.now() - RETENTION_MS.ledger;
  await ledgerStore.append({ kind: "sweeper-canary", ts: cutoff - 1 });
  const sweeper = startCtoStoreSweeper({ intervalMs: 15 });
  try {
    const deadline = Date.now() + 5000;
    let gone = false;
    while (Date.now() < deadline) {
      const rows = await ledgerStore.read();
      if (!rows.some((r) => r.kind === "sweeper-canary")) {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(gone, true, "the sweeper's first tick removed the expired ledger row");
  } finally {
    sweeper.stop();
    await rm(ctoPath("ledger-1464-atomicity.jsonl"), { force: true });
  }
});
