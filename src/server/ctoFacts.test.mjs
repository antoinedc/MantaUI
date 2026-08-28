import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACT_VERSION,
  KINDS,
  CAP_ACTIVE,
  HALF_LIVES_POLICY,
  HOUR_MS,
  DAY_MS,
  validateFact,
  newFactId,
  isActiveFact,
  liveHeadOf,
  senderKey,
  senderReliability,
  retentionOf,
  lowestRetention,
  validateProposal,
  buildFactProposal,
  enqueueProposal,
  popProposal,
  markApplied,
  gatekeeperPrecheck,
  buildGatekeeperContext,
  parseGatekeeperDecision,
  validateDecision,
  applyResolution,
  enforceCap,
  matchCheckable,
  recomputeHalfLives,
  median,
  createFactsEngine,
} from "./ctoFacts.mjs";

const H = HOUR_MS;
const D = DAY_MS;

function makeFact(over = {}) {
  return {
    v: FACT_VERSION,
    id: "cto:x",
    kind: "status",
    statement: "shipped things",
    refs: ["s1"],
    confidence: 0.8,
    created: 0,
    last_accessed: 0,
    access_count: 0,
    sender: "cto",
    ...over,
  };
}

function makeEngine(over = {}) {
  const inmemory = new Map();
  const states = { v: 1 };
  const facts = {
    load: async (p) => inmemory.get(`f:${p}`) ?? { v: 1, facts: [] },
    save: async (p, data) => inmemory.set(`f:${p}`, data),
    dir: "facts-dir-placeholder",
  };
  const archive = {
    load: async (p) => inmemory.get(`a:${p}`) ?? { v: 1, entries: [] },
    save: async (p, data) => inmemory.set(`a:${p}`, data),
  };
  const engineState = {
    load: async () => states,
    save: async (s) => {
      Object.keys(states).forEach((k) => delete states[k]);
      Object.assign(states, s);
    },
  };
  const ledger = { append: async () => {} };
  const engine = createFactsEngine({
    facts,
    archive,
    engineState,
    ledger,
    listProjects: async () => ["alpha", "beta"],
    now: () => over.nowMs ?? 1000 * D,
    ...over,
  });
  return { engine, facts, archive, engineState, states, inmemory };
}

test("validateFact accepts a well-formed fact, rejects bad kinds/refs/confidence", () => {
  assert.ok(validateFact(makeFact()));
  assert.ok(!validateFact(makeFact({ kind: "bogus" })));
  assert.ok(!validateFact(makeFact({ refs: [] })));
  assert.ok(!validateFact(makeFact({ refs: [""] })));
  assert.ok(!validateFact(makeFact({ confidence: 1.5 })));
  assert.ok(!validateFact(makeFact({ confidence: -0.1 })));
  assert.ok(!validateFact(makeFact({ statement: "x".repeat(300) })));
});

test("KINDS is the closed set from spec", () => {
  assert.deepEqual([...KINDS].sort(), ["anomaly", "blocker", "decision", "invariant", "status", "theory"]);
});

test("senderKey collapses {sessionID} and string senders to reliability keys", () => {
  assert.equal(senderKey({ sessionID: "abc" }), "session:abc");
  assert.equal(senderKey("cto"), "cto");
  assert.equal(senderKey("user"), "user");
  assert.equal(senderKey(undefined), "unknown");
});

test("senderReliability is the Beta(confirmed+1, rejected+1) mean", () => {
  assert.equal(senderReliability({ confirmed: 0, rejected: 0 }), 0.5);
  assert.equal(senderReliability({ confirmed: 2, rejected: 0 }), 0.75);
  assert.equal(senderReliability({ confirmed: 0, rejected: 4 }), 1 / 6);
});

test("buildFactProposal shapes the registrar payload (project/kind/statement/refs/sender)", () => {
  const { proposal } = buildFactProposal({
    project: "alpha",
    kind: "blocker",
    statement: "build is red after the deploy",
    refs: ["m1", "a1b2c3"],
    valid_until: "2026-12-01T00:00:00Z",
    supersedes: "cto:abc",
    sessionID: "ses_1",
  });
  assert.ok(proposal);
  assert.equal(proposal.project, "alpha");
  assert.equal(proposal.kind, "blocker");
  assert.equal(proposal.statement, "build is red after the deploy");
  assert.deepEqual(proposal.refs, ["m1", "a1b2c3"]);
  assert.equal(proposal.valid_until, "2026-12-01T00:00:00Z");
  assert.equal(proposal.supersedes, "cto:abc");
  assert.deepEqual(proposal.sender, { sessionID: "ses_1" });
  // it produces a proposalId you can enqueue
  assert.ok(typeof proposal.proposalId === "string" && proposal.proposalId.startsWith("cto:"));
});

test("buildFactProposal derives an idempotent proposalId from content + session", () => {
  const base = { project: "alpha", kind: "status", statement: "api is healthy", refs: ["m9"], sessionID: "s1" };
  const a = buildFactProposal(base).proposal.proposalId;
  const b = buildFactProposal(base).proposal.proposalId;
  assert.equal(a, b);
  // changing evidence or session changes the id, so genuine updates are distinct
  assert.notEqual(a, buildFactProposal({ ...base, refs: ["m10"] }).proposal.proposalId);
  assert.notEqual(a, buildFactProposal({ ...base, sessionID: "s2" }).proposal.proposalId);
});

test("buildFactProposal rejects zero refs with an attach-evidence message", () => {
  const res = buildFactProposal({ project: "alpha", kind: "status", statement: "x", refs: [], sessionID: "s1" });
  assert.ok(!res.proposal);
  assert.match(res.error ?? "", /attach evidence/i);
  assert.match(res.error ?? "", /refs/i);
});

test("buildFactProposal trims statement, rejects empty/missing project, bad kind, over-limit", () => {
  assert.ok(buildFactProposal({ kind: "status", statement: "x", refs: ["r"], sessionID: "s" }).error);
  assert.match(
    buildFactProposal({ project: "alpha", kind: "bogus", statement: "x", refs: ["r"] }).error ?? "",
    /kind/,
  );
  assert.ok(buildFactProposal({ project: "alpha", kind: "status", statement: "  ", refs: ["r"] }).error);
  assert.ok(
    buildFactProposal({ project: "alpha", kind: "status", statement: "x".repeat(300), refs: ["r"] }).error,
  );
  // valid stays valid, statement trimmed
  assert.equal(
    buildFactProposal({ project: "alpha", kind: "status", statement: "  ok  ", refs: ["r"] }).proposal.statement,
    "ok",
  );
});

test("buildFactProposal defaults sender to cto when no sessionID is supplied", () => {
  const { proposal } = buildFactProposal({ project: "alpha", kind: "status", statement: "ok", refs: ["r"] });
  assert.equal(proposal.sender, "cto");
});

test("topFacts ranks active facts by retention and applies the K cap", async () => {
  const { engine, facts } = makeEngine({ nowMs: 5 * D });
  const fresh = makeFact({
    id: "cto:fresh",
    kind: "decision",
    statement: "we moved to postgres",
    refs: ["m2"],
    created: 4.9 * D,
    last_accessed: 4.9 * D,
    access_count: 3,
    sender: "cto",
  });
  const stale = makeFact({
    id: "cto:stale",
    kind: "decision",
    statement: "old call path",
    refs: ["m1"],
    created: 0,
    last_accessed: 0,
    access_count: 0,
    sender: "cto",
  });
  await facts.save("alpha", { v: 1, facts: [stale, fresh] });

  const top1 = await engine.topFacts("alpha", { k: 1, nowMs: 5 * D });
  assert.equal(top1.length, 1);
  assert.equal(top1[0].id, "cto:fresh");

  const topAll = await engine.topFacts("alpha", { k: 10, nowMs: 5 * D });
  assert.deepEqual(
    topAll.map((f) => f.id),
    ["cto:fresh", "cto:stale"],
  );

  assert.deepEqual(await engine.topFacts("", { k: 10 }), []);
  assert.deepEqual(await engine.topFacts("nope", { k: 10 }), []);
});

test("retention: decay halves after one half-life", () => {
  const f = makeFact({ kind: "status", created: 0, last_accessed: 0, access_count: 0 });
  const s0 = retentionOf(f, { nowMs: 0 });
  const sAfter = retentionOf(f, { nowMs: HALF_LIVES_POLICY.status * HOUR_MS });
  assert.ok(Math.abs(sAfter - s0 * 0.5) < 1e-9);
});

test("retention: access bumps the access multiplier", () => {
  const a = makeFact({ last_accessed: 0, access_count: 0 });
  const b = makeFact({ last_accessed: 0, access_count: 10 });
  assert.ok(retentionOf(b, { nowMs: 0 }) > retentionOf(a, { nowMs: 0 }));
});

test("retention: unresolved blocker does not decay", () => {
  const block = makeFact({ kind: "blocker", refs: ["m1"], created: 0, last_accessed: 0 });
  const status = makeFact({ kind: "status", created: 0, last_accessed: 0 });
  const far = 10 * D;
  assert.ok(retentionOf(block, { nowMs: far }) > retentionOf(status, { nowMs: far }));
  assert.equal(retentionOf(block, { nowMs: far }), retentionOf(block, { nowMs: 1 }));
});

test("retention: valid_until hard-expires a fact", () => {
  const f = makeFact({ valid_until: 5 * D });
  assert.ok(retentionOf(f, { nowMs: 4 * D }) > 0);
  assert.equal(retentionOf(f, { nowMs: 6 * D }), 0);
});

test("lowestRetention picks the most-disposable fact", () => {
  const oldStatus = makeFact({ kind: "status", created: 0, last_accessed: 0 });
  const freshInvariant = makeFact({ kind: "invariant", created: 0, last_accessed: 30 * D });
  const { fact } = lowestRetention([oldStatus, freshInvariant], { nowMs: 40 * D });
  assert.equal(fact.id, oldStatus.id);
});

test("enqueueProposal adds per-project FIFO and dedupes by proposal id", () => {
  const p1 = { proposalId: "p1", project: "alpha", kind: "status", statement: "a", refs: ["r1"] };
  const p2 = { proposalId: "p2", project: "alpha", kind: "status", statement: "b", refs: ["r2"] };
  let s = {};
  let r = enqueueProposal(s, p1);
  assert.ok(r.added);
  s = r.state;
  r = enqueueProposal(s, p1);
  assert.equal(r.added, false);
  assert.equal(r.reason, "already-queued");
  r = enqueueProposal(s, p2);
  s = r.state;
  const pop1 = popProposal(s, "alpha");
  assert.equal(pop1.proposal.proposalId, "p1");
  assert.equal(popProposal(pop1.state, "alpha").proposal.proposalId, "p2");
});

test("enqueueProposal skips an already-applied id (crash re-resolution no-op)", () => {
  const p = { proposalId: "p1", project: "alpha", kind: "status", statement: "a", refs: ["r1"] };
  const s = markApplied({}, p.proposalId, { action: "add" });
  const r = enqueueProposal(s, p);
  assert.equal(r.added, false);
  assert.equal(r.reason, "already-applied");
});

test("gatekeeperPrecheck rejects zero refs", async () => {
  const r = await gatekeeperPrecheck({ refs: [] }, []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "zero refs");
});

test("gatekeeperPrecheck: supersede must name a live head; else reject with head id", async () => {
  const old1 = makeFact({ id: "a", superseded_by: "b" });
  const b = makeFact({ id: "b" });
  const active = [old1, b];
  const r = await gatekeeperPrecheck({ refs: ["r1"], supersedes: "a" }, active);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "supersede target is not the live head");
  assert.equal(r.targetId, "b");
  const ok = await gatekeeperPrecheck({ refs: ["r1"], supersedes: "b" }, active);
  assert.equal(ok.ok, true);
});

test("gatekeeperPrecheck: trace spot-check rejects unresolved refs", async () => {
  const resolveRef = async (ref) => ref !== "missing";
  const r = await gatekeeperPrecheck({ refs: ["good", "missing"] }, [], { resolveRef });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unresolved ref");
  const ok = await gatekeeperPrecheck({ refs: ["good"] }, [], { resolveRef });
  assert.equal(ok.ok, true);
});

test("validateDecision falls back to a safe add/supersede on a bad model target", () => {
  const active = [makeFact({ id: "head" })];
  const d = validateDecision({ action: "update", targetId: "nope", reason: "" }, active, { supersedes: null });
  assert.equal(d.action, "add");
  const d2 = validateDecision({ action: "merge", targetId: "nope", reason: "" }, active, { supersedes: "head" });
  assert.equal(d2.action, "supersede");
  assert.equal(d2.targetId, "head");
});

test("applyResolution: supersede chains the old fact (never deleted)", () => {
  const head = makeFact({ id: "head", kind: "decision", created: 100 });
  const proposal = { proposalId: "p", project: "alpha", kind: "decision", statement: "new take", refs: ["r9"], supersedes: "head", sender: "cto", created: 200 };
  const res = applyResolution(proposal, { action: "supersede", targetId: "head", reason: "" }, [head], { nowMs: 300 });
  assert.equal(res.action, "supersede");
  assert.ok(res.factId);
  const oldFact = res.facts.find((f) => f.id === "head");
  assert.equal(oldFact.superseded_by, res.factId);
  assert.equal(isActiveFact(oldFact), false);
  assert.equal(res.facts.filter(isActiveFact).length, 1);
});

test("applyResolution: merge unions refs into the target", () => {
  const target = makeFact({ id: "t", refs: ["r1"], confidence: 0.3 });
  const proposal = { proposalId: "p", project: "alpha", kind: "status", statement: "x", refs: ["r2"], confidence: 0.9, sender: "user" };
  const res = applyResolution(proposal, { action: "merge", targetId: "t", reason: "" }, [target], { nowMs: 500 });
  const merged = res.facts.find((f) => f.id === "t");
  assert.deepEqual(merged.refs.slice(), ["r1", "r2"]);
  assert.equal(merged.confidence, 0.9);
});

test("enforceCap displaces the lowest-retention fact over the cap", () => {
  const many = [];
  for (let i = 0; i < CAP_ACTIVE + 3; i++) {
    many.push(makeFact({ id: `f${i}`, created: i, last_accessed: i }));
  }
  const { facts, displaced } = enforceCap(many, { nowMs: 1000 * 100000 });
  assert.equal(facts.filter(isActiveFact).length, CAP_ACTIVE);
  assert.equal(displaced.length, 3);
  assert.ok(displaced.some((d) => d.id === "f0"));
});

test("matchCheckable recognizes branch/ci/issue probes", () => {
  assert.deepEqual(matchCheckable("CI is green on main"), { kind: "ci", surface: "ci", probe: "green" });
  assert.deepEqual(matchCheckable("branch fix/foo merged"), { kind: "branch", surface: "git", probe: "fix/foo" });
  assert.deepEqual(matchCheckable("BET-1234 is open"), { kind: "issue", surface: "issue", probe: "BET-1234" });
  assert.equal(matchCheckable("arbitrary thought"), null);
});

test("median works on even/odd/empty", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("recomputeHalfLives clamps to ±50% of policy and skips kinds without policy", () => {
  const statusHl = HALF_LIVES_POLICY.status;
  const fast = recomputeHalfLives([{ kind: "status", hours: 1 }]);
  assert.equal(fast.status, statusHl * 0.5);
  const slow = recomputeHalfLives([{ kind: "invariant", hours: 99999 }]);
  assert.equal(slow.invariant, HALF_LIVES_POLICY.invariant * 1.5);
  const mid = recomputeHalfLives([{ kind: "status", hours: statusHl * 0.75 }]);
  assert.ok(mid.status >= statusHl * 0.5 && mid.status <= statusHl);
  assert.ok(!("blocker" in recomputeHalfLives([{ kind: "blocker", hours: 5 }])));
});

test("pump adds a proposal through the degraded gatekeeper and persists", async () => {
  const { engine, facts, states } = makeEngine();
  await engine.submitProposal({ proposalId: "pa", project: "alpha", kind: "status", statement: "shipped rollups", refs: ["s1"], sender: "cto" });
  const tally = await engine.pump();
  assert.equal(tally.processed, 1);
  assert.equal(tally.byAction.add, 1);
  const saved = (await facts.load("alpha")).facts.filter(isActiveFact);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].statement, "shipped rollups");
  assert.equal(states.appliedProposals.pa.action, "add");
});

test("pump: positive-flow idempotency — re-pumping an applied id is a no-op", async () => {
  const { engine, facts } = makeEngine();
  await engine.submitProposal({ proposalId: "pb", project: "alpha", kind: "status", statement: "only once", refs: ["s1"] });
  await engine.pump();
  const t2 = await engine.pump();
  assert.equal(t2.processed, 0);
  const saved = (await facts.load("alpha")).facts.filter(isActiveFact);
  assert.equal(saved.length, 1);
});

test("pump: zero-refs proposal is rejected, counts rejected sender", async () => {
  const { engine, states, facts } = makeEngine();
  await engine.submitProposal({ proposalId: "pz", project: "alpha", kind: "status", statement: "no evidence", refs: [], sender: "user" });
  const tally = await engine.pump();
  assert.equal(tally.byAction.reject, 1);
  assert.equal((await facts.load("alpha")).facts.filter(isActiveFact).length, 0);
  assert.equal(states.appliedProposals.pz.action, "reject");
  assert.equal(states.factReliability.user.rejected, 1);
});

test("pump: trace spot-check failure rejects and counts the sender", async () => {
  const { engine, states } = makeEngine({ resolveRef: async (r) => r !== "ghost" });
  await engine.submitProposal({ proposalId: "pt", project: "alpha", kind: "status", statement: "depends on ghost", refs: ["ghost"], sender: { sessionID: "abc" } });
  await engine.pump();
  assert.equal(states.appliedProposals.pt.action, "reject");
  assert.equal(states.factReliability["session:abc"].rejected, 1);
});

test("pump: caps displacement writes to the archive and caps at CAP_ACTIVE", async () => {
  const { engine, facts, archive } = makeEngine();
  for (let i = 0; i < CAP_ACTIVE + 2; i++) {
    await engine.submitProposal({ proposalId: `pc${i}`, project: "alpha", kind: "status", statement: `fact ${i}`, refs: [`r${i}`] });
  }
  await engine.pump();
  const active = (await facts.load("alpha")).facts.filter(isActiveFact);
  assert.equal(active.length, CAP_ACTIVE);
  const arch = (await archive.load("alpha")).entries;
  assert.equal(arch.length, 2);
  assert.ok(arch.every((e) => typeof e.ts === "number"));
});

test("checkable: stamping honors surface-exists; verify supersedes failures", async () => {
  const { engine, facts } = makeEngine({ surfaceExists: async (s) => s === "git", verify: async () => ({ ok: false }) });
  await engine.submitProposal({ proposalId: "ck", project: "alpha", kind: "status", statement: "branch fix/a is merged", refs: ["r1"] });
  await engine.pump();
  const f = (await facts.load("alpha")).facts.find((x) => isActiveFact(x));
  assert.ok(f.checkable, "checkable stamped when the git surface exists");
  const v = await engine.verifyDue();
  assert.equal(v.checked, 1);
  assert.equal(v.superseded, 1);
  const live = (await facts.load("alpha")).facts.filter(isActiveFact);
  assert.ok(live.length >= 1);
});

test("touchFacts bumps last_accessed + access_count on retrieval", async () => {
  const { engine, facts } = makeEngine();
  await engine.submitProposal({ proposalId: "ta", project: "alpha", kind: "status", statement: "touched", refs: ["r1"] });
  await engine.pump();
  const id = (await engine.listFacts("alpha"))[0].id;
  const r = await engine.touchFacts({ project: "alpha", ids: [id] });
  assert.equal(r.touched, 1);
  const f = (await facts.load("alpha")).facts.find((x) => x.id === id);
  assert.equal(f.access_count, 1);
  assert.equal(typeof f.last_accessed, "number");
});

// ---------------------------------------------------------------------------
// §6.4 / §6.6 reliability fixes (reviewer Blocks, attempt 2)
// ---------------------------------------------------------------------------

test("retention honors per-fact sender reliability (reliabilityOf resolver)", () => {
  const reliable = makeFact({ id: "r", last_accessed: 0, access_count: 0 });
  const shaky = makeFact({ id: "s", last_accessed: 0, access_count: 0, sender: "low" });
  const relOf = (f) => (f.id === "s" ? 0.1 : 1);
  const sr = retentionOf(reliable, { nowMs: 0, reliabilityOf: relOf });
  const ss = retentionOf(shaky, { nowMs: 0, reliabilityOf: relOf });
  assert.ok(ss < sr, "low-reliability sender scores lower");
  const { fact } = lowestRetention([reliable, shaky], { nowMs: 0, reliabilityOf: relOf });
  assert.equal(fact.id, "s");
});

test("enforceCap displaces the low-sender-reliability fact under equivalent retention", () => {
  const a = makeFact({ id: "a", created: 0, last_accessed: 0, sender: "high" });
  const b = makeFact({ id: "b", created: 0, last_accessed: 0, sender: "high" });
  const c = makeFact({ id: "c", created: 0, last_accessed: 0, sender: "low" });
  const relOf = (f) => (f.sender === "low" ? 0.1 : 1);
  const { facts, displaced } = enforceCap([a, b, c], { cap: 2, nowMs: 0, reliabilityOf: relOf });
  assert.equal(displaced.length, 1);
  assert.equal(displaced[0].id, "c");
  assert.equal(facts.filter(isActiveFact).length, 2);
});

test("pump feeds per-sender reliability into cap displacement", async () => {
  const { engine, facts, archive, states } = makeEngine();
  states.factReliability = { low: { confirmed: 0, rejected: 9 } };
  for (let i = 0; i < CAP_ACTIVE + 1; i++) {
    const sender = i % 2 === 0 ? "cto" : "low";
    await engine.submitProposal({ proposalId: `pc${i}`, project: "alpha", kind: "status", statement: `fact ${i}`, refs: [`r${i}`], sender });
  }
  await engine.pump();
  const active = (await facts.load("alpha")).facts.filter(isActiveFact);
  assert.equal(active.length, CAP_ACTIVE);
  // Same recency/decay: the poor-reliability "low" sender is preferentially
  // displaced over "cto". No cto-sender fact may be lost this round.
  assert.ok(active.some((f) => f.sender === "cto"), "a reliable sender survived the cap");
  const arch = (await archive.load("alpha")).entries;
  assert.ok(arch.some((e) => e.sender === "low"), "a low-reliability sender was displaced");
});

test("verify-pass confirms the origin sender (§6.6, Block 2)", async () => {
  const { engine, states } = makeEngine({ surfaceExists: async (s) => s === "git", verify: async () => ({ ok: true }) });
  await engine.submitProposal({ proposalId: "cv", project: "alpha", kind: "status", statement: "branch fix/a is merged", refs: ["r1"], sender: "a-sender" });
  await engine.pump();
  const f = (await engine.listFacts("alpha"))[0];
  assert.ok(f.checkable, "stamped because the git surface exists");
  const v = await engine.verifyDue();
  assert.equal(v.checked, 1);
  assert.equal(v.superseded, 0);
  assert.ok((states.factReliability["a-sender"]?.confirmed ?? 0) >= 1, "confirmed incremented on verify-pass");
});
