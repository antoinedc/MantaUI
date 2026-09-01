// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// src/server/ctoSessions.test.mjs — BET-1378 ephemeral session runner (§3.1),
// task classes + cascade (§12.3), context budgets, active-set, reaper. Pure
// logic only — injected oc/engineState, no live tmux/opencode/network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_CLASSES,
  TIER_TO_ROUTER_TIER,
  getTaskClass,
  escalateTier,
  estimateTokens,
  assembleContext,
  formatFactsBlock,
  factAgeLabel,
  addActive,
  removeActive,
  sessionCreatedMs,
  selectReapCandidates,
  createEphemeralReaper,
  runEphemeral,
} from "./ctoSessions.mjs";

function fakeEngineState(initial = {}) {
  let payload = { ...initial };
  return {
    async load() {
      return payload;
    },
    async save(p) {
      payload = p;
    },
    peek() {
      return payload;
    },
  };
}

// The resolveModel is injected in unit tests; modelID carries the ROUTER tier
// so the cascade's escalation is observable without touching the real router.
function tierModelResolver() {
  return async ({ tier }) => ({ providerID: "p", modelID: TIER_TO_ROUTER_TIER[tier] ?? tier });
}

// ---------------------------------------------------------------------------
// Task classes (§12.3)
// ---------------------------------------------------------------------------

test("getTaskClass returns the literal §12.3 table (tier + budget)", () => {
  assert.equal(getTaskClass("ambient-summarize").tier, "nano");
  assert.equal(getTaskClass("ambient-summarize").contextBudget, 4000);
  assert.equal(getTaskClass("gatekeeper").tier, "nano");
  assert.equal(getTaskClass("worthiness").tier, "nano");
  assert.equal(getTaskClass("digest-compose").tier, "mid");
  assert.equal(getTaskClass("digest-compose").contextBudget, 12000);
  assert.equal(getTaskClass("suggest").tier, "mid");
  assert.equal(getTaskClass("spawn").contextBudget, 8000);
});

test("getTaskClass rejects an unknown class", () => {
  assert.throws(() => getTaskClass("nope"), /unknown task class/);
});

test("escalation: only ambient (nano) classes escalate exactly one tier", () => {
  assert.equal(escalateTier("nano"), "mid");
  assert.equal(escalateTier("mid"), null);
});

test("router-tier mapping never hardcodes a model", () => {
  assert.equal(TIER_TO_ROUTER_TIER.nano, "fast");
  assert.equal(TIER_TO_ROUTER_TIER.mid, "balanced");
});

// ---------------------------------------------------------------------------
// Context budgets (§12.3) — pure truncation
// ---------------------------------------------------------------------------

test("assembleContext drops the LOWEST-priority blocks first", () => {
  const high = { priority: 3, text: "high " + "h".repeat(200) };
  const mid = { priority: 2, text: "mid " + "m".repeat(200) };
  const low = { priority: 1, text: "low " + "l".repeat(40000) }; // huge, lowest priority
  const out = assembleContext([high, mid, low], { taskClass: "ambient-summarize" });
  assert.ok(out.includes("high"));
  assert.ok(out.includes("mid"));
  assert.ok(!out.includes("low"), "lowest-priority block is dropped first");
});

test("assembleContext truncates a lone over-budget highest block rather than drop it", () => {
  const big = "x".repeat(100000); // way over ambient-summarize's 4k-token budget
  const out = assembleContext([{ priority: 3, text: big }], {
    taskClass: "ambient-summarize",
  });
  assert.ok(out.length > 0, "a lone over-budget block is truncated, never dropped");
  assert.ok(out.length <= 4000 * 4, "truncated to the class budget (1 token ≈ 4 chars)");
});

test("assembleContext keeps blocks in priority order when all fit", () => {
  const a = { priority: 1, text: "a" };
  const b = { priority: 5, text: "b" };
  const out = assembleContext([a, b], { taskClass: "spawn" });
  // spawn has an 8k budget — both tiny blocks fit; b (higher priority) is first
  assert.equal(out, "b\n\na");
});

test("estimateTokens is 4 chars per token", () => {
  assert.equal(estimateTokens("1234"), 1);
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("factAgeLabel renders hours/days/months/years", () => {
  const now = Date.UTC(2026, 0, 2, 0, 0, 0);
  assert.equal(factAgeLabel(now - 3 * 3600_000, now), "3h");
  assert.equal(factAgeLabel(now - 2 * 24 * 3600_000, now), "2d");
  assert.equal(factAgeLabel(now - 45 * 24 * 3600_000, now), "1mo");
  assert.equal(factAgeLabel(now - 14 * 30 * 24 * 3600_000, now), "1y");
});

test("formatFactsBlock renders kind + statement + age lines under a header", () => {
  const now = 1000 * 3600_000;
  const block = formatFactsBlock(
    [
      { id: "cto:a", kind: "blocker", statement: "build is red", created: now - 2 * 3600_000, retention: 0.9 },
      { id: "cto:b", kind: "decision", statement: "moved to postgres", created: now - 5 * 3600_000, retention: 0.5 },
    ],
    { nowMs: now },
  );
  assert.ok(block);
  assert.equal(block.priority, 60);
  assert.ok(block.text.includes("[blocker] build is red (2h)"));
  assert.ok(block.text.includes("[decision] moved to postgres (5h)"));
  assert.ok(block.text.startsWith("Relevant project facts"));
});

test("formatFactsBlock sorts by retention desc, caps, and returns null on empty", () => {
  const now = 1000 * 3600_000;
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `cto:${i}`,
    kind: "status",
    statement: `fact ${i}`,
    created: now - 3600_000,
    retention: 20 - i,
  }));
  const block = formatFactsBlock(many, { cap: 15, nowMs: now });
  assert.equal(block.text.split("\n").filter((l) => l.startsWith("- [")).length, 15);
  assert.ok(block.text.indexOf("fact 19") < block.text.indexOf("fact 0"), "highest retention first");
  assert.equal(formatFactsBlock([], { nowMs: now }), null);
  assert.equal(formatFactsBlock([{ id: "x", kind: "status", statement: "", created: now }], { nowMs: now }), null);
});


// ---------------------------------------------------------------------------
// Active-set bookkeeping
// ---------------------------------------------------------------------------

test("addActive/removeActive dedupe and delete", () => {
  let set = addActive([], "s1");
  set = addActive(set, "s1");
  assert.deepEqual(set, ["s1"]);
  set = addActive(set, "s2");
  assert.deepEqual(set, ["s1", "s2"]);
  assert.deepEqual(removeActive(set, "s1"), ["s2"]);
  assert.deepEqual(removeActive(set, "s3"), ["s1", "s2"]);
});

// ---------------------------------------------------------------------------
// runEphemeral — lifecycle + cascade
// ---------------------------------------------------------------------------

test("runEphemeral records the session in the active set BEFORE prompting, then removes it", async () => {
  let activeDuringPrompt = null;
  const engineState = fakeEngineState();
  const oc = {
    async runEphemeralSession({ onCreated }) {
      await onCreated("sid-1");
      activeDuringPrompt = [...engineState.peek().activeEphemeral];
      return { text: "reply", sid: "sid-1" };
    },
  };
  const out = await runEphemeral({
    taskClass: "gatekeeper",
    context: [{ priority: 1, text: "hi" }],
    deps: { oc, engineState, resolveModel: async () => null },
  });
  assert.equal(out.text, "reply");
  assert.deepEqual(activeDuringPrompt, ["sid-1"], "recorded BEFORE prompting");
  assert.deepEqual(
    engineState.peek().activeEphemeral ?? [],
    [],
    "removed from the active set after the run",
  );
});

test("runEphemeral removes the active-set entry on error (finally)", async () => {
  const engineState = fakeEngineState();
  const oc = {
    async runEphemeralSession({ onCreated }) {
      await onCreated("sid-err");
      throw new Error("boom");
    },
  };
  await assert.rejects(
    () =>
      runEphemeral({
        taskClass: "worthiness",
        context: [],
        deps: { oc, engineState, resolveModel: async () => null },
      }),
    /boom/,
  );
  assert.deepEqual(
    engineState.peek().activeEphemeral ?? [],
    [],
    "active-set entry removed even though the session run errored",
  );
});

test("cascade fires ONCE and ONLY on validation failure, escalating nano→mid", async () => {
  const engineState = fakeEngineState();
  const calls = [];
  const oc = {
    async runEphemeralSession({ model, onCreated }) {
      calls.push(model?.modelID);
      await onCreated(`sid-${calls.length}`);
      return { text: `reply-${calls.length}`, sid: `sid-${calls.length}` };
    },
  };
  let validateCalls = 0;
  const validate = async () => {
    validateCalls += 1;
    return validateCalls >= 2; // first attempt fails → cascade once
  };
  const modelFor = tierModelResolver();
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: {
      oc,
      engineState,
      resolveModel: modelFor,
      validate,
    },
  });
  assert.equal(calls.length, 2, "exactly one escalation");
  assert.equal(calls[0], "fast", "first attempt on nano → cheapest fast");
  assert.equal(calls[1], "balanced", "escalated one tier to mid → balanced");
  assert.equal(out.text, "reply-2");
  assert.equal(out.tier, "mid");
});

test("cascade does NOT fire a third attempt when validation keeps failing (at most once)", async () => {
  const engineState = fakeEngineState();
  const calls = [];
  const oc = {
    async runEphemeralSession({ onCreated }) {
      calls.push(true);
      await onCreated(`sid-${calls.length}`);
      return { text: "x", sid: `sid-${calls.length}` };
    },
  };
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, resolveModel: async () => null, validate: async () => false },
  });
  assert.equal(calls.length, 2, "two attempts at most");
  assert.equal(out.text, "x", "returns the last (still low-confidence) result");
});

test("cascade does NOT fire when validation passes on the first attempt", async () => {
  const engineState = fakeEngineState();
  const calls = [];
  const oc = {
    async runEphemeralSession({ onCreated }) {
      calls.push(true);
      await onCreated("sid-1");
      return { text: "fresh", sid: "sid-1" };
    },
  };
  const out = await runEphemeral({
    taskClass: "worthiness",
    context: [],
    deps: { oc, engineState, resolveModel: async () => null, validate: async () => true },
  });
  assert.equal(calls.length, 1);
  assert.equal(out.text, "fresh");
});

test("cascade does NOT escalate a mid-tier class on validation failure", async () => {
  const engineState = fakeEngineState();
  const calls = [];
  const oc = {
    async runEphemeralSession({ onCreated }) {
      calls.push(true);
      await onCreated("sid-1");
      return { text: "x", sid: "sid-1" };
    },
  };
  const modelFor = tierModelResolver();
  const out = await runEphemeral({
    taskClass: "digest-compose", // mid tier — no escalation allowed
    context: [],
    deps: { oc, engineState, resolveModel: modelFor, validate: async () => false },
  });
  assert.equal(calls.length, 1, "mid tier never cascades");
  assert.equal(out.tier, "mid");
});

test("runEphemeral throws when no oc client is injected", async () => {
  await assert.rejects(
    () => runEphemeral({ taskClass: "suggest", context: [], deps: {} }),
    /requires deps\.oc/,
  );
});

// ---------------------------------------------------------------------------
// Reaper (§3.1)
// ---------------------------------------------------------------------------

test("sessionCreatedMs reads opencode session time", () => {
  assert.equal(sessionCreatedMs({ time: { created: 123 } }), 123);
  assert.equal(sessionCreatedMs({ time: { updated: 456 } }), 456);
  assert.equal(sessionCreatedMs({ time: 789 }), 789);
  assert.equal(sessionCreatedMs({ created: 1000 }), 1000);
  assert.equal(sessionCreatedMs({}), null);
});

test("selectReapCandidates: age + active-set + prefix", () => {
  const nowMs = 1_000_000_000_000;
  const old = nowMs - 40 * 60 * 1000; // 40 min
  const sessions = [
    { id: "a", title: "cto:gatekeeper", time: { created: old } },
    { id: "b", title: "cto:worthiness", time: { created: old } }, // in active
    { id: "c", title: "cto:suggest", time: { created: nowMs - 5 * 60 * 1000 } }, // recent
    { id: "d", title: "not-cto", time: { created: old } }, // wrong prefix
    { id: "e", title: "cto:spawn" }, // undatable
  ];
  const doomed = selectReapCandidates({
    sessions,
    activeSet: ["b"],
    nowMs,
    maxAgeMs: 30 * 60 * 1000,
    prefix: "cto:",
  });
  assert.deepEqual(doomed, ["a"]);
});

test("reaper tick lists, selects and deletes only orphans", async () => {
  const nowMs = 1_000_000_000_000;
  const old = nowMs - 40 * 60 * 1000;
  const deleted = [];
  const engineState = fakeEngineState({ activeEphemeral: ["active-session"] });
  const reaper = createEphemeralReaper({
    listSessions: async () => [
      { id: "orphan", title: "cto:gatekeeper", time: { created: old } },
      { id: "active-session", title: "cto:worthiness", time: { created: old } },
      { id: "fresh", title: "cto:suggest", time: { created: nowMs - 5 * 60 * 1000 } },
    ],
    deleteSession: async (id) => {
      deleted.push(id);
    },
    engineState,
    now: () => nowMs,
  });
  const doomed = await reaper.tick();
  assert.deepEqual(doomed, ["orphan"]);
  assert.deepEqual(deleted, ["orphan"]);
});

test("reaper tolerates list/delete/state failures without throwing", async () => {
  const reaper = createEphemeralReaper({
    listSessions: async () => {
      throw new Error("list failed");
    },
    deleteSession: async () => {
      throw new Error("delete failed");
    },
    engineState: fakeEngineState(),
    now: () => Date.now(),
  });
  const doomed = await reaper.tick(); // must not throw
  assert.deepEqual(doomed, []);
});

test("createEphemeralReaper requires listSessions + deleteSession", () => {
  assert.throws(() => createEphemeralReaper(), /requires listSessions/);
});
