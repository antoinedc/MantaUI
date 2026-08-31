import { test } from "node:test";
import assert from "node:assert/strict";
import { createCtoCards } from "./ctoCards.mjs";
import {
  ACTION_TYPES,
  DEFAULT_CLASS_PRIORS,
  VERDICT_MIN,
  buildSuggestContext,
  buildWorthinessContext,
  collectAnomaliesFromFacts,
  collectFailuresFromDigests,
  collectFindings,
  createCtoSuggest,
  decideVerb,
  defaultThresholds,
  filterOptionsByData,
  normalizeCandidates,
  parseSuggestionText,
  parseWorthinessScore,
  stableSuggestionId,
  worthinessProbability,
} from "./ctoSuggest.mjs";

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
// Verb decision (§9.1): cold-start cap + p_ask threshold + act unreachable
// ---------------------------------------------------------------------------

test("decideVerb: below p_ask → silent-log", () => {
  assert.deepEqual(decideVerb({ p: 0.1 }), { verb: "silent-log" });
});

test("decideVerb: p between p_ask and p_act → decision (no notify unless recurrence)", () => {
  assert.deepEqual(decideVerb({ p: 0.6 }), { verb: "decision", notify: false });
  assert.deepEqual(decideVerb({ p: 0.8, sourceKind: "failure-recurrence" }), { verb: "decision", notify: true });
  assert.deepEqual(decideVerb({ p: 0.8, sourceKind: "fact-anomaly" }), { verb: "decision", notify: false });
});

test("decideVerb: act branch without trust — throws on p >= p_act (BET-1403: ask-tier hold)", () => {
  assert.throws(() => decideVerb({ p: 0.99 }), /class not trusted/);
  // Eligibility gates the climb (§9.3): an ask-capped class never leaves the
  // ask verbs even when its tier record somehow reads promoted.
  assert.throws(() => decideVerb({ p: 0.99, tier: "act", eligible: false }), /class not trusted/);
});

test("decideVerb: trust ladder raises the ceiling (§9.2/§9.4)", () => {
  // veto-window tier: p >= p_ask surfaces the veto-window verb.
  assert.deepEqual(decideVerb({ p: 0.6, tier: "veto-window", eligible: true }), { verb: "veto-window", notify: false });
  // act tier but below the act bar → still the veto-window verb.
  assert.deepEqual(decideVerb({ p: 0.6, tier: "act", eligible: true }), { verb: "veto-window", notify: false });
  // act tier + p >= p_act → the act verb fires.
  assert.deepEqual(decideVerb({ p: 0.99, tier: "act", eligible: true }), { verb: "act", notify: false });
  assert.deepEqual(decideVerb({ p: 0.99, tier: "act", eligible: true, sourceKind: "watcher-hit-rate" }), { verb: "act", notify: true });
  // cold-start dominates the ladder (§10.6-4): capped at ask whatever the tier.
  assert.deepEqual(decideVerb({ p: 0.99, coldStart: true, tier: "act", eligible: true }), { verb: "decision", capped: true, notify: false });
});

test("decideVerb: cold-start caps high-score candidates at the ask verb (no throw)", () => {
  // Even a score that would exceed p_act is capped to a decision card during
  // cold start — the act branch is not even considered.
  assert.deepEqual(decideVerb({ p: 0.99, coldStart: true }), { verb: "decision", capped: true, notify: false });
  // The p_ask threshold still applies during cold start: below it → silent-log.
  assert.deepEqual(decideVerb({ p: 0.1, coldStart: true }), { verb: "silent-log" });
});

test("decideVerb: custom thresholds override defaults", () => {
  assert.deepEqual(decideVerb({ p: 0.3, thresholds: { p_ask: 0.2, p_act: 0.9 } }), { verb: "decision", notify: false });
  assert.deepEqual(decideVerb({ p: 0.1, thresholds: { p_ask: 0.2 } }), { verb: "silent-log" });
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
// ---------------------------------------------------------------------------

function makeHarness() {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const verdictEntries = [];
  let engineState = { v: 1 };
  let cardPayload = { v: 1, cards: [] };
  const writes = [];

  const ledger = { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows };
  const verdicts = {
    load: async () => ({ v: 1, entries: verdictEntries }),
    save: async (p) => {
      verdictEntries.length = 0;
      verdictEntries.push(...(p?.entries || []));
    },
  };
  const engineState2 = {
    load: async () => engineState,
    save: async (p) => {
      engineState = p;
    },
  };

  // cards manager — a minimal fake exercising our upsertDecision contract.
  const cards = {
    upsertDecision: async (c) => {
      cardPayload.cards.push(c);
      writes.push(c.id);
      return { changed: true, isNew: true };
    },
    loadCards: () => cardPayload.cards,
  };

  const sug = createCtoSuggest({
    now: () => clock.ms,
    publish: () => {},
    ledger,
    verdicts,
    engineState: engineState2,
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({}),
    cards,
    recordVerdict: async ({ subject, verdict, never }) => {
      verdictEntries.push({ ts: clock.ms, subject, verdict, ...(never ? { never: true } : {}) });
      return { ok: true };
    },
    fireNotify: async () => {
      notified.push(1);
    },
    senderReliability: async () => 0.9,
  });

  const notified = [];

  return { sug, clock, ledgerRows, verdictEntries, cardPayload, writes, notified, setEngineState(p) { engineState = p; } };
}

test("pipeline: silent-log when below p_ask (no card, ledger row, no notify)", async () => {
  const h = makeHarness();
  await h.setEngineState({ v: 1, suggest: { thresholds: { p_ask: 0.5, p_act: 0.95 } } });
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    engineState: {
      load: async () => ({ suggest: { thresholds: { p_ask: 0.5, p_act: 0.95 } } }),
      save: async () => {},
    },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    // low worthiness score → p = 0.2 * prior * reliability < p_ask=0.5
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "start-job", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "start-job", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "0.2" }),
    senderReliability: async () => 1.0,
    fireNotify: async () => h.notified.push(1),
  });
  const r = await sug2.processFinding({ id: "rec:abc", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 0);
  assert.equal(r.silent, 1);
  assert.equal(h.cardPayload.cards.length, 0);
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.silent" && x.id === stableSuggestionId("rec:abc", "start-job")));
  assert.equal(h.notified.length, 0);
});

test("pipeline: decision card surfaced + notify on failure-recurrence; option executors excluded by P2 data", async () => {
  const h = makeHarness();
  const runSuggest = async () => ({
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
  });
  const runWorthiness = async () => ({ text: "1.0" });
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    engineState: {
      load: async () => ({ suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } }),
      save: async () => {},
    },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    runSuggest,
    runWorthiness,
    senderReliability: async () => 1.0,
    fireNotify: async () => h.notified.push(1),
  });

  // non-cold-start (15 verdicts above), failure-recurrence finding → notify
  const r = await sug2.processFinding(
    { id: "rec:x", sourceKind: "failure-recurrence", text: "build", refs: ["c1"] },
    { coldStart: false, tier: "medium" },
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

test("pipeline: cold-start caps even a high-score candidate into a decision card (never acts)", async () => {
  const h = makeHarness();
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: { load: async () => ({ entries: [] }), save: async () => {} }, // cold start
    engineState: {
      load: async () => ({ suggest: { thresholds: { p_ask: 0.2, p_act: 0.3 } } }),
      save: async () => {},
    },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "high" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "start-job", finding: { text: "cold", refs: [] }, options: [{ label: "Go", action: { type: "start-job", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "1.0" }), // score → p high
    senderReliability: async () => 1.0,
  });
  const r = await sug2.processFinding({ id: "rec:cold", sourceKind: "fact-anomaly", text: "cold", refs: [] }, { coldStart: true, tier: "high" });
  assert.equal(r.surfaced, 1); // capped -> decision card, not an act
  assert.equal(h.cardPayload.cards[0].capped, true);
});

test("listHeld: returns silent-log ledger rows", async () => {
  const h = makeHarness();
  h.ledgerRows.push({ kind: "suggest.silent", id: "a", score: 0.1, ts: 10 });
  h.ledgerRows.push({ kind: "suggest.presented", cardId: "b", ts: 9 });
  h.ledgerRows.push({ kind: "suggest.silent", id: "c", score: 0.2, ts: 11 });
  const held = await h.sug.listHeld();
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((x) => x.id).sort(), ["a", "c"]);
});

test("verdictHeld: routes judgment to the B3 verdict route", async () => {
  const h = makeHarness();
  const r = await h.sug.verdictHeld({ id: "rec:abc", verdict: "dismiss" });
  assert.equal(r.ok, true);
  assert.equal(h.verdictEntries.length, 1);
  assert.equal(h.verdictEntries[0].subject.type, "suggestion");
  assert.equal(h.verdictEntries[0].verdict, "dismiss");
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

test("production wiring can surface a decision card: reliability 1.0 × prior 0.6 ≥ p_ask 0.4", async () => {
  const h = makeHarness();
  // Mirror the SHIPPED index.mjs constants: reliability 1.0 (trusted internal
  // sender), default class priors (max 0.6 record-decision), default engine
  // thresholds (p_ask 0.4, no suggest in engine-state), Medium tier.
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: { load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }), save: async () => {} },
    engineState: { load: async () => ({}), save: async () => {} }, // no suggest.thresholds → defaults
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    runSuggest: async () => ({
      text: JSON.stringify({
        candidates: [
          {
            class: "record-decision", // prior 0.6 — the max
            finding: { text: "Adopt pact", refs: [] },
            options: [{ label: "Record", action: { type: "record-decision", payload: { statement: "x" } } }],
          },
        ],
      }),
    }),
    runWorthiness: async () => ({ text: "1.0" }), // max-worthiness candidate
    senderReliability: async () => 1.0, // SHIPPED value in index.mjs
  });
  const r = await sug2.processFinding({ id: "rec:r", sourceKind: "fact-anomaly", text: "r", refs: [] }, { coldStart: false, tier: "medium" });
  // p = 1.0 × 0.6 × 1.0 = 0.6 ≥ p_ask 0.4 → decision card, not silent-log.
  assert.equal(r.surfaced, 1);
  assert.equal(h.cardPayload.cards.length, 1);
  assert.equal(h.cardPayload.cards[0].variant, "decision");
});

// ---------------------------------------------------------------------------
// BET-1403 — the trust ladder in the pipeline (§9.2/§9.3/§9.4)
// ---------------------------------------------------------------------------

test("pipeline: veto-window tier surfaces the veto verb; missing veto writer degrades to the decision card", async () => {
  const h = makeHarness();
  // Promote the class by seeding the trust state directly (same store the
  // suggest engine consults), with a non-cold-start verdict ledger.
  await h.setEngineState({ v: 1, trust: { tiers: { "record-decision": "veto-window" } } });
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    trustStore: {
      load: async () => ({ v: 1, tiers: { "record-decision": "veto-window" } }),
      save: async () => {},
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
      // no upsertVeto — BET-1419 ships it; the verb must degrade, not vanish
    },
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "record-decision", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "record-decision", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "0.9" }),
    senderReliability: async () => 1.0,
  });
  const r = await sug2.processFinding({ id: "rec:vd", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(h.cardPayload.cards.length, 1);
  assert.equal(h.cardPayload.cards[0].variant, "decision"); // degraded veto verb
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.presented" && x.variant === "decision"));
});

test("pipeline: veto-window verb writes the veto card when the writer exists", async () => {
  const h = makeHarness();
  const vetoCards = [];
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    trustStore: {
      load: async () => ({ v: 1, tiers: { "record-decision": "veto-window" } }),
      save: async () => {},
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
      upsertVeto: async (c) => {
        vetoCards.push(c);
        return { changed: true, isNew: true };
      },
    },
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "record-decision", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "record-decision", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "0.9" }),
    senderReliability: async () => 1.0,
  });
  const r = await sug2.processFinding({ id: "rec:vv", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(vetoCards.length, 1);
  assert.equal(vetoCards[0].variant, "veto");
  assert.equal(h.cardPayload.cards.length, 0); // no ask-card fallback
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.presented" && x.variant === "veto"));
});

test("pipeline: act tier + executable action executes, ledgers, and queues the digest report", async () => {
  const h = makeHarness();
  const executed = [];
  let es = { v: 1, tiers: { "record-decision": "act" } }; // memory-backed trust store: recordAct persists the pending report
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    trustStore: {
      load: async () => es,
      save: async (p) => {
        es = p;
      },
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    executeAction: async ({ cls, action }) => {
      executed.push({ cls, action });
      return { ok: true };
    },
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "record-decision", finding: { text: "Adopt pact", refs: ["msg:1"] }, options: [{ label: "Record", action: { type: "record-decision", payload: { statement: "x" } } }] }] }),
    }),
    runWorthiness: async () => ({ text: "1.0" }), // p = 1.0 × 1.0 (prior override) ≥ p_act → act verb
    senderReliability: async () => 1.0,
    classPriors: { "record-decision": 1.0 },
  });
  const r = await sug2.processFinding({ id: "rec:aa", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].action.type, "record-decision");
  assert.equal(h.cardPayload.cards.length, 0); // no card — it acted
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.acted" && x.class === "record-decision"));
  // The mandatory report (§9.2 invariant 1) is queued for the next digest.
  const pending = await sug2._trust.listAnnouncements();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "act");
  assert.match(pending[0].text, /^Acted on my own \(record-decision\)/);
});

test("pipeline: act tier + unexecutable action degrades to the veto-window verb (never silently acts)", async () => {
  const h = makeHarness();
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    trustStore: {
      load: async () => ({ v: 1, tiers: { "start-job": "act" } }),
      save: async () => {},
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    // no executeAction seam wired for this class → refuse
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "start-job", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "start-job", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "1.0" }),
    senderReliability: async () => 1.0,
  });
  const r = await sug2.processFinding({ id: "rec:de", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(h.cardPayload.cards.length, 1); // degraded to the ask card (no veto writer)
  assert.equal(h.ledgerRows.filter((x) => x.kind === "suggest.acted").length, 0);
  assert.equal((await sug2._trust.listAnnouncements()).length, 0);
});

test("pipeline: cold start keeps an act-tier class capped at the ask verb (§10.6-4 dominance)", async () => {
  const h = makeHarness();
  const executed = [];
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: { load: async () => ({ entries: [] }), save: async () => {} }, // cold start
    trustStore: {
      load: async () => ({ v: 1, tiers: { "record-decision": "act" } }),
      save: async () => {},
    },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: {
      upsertDecision: async (c) => {
        h.cardPayload.cards.push(c);
        return { changed: true, isNew: true };
      },
    },
    executeAction: async ({ cls, action }) => {
      executed.push({ cls, action });
      return { ok: true };
    },
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "record-decision", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "record-decision", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "1.0" }),
    senderReliability: async () => 1.0,
  });
  const r = await sug2.processFinding({ id: "rec:cs", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: true, tier: "medium" });
  assert.equal(r.surfaced, 1);
  assert.equal(executed.length, 0); // never acts under the cold-start gate
  assert.equal(h.cardPayload.cards[0].capped, true);
});

test("pipeline: an act-tier ask-capped class still throws into the hold (§9.3 eligibility)", async () => {
  const h = makeHarness();
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: {
      load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }),
      save: async () => {},
    },
    engineState: {
      // config-change is §9.3-capped; even a corrupt/foreign "act" tier row
      // must never raise the ceiling — decideVerb throws, the pipeline holds.
      load: async () => ({ v: 1, trust: { tiers: { "config-change": "act" } } }),
      save: async () => {},
    },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: { upsertDecision: async () => ({ changed: true }) },
    executeAction: async () => ({ ok: true }),
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "config-change", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "config-change", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "1.0" }), // p = 1.0 ≥ p_act — the act branch, refused for a capped class
    senderReliability: async () => 1.0,
    classPriors: { "config-change": 1.0 },
  });
  const r = await sug2.processFinding({ id: "rec:cc", sourceKind: "fact-anomaly", text: "a", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 0);
  assert.equal(r.silent, 1);
  assert.ok(h.ledgerRows.some((x) => x.kind === "suggest.silent" && x.reason === "act-not-trusted"));
});

test("verdictHeld stamps the held row's class onto the subject (§9.4 attribution)", async () => {
  const h = makeHarness();
  const sug1 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: h.verdicts,
    engineState: { load: async () => ({}), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({}),
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "start-job", finding: { text: "a", refs: [] }, options: [{ label: "Go", action: { type: "start-job", payload: {} } }] }] }),
    }),
    runWorthiness: async () => ({ text: "0.1" }), // p below p_ask → silent-log (a HELD row)
    senderReliability: async () => 1.0,
  });
  await sug1.processFinding(
    { id: "rec:h1", sourceKind: "fact-anomaly", text: "a", refs: [] },
    { coldStart: false, tier: "medium" }
  );
  const sid = stableSuggestionId("rec:h1", "start-job");
  const recorded = [];
  const sug2 = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async (r) => h.ledgerRows.push(r), read: async () => h.ledgerRows },
    verdicts: h.verdicts,
    engineState: { load: async () => ({}), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({}),
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
//
// One local builder shared by the four tests below (instead of repeating the
// createCtoSuggest() config in each) so this addition doesn't itself grow the
// file's clone count.
// ---------------------------------------------------------------------------

function oneCandidateSuggestText(cls, text, refs = []) {
  return JSON.stringify({
    candidates: [{ class: cls, finding: { text, refs }, options: [{ label: "Go", action: { type: cls, payload: {} } }] }],
  });
}

function makeDedupeSug({
  engineState: engineStateDep = { load: async () => ({ suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } }), save: async () => {} },
  ledger: ledgerDep = { append: async () => {}, read: async () => [] },
  digests: digestsDep = { list: async () => [], load: async () => null },
  cards: cardsDep = { upsertDecision: async () => ({ changed: true, isNew: true }) },
  runSuggest: runSuggestDep = async () => ({ text: JSON.stringify({ candidates: [] }) }),
  runWorthiness: runWorthinessDep = async () => ({ text: "0.9" }),
  fireNotify: fireNotifyDep = async () => {},
  now = () => 1,
} = {}) {
  return createCtoSuggest({
    now,
    publish: () => {},
    ledger: ledgerDep,
    verdicts: { load: async () => ({ entries: Array(VERDICT_MIN).fill({}) }), save: async () => {} },
    engineState: engineStateDep,
    digests: digestsDep,
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards: cardsDep,
    runSuggest: runSuggestDep,
    runWorthiness: runWorthinessDep,
    senderReliability: async () => 1.0,
    fireNotify: fireNotifyDep,
  });
}

test("dedupe: a second runPass over the same findings makes no new model calls, ledger rows, or notifies", async () => {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  let es = { suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } };
  let suggestCalls = 0;
  let worthinessCalls = 0;
  const notified = [];
  const digestList = [
    { generated: 1, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c1"] }] },
    { generated: 2, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c2"] }] },
  ];
  const sug = makeDedupeSug({
    now: () => clock.ms,
    engineState: { load: async () => es, save: async (p) => { es = p; } },
    ledger: { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows },
    digests: { list: async () => ["d1", "d2"], load: async (id) => (id === "d1" ? digestList[0] : digestList[1]) },
    runSuggest: async () => {
      suggestCalls += 1;
      return { text: oneCandidateSuggestText("start-job", "Restart the stuck build", ["c1"]) };
    },
    runWorthiness: async () => {
      worthinessCalls += 1;
      return { text: "0.9" };
    },
    fireNotify: async (args) => notified.push(args),
  });

  const r1 = await sug.runPass({ nowMs: clock.ms });
  assert.equal(r1.findings, 1);
  assert.equal(r1.surfaced, 1);
  assert.equal(suggestCalls, 1);
  assert.equal(worthinessCalls, 1);
  assert.equal(ledgerRows.length, 1);
  assert.equal(notified.length, 1); // failure-recurrence → notify

  clock.ms += 30 * 60_000; // simulate the next 30-minute pass over the SAME retained digests
  const r2 = await sug.runPass({ nowMs: clock.ms });
  assert.equal(r2.findings, 1); // the finding is still collected (source retained)
  assert.equal(r2.surfaced, 0);
  assert.equal(r2.silent, 0);
  assert.equal(suggestCalls, 1, "no new suggest model call");
  assert.equal(worthinessCalls, 1, "no new worthiness model call");
  assert.equal(ledgerRows.length, 1, "no new ledger row");
  assert.equal(notified.length, 1, "no new fireNotify");
});

test("usedKeys is capped at 200 entries; the oldest fall off", async () => {
  let es = { suggest: { usedKeys: Array.from({ length: 200 }, (_, i) => `old-${i}`) } };
  const sug = makeDedupeSug({ engineState: { load: async () => es, save: async (p) => { es = p; } } });
  await sug.processFinding({ id: "rec:new", sourceKind: "fact-anomaly", text: "x", refs: [] }, { coldStart: false, tier: "medium" });
  const used = es.suggest.usedKeys;
  assert.equal(used.length, 200);
  assert.ok(used.includes("rec:new"));
  assert.ok(!used.includes("old-0")); // the oldest entry fell off
  assert.ok(used.includes("old-1")); // next-oldest survives — only one entry was dropped
});

test("notify: fireNotify carries a distinct, non-global tag per candidate WITHOUT synthesizing a sessionID (defect 2, review fix)", async () => {
  const notified = [];
  const fireNotify = async (args) => notified.push(args);
  const a = makeDedupeSug({ runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "A") }), fireNotify });
  const b = makeDedupeSug({ runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "B") }), fireNotify });
  await a.processFinding({ id: "rec:a", sourceKind: "failure-recurrence", text: "A", refs: [] }, { coldStart: false, tier: "medium" });
  await b.processFinding({ id: "rec:b", sourceKind: "failure-recurrence", text: "B", refs: [] }, { coldStart: false, tier: "medium" });
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
  const notified = [];
  const sug = makeDedupeSug({
    cards: { upsertDecision: async () => ({ changed: true, isNew: false }) }, // upsert of a card already on the board
    runSuggest: async () => ({ text: oneCandidateSuggestText("start-job", "again") }),
    fireNotify: async (args) => notified.push(args),
  });
  const r = await sug.processFinding({ id: "rec:re", sourceKind: "failure-recurrence", text: "again", refs: [] }, { coldStart: false, tier: "medium" });
  assert.equal(r.surfaced, 1); // the card write still counts as surfaced
  assert.equal(notified.length, 0); // but never re-pushes a not-new card
});

// ---------------------------------------------------------------------------
// BET-1465 review, Block 1 — a gated or failed generation must NOT
// permanently mark the finding used. The §3.3 ephemeral gate refuses by
// RETURNING {ok:false}, not by throwing, so a budget-closed pass looked
// exactly like "the generator ran and said zero candidates" before this fix.
// ---------------------------------------------------------------------------

test("a gated generation ({ok:false}) does not mark the finding used — it's reconsidered next pass", async () => {
  let es = { suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } };
  const engineState = { load: async () => es, save: async (p) => { es = p; } };
  let calls = 0;
  const sug = makeDedupeSug({
    engineState,
    runSuggest: async () => {
      calls += 1;
      // §3.3 ephemeral gate refusal shape (index.mjs gatedSuggestionEphemeral)
      return calls === 1 ? { ok: false, gated: true, error: "budget-closed" } : { text: oneCandidateSuggestText("start-job", "recovered") };
    },
    runWorthiness: async () => ({ text: "0.9" }),
  });
  const finding = { id: "rec:gated", sourceKind: "failure-recurrence", text: "x", refs: [] };
  const r1 = await sug.processFinding(finding, { coldStart: false, tier: "medium" });
  assert.equal(r1.surfaced, 0);
  assert.equal(r1.silent, 0);
  assert.ok(!(es.suggest?.usedKeys || []).includes("rec:gated"), "gated pass must not mark used");

  const r2 = await sug.processFinding(finding, { coldStart: false, tier: "medium" });
  assert.equal(calls, 2, "the generator ran again next pass — not permanently suppressed");
  assert.equal(r2.surfaced, 1, "the finding is reconsidered and surfaces once budget frees up");
});

test("a throwing / unparseable generation does not mark the finding used", async () => {
  let es = {};
  const engineState = { load: async () => es, save: async (p) => { es = p; } };
  const throwing = makeDedupeSug({ engineState, runSuggest: async () => { throw new Error("model timeout"); } });
  await throwing.processFinding({ id: "rec:throws", sourceKind: "fact-anomaly", text: "x", refs: [] }, { coldStart: false, tier: "medium" });
  assert.ok(!(es.suggest?.usedKeys || []).includes("rec:throws"));

  let es2 = {};
  const engineState2 = { load: async () => es2, save: async (p) => { es2 = p; } };
  const garbage = makeDedupeSug({ engineState: engineState2, runSuggest: async () => ({ text: "not json at all" }) });
  await garbage.processFinding({ id: "rec:garbage", sourceKind: "fact-anomaly", text: "x", refs: [] }, { coldStart: false, tier: "medium" });
  assert.ok(!(es2.suggest?.usedKeys || []).includes("rec:garbage"));
});

test("a generator that legitimately returns zero candidates (valid empty JSON) IS marked used", async () => {
  let es = {};
  const engineState = { load: async () => es, save: async (p) => { es = p; } };
  const sug = makeDedupeSug({ engineState, runSuggest: async () => ({ text: JSON.stringify({ candidates: [] }) }) });
  await sug.processFinding({ id: "rec:empty", sourceKind: "fact-anomaly", text: "x", refs: [] }, { coldStart: false, tier: "medium" });
  assert.ok((es.suggest?.usedKeys || []).includes("rec:empty"));
});

// ---------------------------------------------------------------------------
// BET-1477 — a byte-identical regeneration of an unchanged candidate is
// "already surfaced, still current" (surfaced), never a suggest.silent
// no-card-path hold, and never a veto→decision verb downgrade.
// ---------------------------------------------------------------------------

// A REAL card manager (createCtoCards) over fake stores — pins the whole
// chain: the BET-1463 byte-identical no-op return in ctoCards.mjs AND the
// BET-1477 branch in ctoSuggest.mjs, not just a fake writer's return shape.
function makeRegenHarness() {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  let cardPayload = { v: 1, cards: [] };
  let engineState = { v: 1, suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } };
  const cards = createCtoCards({
    cardStore: {
      load: async () => cardPayload,
      save: async (p) => { cardPayload = p; },
    },
    ledger: { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows },
    engineState: { load: async () => engineState, save: async (p) => { engineState = p; } },
    now: () => clock.ms,
  });
  const deps = {
    now: () => clock.ms,
    publish: () => {},
    ledger: { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows },
    verdicts: { load: async () => ({ v: 1, entries: Array(VERDICT_MIN).fill({}) }), save: async () => {} },
    engineState: { load: async () => engineState, save: async (p) => { engineState = p; } },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => [], load: async () => null },
    configGet: async () => ({ ctoTier: "medium" }),
    cards,
    runWorthiness: async () => ({ text: "0.6" }),
    senderReliability: async () => 1.0,
    fireNotify: async () => {},
  };
  return {
    clock,
    ledgerRows,
    cards: () => cardPayload,
    resetDedupe() { engineState = { v: 1, suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } }; }, // simulates usedKeys-cap churn / engine-state reset
    deps,
  };
}

test("BET-1477: a byte-identical decision regeneration counts as surfaced, not silent (no-card-path)", async () => {
  const h = makeRegenHarness();
  const sug = createCtoSuggest({
    ...h.deps,
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "config-change", finding: { text: "Tighten the cache TTL", refs: ["c1"] }, options: [{ label: "Apply", action: { type: "config-change", payload: {} } }] }] }),
    }),
  });
  const finding = { id: "rec:regen-d", sourceKind: "fact-anomaly", text: "Tighten the cache TTL", refs: ["c1"] };

  const r1 = await sug.processFinding(finding, { coldStart: false, tier: "medium" });
  assert.equal(r1.surfaced, 1);
  assert.equal(r1.silent, 0);
  const firstWriteAt = h.cards().cards[0].updatedAt;
  const presentedRows = h.ledgerRows.filter((r) => r.kind === "suggest.presented").length;

  // Next pass: the dedupe marker was evicted (cap churn / engine-state
  // reset), the generator regenerates the SAME candidate — the card content
  // is byte-identical, only the write timestamp differs (excluded from
  // cardContentEqual). This must count as surfaced, not as a no-card-path
  // hold.
  h.clock.ms += 30 * 60_000;
  h.resetDedupe();
  const r2 = await sug.processFinding(finding, { coldStart: false, tier: "medium" });
  assert.equal(r2.surfaced, 1, "unchanged card is already on the board and current → surfaced");
  assert.equal(r2.silent, 0);
  assert.ok(!h.ledgerRows.some((r) => r.kind === "suggest.silent" && r.reason === "no-card-path"), "no suggest.silent(no-card-path) miscount");
  assert.equal(h.ledgerRows.filter((r) => r.kind === "suggest.presented").length, presentedRows, "no second presented row — no ledger noise");
  assert.equal(h.cards().cards.filter((c) => c.state === "open").length, 1, "never duplicated");
  assert.equal(h.cards().cards[0].updatedAt, firstWriteAt, "byte-identical no-op did not rewrite the card");
});

test("BET-1477: a byte-identical veto regeneration stays the veto card — surfaced, no downgrade", async () => {
  const h = makeRegenHarness();
  const sug = createCtoSuggest({
    ...h.deps,
    trustStore: { load: async () => ({ v: 1, tiers: { "record-decision": "veto-window" } }), save: async () => {} },
    runSuggest: async () => ({
      text: JSON.stringify({ candidates: [{ class: "record-decision", finding: { text: "Adopt a rollback policy", refs: ["c2"] }, options: [{ label: "Go", action: { type: "record-decision", payload: {} } }] }] }),
    }),
  });
  const finding = { id: "rec:regen-v", sourceKind: "fact-anomaly", text: "Adopt a rollback policy", refs: ["c2"] };

  const r1 = await sug.processFinding(finding, { coldStart: false, tier: "medium" });
  assert.equal(r1.surfaced, 1);
  assert.equal(h.cards().cards[0].variant, "veto");

  h.clock.ms += 30 * 60_000;
  h.resetDedupe();
  const r2 = await sug.processFinding(finding, { coldStart: false, tier: "medium" });
  assert.equal(r2.surfaced, 1, "unchanged veto card is already on the board and current → surfaced");
  assert.equal(r2.silent, 0);
  assert.ok(!h.ledgerRows.some((r) => r.kind === "suggest.silent" && r.reason === "no-card-path"), "no suggest.silent(no-card-path) miscount");
  const open = h.cards().cards.filter((c) => c.state === "open");
  assert.equal(open.length, 1, "never duplicated");
  assert.equal(open[0].variant, "veto", "no veto→decision verb downgrade on the no-op path");
  assert.equal(h.ledgerRows.filter((r) => r.kind === "suggest.presented" && r.variant === "decision").length, 0);
  assert.equal(h.ledgerRows.filter((r) => r.kind === "suggest.presented" && r.variant === "veto").length, 1, "exactly one presented row total");
});

test("BET-1477: a thrown, missing, or explicitly-refused (ok:false) decision-card write still holds as suggest.silent(no-card-path)", async () => {
  for (const [label, cardsDep] of [
    ["throw", { upsertDecision: async () => { throw new Error("card store boom"); } }],
    ["missing-method", {}],
    ["ok:false", { upsertDecision: async () => ({ ok: false, changed: false, isNew: false }) }],
  ]) {
    const clock = { ms: 1_000_000 };
    const ledgerRows = [];
    const sug = createCtoSuggest({
      now: () => clock.ms,
      publish: () => {},
      ledger: { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows },
      verdicts: { load: async () => ({ v: 1, entries: Array(VERDICT_MIN).fill({}) }), save: async () => {} },
      engineState: { load: async () => ({ suggest: { thresholds: { p_ask: 0.2, p_act: 0.95 } } }), save: async () => {} },
      digests: { list: async () => [], load: async () => null },
      facts: { list: async () => [], load: async () => null },
      configGet: async () => ({ ctoTier: "medium" }),
      cards: cardsDep,
      runSuggest: async () => ({
        text: JSON.stringify({ candidates: [{ class: "config-change", finding: { text: "x", refs: [] }, options: [{ label: "Apply", action: { type: "config-change", payload: {} } }] }] }),
      }),
      runWorthiness: async () => ({ text: "0.6" }),
      senderReliability: async () => 1.0,
    });
    const r = await sug.processFinding({ id: `rec:fail-${label}`, sourceKind: "fact-anomaly", text: "x", refs: [] }, { coldStart: false, tier: "medium" });
    assert.equal(r.surfaced, 0, `${label}: no surfaced count without a card`);
    assert.equal(r.silent, 1, `${label}: held instead`);
    assert.ok(ledgerRows.some((x) => x.kind === "suggest.silent" && x.reason === "no-card-path"), `${label}: the hold reason is preserved`);
  }
});
