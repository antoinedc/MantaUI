// BET-1520: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictsStore } from "./ctoStores.mjs";
import {
  collectAnomaliesFromFacts,
  collectFailuresFromDigests,
  collectFindings,
  createCtoSuggest,
  stableSuggestionId,
  sha,
} from "./ctoSuggest.mjs";
import { findingFromSuggestion, findingLedgerKind } from "./ctoCards.mjs";
import { findingIdOf } from "./ctoTriage.mjs";
// BET-1520: the deleted surface-path symbols must be gone from the module
// (see the deleted-symbols test at the bottom).
const suggestModule = await import("./ctoSuggest.mjs");

// ---------------------------------------------------------------------------
// Id stability (§9.1 — the derivation ctoTriage's plan ids re-use)
// ---------------------------------------------------------------------------

test("stableSuggestionId: same (findingId,class) is stable; different inputs differ", () => {
  assert.equal(stableSuggestionId("rec:abc", "start-job"), stableSuggestionId("rec:abc", "start-job"));
  assert.notEqual(stableSuggestionId("rec:abc", "start-job"), stableSuggestionId("rec:abd", "start-job"));
  assert.notEqual(stableSuggestionId("rec:abc", "start-job"), stableSuggestionId("rec:abc", "config-change"));
  assert.match(stableSuggestionId("rec:abc", "config-change"), /^[0-9a-f]{24}$/);
});

// ---------------------------------------------------------------------------
// Findings collection (P2 sources) — unchanged by BET-1520
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

test("collectFindings: combines digest + fact sources", () => {
  const digests = [
    { items: [{ tier: "failure", text: "F" }, { tier: "failure", text: "F" }] },
  ];
  const facts = [{ id: "f", kind: "anomaly", statement: "A" }];
  const out = collectFindings(digests, facts, { nowMs: Date.now() });
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
// The row contract (BET-1520): collector output → pending-findings row
// ---------------------------------------------------------------------------

test("findingFromSuggestion: normalized core + producer-specific fields; garbage → null", () => {
  const ts = 1_000_000;
  const row = findingFromSuggestion(
    { id: "rec:abc", sourceKind: "failure-recurrence", text: "Pipeline red on main", refs: ["c1"] },
    { ts },
  );
  assert.equal(row.source, "suggest");
  assert.equal(row.sourceKind, "failure-recurrence");
  assert.equal(row.sourceId, "rec:abc", "the collector's stable id is the row's sourceId");
  assert.equal(row.ts, ts);
  assert.equal(row.message, "Pipeline red on main");
  assert.equal(row.title, "CTO finding: failure-recurrence");
  assert.deepEqual(row.refs, ["c1"]);
  assert.equal(row.pendingSince, ts);
  assert.equal(row.reason, undefined);
  assert.equal(row.project, undefined);
  // an anomaly's reason and a watcher's project ride alongside
  const withReason = findingFromSuggestion({ id: "anom:x", sourceKind: "fact-anomaly", text: "s", refs: [], reason: "low-confidence fact (0.3)" });
  assert.equal(withReason.reason, "low-confidence fact (0.3)");
  const withProject = findingFromSuggestion({ id: "wh:y", sourceKind: "watcher-hit", text: "s", refs: [], project: "MantaUI" });
  assert.equal(withProject.project, "MantaUI");
  assert.equal(findingFromSuggestion(null), null);
  assert.equal(findingFromSuggestion({ id: "rec:1", sourceKind: "watcher-hit", text: "   " }), null, "no text → no row");
});

test("a suggest row's finding id is content-stable across re-collections (usedKeys + plan upserts converge)", () => {
  const f = { id: "rec:abc", sourceKind: "failure-recurrence", text: "Pipeline red on main", refs: ["c1"] };
  const id1 = findingIdOf(findingFromSuggestion(f, { ts: 1 }));
  const id2 = findingIdOf(findingFromSuggestion(f, { ts: 2 })); // re-collected next pass
  assert.equal(id1, id2);
  assert.match(id1, /^find:suggest:[0-9a-f]{24}$/);
  // different findings → different ids
  const other = findingIdOf(findingFromSuggestion({ ...f, id: "rec:other" }, { ts: 3 }));
  assert.notEqual(id1, other);
});

test("findingLedgerKind: suggest rows fold as suggest.<sourceKind>", () => {
  assert.equal(findingLedgerKind(findingFromSuggestion({ id: "rec:a", sourceKind: "failure-recurrence", text: "x" })), "suggest.failure-recurrence");
  assert.equal(findingLedgerKind(findingFromSuggestion({ id: "wh:b", sourceKind: "watcher-hit-rate", text: "x" })), "suggest.watcher-hit-rate");
  assert.equal(findingLedgerKind({ source: "suggest" }), "suggest.finding", "missing kind falls back, never mislabels as inbox");
});

// ---------------------------------------------------------------------------
// The engine (createCtoSuggest): collect → dedupe → enqueue (BET-1520)
// ---------------------------------------------------------------------------

// The shared harness: memory-backed ledger / engine-state stores + a
// parameterized createCtoSuggest(). Each test overrides only the seams it
// exercises.
function makeSug({
  engineState = null, // full initial engine state
  digests: digestsDep = { list: async () => [], load: async () => null },
  facts: factsDep = { list: async () => [], load: async () => null },
  collectInput = null, // [digestsArr, factsArr] override → skips store reads for collector inputs
  queueFinding = null,
  recordVerdict = null, // default: the B3 route, recorded into verdictEntries
} = {}) {
  const clock = { ms: 1_000_000 };
  const ledgerRows = [];
  const verdictEntries = [];
  const queued = [];
  let es = engineState ?? { v: 1 };

  const ledger = { append: async (r) => ledgerRows.push(r), read: async () => ledgerRows };
  const engineStateDep = { load: async () => es, save: async (p) => { es = p; } };

  const sug = createCtoSuggest({
    now: () => clock.ms,
    publish: () => {},
    ledger,
    engineState: engineStateDep,
    digests: digestsDep,
    facts: factsDep,
    ...(queueFinding
      ? {
          queueFinding: async (row) => {
            await queueFinding(row); // may throw — a failed enqueue is never recorded
            queued.push(row);
          },
        }
      : {}),
    ...(recordVerdict ? { recordVerdict } : {}),
  });

  return {
    sug,
    clock,
    ledgerRows,
    verdictEntries,
    queued,
    getEs: () => es,
    resetEs() {
      es = engineState ?? { v: 1 };
    },
  };
}

// Shared fixture: the same failure text in two retained digests → one
// failure-recurrence finding collected on every pass. Returns the raw list
// (for collectors assertions) and the store dep wired to serve it.
function recurringDigests() {
  const digestList = [
    { generated: 1, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c1"] }] },
    { generated: 2, items: [{ tier: "failure", text: "Pipeline red on main", refs: ["c2"] }] },
  ];
  const digests = { list: async () => ["d1", "d2"], load: async (id) => (id === "d1" ? digestList[0] : digestList[1]) };
  return { digestList, digests };
}

test("runPass: collected findings enqueue on the pending-findings queue in the row contract shape", async () => {
  const { digests } = recurringDigests();
  const h = makeSug({
    digests,
    facts: {
      list: async () => ["p1"],
      load: async () => ({ facts: [{ id: "f1", kind: "anomaly", statement: "Deploys spike on Tuesdays", refs: ["file:1"] }] }),
    },
    queueFinding: () => {},
  });
  const r = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r.findings, 2);
  assert.equal(r.enqueued, 2);
  assert.equal(h.queued.length, 2);
  const rec = h.queued.find((row) => row.sourceKind === "failure-recurrence");
  assert.equal(rec.source, "suggest");
  assert.equal(rec.sourceId, "rec:" + sha("Pipeline red on main"));
  assert.equal(rec.message, "Pipeline red on main");
  assert.deepEqual(rec.refs.sort(), ["c1", "c2"]);
  const anom = h.queued.find((row) => row.sourceKind === "fact-anomaly");
  assert.equal(anom.sourceId, "anom:" + sha("f1|Deploys spike on Tuesdays"));
  assert.equal(anom.reason, "anomaly-kind fact");
  // finding ids derive cleanly from the queued rows (the pipeline's join key)
  assert.match(findingIdOf(rec), /^find:suggest:[0-9a-f]{24}$/);
  // every enqueued key is marked used
  const used = h.getEs().suggest?.usedKeys ?? [];
  assert.equal(used.length, 2);
  assert.ok(used.includes(rec.sourceId));
  assert.ok(used.includes(anom.sourceId));
});

test("dedupe: a second runPass over the same retained sources enqueues nothing (BET-1465 kept)", async () => {
  const { digests } = recurringDigests();
  const h = makeSug({
    digests,
    queueFinding: () => {},
  });
  const r1 = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r1.enqueued, 1);
  h.clock.ms += 30 * 60_000; // the next 30-minute pass over the SAME retained digests
  const r2 = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r2.findings, 1, "the finding is still collected (source retained)");
  assert.equal(r2.enqueued, 0, "but never re-enqueued — no second triage model call");
  assert.equal(h.queued.length, 1);
  assert.equal(h.ledgerRows.length, 0, "the collector writes no ledger rows — evidence rides the drain");
});

test("enqueue-failure: the failed finding is NOT marked used — the next pass retries it; siblings still enqueue", async () => {
  let badCalls = 0;
  const facts = [
    { id: "f-ok", kind: "anomaly", statement: "Ok statement" },
    { id: "f-bad", kind: "anomaly", statement: "Bad statement" },
  ];
  const h = makeSug({
    facts: { list: async () => ["p"], load: async () => ({ facts }) },
    queueFinding: (row) => {
      if (row.message === "Bad statement") {
        badCalls += 1;
        if (badCalls === 1) throw new Error("store down"); // fails once, recovers
      }
    },
  });
  const r1 = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r1.enqueued, 1, "only the healthy enqueue landed");
  const used = h.getEs().suggest?.usedKeys ?? [];
  assert.equal(used.length, 1);
  assert.equal(used[0], "anom:" + sha("f-ok|Ok statement"), "only the healthy finding is consumed");

  const r2 = await h.sug.runPass({ nowMs: h.clock.ms + 1 });
  assert.equal(r2.enqueued, 1, "the failed finding is reconsidered next pass");
  assert.equal(h.queued.filter((row) => row.message === "Bad statement").length, 1, "recorded only on the successful retry");
});

test("unwired queue seam: findings collect, nothing enqueues, nothing marked used (retried later)", async () => {
  const h = makeSug({
    facts: { list: async () => ["p"], load: async () => ({ facts: [{ id: "f", kind: "anomaly", statement: "S" }] }) },
  });
  const r = await h.sug.runPass({ nowMs: h.clock.ms });
  assert.equal(r.findings, 1);
  assert.equal(r.enqueued, 0);
  assert.equal((h.getEs().suggest?.usedKeys ?? []).length, 0, "no consumed key for an unqueued finding");
  // once wired, the same stores pick the finding up
  const wired = createCtoSuggest({
    now: () => h.clock.ms,
    publish: () => {},
    ledger: { append: async () => {}, read: async () => [] },
    engineState: { load: () => h.getEs(), save: async () => {} },
    digests: { list: async () => [], load: async () => null },
    facts: { list: async () => ["p"], load: async () => ({ facts: [{ id: "f", kind: "anomaly", statement: "S" }] }) },
    queueFinding: async () => {},
  });
  const r2 = await wired.runPass({ nowMs: h.clock.ms });
  assert.equal(r2.enqueued, 1);
});

test("usedKeys cap: exactly-at-cap holds every entry; the 201st key evicts the OLDEST and preserves the MRU tail", async () => {
  const mk = (i) => ({ id: `f${i}`, kind: "anomaly", statement: `Statement ${i}` });
  const keyOf = (i) => "anom:" + sha(`f${i}|Statement ${i}`); // the collector's content id
  // 198 seeded keys + 2 enqueued in one pass = exactly 200: NO eviction.
  const h = makeSug({
    engineState: { v: 1, suggest: { usedKeys: Array.from({ length: 198 }, (_, i) => `old-${i}`) } },
    facts: { list: async () => ["p"], load: async () => ({ facts: [mk(200), mk(201)] }) },
    queueFinding: () => {},
  });
  await h.sug.runPass({ nowMs: h.clock.ms });
  let used = h.getEs().suggest.usedKeys;
  assert.equal(used.length, 200, "the cap holds: length never exceeds 200");
  assert.equal(used[0], "old-0", "nothing evicted while filling to exactly the cap");
  assert.equal(used[199], keyOf(201), "the newest key sits at the tail");

  // One past the cap: the 201st distinct key evicts exactly one entry — the
  // OLDEST (front), not the newest. Trailing-slice FIFO is the chosen rule.
  const h2 = makeSug({
    engineState: { v: 1, suggest: { usedKeys: Array.from({ length: 200 }, (_, i) => `old-${i}`) } },
    facts: { list: async () => ["p"], load: async () => ({ facts: [mk(201)] }) },
    queueFinding: () => {},
  });
  await h2.sug.runPass({ nowMs: h.clock.ms });
  used = h2.getEs().suggest.usedKeys;
  assert.equal(used.length, 200);
  assert.ok(!used.includes("old-0"), "the 201st key evicts the OLDEST entry");
  assert.ok(used.includes(keyOf(201)), "the newest key is kept, not dropped");
  assert.equal(used[0], "old-1", "the second-oldest survives at the front");
  assert.deepEqual(used.slice(-2), ["old-199", keyOf(201)], "MRU preserved at the tail");
});

// ---------------------------------------------------------------------------
// §14.3 silence audit — unchanged read surface (rows are written by the gate)
// ---------------------------------------------------------------------------

test("listHeld: returns the gate's silent-log ledger rows", async () => {
  const h = makeSug();
  h.ledgerRows.push({ kind: "suggest.silent", id: "a", score: 0.1, ts: 10 });
  h.ledgerRows.push({ kind: "gate.asked", cardId: "b", ts: 9 });
  h.ledgerRows.push({ kind: "suggest.silent", id: "c", score: 0.2, ts: 11 });
  const held = await h.sug.listHeld();
  assert.equal(held.length, 2);
  assert.deepEqual(held.map((x) => x.id).sort(), ["a", "c"]);
});

test("verdictHeld: routes judgment to the B3 verdict route", async () => {
  const verdictEntries = [];
  const h = makeSug({
    recordVerdict: async ({ subject, verdict, never }) => {
      verdictEntries.push({ subject, verdict, ...(never ? { never: true } : {}) });
      return { ok: true };
    },
  });
  const r = await h.sug.verdictHeld({ id: "rec:abc", verdict: "dismiss" });
  assert.equal(r.ok, true);
  assert.equal(verdictEntries.length, 1);
  assert.equal(verdictEntries[0].subject.type, "suggestion");
  assert.equal(verdictEntries[0].verdict, "dismiss");
});

// Shared verdict-harness scaffold: a fixed ledger carrying one silent-log
// row and a minimal wired engine. `recordVerdict` truthy → the B3 route is
// wired to record into the returned `recorded` array; null → the unwired
// route under test.
function verdictHarness(recordVerdict) {
  const recorded = [];
  const rows = [{ id: "held-9", kind: "suggest.silent", class: "tool-write", ts: 1 }];
  const sug = createCtoSuggest({
    ledger: { append: async () => true, read: async () => rows },
    engineState: { load: async () => ({ v: 1 }), save: async () => {} },
    now: () => 1_000,
    publish: () => {},
    ...(recordVerdict
      ? {
          recordVerdict: async (input) => {
            recorded.push(input);
            return { ok: true };
          },
        }
      : { recordVerdict: null }),
  });
  return { sug, recorded };
}

test("verdictHeld stamps the held row's class onto the subject (§9.5 attribution)", async () => {
  const { sug, recorded } = verdictHarness(true);
  await sug.verdictHeld({ id: "held-9", verdict: "accept" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].subject.class, "tool-write");
});

// BET-1518 — the direct-store fallback is deleted: a fallback-appended
// entry bypasses the verdict sink registry (its counter effects would never
// fold anywhere), so an unwired verdict route degrades instead.
test("verdictHeld without a verdict route degrades — no direct-store append", async () => {
  await verdictsStore.save({ entries: [] });
  const { sug } = verdictHarness(null); // unwired route
  const r = await sug.verdictHeld({ id: "held-9", verdict: "accept" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no-verdict-route/);
  const after = await verdictsStore.load();
  assert.equal((after.entries ?? []).length, 0, "no direct-store append behind the route's back");
});

// ---------------------------------------------------------------------------
// BET-1520 regression: the deleted surface-path symbols are gone. Findings
// surface ONLY through the shared triage → gate pipeline now.
// ---------------------------------------------------------------------------

test("deleted symbols: no generator/worthiness/verb surface on the module or engine", async () => {
  for (const sym of [
    "worthinessProbability",
    "DEFAULT_CLASS_PRIORS",
    "defaultThresholds",
    "parseWorthinessScore",
    "buildSuggestContext",
    "buildWorthinessContext",
    "parseSuggestionText",
    "normalizeCandidates",
    "validateCandidate",
    "validateOption",
    "filterOptionsByData",
    "NOTIFY_RECURRENCE_KINDS",
    "ACTION_TYPES",
    "SUGGEST_VERSION",
    "processFinding",
  ]) {
    assert.equal(sym in suggestModule, false, `${sym} must be deleted from ctoSuggest.mjs`);
  }
  // ... and the surviving engine surface is the new one.
  const eng = suggestModule.createCtoSuggest({});
  assert.equal(typeof eng.runPass, "function");
  assert.equal(typeof eng.listHeld, "function");
  assert.equal(typeof eng.verdictHeld, "function");
  for (const sym of ["processFinding", "getThresholds", "_priors", "_filterOptionsByData"]) {
    assert.equal(sym in eng, false, `${sym} must be deleted from the engine surface`);
  }
});
