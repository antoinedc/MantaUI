import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCHES_PER_PROJECT_PER_DAY, createBudget, localDay, pauseNotice } from "./budget.mjs";
import { fakeBackgroundBudget, memState } from "./testHelpers.mjs";

const PRICES = {
  models: {
    "a/cheap": { input: 1, output: 5 },
    "a/mid": { input: 3, output: 15 },
    "a/deep": { input: 15, output: 75 },
    "b/deep2": { input: 10, output: 40 },
  },
};
const bandOf = (p, m) => ({ "a/cheap": "fast", "a/mid": "balanced", "a/deep": "deep", "b/deep2": "deep" })[`${p}/${m}`] ?? null;

function rig({ prices = PRICES, backgroundBudget = fakeBackgroundBudget(), resolveModel = null } = {}) {
  let t = new Date(2026, 10, 16, 10, 0, 0).getTime();
  return memState().then((state) => {
    const b = createBudget({ state, backgroundBudget, resolveModel, getPrices: () => prices, bandOf, now: () => t });
    return { b, state, backgroundBudget, setNow: (x) => (t = x), now: () => t };
  });
}

test("record writes one ledger row per call: priced at the model's rates, by work type, per local day", async () => {
  const { b } = await rig();
  const r = await b.record({ taskClass: "curator-rules", model: { providerID: "a", modelID: "deep" }, tokens: { input: 20_000, output: 4_000 } });
  assert.equal(r.priced, true);
  assert.ok(Math.abs(r.usd - (20_000 * 15 + 4_000 * 75) / 1e6) < 1e-9); // 0.6
  assert.equal(b.byClass()[0].taskClass, "curator-rules");
  assert.ok(Math.abs(b.spentToday() - 0.6) < 1e-9);
});

test("an unpriced model is charged at its band's dearest price (priced:false); the tidy-up's band is its work type's, not the task class's", async () => {
  const { b } = await rig();
  const r = await b.record({ taskClass: "knowledge-tidy", model: { providerID: "q", modelID: "unknown" }, tokens: { input: 1_000_000 } });
  assert.equal(r.priced, false);
  assert.equal(r.usd, 1); // "fast" band: a/cheap at $1/Mtok — not the "deep" band curator-rules would price at
  assert.equal(b.byClass()[0].taskClass, "knowledge-tidy");
});

test("a directly supplied usd (a trial session's recorded usage) is stored as-is", async () => {
  const { b } = await rig();
  const r = await b.record({ taskClass: "knowledge-trial", usd: 0.123 });
  assert.equal(r.usd, 0.123);
  assert.equal(b.spentToday(), 0.123);
});

test("record prices every component of reported usage; usd wins; a bare total splits 90/10", async () => {
  const { b } = await rig();
  const model = { providerID: "a", modelID: "mid" }; // $3 in / $15 out per Mtok
  const full = await b.record({ taskClass: "knowledge-capture", model, tokens: { input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 } });
  assert.ok(Math.abs(full.usd - (3 + 15 + 15 + 0.3 + 3)) < 1e-9);
  const usd = await b.record({ taskClass: "knowledge-capture", model, usd: 0.5, tokens: { input: 9_999_999 } });
  assert.equal(usd.usd, 0.5);
  const total = await b.record({ taskClass: "knowledge-capture", model, tokens: 1_000_000 });
  assert.ok(Math.abs(total.usd - (0.9 * 3 + 0.1 * 15)) < 1e-9);
  const none = await b.record({ taskClass: "knowledge-capture", model });
  assert.equal(none.usd, 0);
});

test("record never books on the shared budget (the runner and the trial do, once per call)", async () => {
  const { b, backgroundBudget } = await rig();
  await b.record({ taskClass: "knowledge-capture", model: { providerID: "a", modelID: "mid" }, tokens: { input: 10 } });
  assert.equal(backgroundBudget.calls.record.length, 0);
});

test("at most 24 curator batches per project per day", async () => {
  const { b, setNow, now } = await rig();
  for (let i = 0; i < MAX_BATCHES_PER_PROJECT_PER_DAY; i++) {
    assert.equal(b.canBatch("p"), true);
    b.recordBatch("p");
  }
  assert.equal(b.canBatch("p"), false);
  assert.equal(b.canBatch("other"), true);
  setNow(now() + 24 * 3600 * 1000);
  assert.equal(b.canBatch("p"), true);
});

test("localDay is box-local", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
});

test("canSpend asks the shared budget with the work type and the model its task class resolves to", async () => {
  const resolved = [];
  const { b, backgroundBudget } = await rig({ resolveModel: async (c) => (resolved.push(c), { providerID: "a", modelID: "deep" }) });
  const d = await b.canSpend({ workType: "knowledge-tidy", modelClass: "curator-rules" });
  assert.equal(d.ok, true);
  assert.deepEqual(resolved, ["curator-rules"]);
  assert.deepEqual(backgroundBudget.calls.check, [{ workType: "knowledge-tidy", model: { providerID: "a", modelID: "deep" } }]);
  // an explicit model wins; no class given → the work type is the class
  await b.canSpend({ workType: "knowledge-trial", model: { providerID: "b", modelID: "deep2" } });
  assert.deepEqual(backgroundBudget.calls.check[1], { workType: "knowledge-trial", model: { providerID: "b", modelID: "deep2" } });
  await b.canSpend({ workType: "knowledge-capture" });
  assert.deepEqual(resolved, ["curator-rules", "knowledge-capture"]);
});

test("canSpend returns the refusal as the shared budget gave it", async () => {
  const bb = fakeBackgroundBudget({ refuse: "level-cap" });
  const { b } = await rig({ backgroundBudget: bb });
  const d = await b.canSpend({ workType: "knowledge-capture" });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "level-cap");
});

test("a model that can't be resolved (a verdict, null, a throw) leaves the model out: the shared budget uses the box default", async () => {
  for (const resolveModel of [async () => ({ ok: false, code: "no-qualifying-model" }), async () => null, async () => { throw new Error("router down"); }]) {
    const { b, backgroundBudget } = await rig({ resolveModel });
    assert.equal((await b.canSpend({ workType: "curator-rules" })).ok, true);
    assert.deepEqual(backgroundBudget.calls.check, [{ workType: "curator-rules", model: undefined }]);
  }
});

test("without a shared budget, or when it throws, every gate refuses `unavailable` (fail closed); batch timing waits", async () => {
  const { b } = await rig({ backgroundBudget: null });
  assert.deepEqual(await b.canSpend({ workType: "knowledge-capture" }), { ok: false, mode: "payg", fallback: true, reason: "unavailable", resumesAt: null });
  assert.equal((await b.goodMomentForBatch({ workType: "knowledge-tidy" })).ok, false);
  assert.equal(await b.dueAt({ workType: "knowledge-tidy", intervalDueAt: 5 }), 5);
  const boom = { check: async () => { throw new Error("x"); }, goodMomentForBatch: async () => { throw new Error("x"); }, dueAt: async () => { throw new Error("x"); } };
  const t = await rig({ backgroundBudget: boom });
  assert.equal((await t.b.canSpend({ workType: "knowledge-capture" })).reason, "unavailable");
  assert.deepEqual(await t.b.goodMomentForBatch({ workType: "knowledge-tidy" }), { ok: false, rule: null, reason: "unavailable" });
  assert.equal(await t.b.dueAt({ workType: "knowledge-tidy", intervalDueAt: 7 }), 7);
  assert.equal((await (await rig()).b.canSpend({})).ok, false);
});

test("goodMomentForBatch and dueAt pass the work type, the resolved model and the times through", async () => {
  const bb = fakeBackgroundBudget({ good: false });
  bb.dueAtFn = ({ intervalDueAt }) => intervalDueAt + 1000;
  const { b } = await rig({ backgroundBudget: bb, resolveModel: async () => ({ providerID: "a", modelID: "cheap" }) });
  assert.equal(await b.dueAt({ workType: "knowledge-tidy", modelClass: "curator-rules", intervalDueAt: 50 }), 1050);
  assert.deepEqual(bb.calls.dueAt, [{ model: { providerID: "a", modelID: "cheap" }, intervalDueAt: 50 }]);
  const gm = await b.goodMomentForBatch({ workType: "knowledge-tidy", modelClass: "curator-rules", dueSince: 9 });
  assert.equal(gm.ok, false);
  assert.deepEqual(bb.calls.goodMoment, [{ workType: "knowledge-tidy", model: { providerID: "a", modelID: "cheap" }, dueSince: 9 }]);
});

test("book forwards real usage to the shared budget (a trial's own session), and never throws", async () => {
  const { b, backgroundBudget } = await rig();
  await b.book({ workType: "knowledge-trial", model: { providerID: "a", modelID: "mid" }, usage: { input: 5 }, usd: 0.2 });
  assert.deepEqual(backgroundBudget.calls.record, [{ workType: "knowledge-trial", model: { providerID: "a", modelID: "mid" }, usage: { input: 5 }, usd: 0.2, inLedger: false }]);
  const t = await rig({ backgroundBudget: { record: async () => { throw new Error("x"); } } });
  assert.equal(await t.b.book({ workType: "knowledge-trial" }), null);
  assert.equal(await (await rig({ backgroundBudget: null })).b.book({ workType: "knowledge-trial" }), null);
});

test("pauseNotice: plain words for every reason, an unknown one reads as 'waiting for the budget'", () => {
  for (const r of ["usd-cap", "level-cap", "window-busy", "projected-high", "exhausted", "off", "unavailable", "nonsense"]) {
    const n = pauseNotice(r);
    assert.ok(n.summary.length > 0 && n.reason.length > 0, r);
    assert.match(n.reason, /Briefings and the search tools keep working/);
  }
  assert.match(pauseNotice("usd-cap").summary, /Daily spend cap reached/);
  assert.match(pauseNotice("nonsense").summary, /Waiting for the background budget/);
});
