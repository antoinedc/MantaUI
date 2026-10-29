import { test } from "node:test";
import assert from "node:assert/strict";
import { contextModelFor, buildContextPayload, createContextModelResolver } from "./sessionContext.mjs";

const sel = { providerID: "anthropic", modelID: "opus" };
const def = { providerID: "openai", modelID: "gpt" };
const last = { providerID: "x", modelID: "y" };

test("resolution order: selected → default → last-used → null", () => {
  const prefs = { sessions: { s1: sel } };
  assert.deepEqual(contextModelFor({ sessionId: "s1", prefs, config: { defaultModel: def }, lastUsed: last }), { ...sel, basis: "selected" });
  assert.deepEqual(contextModelFor({ sessionId: "s2", prefs, config: { defaultModel: def }, lastUsed: last }), { ...def, basis: "default" });
  assert.deepEqual(contextModelFor({ sessionId: "s2", prefs, config: {}, lastUsed: last }), { ...last, basis: "last-used" });
  assert.equal(contextModelFor({ sessionId: "s2", prefs, config: {}, lastUsed: null }), null);
  assert.equal(contextModelFor({ sessionId: "s2", prefs: { sessions: { s2: { providerID: "", modelID: "z" } } }, config: {}, lastUsed: null }), null);
});

test("buildContextPayload adds limit/model/basis to the breakdown", () => {
  const p = buildContextPayload({ input: 100, cache: { read: 0, write: 0 } }, { ...sel, basis: "selected" }, 1000);
  assert.equal(p.limit, 1000);
  assert.equal(p.basis, "selected");
  assert.equal(p.totalInput, 100);
  const none = buildContextPayload({ input: 100 }, null, null);
  assert.deepEqual([none.limit, none.model, none.basis, none.hasLimit], [null, null, null, false]);
});

test("the resolver caches prefs until invalidated and tracks the default", () => {
  let reads = 0;
  let prefs = { sessions: {} };
  const r = createContextModelResolver({ loadPrefs: () => (reads++, prefs) });
  assert.equal(r.resolve({ sessionId: "s", lastUsed: null }), null);
  prefs = { sessions: { s: sel } };
  assert.equal(r.resolve({ sessionId: "s", lastUsed: null }), null); // cached
  assert.equal(reads, 1);
  r.invalidatePrefs();
  assert.equal(r.resolve({ sessionId: "s", lastUsed: null }).basis, "selected");
  assert.equal(r.setDefaultModel(def), true);
  assert.equal(r.setDefaultModel(def), false);
});
