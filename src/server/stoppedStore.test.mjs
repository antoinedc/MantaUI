// stoppedStore.test.mjs — durable stopped-conversation record lifecycle
// (BET-1047 §5). Pure logic + injected I/O; no real disk writes (an in-memory
// load/save pair stands in) unless a canary asserts the sandboxed path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { sep } from "node:path";
import { statePath } from "../shared/paths.mjs";
import {
  STORE_PATH,
  loadStoppedState,
  saveStoppedState,
  buildStoppedRecord,
  upsertStopped,
  armStopped,
  disarmStopped,
  markStoppedRan,
  stampStoppedLastLooked,
  listStopped,
} from "./stoppedStore.mjs";

// A tiny in-memory store so the lifecycle tests never touch the filesystem.
function memStore(initial = { lastLooked: null, records: [] }) {
  let state = { lastLooked: initial?.lastLooked ?? null, records: initial?.records ?? [] };
  return {
    load: () => state,
    save: async (s) => {
      state = s;
    },
    get: () => state,
  };
}

function pausedEvents() {
  const events = [];
  return { events, publish: (evt) => events.push(evt) };
}

const ENTRY = { conversation: "sess-1", workspace: "proj", provider: "claude", model: "claude-opus-4-7", window: "weekly", stoppedAt: 1000, cachedTokens: 5000 };

test("upsertStopped enrols a fresh stopped conversation", async () => {
  const store = memStore();
  const r = await upsertStopped(ENTRY, { load: store.load, save: store.save, publish: () => {} });
  assert.equal(r, undefined);
  const { records, lastLooked } = await listStopped({ load: store.load });
  assert.equal(records.length, 1);
  assert.equal(records[0].conversation, "sess-1");
  assert.equal(records[0].provider, "claude");
  assert.equal(records[0].window, "weekly");
  assert.equal(records[0].stoppedAt, 1000);
  assert.equal(records[0].cachedTokens, 5000);
  assert.equal(records[0].armed, false);
  assert.equal(records[0].attempts, 1);
  assert.equal(lastLooked, null);
});

test("a repeat refusal UPDATES the existing entry — never a duplicate", async () => {
  const store = memStore();
  await upsertStopped(ENTRY, { load: store.load, save: store.save, publish: () => {} });
  // Same conversation, same provider — a repeat refusal. Some fields evolve.
  await upsertStopped(
    { ...ENTRY, window: "session", stoppedAt: 2000, cachedTokens: 7000 },
    { load: store.load, save: store.save, publish: () => {} },
  );
  const { records } = await listStopped({ load: store.load });
  assert.equal(records.length, 1, "a repeat refusal must not duplicate the row");
  assert.equal(records[0].stoppedAt, 2000, "the entry is updated");
  assert.equal(records[0].window, "session", "the window is updated");
  assert.equal(records[0].cachedTokens, 7000);
  assert.equal(records[0].attempts, 2, "attempts increments so a permanent refusal stops looping");
});

test("a successful run (markStoppedRan) removes the row", async () => {
  const store = memStore();
  await upsertStopped(ENTRY, { load: store.load, save: store.save, publish: () => {} });
  await markStoppedRan({ conversation: "sess-1" }, { load: store.load, save: store.save, publish: () => {} });
  const { records } = await listStopped({ load: store.load });
  assert.equal(records.length, 0);
});

test("disarm (modal uncheck) REMOVES the row", async () => {
  const store = memStore();
  await upsertStopped(ENTRY, { load: store.load, save: store.save, publish: () => {} });
  await disarmStopped({ conversation: "sess-1" }, { load: store.load, save: store.save, publish: () => {} });
  const { records } = await listStopped({ load: store.load });
  assert.equal(records.length, 0);
});

test("arm marks the entry for resume and keeps it", async () => {
  const store = memStore();
  await upsertStopped(ENTRY, { load: store.load, save: store.save, publish: () => {} });
  await armStopped({ conversation: "sess-1" }, { load: store.load, save: store.save, publish: () => {} });
  const { records } = await listStopped({ load: store.load });
  assert.equal(records.length, 1);
  assert.equal(records[0].armed, true);
});

test("arm/disarm on a missing conversation are no-ops", async () => {
  const store = memStore();
  await armStopped({ conversation: "nope" }, { load: store.load, save: store.save, publish: () => {} });
  await disarmStopped({ conversation: "nope" }, { load: store.load, save: store.save, publish: () => {} });
  assert.equal(store.get().records.length, 0);
});

test("stampStoppedLastLooked records the list-level timestamp", async () => {
  const store = memStore();
  await stampStoppedLastLooked({ now: () => 9000 }, { load: store.load, save: store.save, publish: () => {} });
  const { lastLooked } = await listStopped({ load: store.load });
  assert.equal(lastLooked, 9000);
});

test("mutations publish usage-stopped.updated on the bus", async () => {
  const store = memStore();
  const { events, publish } = pausedEvents();
  await upsertStopped(ENTRY, { load: store.load, save: store.save, publish });
  await armStopped({ conversation: "sess-1" }, { load: store.load, save: store.save, publish });
  await markStoppedRan({ conversation: "sess-1" }, { load: store.load, save: store.save, publish });
  assert.equal(events.every((e) => e.kind === "usage-stopped.updated"), true);
  assert.equal(events.length, 3);
});

test("buildStoppedRecord normalises fields", () => {
  const r = buildStoppedRecord({ workspace: "w", conversation: "c", provider: "kimi", model: "m", window: "monthly", stoppedAt: 5, cachedTokens: 3 });
  assert.deepEqual(r, { workspace: "w", conversation: "c", provider: "kimi", model: "m", window: "monthly", stoppedAt: 5, cachedTokens: 3, armed: false, attempts: 1 });
});

// ---------------------------------------------------------------------------
// Canary: the store must resolve INSIDE the test sandbox, never the live box
// ---------------------------------------------------------------------------

test("the stopped-store path resolves inside the test sandbox", () => {
  const sandbox = process.env.MANTA_STATE_HOME;
  assert.ok(sandbox && sandbox.trim() !== "", "MANTA_STATE_HOME must be set (run via npm test)");
  assert.ok(
    STORE_PATH.startsWith(sandbox + sep),
    `stopped store resolved to ${STORE_PATH}, outside the sandbox ${sandbox}`,
  );
  assert.ok(!STORE_PATH.startsWith(homedir() + sep + ".manta"), "stopped store must not be in the live box");
  assert.ok(statePath("usage-stopped.json") === STORE_PATH);
});

test("loadStoppedState falls back to an empty record on missing/invalid data", () => {
  // A JSON-invalid file path falls back to an empty-but-valid state.
  const state = loadStoppedState("/tmp/definitely-not-a-real-store-here.json");
  assert.deepEqual(state, { lastLooked: null, records: [] });
});

test("save/load round-trips through the real store path helpers", async () => {
  // Use a throwaway sandbox path; exercises saveStoppedState/loadStoppedState.
  const path = statePath("canary-usage-stopped.json");
  await saveStoppedState({ lastLooked: 42, records: [{ conversation: "s", workspace: "", provider: "claude", window: null, stoppedAt: 1 }] }, path);
  const back = loadStoppedState(path);
  assert.equal(back.lastLooked, 42);
  assert.equal(back.records[0].conversation, "s");
});
