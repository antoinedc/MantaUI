import { test } from "node:test";
import assert from "node:assert/strict";
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
