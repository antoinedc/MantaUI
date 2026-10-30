import { test } from "node:test";
import assert from "node:assert/strict";
import { createSummaryModel, decideSummaryModel, readStoredSummaryModel } from "./summaryModel.mjs";

const model = (providerID, id, over = {}) => ({
  providerID,
  id,
  name: id,
  family: undefined,
  limit: { context: 200_000 },
  capabilities: { output: ["text"] },
  ...over,
});
const HAIKU = model("anthropic", "claude-haiku-4", { family: "haiku", cost: { input: 1, output: 5 } });
const SONNET = model("anthropic", "claude-sonnet-4", { family: "sonnet", cost: { input: 3, output: 15 } });
const CHEAP = model("openai", "gpt-4o-mini", { family: "gpt-4o-mini", cost: { input: 0.1, output: 0.4 } });

function world({ models = [HAIKU, SONNET], cfg = {}, subs = [], lastUsed = null } = {}) {
  const w = {
    models,
    cfg: { ...cfg },
    subs: new Set(subs),
    listCalls: 0,
    listFails: false,
    writes: [],
    lastUsed,
    now: 1_000,
    warnings: [],
  };
  w.api = createSummaryModel({
    listModels: async () => {
      w.listCalls++;
      if (w.listFails) throw new Error("model list unavailable");
      return w.models;
    },
    configGet: async () => ({ ...w.cfg }),
    configUpdate: async (patch) => {
      w.writes.push(patch);
      w.cfg = { ...w.cfg, ...patch };
      return w.cfg;
    },
    catalog: { matchModel: () => ({ kind: "none", candidates: [] }), allModels: () => [] },
    loadPriceCatalog: () => null,
    readOpencodeConfig: async () => ({}),
    subscriptionIds: async () => w.subs,
    lastUsedModel: async () => w.lastUsed,
    now: () => w.now,
    warn: (m) => w.warnings.push(m),
  });
  return w;
}

test("decideSummaryModel: the A.4 table", () => {
  const eligible = new Set(["a/m1"]);
  const pick = { providerID: "a", modelID: "m1" };
  assert.equal(decideSummaryModel({ stored: null, optOut: true, eligible, pick }).state, "opted-out");
  assert.equal(decideSummaryModel({ stored: null, optOut: true, eligible, pick }).write, undefined);
  const user = { providerID: "x", modelID: "gone", source: "user", pickedAt: 1 };
  const du = decideSummaryModel({ stored: user, optOut: false, eligible, pick });
  assert.equal(du.state, "unavailable");
  assert.equal(du.write, undefined, "a user choice is never changed");
  const auto = { providerID: "x", modelID: "gone", source: "auto", pickedAt: 1 };
  assert.deepEqual(decideSummaryModel({ stored: auto, optOut: false, eligible, pick }).write.value, { providerID: "a", modelID: "m1", source: "auto" });
  const none = decideSummaryModel({ stored: auto, optOut: false, eligible, pick: null, pickReason: "why" });
  assert.equal(none.state, "unset");
  assert.equal(none.reason, "why");
  assert.deepEqual(none.write, { value: null });
  assert.equal(decideSummaryModel({ stored: null, optOut: false, eligible, pick: null }).write, undefined, "already null → no write");
  assert.equal(readStoredSummaryModel({ summaryModel: { providerID: "a" } }), null, "malformed → null");
});

test("first run: a connected subscription model is picked, stamped auto, and reported ok", async () => {
  const w = world({ subs: ["anthropic"] });
  const s = await w.api.status();
  assert.equal(s.state, "ok");
  assert.equal(s.current.source, "auto");
  assert.equal(s.current.providerID, "anthropic");
  assert.equal(s.current.modelID, "claude-haiku-4", "lowest tier first");
  assert.equal(s.reason, undefined, "no reason when ok");
  assert.equal(w.writes.length, 1);
  assert.equal(w.cfg.summaryModel.pickedAt, 1_000);
  assert.equal(s.candidates.find((c) => c.recommended).modelID, "claude-haiku-4");
  assert.equal(s.candidates.find((c) => c.modelID === "claude-haiku-4").priceLabel, "subscription");
  const m = await w.api.activeModel();
  assert.deepEqual(m, { providerID: "anthropic", modelID: "claude-haiku-4", name: "claude-haiku-4", limit: { context: 200_000 } });
});

test("nothing connected is eligible → unset with a reason, nothing written, no active model", async () => {
  const w = world({ models: [] });
  const s = await w.api.status();
  assert.equal(s.state, "unset");
  assert.ok(s.reason);
  assert.equal(w.writes.length, 0);
  assert.equal(await w.api.activeModel(), null);
});

test("a user's choice is never changed: when it disconnects the status is `unavailable` and nothing is written", async () => {
  const w = world({ cfg: { summaryModel: { providerID: "openai", modelID: "gone", source: "user", pickedAt: 5 } } });
  const s = await w.api.status();
  assert.equal(s.state, "unavailable");
  assert.ok(s.reason);
  assert.deepEqual(s.current, { providerID: "openai", modelID: "gone", name: "gone", source: "user" });
  assert.equal(w.writes.length, 0);
  assert.equal(await w.api.activeModel(), null, "the cold path trusts only `ok`");
  assert.equal(s.candidates.some((c) => c.modelID === "gone"), false, "an unavailable current model is not listed");
});

test("an automatic choice is re-picked when it is gone, or no longer passes the hard gates", async () => {
  const w = world({ cfg: { summaryModel: { providerID: "anthropic", modelID: "claude-haiku-4", source: "auto", pickedAt: 1 } }, models: [{ ...HAIKU, status: "deprecated" }, SONNET] });
  const s = await w.api.status();
  assert.equal(s.state, "ok");
  assert.equal(s.current.modelID, "claude-sonnet-4");
  assert.equal(w.cfg.summaryModel.source, "auto");
  // …and a user choice that went deprecated is only reported
  const u = world({ cfg: { summaryModel: { providerID: "anthropic", modelID: "claude-haiku-4", source: "user", pickedAt: 1 } }, models: [{ ...HAIKU, status: "deprecated" }, SONNET] });
  assert.equal((await u.api.status()).state, "unavailable");
  assert.equal(u.writes.length, 0);
});

test("no churn: a kept automatic choice stays, and `betterAvailable` flags a cheaper capable model", async () => {
  const w = world({ models: [HAIKU, SONNET] });
  await w.api.status();
  assert.equal(w.cfg.summaryModel.modelID, "claude-haiku-4");
  w.models = [HAIKU, SONNET, CHEAP];
  await w.api.reconcile();
  const s = await w.api.status();
  assert.equal(s.current.modelID, "claude-haiku-4", "nothing silently moves");
  assert.equal(s.betterAvailable, true);
  assert.equal(w.writes.length, 1);
  assert.equal(s.candidates.find((c) => c.recommended).modelID, "gpt-4o-mini");
});

test("candidates are capped at 30 and keep the current model even when it ranks lower", async () => {
  const many = Array.from({ length: 45 }, (_, i) => model("anthropic", `claude-haiku-${i}`, { family: "haiku", cost: { input: 1 + i, output: 5 + i } }));
  const w = world({ models: many, cfg: { summaryModel: { providerID: "anthropic", modelID: "claude-haiku-44", source: "user", pickedAt: 1 } } });
  const s = await w.api.status();
  assert.equal(s.candidates.length, 30);
  assert.ok(s.candidates.some((c) => c.modelID === "claude-haiku-44"));
  assert.equal(s.state, "ok");
});

test("opt-out is respected: `none` writes null + the flag; the reconciler never picks again; choosing a model clears it", async () => {
  const w = world();
  await w.api.status();
  const s = await w.api.set({ none: true });
  assert.equal(s.state, "opted-out");
  assert.equal(s.current, null);
  assert.deepEqual(w.cfg.summaryModel, null);
  assert.equal(w.cfg.summaryModelOptOut, true);
  await w.api.reconcile();
  assert.equal((await w.api.status()).state, "opted-out");
  assert.equal(w.cfg.summaryModel, null);
  const t = await w.api.set({ providerID: "anthropic", modelID: "claude-sonnet-4" });
  assert.equal(t.state, "ok");
  assert.equal(w.cfg.summaryModelOptOut, false);
  assert.equal(w.cfg.summaryModel.source, "user");
});

test("a failed model list is `unknown`: nothing is changed, and the cold path gets no model", async () => {
  const w = world({ cfg: { summaryModel: { providerID: "anthropic", modelID: "claude-haiku-4", source: "auto", pickedAt: 1 } } });
  await w.api.reconcile();
  assert.equal((await w.api.status()).state, "ok");
  w.writes.length = 0;
  w.listFails = true;
  await w.api.reconcile();
  const s = await w.api.status();
  assert.equal(s.state, "unknown");
  assert.ok(s.reason);
  assert.equal(s.current.modelID, "claude-haiku-4");
  assert.equal(w.writes.length, 0, "an outage is not a disconnect");
  assert.equal(await w.api.activeModel(), null);
  assert.ok(s.candidates.length > 0, "the last good shortlist is still shown");
});

test("compare-and-set: a write that lands between the snapshot and the write is not clobbered; the reconciler decides again", async () => {
  const w = world();
  let reads = 0;
  const base = w.cfg;
  // The second config read (the CAS read) sees a user choice that landed meanwhile.
  const realGet = async () => ({ ...w.cfg });
  w.api = createSummaryModel({
    listModels: async () => w.models,
    configGet: async () => {
      reads++;
      if (reads === 2) w.cfg = { ...base, summaryModel: { providerID: "anthropic", modelID: "claude-sonnet-4", source: "user", pickedAt: 7 }, summaryModelOptOut: false };
      return realGet();
    },
    configUpdate: async (patch) => {
      w.writes.push(patch);
      w.cfg = { ...w.cfg, ...patch };
    },
    catalog: {},
    subscriptionIds: async () => new Set(),
    now: () => 9,
    warn: () => {},
  });
  const s = await w.api.status();
  assert.equal(w.writes.length, 0, "the stale decision was dropped, not written");
  assert.equal(w.cfg.summaryModel.source, "user");
  assert.equal(s.current.modelID, "claude-sonnet-4");
  assert.equal(s.state, "ok");
});

test("requests while a reconcile runs coalesce into exactly one more run", async () => {
  const w = world();
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  w.api = createSummaryModel({
    listModels: async () => {
      calls++;
      if (calls === 1) await gate;
      return w.models;
    },
    configGet: async () => ({ ...w.cfg }),
    configUpdate: async (p) => { w.cfg = { ...w.cfg, ...p }; },
    catalog: {},
    subscriptionIds: async () => new Set(),
    now: () => 1,
    warn: () => {},
  });
  const first = w.api.reconcile();
  await new Promise((r) => setImmediate(r));
  const a = w.api.reconcile();
  const b = w.api.reconcile();
  const c = w.api.reconcile();
  assert.equal(a, b);
  assert.equal(b, c);
  release();
  await Promise.all([first, a, b, c]);
  assert.equal(calls, 2, "the running one plus exactly one more");
});

test("`set` accepts any ELIGIBLE model (even outside the 30-entry shortlist); `search` finds it; ineligible is a 400", async () => {
  const many = Array.from({ length: 45 }, (_, i) => model("anthropic", `claude-haiku-${i}`, { family: "haiku", cost: { input: 1 + i, output: 5 + i } }));
  const tiny = model("anthropic", "tiny-claude", { limit: { context: 8_000 } });
  const w = world({ models: [...many, tiny] });
  const s = await w.api.status();
  assert.equal(s.candidates.length, 30);
  assert.equal(s.candidates.some((c) => c.modelID === "claude-haiku-44"), false);
  const found = await w.api.search({ query: "HAIKU-44" });
  assert.deepEqual(found.models.map((m) => m.modelID), ["claude-haiku-44"]);
  assert.equal((await w.api.search({ query: "haiku" })).models.length, 45);
  assert.equal((await w.api.search({ query: "tiny" })).models.length, 0, "ineligible models are not searchable");
  const set = await w.api.set({ providerID: "anthropic", modelID: "claude-haiku-44" });
  assert.equal(set.current.modelID, "claude-haiku-44");
  assert.equal(w.cfg.summaryModel.source, "user");
  await assert.rejects(() => w.api.set({ providerID: "anthropic", modelID: "tiny-claude" }), (e) => e.rpcStatus === 400 && /isn't available as a summary model/.test(e.message));
  await assert.rejects(() => w.api.set({ providerID: "x", modelID: "nope" }), (e) => e.rpcStatus === 400);
  await assert.rejects(() => w.api.set({}), (e) => e.rpcStatus === 400);
  assert.equal(w.cfg.summaryModel.modelID, "claude-haiku-44", "a refused set changes nothing");
});

test("resolveCheapWriter: the Summary model when ok, else the session's own last-used model, else null", async () => {
  const w = world({ lastUsed: { providerID: "anthropic", modelID: "claude-opus-5" } });
  assert.deepEqual(await w.api.resolveCheapWriter("ses_1"), { providerID: "anthropic", modelID: "claude-haiku-4", from: "summary" });
  await w.api.set({ none: true });
  assert.deepEqual(await w.api.resolveCheapWriter("ses_1"), { providerID: "anthropic", modelID: "claude-opus-5", from: "session" });
  w.lastUsed = null;
  assert.equal(await w.api.resolveCheapWriter("ses_1"), null);
  w.lastUsed = { providerID: "anthropic", modelID: "claude-opus-5" };
  assert.equal(await w.api.resolveCheapWriter(""), null, "no session → no fallback");
  // an unavailable user choice is not trusted either
  const u = world({ cfg: { summaryModel: { providerID: "openai", modelID: "gone", source: "user", pickedAt: 1 } }, lastUsed: { providerID: "anthropic", modelID: "claude-opus-5" } });
  assert.equal((await u.api.resolveCheapWriter("ses_1")).from, "session");
});
