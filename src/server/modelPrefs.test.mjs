import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelPrefs,
  setModelPrefs,
  seedModelPrefs,
  getModelPrefs,
} from "./modelPrefs.mjs";

// In-memory store helpers: `load` returns the live object reference, `save`
// applies the mutated/await state. `publish` records published envelopes.
function memDeps(initial = { sessions: {}, recents: [] }, published = []) {
  const store = { ...initial, sessions: { ...(initial.sessions ?? {}) }, recents: [...(initial.recents ?? [])] };
  return {
    deps: {
      load: () => store,
      save: async (s) => Object.assign(store, s),
      publish: (e) => published.push(e),
      now: () => 1000,
    },
    store,
    published,
  };
}

function tmpPath() {
  return join(process.env.MANTA_STATE_HOME ?? tmpdir(), `model-prefs-${Math.random().toString(36).slice(2)}.json`);
}

// ----------------------------------------------------------------------------
// loadModelPrefs — defaults + drop-on-load
// ----------------------------------------------------------------------------

test("loadModelPrefs returns empty defaults for a missing file", () => {
  const state = loadModelPrefs(join(tmpdir(), "does-not-exist-model-prefs.json"));
  assert.deepEqual(state, { sessions: {}, recents: [] });
});

test("loadModelPrefs returns empty defaults for garbage", () => {
  const p = tmpPath();
  const state = loadModelPrefs(p); // not yet written — still missing
  assert.deepEqual(state, { sessions: {}, recents: [] });
});

test("loadModelPrefs drops invalid session records on load", async () => {
  const p = tmpPath();
  await writeFile(
    p,
    JSON.stringify({
      sessions: {
        good: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "high", updatedAt: 1 },
        badEmptyProvider: { providerID: "", modelID: "m", updatedAt: 2 },
        badNoModel: { providerID: "p", updatedAt: 3 },
        badNull: { providerID: "p", modelID: "m", variant: null, updatedAt: 4 },
      },
      recents: [
        { providerID: "anthropic", modelID: "m", fast: false },
        { providerID: "bad", modelID: "", fast: true },
      ],
    }),
  );
  const state = loadModelPrefs(p);
  assert.deepEqual(Object.keys(state.sessions), ["good"]);
  assert.deepEqual(state.sessions.good, { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "high", updatedAt: 1 });
  // invalid recent dropped, valid kept with its `fast` preserved
  assert.deepEqual(state.recents, [{ providerID: "anthropic", modelID: "m", fast: false }]);
  await rm(p, { force: true });
});

// ----------------------------------------------------------------------------
// setModelPrefs — upsert
// ----------------------------------------------------------------------------

test("setModelPrefs upserts a session selection with updatedAt now()", async () => {
  const { deps, store, published } = memDeps();
  await setModelPrefs(
    { sessionId: "ses_1", selection: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "high" } },
    deps,
  );
  assert.equal(store.sessions.ses_1.providerID, "anthropic");
  assert.equal(store.sessions.ses_1.modelID, "claude-opus-4-6");
  assert.equal(store.sessions.ses_1.variant, "high");
  assert.equal(store.sessions.ses_1.updatedAt, 1000);
  assert.equal("fast" in store.sessions.ses_1, false, "session record has no fast field");
  assert.deepEqual(published, [{ kind: "model-prefs.updated", payload: { sessionId: "ses_1" } }]);
});

test("setModelPrefs omits variant when absent (never null)", async () => {
  const { deps, store } = memDeps();
  await setModelPrefs({ sessionId: "s", selection: { providerID: "anthropic", modelID: "m" } }, deps);
  assert.equal("variant" in store.sessions.s, false);
});

test("setModelPrefs replaces an existing session (updatedAt refreshes)", async () => {
  const { deps, store, published } = memDeps();
  await setModelPrefs({ sessionId: "s", selection: { providerID: "anthropic", modelID: "a" } }, deps);
  await setModelPrefs({ sessionId: "s", selection: { providerID: "openai", modelID: "b", variant: "low" } }, deps);
  assert.equal(store.sessions.s.providerID, "openai");
  assert.equal(store.sessions.s.modelID, "b");
  assert.equal(store.sessions.s.variant, "low");
  assert.equal(published.length, 2);
});

// ----------------------------------------------------------------------------
// setModelPrefs — delete
// ----------------------------------------------------------------------------

test("setModelPrefs deletes a session on selection null", async () => {
  const { deps, store, published } = memDeps({ sessions: { s: { providerID: "p", modelID: "m", updatedAt: 1 } }, recents: [] });
  await setModelPrefs({ sessionId: "s", selection: null }, deps);
  assert.equal("s" in store.sessions, false);
  assert.deepEqual(published, [{ kind: "model-prefs.updated", payload: { sessionId: "s" } }]);
});

test("setModelPrefs deleting a missing session is a no-op (no publish)", async () => {
  const { deps, published } = memDeps();
  await setModelPrefs({ sessionId: "nope", selection: null }, deps);
  assert.deepEqual(published, []);
});

// ----------------------------------------------------------------------------
// setModelPrefs — recents replace + truncation
// ----------------------------------------------------------------------------

test("setModelPrefs replaces recents truncated to 5, payload omits sessionId", async () => {
  const { deps, store, published } = memDeps();
  const recents = Array.from({ length: 7 }, (_, i) => ({
    providerID: "anthropic",
    modelID: `model-${i}`,
    variant: i % 2 ? "high" : undefined,
    fast: i % 2 === 0,
  }));
  await setModelPrefs({ recents }, deps);
  assert.equal(store.recents.length, 5);
  assert.deepEqual(
    store.recents.map((r) => r.modelID),
    ["model-0", "model-1", "model-2", "model-3", "model-4"],
  );
  // only recents changed → payload has no sessionId
  assert.deepEqual(published, [{ kind: "model-prefs.updated", payload: {} }]);
});

test("setModelPrefs with session + recents publishes a sessionId payload", async () => {
  const { deps, published } = memDeps();
  await setModelPrefs(
    { sessionId: "s", selection: { providerID: "p", modelID: "m" }, recents: [{ providerID: "p", modelID: "m", fast: false }] },
    deps,
  );
  assert.deepEqual(published, [{ kind: "model-prefs.updated", payload: { sessionId: "s" } }]);
});

// ----------------------------------------------------------------------------
// setModelPrefs — 500-entry prune
// ----------------------------------------------------------------------------

test("setModelPrefs prunes sessions past the 500 cap, dropping lowest updatedAt", async () => {
  const store = { sessions: {}, recents: [] };
  let t = 0;
  const deps = {
    load: () => store,
    save: async (s) => Object.assign(store, s),
    publish: () => {},
    now: () => t++,
  };
  for (let i = 0; i < 505; i++) {
    await setModelPrefs({ sessionId: `ses_${i}`, selection: { providerID: "p", modelID: "m" } }, deps);
  }
  const keys = Object.keys(store.sessions);
  assert.equal(keys.length, 500, "capped at 500");
  // The 5 oldest (lowest updatedAt) — ses_0..ses_4 — were dropped.
  for (let i = 0; i < 5; i++) assert.equal(keys.includes(`ses_${i}`), false, `ses_${i} should be pruned`);
  assert.ok(keys.includes("ses_504"), "newest session survives");
});

// ----------------------------------------------------------------------------
// setModelPrefs — invalid records rejected silently, no-op call
// ----------------------------------------------------------------------------

test("setModelPrefs rejects an invalid selection silently (nothing written, no publish)", async () => {
  const { deps, store, published } = memDeps();
  await setModelPrefs({ sessionId: "s", selection: { providerID: "", modelID: "m" } }, deps);
  await setModelPrefs({ sessionId: "s2", selection: { providerID: "p", modelID: "" } }, deps);
  assert.equal(Object.keys(store.sessions).length, 0);
  assert.deepEqual(published, []);
});

test("setModelPrefs with neither session nor recents is a no-op (no save, no publish)", async () => {
  let saved = 0;
  const published = [];
  const store = { sessions: {}, recents: [] };
  await setModelPrefs(
    {},
    { load: () => store, save: async () => { saved++; }, publish: (e) => published.push(e), now: () => 1 },
  );
  assert.equal(saved, 0);
  assert.deepEqual(published, []);
});

// ----------------------------------------------------------------------------
// seedModelPrefs — non-destructive merge
// ----------------------------------------------------------------------------

test("seedModelPrefs fills missing sessions + empty recents, publishes once with empty payload", async () => {
  const { deps, store, published } = memDeps();
  await seedModelPrefs(
    {
      sessions: { ses_1: { providerID: "anthropic", modelID: "a" }, ses_2: { providerID: "openai", modelID: "b", variant: "low" } },
      recents: [{ providerID: "anthropic", modelID: "a", fast: false }],
    },
    deps,
  );
  assert.equal(store.sessions.ses_1.providerID, "anthropic");
  assert.equal(store.sessions.ses_2.variant, "low");
  assert.deepEqual(store.recents, [{ providerID: "anthropic", modelID: "a", fast: false }]);
  assert.deepEqual(published, [{ kind: "model-prefs.updated", payload: {} }]);
});

test("seedModelPrefs does NOT overwrite an existing session key or non-empty recents", async () => {
  const published = [];
  const store = {
    sessions: { ses_1: { providerID: "existing", modelID: "keep", updatedAt: 1 } },
    recents: [{ providerID: "existing", modelID: "keep", fast: true }],
  };
  const deps = {
    load: () => store,
    save: async (s) => Object.assign(store, s),
    publish: (e) => published.push(e),
    now: () => 999,
  };
  await seedModelPrefs(
    {
      sessions: {
        ses_1: { providerID: "new", modelID: "overwrite" },
        ses_2: { providerID: "new", modelID: "added" },
      },
      recents: [{ providerID: "new", modelID: "new-recent", fast: false }],
    },
    deps,
  );
  // existing session untouched, new session added
  assert.deepEqual(store.sessions.ses_1, { providerID: "existing", modelID: "keep", updatedAt: 1 });
  assert.equal(store.sessions.ses_2.modelID, "added");
  // non-empty recents NOT overwritten
  assert.deepEqual(store.recents, [{ providerID: "existing", modelID: "keep", fast: true }]);
  // ses_2 IS a genuinely new session (merged) → one publish, empty payload
  assert.deepEqual(published, [{ kind: "model-prefs.updated", payload: {} }]);
});

test("seedModelPrefs with nothing to merge publishes nothing", async () => {
  const { deps, published } = memDeps({ sessions: { s: { providerID: "p", modelID: "m", updatedAt: 1 } }, recents: [{ providerID: "p", modelID: "m", fast: false }] });
  await seedModelPrefs({ sessions: { s: { providerID: "x", modelID: "y" } }, recents: [{ providerID: "x", modelID: "z", fast: true }] }, deps);
  assert.deepEqual(published, []);
});

// ----------------------------------------------------------------------------
// getModelPrefs
// ----------------------------------------------------------------------------

test("getModelPrefs returns the loaded { sessions, recents }", async () => {
  const store = {
    sessions: { s: { providerID: "p", modelID: "m", updatedAt: 1 } },
    recents: [{ providerID: "p", modelID: "m", fast: false }],
  };
  const { sessions, recents } = await getModelPrefs({ load: () => store });
  assert.deepEqual(sessions, store.sessions);
  assert.deepEqual(recents, store.recents);
});
