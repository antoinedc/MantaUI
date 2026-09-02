// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCtoCards } from "./ctoCards.mjs";
import { patchStore, verdictsStore } from "./ctoStores.mjs";
import {
  ACTION_TYPES,
  DEFAULT_CLASS_PRIORS,
  buildSuggestContext,
  buildWorthinessContext,
  collectAnomaliesFromFacts,
  collectFailuresFromDigests,
  collectFindings,
  createCtoSuggest,
  defaultThresholds,
  filterOptionsByData,
  normalizeCandidates,
  parseSuggestionText,
  parseWorthinessScore,
  stableSuggestionId,
  worthinessProbability,
} from "./ctoSuggest.mjs";
import { evaluateGate } from "./ctoGate.mjs";
// BET-1518: the deleted verb-ladder symbols must be gone — a stale import of
// decideVerb/VERDICT_MIN below (or anywhere) would break this file's module
// contract check (see the deleted-symbols test at the bottom).
const suggestModule = await import("./ctoSuggest.mjs");

// ---------------------------------------------------------------------------
// Id stability (§9.1)
// ---------------------------------------------------------------------------

test("stableSuggestionId: same (findingId,class) is stable; different inputs differ", () => {
  assert.equal(stableSuggestionId("rec:abc", "start-job"), stableSuggestionId("rec:abc", "start-job"));
  assert.notEqual(stableSuggestionId("rec:abc", "start-job"), stableSuggestionId("rec:abd", "start-job"));
  assert.notEqual(stableSuggestionId("rec:abc", "start-job"), stableSuggestionId("rec:abc", "config-change"));
  assert.match(stableSuggestionId("rec:abc", "config-change"), /^[0-9a-f]{24}$/);
});

// ---------------------------------------------------------------------------
// Option filtering by data (§9.1 + §7.4) — enum exclusion
// ---------------------------------------------------------------------------

test("filterOptionsByData: empty write ring always excludes tool-write even with capability on", () => {
  const opts = [
    { label: "run", action: { type: "start-job", payload: {} } },
    { label: "write", action: { type: "tool-write", payload: { tool: "edit" } } },
  ];
  const out = filterOptionsByData(opts, { writeToolIds: [], tier: "high", capabilities: { toolWrite: true, queueTonight: true } });
  assert.deepEqual(out.map((o) => o.label), ["run"]);
});

test("filterOptionsByData: tool-write on the write ring passes; tool off-ring excluded", () => {
  const opts = [
    { label: "write-a", action: { type: "tool-write", payload: { tool: "edit" } } },
    { label: "write-b", action: { type: "tool-write", payload: { tool: "bash" } } },
  ];
  const out = filterOptionsByData(opts, { writeToolIds: ["edit"], tier: "high", capabilities: { toolWrite: true } });
  assert.deepEqual(out.map((o) => o.label), ["write-a"]);
});

test("filterOptionsByData: Low/Medium tier excludes queue-tonight; High + capability allows it", () => {
  const oq = { label: "tonight", action: { type: "queue-tonight", payload: {} } };
  assert.deepEqual(filterOptionsByData([oq], { tier: "low", capabilities: { queueTonight: true } }).length, 0);
  assert.deepEqual(filterOptionsByData([oq], { tier: "medium", capabilities: { queueTonight: true } }).length, 0);
  // capability off (P2 default) — excluded even at High tier
  assert.deepEqual(filterOptionsByData([oq], { tier: "high", capabilities: { queueTonight: false } }).length, 0);
  // capability on AND High → allowed
  assert.equal(filterOptionsByData([oq], { tier: "high", capabilities: { queueTonight: true } }).length, 1);
});

test("filterOptionsByData: P2 default capabilities exclude both queue-tonight and tool-write", () => {
  const opts = [
    { label: "cfg", action: { type: "config-change", payload: {} } },
    { label: "tonight", action: { type: "queue-tonight", payload: {} } },
    { label: "write", action: { type: "tool-write", payload: { tool: "edit" } } },
  ];
  const out = filterOptionsByData(opts, { writeToolIds: [], tier: "medium", capabilities: {} });
  assert.deepEqual(out.map((o) => o.label), ["cfg"]);
});

// ---------------------------------------------------------------------------
// Worthiness calibration (§9.1)
// ---------------------------------------------------------------------------

test("worthinessProbability: score × prior × reliability, clamped", () => {
  assert.equal(worthinessProbability(0.5, 0.5, 0.5), 0.125);
  assert.equal(worthinessProbability(1, 1, 1), 1);
  assert.equal(worthinessProbability(2, 1, 1), 1); // clamp high
  assert.equal(worthinessProbability(0, 1, 1), 0);
  // invalid/non-finite score treated as 0
  assert.equal(worthinessProbability(NaN, 1, 1), 0);
  assert.equal(worthinessProbability(0.5, 0.5, 2), 0.25); // reliability clamped to 1
  // defaults
  assert.equal(worthinessProbability(0.5), 0.5 * 0.5 * 0.5);
});

test("default priors cover the closed enum", () => {
  for (const t of ACTION_TYPES) {
    assert.ok(typeof DEFAULT_CLASS_PRIORS[t] === "number", `missing prior for ${t}`);
  }
});

// ---------------------------------------------------------------------------
// Salience floors (BET-1471) — the ONLY thresholds left under the gate.
// The verb ladder itself (decideVerb, tiers, cold-start, p_act) is deleted
// (BET-1518); the act/ask split is evaluateGate on effective = p ×
// calibration ≥ τ (ctoGate.test.mjs covers the gate math).
// ---------------------------------------------------------------------------

// BET-1471: the shipped per-class table — each floor derives from the class's
// prior ceiling (p_ask = 0.8 × ceiling). Pinned as exact literals so a prior
// change without a floor change cannot sneak the arithmetic dead-zone back
// in. The p_act half of the pair is dead but kept in the shape so the
// persisted engine-state override round-trips.
test("defaultThresholds: per-class floors match the BET-1470 decision table", () => {
  const th = defaultThresholds();
  for (const t of ACTION_TYPES) {
    assert.ok(th[t] && typeof th[t] === "object", `missing thresholds for ${t}`);
  }
  assert.deepEqual(th["record-decision"], { p_ask: 0.48, p_act: 0.57 });
  assert.deepEqual(th["config-change"], { p_ask: 0.4, p_act: 0.48 });
  assert.deepEqual(th["start-job"], { p_ask: 0.32, p_act: 0.38 });
  assert.deepEqual(th["queue-tonight"], { p_ask: 0.28, p_act: 0.33 });
  assert.deepEqual(th["tool-write"], { p_ask: 0.24, p_act: 0.29 });
  // Every floor stays inside its class's p ceiling (= its prior): a candidate
  // at the ceiling clears the ask bar.
  for (const t of ACTION_TYPES) {
    const ceiling = DEFAULT_CLASS_PRIORS[t];
    assert.ok(th[t].p_ask <= ceiling, `${t}: p_ask must not exceed the prior ceiling`);
  }
});

// BET-1518 regression: the deleted ladder symbols must be gone from the
// module surface (no VERDICT_MIN re-export, no decideVerb, no countVerdicts).
test("deleted symbols: no decideVerb, no VERDICT_MIN, no countVerdicts on the module", () => {
  assert.equal("decideVerb" in suggestModule, false);
  assert.equal("VERDICT_MIN" in suggestModule, false);
  const eng = createCtoSuggest({});
  assert.equal(typeof eng.countVerdicts, "undefined");
  assert.equal("_trust" in eng, false);
});

// ---------------------------------------------------------------------------
// Findings collection (P2 sources)
// ---------------------------------------------------------------------------

test("collectFailuresFromDigests: recurring failure becomes a finding; single = not", () => {
  const digests = [
    { generated: 1, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c1"] }] },
    { generated: 2, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c2"] }, { tier: "progress", text: "x" }] },
  ];
  const findings = collectFailuresFromDigests(digests);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceKind, "failure-recurrence");
  assert.match(findings[0].id, /^rec:[0-9a-f]{24}$/);
  assert.deepEqual(findings[0].refs, ["c1", "c2"]);

  const single = collectFailuresFromDigests([{ items: [{ tier: "failure", text: "Once" }] }]);
  assert.equal(single.length, 0);
});

test("collectAnomaliesFromFacts: anomaly/kind, low-confidence, and superseded facts", () => {
  const nowMs = 1_000_000_000;
  const facts = [
    { id: "f1", kind: "anomaly", statement: "Deploys spike on Tuesdays" },
    { id: "f2", kind: "fact", confidence: 0.3, statement: "Low conf" },
    { id: "f3", kind: "fact", confidence: 0.9, superseded_by: "f4", updated: nowMs - 1000, statement: "Old priority" },
    { id: "f4", kind: "fact", confidence: 0.9, statement: "Fine - not anomalous" },
  ];
  const findings = collectAnomaliesFromFacts(facts, { nowMs });
  assert.equal(findings.length, 3);
  assert.ok(findings.every((f) => f.sourceKind === "fact-anomaly"));
  assert.ok(findings.some((f) => f.text === "Deploys spike on Tuesdays"));
  assert.ok(findings.some((f) => f.text === "Low conf"));
  assert.ok(findings.some((f) => f.text === "Old priority"));
});

// ---------------------------------------------------------------------------
// Generator output normalization (§9.1 schema)
// ---------------------------------------------------------------------------

test("normalizeCandidates: validates schema, binds stable id, caps at 3", () => {
  const text = JSON.stringify({
    candidates: [
      { class: "start-job", finding: { text: "Retry the build", refs: ["c1"] }, options: [{ label: "Run", action: { type: "start-job", payload: { prompt: "x" } } }] },
      { class: "bad-class", finding: { text: "ignored" }, options: [{ label: "x", action: { type: "start-job", payload: {} } }] },
      { class: "config-change", finding: { text: "Bump cap", refs: ["c2"] }, options: [{ label: "Apply", action: { type: "config-change", payload: { patch: {} } } }] },
      { class: "record-decision", finding: { text: "fourth", refs: [] }, options: [{ label: "4", action: { type: "record-decision", payload: {} } }] },
      { class: "tool-write", finding: { text: "five", refs: [] }, options: [{ label: "5", action: { type: "tool-write", payload: { tool: "edit" } } }] },
    ],
  });
  const out = normalizeCandidates(parseSuggestionText(text), "rec:abc");
  assert.equal(out.length, 3); // capped, invalid class dropped
  assert.equal(out[0].id, stableSuggestionId("rec:abc", "start-job"));
  assert.ok(out.every((c) => ACTION_TYPES.includes(c.class)));
  assert.ok(out.every((c) => c.options.length >= 1 && c.options.length <= 3));
});

test("parseSuggestionText: extracts JSON from prose fences", () => {
  const out = parseSuggestionText("Here you go:\n```json\n{\"candidates\":[]}\n```");
  assert.deepEqual(out, { candidates: [] });
  assert.equal(parseSuggestionText("not json"), null);
  assert.equal(parseWorthinessScore("0.7"), 0.7);
  assert.equal(parseWorthinessScore("score: 0.35"), 0.35);
  assert.equal(parseWorthinessScore("nan"), null);
});

// ---------------------------------------------------------------------------
// The pipeline (createCtoSuggest) — injected stores + gated model seams
//
// ONE harness builder (`makeSug`) parameterizes the full createCtoSuggest()
// config over memory-backed stores; each test overrides only the seams it
// exercises. This is the file-wide generalization of BET-1465's local
// makeDedupeSug pattern (BET-1474): the duplication gate re-scans the WHOLE
// changed file, so every repeated config block must live in this builder.
// ---------------------------------------------------------------------------

// One-candidate generator payload for a class — the shape the gated `suggest`
// model call returns for a single finding. The "Go" label is arbitrary; no
// assertion reads it.
function oneCandidateSuggestText(cls, text, refs = []) {
  return JSON.stringify({
    candidates: [{ class: cls, finding: { text, refs }, options: [{ label: "Go", action: { type: cls, payload: {} } }] }],
  });
}

// The shared harness: memory-backed ledger / verdicts / engine-state /
// calibration / board stores + a parameterized createCtoSuggest(). Defaults
// encode the common warm wiring (medium tier, reliability 1.0, a card writer
// that accepts and records every write, fresh calibration 0.5 and τ 0.7 —
// under which a max-p candidate still ASKS, never acts). `build` assembles
// a SECOND engine over the same stores for multi-instance tests.
function makeSug({
  thresholds = null, // flat {p_ask, p_act} → the es.suggest.thresholds override
  engineState = null, // full initial engine state (wins over thresholds)
  calibration = null, // number | async (cls) => (0,1] — the class's §9.5 calibration
  tau = null, // number | async () => 0..1 — the gate's τ (default 0.7)
  digests: digestsDep = { list: async () => [], load: async () => null },
  configGet = async () => ({ ctoTier: "medium" }),
  capabilities = null,
  cards: cardsDep = null, // cards dep override; default records into the board
  vetoSink = null, // array → the cards dep also exposes a recording upsertVeto (overnight tests only)
  buildCards = null, // ({boardStore, ledger, engineState, now}) => cards manager
  runSuggest = async () => ({ text: JSON.stringify({ candidates: [] }) }),
  runWorthiness = async () => ({ text: "0.9" }),
  senderReliability = async () => 1.0,
  classPriors = null,
  executeAction = null,
  recordVerdict = null, // default: the B3 route, recorded into verdictEntries
  fireNotify = null, // default: recorded into notified[]
} = {}) {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const verdictEntries = [];
  const notified = [];
  const acts = [];
  let board = { v: 1, cards: [] };
  const initialEs = engineState ?? (thresholds ? { v: 1, suggest: { thresholds } } : { v: 1 });
  let es = initialEs;

  const ledger = { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows };
  const verdicts = { load: async () => ({ entries: verdictEntries }), save: async () => {} };
  const engineStateDep = { load: async () => es, save: async (p) => { es = p; } };
  const boardStore = { load: async () => board, save: async (p) => { board = p; } };

  const defaultCards = {
    upsertDecision: async (c) => {
      board.cards.push(c);
      return { changed: true, isNew: true };
    },
  };
  if (vetoSink) {
    defaultCards.upsertVeto = async (c) => {
      vetoSink.push(c);
      return { changed: true, isNew: true };
    };
  }
  const cardsManager = buildCards
    ? buildCards({ boardStore, ledger, engineState: engineStateDep, now: () => clock.ms })
    : cardsDep ?? defaultCards;

  function assemble(extra = {}) {
    return createCtoSuggest({
      now: () => clock.ms,
      publish: () => {},
      ledger,
      verdicts,
      engineState: engineStateDep,
      digests: digestsDep,
      facts: { list: async () => [], load: async () => null },
      configGet,
      ...(capabilities ? { capabilities } : {}),
      cards: cardsManager,
      runSuggest,
      runWorthiness,
      senderReliability,
      ...(classPriors ? { classPriors } : {}),
      ...(executeAction ? { executeAction } : {}),
      calibrationOf:
        calibration == null
          ? async () => 0.5
          : typeof calibration === "function"
            ? calibration
            : async () => calibration,
      tau:
        tau == null
          ? async () => 0.7
          : typeof tau === "function"
            ? tau
            : async () => tau,
      recordAct: async (input) => {
        acts.push(input);
        return { ok: true };
      },
      recordVerdict:
        recordVerdict ??
        (async ({ subject, verdict, never }) => {
          verdictEntries.push({ ts: clock.ms, subject, verdict, ...(never ? { never: true } : {}) });
          return { ok: true };
        }),
      fireNotify: fireNotify ?? (async (args) => { notified.push(args); }),
      ...extra,
    });
  }

  return {
    sug: assemble(),
    build: assemble, // a second engine over the SAME stores
    clock,
    ledgerRows,
    verdictEntries,
    notified,
    acts,
    get cardPayload() {
      return board;
    },
    getEs: () => es,
    resetEs() {
      es = initialEs; // simulates usedKeys-cap churn / engine-state reset
    },
  };
}

test("pipeline: silent-log when below p_ask (no card, ledger row, no notify)", async () => {
  const h = makeSug({
    thresholds: { p_ask: 0.5, p_act: 0.95 },
    // low worthiness score → p = 0.2 * prior * reliability < p_ask=0.5
    runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "a") }),
    runWorthiness: async () => ({ text: "0.2" }),
  });
  const r = await h.sug.processFinding({ id: "rec:abc", sourceKind: "fact-anomaly", text: "a", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 0);
  assert.equal(r.silent, 1);
  assert.equal(h.cardPayload.cards.length, 0);
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.silent" && x.id === stableSuggestionId("rec:abc", "start-job")));
  assert.equal(h.notified.length, 0);
});

test("pipeline: decision card surfaced + notify on failure-recurrence; option executors excluded by P2 data", async () => {
  const h = makeSug({
    thresholds: { p_ask: 0.2, p_act: 0.95 },
    runSuggest: async () => ({
      text: JSON.stringify({
        candidates: [
          {
            class: "start-job",
            finding: { text: "Restart the stuck build", refs: ["c1"] },
            options: [
              { label: "Kick build", action: { type: "start-job", payload: { prompt: "retry" } } },
              { label: "Tonight", action: { type: "queue-tonight", payload: {} } },
              { label: "Write", action: { type: "tool-write", payload: { tool: "edit" } } },
            ],
          },
        ],
      }),
    }),
    runWorthiness: async () => ({ text: "1.0" }),
  });

  // failure-recurrence finding → notify
  const r = await h.sug.processFinding(
    { id: "rec:x", sourceKind: "failure-recurrence", text: "build", refs: ["c1"] },
    { tier: "medium" },
  );
  assert.equal(r.surfaced, 1);
  assert.equal(h.notified.length, 1); // steep-decay notify variant fired
  const card = h.cardPayload.cards[0];
  assert.ok(card);
  assert.equal(card.variant, "decision");
  // P2 data excluded queue-tonight + tool-write (empty write ring / capability off)
  const labels = card.options.map((o) => o.action.type);
  assert.deepEqual(labels, ["start-job"]);
});

test("pipeline: a fresh class never acts (calibration 0.5 × p < τ) — the gate caps everything at ask", async () => {
  // BET-1518: with a fresh class (calibration 0.5) and the default τ 0.7,
  // even a max-worthiness candidate's effective (1.0 × 0.5 = 0.5) stays below
  // the bar — the cold-start behavior emerges from the estimator, no pin.
  const h = makeSug({
    thresholds: { p_ask: 0.2, p_act: 0.3 },
    configGet: async () => ({ ctoTier: "high" }),
    runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "cold") }),
    runWorthiness: async () => ({ text: "1.0" }), // score → p high
  });
  const r = await h.sug.processFinding({ id: "rec:cold", sourceKind: "fact-anomaly", text: "cold", refs: [] }, { tier: "high" });
  assert.equal(r.surfaced, 1); // asks -> decision card, not an act
  assert.equal(h.cardPayload.cards[0].variant, "decision");
});

test("listHeld: returns silent-log ledger rows", async () => {
  const h = makeSug();
  h.ledgerRows.push({ kind: "suggest.silent", id: "a", score: 0.1, ts: 10 });
  h.ledgerRows.push({ kind: "suggest.presented", cardId: "b", ts: 9 });
  h.ledgerRows.push({ kind: "suggest.silent", id: "c", score: 0.2, ts: 11 });
  const held = await h.sug.listHeld();
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((x) => x.id).sort(), ["a", "c"]);
});

test("verdictHeld: routes judgment to the B3 verdict route", async () => {
  const h = makeSug();
  const r = await h.sug.verdictHeld({ id: "rec:abc", verdict: "dismiss" });
  assert.equal(r.ok, true);
  assert.equal(h.verdictEntries.length, 1);
  assert.equal(h.verdictEntries[0].subject.type, "suggestion");
  assert.equal(h.verdictEntries[0].verdict, "dismiss");
});

// BET-1492 — the direct-store fallback appends through the verdicts store's
// patchStore mutex: a concurrent writer's committed state survives (the old
// unlocked load-spread-save loaded before the writer's commit and reverted
// its key on save).
test("verdictHeld fallback is a patchStore section: a concurrent writer's patch and the append BOTH land", async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  await verdictsStore.save({ entries: [] });
  const rows = [{ id: "held-9", kind: "suggest.silent", class: "tool", ts: 1 }];
  const sug = createCtoSuggest({
    ledger: { append: async () => true, read: async () => rows },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    verdicts: verdictsStore,
    now: () => 1_000,
    publish: () => {},
    configGet: async () => ({}),
    recordVerdict: null, // force the direct-store fallback
  });
  const writer = patchStore(verdictsStore, async () => {
    await delay(25);
    return { marker: "w" };
  });
  await delay(5); // let the writer take the mutex
  const r = await sug.verdictHeld({ id: "held-9", verdict: "accept" });
  assert.equal(r.ok, true);
  await writer;
  const after = await verdictsStore.load();
  assert.equal(after.marker, "w", "the concurrent writer's key survived the fallback append");
  assert.equal(after.entries.filter((e) => e?.subject?.id === "held-9").length, 1);
});

test("collectFindings: combines digest + fact sources", () => {
  const digests = [
    { items: [{ tier: "failure", text: "F" }, { tier: "failure", text: "F" }] },
  ];
  const facts = [{ id: "f", kind: "anomaly", statement: "A" }];
  const out = collectFindings(digests, facts, { nowMs: Date.now() });
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
// §9.1 review Block 1 — decision-card reachability under PRODUCTION wiring
// ---------------------------------------------------------------------------

test("production wiring can surface a decision card: reliability 1.0 × prior 0.6 ≥ p_ask 0.48", async () => {
  // Mirror the SHIPPED index.mjs constants: reliability 1.0 (trusted internal
  // sender), default class priors (max 0.6 record-decision), no engine-state
  // override → the BET-1471 per-class thresholds (record-decision p_ask 0.48
  // = 0.8 × the 0.6 ceiling), Medium tier — the harness defaults ARE that
  // wiring; only the generator + worthiness seams are per-test.
  const h = makeSug({
    runSuggest: async () => ({ text: oneCandidateSuggestText("record-decision", "Adopt pact") }),
    runWorthiness: async () => ({ text: "1.0" }), // max-worthiness candidate
  });
  const r = await h.sug.processFinding({ id: "rec:r", sourceKind: "fact-anomaly", text: "r", refs: [] }, { tier: "medium" });
  // p = 1.0 × 0.6 × 1.0 = 0.6 ≥ p_ask 0.48 → surfaces; the gate asks (fresh
  // class 0.5 → effective 0.3 < τ 0.7), never silent-log.
  assert.equal(r.surfaced, 1);
  assert.equal(h.cardPayload.cards.length, 1);
  assert.equal(h.cardPayload.cards[0].variant, "decision");
});

// BET-1471 regression: queue-tonight's ceiling (prior 0.35) sat below the old
// global p_ask 0.4, so the class was silent-log at ANY score. Its per-class
// bar (0.28 = 0.8 × 0.35) makes a max-worthiness candidate surface.
test("queue-tonight is no longer a dead class: score-1.0 candidate surfaces a card", async () => {
  const h = makeSug({
    configGet: async () => ({ ctoTier: "high" }),
    capabilities: { queueTonight: true, toolWrite: true }, // SHIPPED values in index.mjs
    runSuggest: async () => ({ text: oneCandidateSuggestText("queue-tonight", "Queue the maintenance window") }),
    runWorthiness: async () => ({ text: "1.0" }), // max-worthiness candidate
  });
  const r = await h.sug.processFinding({ id: "rec:q", sourceKind: "fact-anomaly", text: "q", refs: [] }, { tier: "high" });
  // p = 1.0 × 0.35 × 1.0 = 0.35 ≥ p_ask 0.28 → decision card. Under the old
  // global bar (0.4) this exact candidate was silent-log at every score.
  assert.equal(r.surfaced, 1);
  assert.equal(r.silent, 0);
  assert.equal(h.cardPayload.cards.length, 1);
  assert.equal(h.cardPayload.cards[0].variant, "decision");
  assert.ok(h.ledgerRows.every((x) => x.kind !== "suggest.silent"));
});

// BET-1518 reachability: for each class, p at the ceiling reaches the act
// verb through a fully-calibrated class (calibration → 1.0 over its outcome
// window), surfaces the ask card on a fresh class, and stays silent below
// the class's p_ask floor. No tiers, no eligibility map — the class list is
// the §9.2 enum itself, and the τ dial is lowered to 0.3 (the default 0.7
// exceeds the low-prior classes' ceilings by design: they ask until the user
// turns the dial down).
test("act verb is arithmetically reachable through calibration, not tiers", () => {
  const classes = { "record-decision": 0.6, "queue-tonight": 0.35, "start-job": 0.4 };
  for (const [cls, ceiling] of Object.entries(classes)) {
    // τ dialed to the class's ceiling: a calibrated class reaches the act verb
    const acted = evaluateGate({ plans: [{ id: "p", class: cls, confidence: ceiling }], tau: ceiling, calibration: { [cls]: 1.0 } });
    assert.equal(acted.verb, "act", `${cls}: p at the ceiling with full calibration must reach the act verb`);
    // the same p on a fresh class → ask card (0.5 × ceiling < ceiling)
    const asked = evaluateGate({ plans: [{ id: "p", class: cls, confidence: ceiling }], tau: ceiling, calibration: { [cls]: 0.5 } });
    assert.equal(asked.verb, "ask", `${cls}: p at the ceiling on a fresh class must surface the ask card`);
    // just below the class's p_ask floor → silent-log (handled in processFinding)
    const pAsk = defaultThresholds()[cls].p_ask;
    assert.ok(pAsk > 0 && pAsk < ceiling, `${cls}: the floor sits inside the class's ceiling`);
  }
});

// ---------------------------------------------------------------------------
// BET-1518 — the gate in the pipeline (§9.3/§9.5): act vs ask on
// effective = p × calibration ≥ τ; refusal degrades to the ask card; notify
// is a delivery property of ask.
// ---------------------------------------------------------------------------

test("pipeline: ask verb surfaces the decision card with the effective score (never a veto card)", async () => {
  // Fresh calibration (0.5) × p 1.0 = 0.5 < τ 0.7 → ask. The veto-window
  // verb is deleted: even with a veto writer on the harness, no veto card
  // may be written.
  const vetoCards = [];
  const h = makeSug({
    vetoSink: vetoCards,
    runSuggest: async () => ({ text: oneCandidateSuggestText("record-decision", "a") }),
  });
  const r = await h.sug.processFinding({ id: "rec:vd", sourceKind: "fact-anomaly", text: "a", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(h.cardPayload.cards.length, 1);
  assert.equal(h.cardPayload.cards[0].variant, "decision");
  assert.equal(vetoCards.length, 0);
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.presented" && x.variant === "decision"));
});

test("pipeline: calibrated class + p ≥ τ acts, ledgers, and queues the digest report", async () => {
  const executed = [];
  const h = makeSug({
    calibration: async (cls) => (cls === "record-decision" ? 1.0 : 0.5),
    tau: 0.7,
    executeAction: async ({ cls, action }) => {
      executed.push({ cls, action });
      return { ok: true };
    },
    runSuggest: async () => ({ text: oneCandidateSuggestText("record-decision", "Adopt pact", ["msg:1"]) }),
    runWorthiness: async () => ({ text: "1.0" }), // p = 1.0 × 1.0 (prior override) ≥ τ → act
    classPriors: { "record-decision": 1.0 },
  });
  const r = await h.sug.processFinding({ id: "rec:aa", sourceKind: "fact-anomaly", text: "a", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].action.type, "record-decision");
  assert.equal(h.cardPayload.cards.length, 0); // no card — it acted
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.acted" && x.class === "record-decision"));
  // The mandatory report (§9.2 invariant 1) is queued for the next digest.
  assert.equal(h.acts.length, 1);
  assert.equal(h.acts[0].cls, "record-decision");
});

test("pipeline: act-refused action degrades to the ask card (never silently acts, never a veto card)", async () => {
  const h = makeSug({
    calibration: async (cls) => (cls === "start-job" ? 1.0 : 0.5),
    runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "a") }),
    runWorthiness: async () => ({ text: "1.0" }),
    classPriors: { "start-job": 1.0 },
    // executeAction stays unwired for this class → refuse
  });
  const r = await h.sug.processFinding({ id: "rec:de", sourceKind: "fact-anomaly", text: "a", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(h.cardPayload.cards.length, 1); // degraded to the ask card
  assert.equal(h.cardPayload.cards[0].variant, "decision");
  assert.equal(h.ledgerRows.filter((x) => x.kind === "suggest.acted").length, 0);
  assert.equal(h.acts.length, 0);
});

test("pipeline: below the class's p_ask stays silent even when calibration would act", async () => {
  const executed = [];
  const h = makeSug({
    calibration: 1.0,
    runSuggest: async () => ({ text: oneCandidateSuggestText("config-change", "a") }),
    runWorthiness: async () => ({ text: "0.35" }), // p = 0.35 < config-change p_ask 0.4
    classPriors: { "config-change": 1.0 },
    executeAction: async () => { executed.push(1); return { ok: true }; },
  });
  const r = await h.sug.processFinding({ id: "rec:cc", sourceKind: "fact-anomaly", text: "a", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 0);
  assert.equal(r.silent, 1);
  assert.equal(executed.length, 0);
  assert.equal(h.cardPayload.cards.length, 0);
});

test("pipeline: no special-casing — a config-change plan acts through the same gate", async () => {
  const executed = [];
  const h = makeSug({
    calibration: 1.0,
    tau: 0.5,
    executeAction: async ({ cls, action }) => {
      executed.push({ cls, action });
      return { ok: true };
    },
    runSuggest: async () => ({ text: oneCandidateSuggestText("config-change", "a") }),
    runWorthiness: async () => ({ text: "1.0" }),
    classPriors: { "config-change": 1.0 },
  });
  const r = await h.sug.processFinding({ id: "rec:noSpecial", sourceKind: "fact-anomaly", text: "a", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].cls, "config-change");
});

test("verdictHeld stamps the held row's class onto the subject (§9.5 attribution)", async () => {
  const h = makeSug({
    runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "a") }),
    runWorthiness: async () => ({ text: "0.1" }), // p below p_ask → silent-log (a HELD row)
  });
  await h.sug.processFinding(
    { id: "rec:h1", sourceKind: "fact-anomaly", text: "a", refs: [] },
    { tier: "medium" }
  );
  const sid = stableSuggestionId("rec:h1", "start-job");
  const recorded = [];
  const sug2 = h.build({
    recordVerdict: async ({ subject, verdict }) => {
      recorded.push({ subject, verdict });
      return { ok: true };
    },
  });
  await sug2.verdictHeld({ id: sid, verdict: "accept" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].subject.class, "start-job");
});

// ---------------------------------------------------------------------------
// BET-1465 — usedKeys dedupe (defect 1) + distinct notify tag (defect 2)
// ---------------------------------------------------------------------------

test("dedupe: a second runPass over the same findings makes no new model calls, ledger rows, or notifies", async () => {
  let suggestCalls = 0;
  let worthinessCalls = 0;
  const digestList = [
    { generated: 1, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c1"] }] },
    { generated: 2, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c2"] }] },
  ];
  const h = makeSug({
    thresholds: { p_ask: 0.2, p_act: 0.95 },
    digests: { list: async () => ["d1", "d2"], load: async (id) => (id === "d1" ? digestList[0] : digestList[1]) },
    runSuggest: async () => {
      suggestCalls += 1;
      return { text: oneCandidateSuggestText("start-job", "Restart the stuck build", ["c1"]) };
    },
    runWorthiness: async () => {
      worthinessCalls += 1;
      return { text: "0.9" };
    },
  });

  const r1 = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r1.findings, 1);
  assert.equal(r1.surfaced, 1);
  assert.equal(suggestCalls, 1);
  assert.equal(worthinessCalls, 1);
  assert.equal(h.ledgerRows.length, 1);
  assert.equal(h.notified.length, 1); // failure-recurrence → notify

  h.clock.ms += 30 * 60_000; // simulate the next 30-minute pass over the SAME retained digests
  const r2 = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r2.findings, 1); // the finding is still collected (source retained)
  assert.equal(r2.surfaced, 0);
  assert.equal(r2.silent, 0);
  assert.equal(suggestCalls, 1, "no new suggest model call");
  assert.equal(worthinessCalls, 1, "no new worthiness model call");
  assert.equal(h.ledgerRows.length, 1, "no new ledger row");
  assert.equal(h.notified.length, 1, "no new fireNotify");
});

test("usedKeys cap: exactly-at-cap holds every entry; the 201st evicts the OLDEST and preserves the MRU tail", async () => {
  // Seed one short of the cap, then fill to exactly 200 through the real
  // processFinding → markUsed append path.
  const h = makeSug({
    engineState: { v: 1, suggest: { usedKeys: Array.from({ length: 199 }, (_, i) => `old-${i}`) } },
  });
  const process = (id) =>
    h.sug.processFinding({ id, sourceKind: "fact-anomaly", text: "x", refs: [] }, { tier: "medium" });

  // At-cap state: the 200th distinct key lands with NO eviction.
  await process("rec:fill");
  let used = h.getEs().suggest.usedKeys;
  assert.equal(used.length, 200);
  assert.equal(used[0], "old-0", "nothing evicted while filling to exactly the cap");
  assert.equal(used[199], "rec:fill", "the newest key sits at the tail");

  // One past the cap: the 201st distinct key evicts exactly one entry —
  // the OLDEST (front), not the newest being dropped. Trailing-slice FIFO
  // is the chosen rule (documented idiom shared with ctoBudget.mjs).
  await process("rec:over");
  used = h.getEs().suggest.usedKeys;
  assert.equal(used.length, 200, "the cap holds: length never exceeds 200");
  assert.ok(!used.includes("old-0"), "the 201st key evicts the OLDEST entry");
  assert.ok(used.includes("rec:over"), "the newest key is kept, not dropped");

  // The surviving keys are exactly the expected ones, in order —
  // old-1..old-198 (198 entries) plus the two appends at the tail (MRU preserved).
  assert.deepEqual(used, [
    ...Array.from({ length: 198 }, (_, i) => `old-${i + 1}`),
    "rec:fill",
    "rec:over",
  ]);
});

test("notify: fireNotify carries a distinct, non-global tag per candidate WITHOUT synthesizing a sessionID (defect 2, review fix)", async () => {
  const notified = [];
  const fireNotify = async (args) => notified.push(args);
  const a = makeSug({ runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "A") }), fireNotify });
  const b = makeSug({ runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "B") }), fireNotify });
  await a.sug.processFinding({ id: "rec:a", sourceKind: "failure-recurrence", text: "A", refs: [] }, { tier: "medium" });
  await b.sug.processFinding({ id: "rec:b", sourceKind: "failure-recurrence", text: "B", refs: [] }, { tier: "medium" });
  assert.equal(notified.length, 2);
  // push.mjs's `tag` override (added for this fix) is the caller-supplied
  // identifier — a present, per-candidate tag is what keeps two unrelated
  // CTO suggestions (and every other session-less AI `notify` call) from
  // colliding on the shared "notify-global" tag. `sessionID` is a real,
  // load-bearing field that deep-links a phone tap — it must stay unset here,
  // never synthesized just to influence the tag (that was the reviewer Block).
  assert.ok(notified[0].tag, "tag must be present — omission degrades to the shared notify-global tag");
  assert.ok(notified[1].tag);
  assert.notEqual(notified[0].tag, notified[1].tag);
  assert.doesNotMatch(String(notified[0].tag), /^global$/);
  assert.equal(notified[0].sessionID, undefined);
  assert.equal(notified[1].sessionID, undefined);
});

test("fireNotify is gated on the card write's isNew: a re-upserted (not new) card never re-pushes", async () => {
  const h = makeSug({
    cards: { upsertDecision: async () => ({ changed: true, isNew: false }) }, // upsert of a card already on the board
    runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "again") }),
  });
  const r = await h.sug.processFinding({ id: "rec:re", sourceKind: "failure-recurrence", text: "again", refs: [] }, { tier: "medium" });
  assert.equal(r.surfaced, 1); // the card write still counts as surfaced
  assert.equal(h.notified.length, 0); // but never re-pushes a not-new card
});

// ---------------------------------------------------------------------------
// BET-1465 review, Block 1 — a gated or failed generation must NOT
// permanently mark the finding used. The §3.3 ephemeral gate refuses by
// RETURNING {ok:false}, not by throwing, so a budget-closed pass looked
// exactly like "the generator ran and said zero candidates" before this fix.
// ---------------------------------------------------------------------------

test("a gated generation ({ok:false}) does not mark the finding used — it's reconsidered next pass", async () => {
  let calls = 0;
  const h = makeSug({
    thresholds: { p_ask: 0.2, p_act: 0.95 },
    runSuggest: async () => {
      calls += 1;
      // §3.3 ephemeral gate refusal shape (index.mjs gatedSuggestionEphemeral)
      return calls === 1 ? { ok: false, gated: true, error: "budget-closed" } : { text: oneCandidateSuggestText("start-job", "recovered") };
    },
  });
  const finding = { id: "rec:gated", sourceKind: "failure-recurrence", text: "x", refs: [] };
  const r1 = await h.sug.processFinding(finding, { tier: "medium" });
  assert.equal(r1.surfaced, 0);
  assert.equal(r1.silent, 0);
  assert.ok(!(h.getEs().suggest?.usedKeys || []).includes("rec:gated"), "gated pass must not mark used");

  const r2 = await h.sug.processFinding(finding, { tier: "medium" });
  assert.equal(calls, 2, "the generator ran again next pass — not permanently suppressed");
  assert.equal(r2.surfaced, 1, "the finding is reconsidered and surfaces once budget frees up");
});

test("a throwing / unparseable generation does not mark the finding used", async () => {
  const throwing = makeSug({
    runSuggest: async () => {
      throw new Error("model timeout");
    },
  });
  await throwing.sug.processFinding({ id: "rec:throws", sourceKind: "fact-anomaly", text: "x", refs: [] }, { tier: "medium" });
  assert.ok(!(throwing.getEs().suggest?.usedKeys || []).includes("rec:throws"));

  const garbage = makeSug({ runSuggest: async () => ({ text: "not json at all" }) });
  await garbage.sug.processFinding({ id: "rec:garbage", sourceKind: "fact-anomaly", text: "x", refs: [] }, { tier: "medium" });
  assert.ok(!(garbage.getEs().suggest?.usedKeys || []).includes("rec:garbage"));
});

test("a generator that legitimately returns zero candidates (valid empty JSON) IS marked used", async () => {
  const h = makeSug(); // the default generator returns valid empty JSON
  await h.sug.processFinding({ id: "rec:empty", sourceKind: "fact-anomaly", text: "x", refs: [] }, { tier: "medium" });
  assert.ok((h.getEs().suggest?.usedKeys || []).includes("rec:empty"));
});

// ---------------------------------------------------------------------------
// BET-1477 — a byte-identical regeneration of an unchanged candidate is
// "already surfaced, still current" (surfaced), never a suggest.silent
// no-card-path hold, and never a veto→decision verb downgrade.
//
// These tests pin the whole chain through the REAL card manager
// (createCtoCards over the harness's fake stores) — the BET-1463
// byte-identical no-op return in ctoCards.mjs AND the BET-1477 branch in
// ctoSuggest.mjs, not just a fake writer's return shape.
// ---------------------------------------------------------------------------

function makeRegenSug(extra = {}) {
  return makeSug({
    thresholds: { p_ask: 0.2, p_act: 0.95 },
    runWorthiness: async () => ({ text: "0.6" }),
    buildCards: ({ boardStore, ledger, engineState, now }) =>
      createCtoCards({ cardStore: boardStore, ledger, engineState, now }),
    ...extra,
  });
}

test("BET-1477: a byte-identical decision regeneration counts as surfaced, not silent (no-card-path)", async () => {
  const h = makeRegenSug({
    runSuggest: async () => ({ text: oneCandidateSuggestText("config-change", "Tighten the cache TTL", ["c1"]) }),
  });
  const finding = { id: "rec:regen-d", sourceKind: "fact-anomaly", text: "Tighten the cache TTL", refs: ["c1"] };

  const r1 = await h.sug.processFinding(finding, { tier: "medium" });
  assert.equal(r1.surfaced, 1);
  assert.equal(r1.silent, 0);
  const firstWriteAt = h.cardPayload.cards[0].updatedAt;
  const presentedRows = h.ledgerRows.filter((r) => r.kind === "suggest.presented").length;

  // Next pass: the dedupe marker was evicted (cap churn / engine-state
  // reset), the generator regenerates the SAME candidate — the card content
  // is byte-identical, only the write timestamp differs (excluded from
  // cardContentEqual). This must count as surfaced, not as a no-card-path
  // hold.
  h.clock.ms += 30 * 60_000;
  h.resetEs();
  const r2 = await h.sug.processFinding(finding, { tier: "medium" });
  assert.equal(r2.surfaced, 1, "unchanged card is already on the board and current → surfaced");
  assert.equal(r2.silent, 0);
  assert.ok(!h.ledgerRows.some((r) => r.kind === "suggest.silent" && r.reason === "no-card-path"), "no suggest.silent(no-card-path) miscount");
  assert.equal(h.ledgerRows.filter((r) => r.kind === "suggest.presented").length, presentedRows, "no second presented row — no ledger noise");
  assert.equal(h.cardPayload.cards.filter((c) => c.state === "open").length, 1, "never duplicated");
  assert.equal(h.cardPayload.cards[0].updatedAt, firstWriteAt, "byte-identical no-op did not rewrite the card");
});

test("BET-1477: a thrown, missing, or explicitly-refused (ok:false) decision-card write still holds as suggest.silent(no-card-path)", async () => {
  for (const [label, cardsDep] of [
    ["throw", { upsertDecision: async () => { throw new Error("card store boom"); } }],
    ["missing-method", {}],
    ["ok:false", { upsertDecision: async () => ({ ok: false, changed: false, isNew: false }) }],
  ]) {
    const h = makeSug({
      thresholds: { p_ask: 0.2, p_act: 0.95 },
      cards: cardsDep,
      runSuggest: async () => ({ text: oneCandidateSuggestText("config-change", "x") }),
      runWorthiness: async () => ({ text: "0.6" }),
    });
    const r = await h.sug.processFinding({ id: `rec:fail-${label}`, sourceKind: "fact-anomaly", text: "x", refs: [] }, { tier: "medium" });
    assert.equal(r.surfaced, 0, `${label}: no surfaced count without a card`);
    assert.equal(r.silent, 1, `${label}: held instead`);
    assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.silent" && x.reason === "no-card-path"), `${label}: the hold reason is preserved`);
  }
});
