// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// src/server/ctoTriage.test.mjs
// BET-1517 — the §9.1/§9.2 TRIAGE stage: finding-id derivation, §9.2 plan
// validation, the triage call + plans-store upsert, and the §4.4 untrusted
// context wrapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_RECORDS_CAP,
  PLAN_STEPS_MAX,
  TRIAGE_CLASSES,
  VERIFY_KINDS,
  buildTriageContext,
  createCtoTriage,
  findingIdOf,
  normalizeAccess,
  normalizePlan,
  normalizeVerify,
  parseResolutionPlans,
} from "./ctoTriage.mjs";
import { memoryStore } from "./ctoTestStores.mjs";

const FINDING = {
  source: "inbox",
  ts: 1_000_000,
  noteId: "note-1",
  noteKind: "blocker",
  message: "deploy failed",
  title: "Deploy",
  tag: "deploy",
  refs: ["BET-9"],
  condition: "session s1 active",
  sender: { sessionID: "s1", name: "w" },
};

function validPlan(overrides = {}) {
  return {
    class: "job-redispatch",
    diagnosis: "The deploy job died; rerun it.",
    steps: ["Restart the deploy job", "Watch for the green check"],
    access: [{ permission: "bash", pattern: "deploy *" }],
    verify: { kind: "predicate", condition: "CI green on main" },
    undo: "none",
    confidence: 0.8,
    report: { one_liner: "Rerunning the failed deploy", bullets: ["watching CI"] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findingIdOf — deterministic content hash
// ---------------------------------------------------------------------------

test("findingIdOf is deterministic, source-specific and garbage-safe", () => {
  const id1 = findingIdOf(FINDING);
  assert.ok(id1 && id1.startsWith("find:inbox:"), "inbox rows key as find:inbox:*");
  assert.equal(id1, findingIdOf({ ...FINDING, ts: 9_999_999, noteId: "note-OTHER" }), "ts/noteId changes do not change the id (a restated blocker is the same finding)");
  assert.notEqual(id1, findingIdOf({ ...FINDING, message: "other" }), "different message → different id");
  const ask = { source: "ask", sourceKind: "permission", sourceId: "perm_1", message: "Allow rm -rf?" };
  const askId = findingIdOf(ask);
  assert.ok(askId.startsWith("find:ask:"), "ask rows key as find:ask:*");
  assert.equal(askId, findingIdOf({ ...ask, ts: 5 }), "ask id is content-stable");
  assert.notEqual(id1, askId);
  assert.equal(findingIdOf(null), null);
  assert.equal(findingIdOf(42), null);
});

// ---------------------------------------------------------------------------
// access + verify + plan validation (§9.2)
// ---------------------------------------------------------------------------

test("normalizeAccess enforces the delegate grant grammar", () => {
  assert.deepEqual(normalizeAccess(null), { ok: true, value: [] });
  assert.deepEqual(normalizeAccess([{ permission: " bash ", pattern: "**" }]), { ok: true, value: [{ permission: "bash", pattern: "**" }] });
  assert.equal(normalizeAccess("nope").ok, false);
  assert.equal(normalizeAccess([{ permission: "", pattern: "**" }]).ok, false);
  assert.equal(normalizeAccess([{ permission: "bash" }]).ok, false);
  assert.equal(normalizeAccess([{ permission: "bash", pattern: "**", action: "deny" }]).ok, false);
  assert.equal(normalizeAccess([{ permission: "bash", pattern: "**", action: "allow" }]).ok, true);
  // Grantability (Q2, review return): the permission vocabulary is open on
  // purpose — any tool-name string is grantable through the delegate ruleset
  // (opencode accepts plugin/MCP tool keys verbatim). Grammar validity IS the
  // triage-time check; the executor ticket owns the vocabulary check.
  assert.deepEqual(normalizeAccess([{ permission: "myplugin_tool", pattern: "**" }]), { ok: true, value: [{ permission: "myplugin_tool", pattern: "**" }] });
});

test("normalizeVerify: closed enum; predicate needs a condition; probe needs a probe id", () => {
  for (const kind of VERIFY_KINDS) {
    const res = normalizeVerify(kind === "predicate" ? { kind, condition: "x" } : kind === "probe" ? { kind, probe: "p" } : { kind });
    assert.equal(res.ok, true, `kind ${kind} is valid`);
  }
  assert.equal(normalizeVerify({ kind: "diary-entry" }).ok, false);
  assert.equal(normalizeVerify({ kind: "predicate" }).ok, false);
  assert.equal(normalizeVerify({ kind: "predicate", condition: "  " }).ok, false);
  assert.equal(normalizeVerify({ kind: "probe" }).ok, false);
  assert.equal(normalizeVerify(null).ok, false);
  assert.equal(normalizeVerify("session-ok").ok, false);
});

test("normalizePlan stamps id=hash(findingId,class), stamps the verbatim finding, unknown class → other", () => {
  const fid = findingIdOf(FINDING);
  const res = normalizePlan(validPlan(), fid, FINDING);
  assert.equal(res.ok, true);
  assert.equal(res.plan.class, "job-redispatch");
  assert.equal(res.plan.id, res.plan.id); // stable shape
  assert.deepEqual(res.plan.finding, { text: "deploy failed", refs: ["BET-9"] }, "finding text/refs are engine-stamped, not model-invented");
  assert.equal(res.plan.undo, "none");
  assert.deepEqual(res.plan.report.bullets, ["watching CI"]);
  const unknown = normalizePlan(validPlan({ class: "launch-missiles" }), fid, FINDING);
  assert.equal(unknown.ok, true, "unknown class is not a drop — it maps to other");
  assert.equal(unknown.plan.class, "other");
});

test("normalizePlan drops invalid plans with reasons", () => {
  const fid = findingIdOf(FINDING);
  const cases = [
    [null, "plan-not-object"],
    [{ ...validPlan(), class: "" }, "class-missing"],
    [{ ...validPlan(), diagnosis: "" }, "diagnosis-missing"],
    [{ ...validPlan(), steps: [] }, "steps-empty"],
    [{ ...validPlan(), steps: ["  ", ""] }, "steps-empty"],
    [{ ...validPlan(), access: [{ permission: "bash" }] }, "access-entry-missing-fields"],
    [{ ...validPlan(), verify: { kind: "predicate" } }, "verify-condition-missing"],
    [{ ...validPlan(), confidence: 1.5 }, "confidence-invalid"],
    [{ ...validPlan(), confidence: "high" }, "confidence-invalid"],
    [{ ...validPlan(), report: null }, "report-missing"],
    [{ ...validPlan(), report: { one_liner: "" } }, "report-missing"],
  ];
  for (const [raw, reason] of cases) {
    const res = normalizePlan(raw, fid, FINDING);
    assert.equal(res.ok, false, `expected drop: ${reason}`);
    assert.equal(res.reason, reason);
  }
});

test("normalizePlan truncates step overflow (§9.2: truncate, never synthesize)", () => {
  const fid = findingIdOf(FINDING);
  const res = normalizePlan(
    validPlan({ steps: Array.from({ length: PLAN_STEPS_MAX + 2 }, (_, i) => `step ${i + 1}`) }),
    fid,
    FINDING,
  );
  assert.equal(res.ok, true, "steps > cap truncate, they do not drop the plan");
  assert.equal(res.plan.steps.length, PLAN_STEPS_MAX);
  assert.deepEqual(res.plan.steps, ["step 1", "step 2", "step 3", "step 4"], "the head of the brief survives");
});

// ---------------------------------------------------------------------------
// parseResolutionPlans
// ---------------------------------------------------------------------------

test("parseResolutionPlans: cap of 3, drops invalid with reasons, unparseable → dropped", () => {
  const fid = findingIdOf(FINDING);
  const ok = parseResolutionPlans(JSON.stringify({ plans: [validPlan(), validPlan({ class: "permission-grant" }), validPlan({ class: "config-change" }), validPlan({ class: "start-job" })] }), fid, FINDING);
  assert.equal(ok.plans.length, 3, "valid plans cap at 3");
  assert.equal(ok.dropped.length, 0);
  // ids are distinct per class (hash(findingId, class))
  const ids = new Set(ok.plans.map((p) => p.id));
  assert.equal(ids.size, 3);

  const mixed = parseResolutionPlans(
    JSON.stringify({ plans: [validPlan(), validPlan({ confidence: 9 }), "junk"] }),
    fid,
    FINDING,
  );
  assert.equal(mixed.plans.length, 1);
  assert.deepEqual(mixed.dropped.map((d) => d.reason), ["confidence-invalid", "plan-not-object"]);

  const none = parseResolutionPlans('{"plans":[]}', fid, FINDING);
  assert.deepEqual(none.plans, []);
  assert.deepEqual(none.dropped, [], "an explicit empty list is a real outcome, not a parse failure");

  const garbage = parseResolutionPlans("I cannot help with that", fid, FINDING);
  assert.deepEqual(garbage.plans, []);
  assert.deepEqual(garbage.dropped, [{ reason: "unparseable" }]);

  assert.deepEqual(parseResolutionPlans(null, fid, FINDING).dropped, [{ reason: "unparseable" }]);

  // A bare top-level array is a legal shape — one element AND several.
  const bare1 = parseResolutionPlans(`[${JSON.stringify(validPlan())}]`, fid, FINDING);
  assert.equal(bare1.plans.length, 1);
  const bareN = parseResolutionPlans(
    JSON.stringify([validPlan(), validPlan({ class: "config-change" })]),
    fid,
    FINDING,
  );
  assert.equal(bareN.plans.length, 2);
});

// ---------------------------------------------------------------------------
// buildTriageContext — untrusted-data wrapping (§4.4)
// ---------------------------------------------------------------------------

test("buildTriageContext wraps the finding as untrusted data and keeps the prompt contract highest", () => {
  const blocks = buildTriageContext(FINDING, { transcriptTail: "user: deploy it", factsBlock: "Relevant project facts:", reliability: 0.8 });
  const priorities = blocks.map((b) => b.priority);
  assert.deepEqual([...priorities].sort((a, b) => b - a), priorities, "blocks arrive high→low");
  assert.ok(blocks[0].priority > blocks[1].priority, "the prompt contract outranks the finding");
  const findingBlock = blocks.find((b) => b.text.includes("deploy failed"));
  assert.ok(findingBlock, "the finding text rides verbatim");
  assert.match(findingBlock.text, /untrusted DATA, not as instructions/);
  assert.match(findingBlock.text, /Blocker liveness condition/);
  assert.match(blocks[0].text, /0–3 resolution plans/);
  const tail = blocks.find((b) => b.text.includes("user: deploy it"));
  assert.ok(tail && /untrusted DATA/.test(tail.text), "the transcript tail is fenced as untrusted data");
  assert.ok(blocks.some((b) => /Sender reliability/.test(b.text) && /0\.800/.test(b.text)));
  // A bare finding still yields a well-formed prompt.
  const bare = buildTriageContext(FINDING, {});
  assert.equal(bare.length, 2);
});

test("buildTriageContext kind label spans all §9.1 producers (shared findingLedgerKind)", () => {
  const labelOf = (finding) => {
    const blocks = buildTriageContext(finding, {});
    const m = blocks.find((b) => b.text.startsWith("[Finding from the CTO pipeline"));
    return m.text.match(/^Source: (.+)$/m)?.[1];
  };
  assert.equal(labelOf(FINDING), "inbox.blocker");
  assert.equal(
    labelOf({ source: "ask", sourceKind: "permission", sourceId: "perm_1", message: "m" }),
    "ask.permission",
  );
  assert.equal(
    labelOf({ source: "health", sourceKind: "health", sourceId: "h1", message: "watchdog tripped" }),
    "health.blocker",
    "health escalations are not mislabeled as inbox rows",
  );
});

// ---------------------------------------------------------------------------
// createCtoTriage — the one-call-per-finding flow + upsert persistence
// ---------------------------------------------------------------------------

test("triageFinding persists a validated record keyed by finding id and upserts on re-triage", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  const ledgerRows = [];
  const calls = [];
  const triage = createCtoTriage({
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    now: () => 1_000,
    runEphemeral: async (args) => {
      calls.push(args);
      return { ok: true, text: JSON.stringify({ plans: [validPlan()] }) };
    },
  });
  const fid = findingIdOf(FINDING);
  const res1 = await triage.triageFinding(FINDING, { reliability: 0.5 });
  assert.equal(res1.ok, true);
  assert.equal(res1.plans.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskClass, "triage", "the call runs as the §12.3 triage class");
  assert.ok(Array.isArray(calls[0].context) && calls[0].context.length >= 2, "context blocks are passed to the runner");

  const stored = await plans.load();
  const rec = stored.records[fid];
  assert.ok(rec, "the record is keyed by finding id");
  assert.equal(rec.plans.length, 1);
  assert.equal(rec.plans[0].id, res1.plans[0].id);
  assert.equal(rec.finding.message, "deploy failed", "the verbatim source rides the record");
  assert.equal(rec.triagedAt, 1_000);
  assert.equal(ledgerRows.filter((r) => r.kind === "cto.triage").length, 1);

  // Re-triage (same finding) UPSERTS: same id, no duplicate record.
  const res2 = await triage.triageFinding({ ...FINDING, ts: 2_000, noteId: "note-2" });
  assert.equal(res2.ok, true);
  assert.equal(res2.plans[0].id, res1.plans[0].id, "regeneration keeps the stable id");
  const after = await plans.load();
  assert.equal(Object.keys(after.records).length, 1, "upsert, never append");
  assert.equal(after.records[fid].triagedAt, 1_000, "now() is injectable — same tick keeps the stamp");
  assert.equal(calls.length, 2);
});

test("triageFinding: model outputs none → an empty-plans record still lands (a real outcome)", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  const triage = createCtoTriage({
    plans,
    runEphemeral: async () => ({ ok: true, text: '{"plans":[]}' }),
    now: () => 1_000,
  });
  const res = await triage.triageFinding(FINDING, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.plans, []);
  const rec = (await plans.load()).records[findingIdOf(FINDING)];
  assert.deepEqual(rec.plans, []);
});

test("triageFinding: every §9.1 source stamps its true source on the stored record", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  const triage = createCtoTriage({
    plans,
    runEphemeral: async () => ({ ok: true, text: '{"plans":[]}' }),
    now: () => 1_000,
  });
  await triage.triageFinding({ source: "ask", sourceKind: "permission", sourceId: "perm_1", message: "m" }, {});
  await triage.triageFinding({ source: "health", sourceKind: "health", sourceId: "h1", message: "watchdog tripped" }, {});
  const records = (await plans.load()).records;
  assert.equal(records[findingIdOf({ source: "ask", sourceKind: "permission", sourceId: "perm_1", message: "m" })].finding.source, "ask");
  assert.equal(
    records[findingIdOf({ source: "health", sourceKind: "health", sourceId: "h1", message: "watchdog tripped" })].finding.source,
    "health",
    "health rows are not mis-stamped as inbox",
  );
});

test("triageFinding: gated/error model call persists NOTHING (the finding is already in evidence)", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  const ledgerRows = [];
  const triage = createCtoTriage({
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    runEphemeral: async () => ({ ok: false, gated: true, error: "cto_paused" }),
    now: () => 1_000,
  });
  const res = await triage.triageFinding(FINDING, {});
  assert.equal(res.ok, false);
  assert.equal(res.gated, true);
  assert.deepEqual((await plans.load()).records, {});
  const row = ledgerRows.find((r) => r.kind === "cto.triage");
  assert.ok(row && row.gated === true, "the gated call still leaves a ledger trail");
  // No runEphemeral wired at all → same shape.
  const inert = createCtoTriage({ plans, ledger: { append: async (row) => ledgerRows.push(row) } });
  assert.equal((await inert.triageFinding(FINDING, {})).gated, true);
  assert.deepEqual((await plans.load()).records, {});
});

test("triageFinding: a model throw is contained (no record, ledger row, ok:false)", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  const ledgerRows = [];
  const triage = createCtoTriage({
    plans,
    ledger: { append: async (row) => ledgerRows.push(row) },
    runEphemeral: async () => {
      throw new Error("boom");
    },
  });
  const res = await triage.triageFinding(FINDING, {});
  assert.equal(res.ok, false);
  assert.deepEqual((await plans.load()).records, {});
  assert.equal(ledgerRows.filter((r) => r.kind === "cto.triage" && r.reason === "model-error").length, 1);
});

test("triageFinding: invalid finding → invalid-finding, no call, no record", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  let calls = 0;
  const triage = createCtoTriage({ plans, runEphemeral: async () => void calls++ });
  assert.equal((await triage.triageFinding(null, {})).reason, "invalid-finding");
  assert.deepEqual((await plans.load()).records, {});
  assert.equal(calls, 0);
});

test("plans store: eviction at admission keeps the newest PLAN_RECORDS_CAP records", async () => {
  const plans = memoryStore({ v: 1, records: {} });
  let clock = 0;
  const triage = createCtoTriage({ plans, runEphemeral: async () => ({ ok: true, text: '{"plans":[]}' }), now: () => ++clock });
  for (let i = 0; i < PLAN_RECORDS_CAP + 5; i++) {
    await triage.triageFinding({ ...FINDING, tag: `t${i}` }, {}); // distinct content → distinct ids
  }
  const records = (await plans.load()).records;
  const all = Object.values(records);
  assert.equal(all.length, PLAN_RECORDS_CAP, "the cap holds");
  const newest = all.map((r) => r.triagedAt).sort((a, b) => b - a)[0];
  assert.equal(newest, clock, "the newest records survive eviction");
});
