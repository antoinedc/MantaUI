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
} from "./ctoStores.mjs";

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
