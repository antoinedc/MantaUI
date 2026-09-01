// BET-1469: fail fast, before ANY test body runs, when this file is executed
// outside the state sandbox. A CTO store module imported unsandboxed resolves
// its paths against the LIVE box state (~/.manta) and a test would write
// production data. `npm test` / `npm run test:server` set MANTA_STATE_HOME via
// scripts/testSandbox.mjs before any module is evaluated; a bare
// `node --test <file>` does not.
if (!process.env.MANTA_STATE_HOME) {
  throw new Error(
    "MANTA_STATE_HOME is not set — refusing to run CTO tests against the live box state. " +
      "Run via `npm test` or `npm run test:server` (both --import ./scripts/testSandbox.mjs), " +
      "or set MANTA_STATE_HOME to a throwaway directory first.",
  );
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ELIGIBILITY,
  PROMOTE_MIN_OBS,
  PROMOTE_TAIL_CONF,
  PROMOTE_TAIL_P,
  REJECT_DEMOTE,
  REJECT_WINDOW,
  TIERS,
  TIER_ACT,
  TIER_ASK,
  TIER_VETO_WINDOW,
  VERDICT_MIN,
  betaPasses,
  createCtoTrust,
  eligibilityOf,
  evaluateTier,
} from "./ctoTrust.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memoryStore(initial = {}) {
  // Deep-copy at the boundary like the real jsonStore (a parsed clone per
  // load/save) — aliasing the live object would fake both migrations and
  // clobbers.
  let data = JSON.parse(JSON.stringify(initial ?? {}));
  return {
    load: async () => JSON.parse(JSON.stringify(data)),
    save: async (p) => {
      data = JSON.parse(JSON.stringify(p));
    },
  };
}

function makeTrust({ engineState = {}, verdictCount = 0 } = {}) {
  const ledgerRows = [];
  const verdictEntries = Array.from({ length: verdictCount }, (_, i) => ({ ts: i, subject: { type: "suggestion", id: `s${i}`, class: "start-job" }, verdict: "accept" }));
  const stores = {
    // The trust ladder's own file — fresh unless a test seeds it directly.
    store: memoryStore({}),
    // The legacy engine-state file (the old `es.trust` home) — migration source.
    legacy: memoryStore({ v: 1, ...engineState }),
    ledger: { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows },
    verdicts: memoryStore({ v: 1, entries: verdictEntries }),
  };
  const trust = createCtoTrust({ ...stores, now: () => 1_000_000 });
  return { trust, stores, ledgerRows, verdictEntries };
}

// ---------------------------------------------------------------------------
// §9.3 eligibility map
// ---------------------------------------------------------------------------

test("eligibilityOf: reversible/isolated classes are eligible; config/external-tool/unknown are capped", () => {
  assert.equal(eligibilityOf("record-decision"), "eligible");
  assert.equal(eligibilityOf("queue-tonight"), "eligible");
  assert.equal(eligibilityOf("start-job"), "eligible");
  // §9.3: config and external tool state are capped at ask permanently.
  assert.equal(eligibilityOf("config-change"), "ask-capped");
  assert.equal(eligibilityOf("tool-write"), "ask-capped");
  // Unknown class = capped (fail-closed).
  assert.equal(eligibilityOf("mystery-class"), "ask-capped");
  assert.equal(eligibilityOf(undefined), "ask-capped");
  for (const [k, v] of Object.entries(ELIGIBILITY)) {
    assert.ok(["eligible", "ask-capped"].includes(v), `eligibility for ${k} must be a known value`);
  }
});

// ---------------------------------------------------------------------------
// §9.4 promotion math (Beta tail bar)
// ---------------------------------------------------------------------------

test("betaPasses: needs >= 8 observations AND the tail over 0.9 at 0.95; a degenerate record never passes", () => {
  // Degenerate (b=0) — the estimator refuses zero-variance records.
  assert.equal(betaPasses(9, 0), false);
  // Below the observation floor.
  assert.equal(betaPasses(7, 0) || betaPasses(6, 1), false);
  // Real bars: 25/1 clears, 24/1 does not.
  assert.equal(betaPasses(25, 1), true);
  assert.equal(betaPasses(24, 1), false);
  assert.equal(betaPasses(30, 1), true);
});

test("evaluateTier: ask tier is pinned by the cold-start gate even with a passing Beta", () => {
  const r = evaluateTier({
    tier: TIER_ASK,
    eligible: true,
    coldStart: true,
    ask: { a: 40, b: 1 },
  });
  assert.equal(r.tier, TIER_ASK);
  assert.equal(r.changed, false);
});

test("evaluateTier: ask → veto-window on the tail bar; eligibility and the tail both gate", () => {
  const passing = { ask: { a: 30, b: 1 } };
  const ok = evaluateTier({ tier: TIER_ASK, eligible: true, coldStart: false, ...passing });
  assert.equal(ok.tier, TIER_VETO_WINDOW);
  assert.equal(ok.changed, true);
  // Capped class: same counters, no promotion.
  const capped = evaluateTier({ tier: TIER_ASK, eligible: false, coldStart: false, ...passing });
  assert.equal(capped.tier, TIER_ASK);
  // Tail not cleared: stays ask.
  const weak = evaluateTier({ tier: TIER_ASK, eligible: true, coldStart: false, ask: { a: 24, b: 1 } });
  assert.equal(weak.tier, TIER_ASK);
});

test("evaluateTier: veto-window → act at the same bar over the veto record", () => {
  const ok = evaluateTier({ tier: TIER_VETO_WINDOW, eligible: true, ask: { a: 40, b: 1 }, veto: { va: 25, vb: 1 } });
  assert.equal(ok.tier, TIER_ACT);
  assert.equal(ok.changed, true);
  const weak = evaluateTier({ tier: TIER_VETO_WINDOW, eligible: true, ask: { a: 40, b: 1 }, veto: { va: 5, vb: 1 } });
  assert.equal(weak.tier, TIER_VETO_WINDOW);
});

test("evaluateTier: any 2 rejections in the rolling 10 demote one step, ask is the floor", () => {
  const recent = [
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: false },
    { ok: false },
  ];
  const down = evaluateTier({ tier: TIER_VETO_WINDOW, eligible: true, ask: { a: 40, b: 1 }, recent });
  assert.equal(down.tier, TIER_ASK);
  assert.equal(down.changed, true);
  // act → veto-window
  const down2 = evaluateTier({ tier: TIER_ACT, eligible: true, ask: { a: 40, b: 1 }, veto: { va: 25, vb: 1 }, recent });
  assert.equal(down2.tier, TIER_VETO_WINDOW);
  // At ask the demotion is a no-op.
  const floor = evaluateTier({ tier: TIER_ASK, eligible: true, ask: { a: 40, b: 1 }, recent });
  assert.equal(floor.tier, TIER_ASK);
  // One rejection in ten does not demote.
  const one = evaluateTier({ tier: TIER_VETO_WINDOW, eligible: true, recent: [...Array(9).fill({ ok: true }), { ok: false }] });
  assert.equal(one.tier, TIER_VETO_WINDOW);
  assert.equal(one.changed, false);
});

test("evaluateTier: demotion is evaluated before promotion (rejection pressure wins)", () => {
  const recent = [
    { ok: false },
    { ok: false },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true },
  ];
  const r = evaluateTier({ tier: TIER_ASK, eligible: true, ask: { a: 30, b: 1 }, recent });
  assert.equal(r.tier, TIER_ASK); // demote from ask = stay; never promoted in the same eval
});

// ---------------------------------------------------------------------------
// The trust engine
// ---------------------------------------------------------------------------

test("persistence: a legacy es.trust payload migrates into the dedicated store on first load (review cycle 4)", async () => {
  const h = makeTrust({ engineState: { trust: { tiers: { "start-job": TIER_VETO_WINDOW }, stats: { "start-job": { a: 40, b: 1, va: 3, vb: 0, recent: [] } } } } });
  // First read adopts the legacy payload…
  const st = await h.trust.getState();
  assert.equal(st.tiers["start-job"], TIER_VETO_WINDOW);
  assert.equal(st.stats["start-job"]?.a, 40);
  // …the dedicated store now holds it…
  const inStore = await h.stores.store.load();
  assert.equal(inStore.tiers["start-job"], TIER_VETO_WINDOW);
  // …and a subsequent write goes to the dedicated store, never back into
  // the engine-state snapshot.
  await h.trust.noteVetoOutcome("start-job", { accepted: true });
  const after = await h.stores.store.load();
  assert.equal(after.stats["start-job"]?.va, 4);
  // The legacy file keeps its fossil untouched by design (no engine-state
  // writes from the trust engine) — readers never consult it again once the
  // dedicated store is non-empty.
  assert.equal((await h.stores.legacy.load()).trust.stats["start-job"]?.va, 3);
});

// BET-1482: the one-time adoption persist rides the store's patchStore mutex.
// The old shape — a naked whole-payload save outside any mutex — could clobber
// a writer that committed between the read's outer load and the persist.
// Sequenced with manually-resolved legacy-load promises (review cycle 1: a
// load-count-based slowdown proved order-dependent — the read's outer store
// load is issued synchronously before the writer starts, so the read takes
// legacy load #1; slowing "call #2" slowed the WRITER and the old naked save
// healed instead of clobbering).
test("durability: the adoption persist cannot clobber a writer that committed first (BET-1482)", async () => {
  const legacyPayload = {
    v: 1,
    trust: {
      tiers: { "start-job": TIER_VETO_WINDOW },
      stats: { "start-job": { a: 40, b: 1, va: 3, vb: 0, recent: [] } },
    },
  };
  const copy = () => JSON.parse(JSON.stringify(legacyPayload));
  // The FIRST legacy load is held unresolved until the test releases it; every
  // later load auto-resolves on the next microtask. The read is the only
  // consumer running when the first load fires, so "held" is deterministically
  // the read's.
  let held = null;
  const legacy = {
    load: () =>
      new Promise((resolve) => {
        if (held) queueMicrotask(() => resolve(copy()));
        else held = resolve;
      }),
    save: async () => {},
  };
  const store = memoryStore({});
  const ledgerRows = [];
  const trust = createCtoTrust({
    store,
    legacy,
    ledger: { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows },
    verdicts: memoryStore({ v: 1, entries: [] }),
    now: () => 1_000_000,
  });
  const tick = () => new Promise((r) => setImmediate(r));
  // 1. The read runs first: its outer store load sees the still-empty
  //    dedicated store and it parks on its HELD legacy load — adoption
  //    undecided.
  const read = trust.getState();
  while (!held) await tick();
  // 2. The writer adopts the same legacy payload inside the store mutex
  //    (auto-resolving legacy load), bumps the ask counter, fully commits.
  await trust.noteVerdictEffects(
    { success: true },
    { subject: { type: "suggestion", id: "x", class: "start-job" }, verdict: "accept" },
  );
  // 3. Only NOW does the read decide to adopt. Under the old naked save its
  //    persist fires strictly AFTER the writer's commit and clobbers the
  //    counter back to 40; under the patchStore persist it queues behind the
  //    mutex, re-derives from the committed (no-longer-fresh) payload, and
  //    no-ops.
  held(copy());
  await read;
  const st = await trust.getState();
  assert.equal(st.stats["start-job"]?.a, 41, "the writer's counter bump survived the adoption persist");
  assert.equal(st.tiers["start-job"], TIER_VETO_WINDOW, "the adopted tier survived");
});

test("durability: a stale full-engine-state save cannot revert trust keys (the mirrored clobber direction)", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  await h.trust.noteVerdictEffects({ success: true }, { subject: { type: "suggestion", id: "x", class: "queue-tonight" }, verdict: "accept" });
  const before = await h.trust.getState();
  assert.equal(before.stats["queue-tonight"]?.a, 1);
  // The old writer shape: a whole-file engine-state save spreading a STALE
  // snapshot — even one that still carries an `es.trust` key (pre-migration
  // fossil). Trust lives in its own file; this cannot reach it.
  await h.stores.legacy.save({ v: 1, trust: { tiers: {}, stats: {} }, tonightQueue: [{ id: "tq:1" }] });
  const after = await h.trust.getState();
  assert.equal(after.stats["queue-tonight"]?.a, 1, "the trust fold survived the hostile engine-state save");
});

test("consult: default ask; cold-start caps a promoted tier at ask (§10.6-4 dominance)", async () => {
  const h = makeTrust({ engineState: { trust: { tiers: { "start-job": TIER_VETO_WINDOW } } } });
  const noCold = await h.trust.consult("start-job", { coldStart: false });
  assert.equal(noCold.tier, TIER_VETO_WINDOW);
  assert.equal(noCold.eligible, true);
  const cold = await h.trust.consult("start-job", { coldStart: true });
  assert.equal(cold.tier, TIER_ASK);
  assert.equal(cold.capped, true);
  // Unknown class: capped eligibility.
  const unknown = await h.trust.consult("mystery", { coldStart: false });
  assert.equal(unknown.eligible, false);
});

test("noteVerdictEffects: §9.5 mapping into per-class counters — accept/edit success, dismiss/correct rejection, open nothing", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  const subject = { type: "suggestion", id: "s1", class: "start-job" };
  await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "accept" });
  await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "edit" });
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "dismiss" });
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "correct" });
  await h.trust.noteVerdictEffects({ access: true }, { subject, verdict: "open" });
  await h.trust.noteVerdictEffects({ decay: true }, { subject, verdict: "expire" });
  const st = await h.trust.getState();
  assert.equal(st.stats["start-job"].a, 2);
  assert.equal(st.stats["start-job"].b, 2);
});

test("noteVerdictEffects: non-suggestion subjects and class-less entries advance nothing", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  await h.trust.noteVerdictEffects({ success: true }, { subject: { type: "digest_item", id: "d", class: "start-job" }, verdict: "accept" });
  await h.trust.noteVerdictEffects({ success: true }, { subject: { type: "suggestion", id: "s" }, verdict: "accept" });
  const st = await h.trust.getState();
  assert.deepEqual(st.stats, {});
});

test("promotion: accepts past the bar promote ask → veto-window, ledger + digest announcement", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  const subject = { type: "suggestion", id: "s1", class: "start-job" };
  // 31 accepts + 1 dismiss: the tail clears (a degenerate b=0 record never
  // passes — the estimator refuses zero-variance records).
  for (let i = 0; i < 31; i++) {
    await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "accept" });
  }
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "dismiss" });
  const st = await h.trust.getState();
  assert.equal(st.tiers["start-job"], TIER_VETO_WINDOW);
  assert.ok(h.ledgerRows.some((r) => r.kind === "trust.promoted" && r.cls === "start-job" && r.to === TIER_VETO_WINDOW));
  assert.equal(st.pending, 1);
  const pending = await h.trust.listAnnouncements();
  assert.equal(pending.length, 1);
  assert.match(pending[0].text, /promoted/);
  await h.trust.markAnnounced([pending[0].id]);
  assert.equal((await h.trust.listAnnouncements()).length, 0);
});

test("promotion never fires under the cold-start gate, whatever the counters say", async () => {
  const h = makeTrust({ verdictCount: 0 }); // cold start: < VERDICT_MIN verdicts
  const subject = { type: "suggestion", id: "s1", class: "start-job" };
  // A record that would pass the tail outside cold start.
  for (let i = 0; i < 40; i++) {
    await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "accept" });
  }
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "dismiss" });
  const st = await h.trust.getState();
  assert.equal(st.pending, 0);
  // And consult reports the ask cap while the global gate holds.
  const c = await h.trust.consult("start-job", { coldStart: true });
  assert.equal(c.tier, TIER_ASK);
});

test("capped class never promotes even with a stellar record", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  const subject = { type: "suggestion", id: "c1", class: "config-change" };
  for (let i = 0; i < 40; i++) {
    await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "accept" });
  }
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "dismiss" });
  const st = await h.trust.getState();
  assert.equal(st.tiers["config-change"] ?? TIER_ASK, TIER_ASK);
  assert.equal(st.pending, 0); // no announcement either
  const c = await h.trust.consult("config-change", { coldStart: false });
  assert.equal(c.eligible, false);
  assert.equal(c.tier, TIER_ASK);
});

test("veto verdicts feed the veto-window record, not the ask record (§9.5 table note)", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  const subject = { type: "suggestion", id: "s1", class: "start-job" };
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "veto" });
  const st = await h.trust.getState();
  assert.equal(st.stats["start-job"].vb, 1);
  assert.equal(st.stats["start-job"].b, 0);
});

test("veto-window record: executed windows promote to act; cancels demote (2-in-10)", async () => {
  const h = makeTrust({
    verdictCount: VERDICT_MIN,
    engineState: { trust: { tiers: { "start-job": TIER_VETO_WINDOW }, stats: { "start-job": { a: 40, b: 1, va: 0, vb: 0, recent: [] } } } },
  });
  const cls = "start-job";
  // Executed windows → acceptance into the veto record (30 accepts + 1 cancel
  // clears the tail; a degenerate all-accept record never passes).
  for (let i = 0; i < 30; i++) {
    await h.trust.noteVetoOutcome(cls, { accepted: true });
  }
  await h.trust.noteVetoOutcome(cls, { accepted: false });
  let st = await h.trust.getState();
  assert.equal(st.tiers[cls], TIER_ACT); // 26 accepts 0 rejects passes the tail
  assert.ok(h.ledgerRows.some((r) => r.kind === "trust.promoted" && r.to === TIER_ACT));

  // Fresh fixture at veto tier: two cancels → demote to ask.
  const h2 = makeTrust({
    verdictCount: VERDICT_MIN,
    engineState: { trust: { tiers: { "start-job": TIER_VETO_WINDOW }, stats: { "start-job": { a: 40, b: 1, va: 25, vb: 1, recent: [] } } } },
  });
  await h2.trust.noteVetoOutcome(cls, { accepted: false });
  await h2.trust.noteVetoOutcome(cls, { accepted: false });
  st = await h2.trust.getState();
  assert.equal(st.tiers[cls], TIER_ASK);
  assert.ok(h2.ledgerRows.some((r) => r.kind === "trust.demoted" && r.to === TIER_ASK));
});

test("act-and-report bookkeeping: ledger row + pending announcement, exactly-once consumption", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  const r = await h.trust.recordAct({ cls: "record-decision", text: "recorded the deploy order decision", refs: ["msg:1"], action: { type: "record-decision", payload: {} } });
  assert.equal(r.ok, true);
  assert.ok(h.ledgerRows.some((row) => row.kind === "trust.act" && row.cls === "record-decision"));
  const pending = await h.trust.listAnnouncements();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "act");
  assert.match(pending[0].text, /^Acted on my own \(record-decision\)/);
  assert.deepEqual(pending[0].refs, ["msg:1"]);
  await h.trust.markAnnounced([r.id]);
  assert.equal((await h.trust.listAnnouncements()).length, 0);
  // Marking again is a no-op.
  const again = await h.trust.markAnnounced([r.id]);
  assert.equal(again.removed, 0);
});

test("rolling window is capped and consumed by a tier change", async () => {
  const h = makeTrust({ verdictCount: VERDICT_MIN });
  const subject = { type: "suggestion", id: "s1", class: "start-job" };
  for (let i = 0; i < 31; i++) {
    await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "accept" });
  }
  await h.trust.noteVerdictEffects({ rejection: true }, { subject, verdict: "dismiss" });
  let st = await h.trust.getState();
  assert.equal(st.tiers["start-job"], TIER_VETO_WINDOW);
  assert.equal(st.stats["start-job"].recent.length, 0); // consumed by promotion
  // Keep recording: the window caps at REJECT_WINDOW entries.
  for (let i = 0; i < REJECT_WINDOW + 3; i++) {
    await h.trust.noteVerdictEffects({ success: true }, { subject, verdict: "accept" });
  }
  st = await h.trust.getState();
  assert.equal(st.stats["start-job"].recent.length, REJECT_WINDOW);
});

test("ladder constants match the spec (§9.4/§10.6-4)", () => {
  assert.equal(PROMOTE_MIN_OBS, 8);
  assert.equal(PROMOTE_TAIL_P, 0.9);
  assert.equal(PROMOTE_TAIL_CONF, 0.95);
  assert.equal(REJECT_WINDOW, 10);
  assert.equal(REJECT_DEMOTE, 2);
  assert.equal(VERDICT_MIN, 15);
  assert.deepEqual(TIERS, ["ask", "veto-window", "act"]);
  assert.deepEqual([TIER_ASK, TIER_VETO_WINDOW, TIER_ACT], TIERS);
});
