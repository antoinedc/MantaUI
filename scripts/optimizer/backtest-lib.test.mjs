// Tests for the PURE half of the sticky-trims backtest (scripts/optimizer/backtest-lib.mjs).
// No DB, no fs, no network: sessions are synthetic rows in the opencode `message` / `part` shape.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOW,
  MAX_GROWTHS_PER_SESSION,
  buildHistory,
  dollars,
  formatReport,
  hasMissingParts,
  historyStart,
  parseTime,
  priceLookup,
  sentStats,
  simulateSession,
  summarize,
} from "./backtest-lib.mjs";
import { POLICY } from "../../src/shared/maskPlan.fixtures.mjs";

const SID = "ses_bt";
const T0 = Date.UTC(2026, 9, 17, 9, 30, 0);
const WINDOW = { from: Date.UTC(2026, 9, 17, 9, 0, 0), to: Date.UTC(2026, 9, 17, 13, 0, 0) };
const TABLE = { anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } } };
const lookup = priceLookup(TABLE);
// production defaults (maskAfterUses 12, batchTokens 20k, protectTail 40k, margin 1.5)
const policy = { ...POLICY, enabled: true, maskAfterUses: 12, batchTokens: 20_000, protectTailTokens: 40_000 };

/** A synthetic session: a user message, then `n` assistant turns each with one big tool call. */
function session(n, { stepMs = 10_000, outChars = 8_000, recordedPrompt = 0 } = {}) {
  const messages = [{ id: "msg_000", session_id: SID, time_created: T0 - 1000, data: JSON.stringify({ role: "user", time: { created: T0 - 1000 }, model: { providerID: "anthropic", modelID: "claude-opus-5-5" } }) }];
  const parts = [{ id: "prt_000", message_id: "msg_000", data: JSON.stringify({ type: "text", text: "go" }) }];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * stepMs;
    const id = `msg_${String(i + 1).padStart(3, "0")}`;
    messages.push({
      id,
      session_id: SID,
      time_created: t,
      data: JSON.stringify({
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-opus-5-5",
        time: { created: t, completed: t + 2000 },
        tokens: { input: 5, output: 100, cache: { read: recordedPrompt ? recordedPrompt - 1000 : 0, write: recordedPrompt ? 995 : 0 } },
      }),
    });
    parts.push({
      id: `prt_${String(i + 1).padStart(3, "0")}`,
      message_id: id,
      data: JSON.stringify({ type: "tool", callID: `call_${i}`, tool: "bash", state: { status: "completed", input: { n: i }, output: "x".repeat(outChars) } }),
    });
  }
  return buildHistory(messages, parts);
}

describe("buildHistory / hasMissingParts / historyStart", () => {
  test("groups parts under their messages in (time, id) order and adds id / sessionID to info", () => {
    const h = session(3);
    assert.equal(h.messages.length, 4);
    assert.equal(h.messages[1].info.id, "msg_001");
    assert.equal(h.messages[1].info.sessionID, SID);
    assert.equal(h.messages[1].parts[0].callID, "call_0");
    assert.equal(h.orphanParts, 0);
    assert.equal(hasMissingParts(h), false);
  });

  test("missing parts: an orphan part, or a completed assistant turn with output but no parts", () => {
    const orphan = buildHistory([], [{ id: "p", message_id: "nope", data: "{}" }]);
    assert.equal(hasMissingParts(orphan), true);
    const empty = buildHistory([{ id: "m1", session_id: SID, time_created: 1, data: JSON.stringify({ role: "assistant", time: { created: 1, completed: 2 }, tokens: { output: 50 } }) }], []);
    assert.equal(hasMissingParts(empty), true);
    const errored = buildHistory([{ id: "m1", session_id: SID, time_created: 1, data: JSON.stringify({ role: "assistant", error: { name: "x" }, time: { created: 1, completed: 2 }, tokens: { output: 50 } }) }], []);
    assert.equal(hasMissingParts(errored), false);
  });

  test("a completed compaction summary restarts the history at its parent user message", () => {
    const msgs = [
      { info: { id: "u1", role: "user" }, parts: [] },
      { info: { id: "a1", role: "assistant" }, parts: [] },
      { info: { id: "u2", role: "user" }, parts: [] },
      { info: { id: "s1", role: "assistant", summary: true, parentID: "u2", time: { completed: 5 } }, parts: [] },
      { info: { id: "a2", role: "assistant" }, parts: [] },
    ];
    assert.equal(historyStart(msgs, 1), 0);
    assert.equal(historyStart(msgs, 4), 2);
    msgs[3].info.time = {}; // an unfinished summary does not restart anything
    assert.equal(historyStart(msgs, 4), 0);
  });
});

describe("sentStats", () => {
  const units = [
    { id: null, kind: "text", text: "aaaa", input: undefined },
    { id: "c1", kind: "tool", text: "x".repeat(40), input: { a: 1 } },
    { id: "c2", kind: "tool", text: "y".repeat(40), input: { a: 2 } },
  ];
  test("counts text + input tokens; applies the sticky map; measures the shared prefix with the previous request", () => {
    const first = sentStats(units, {}, null);
    assert.equal(first.common, 0);
    assert.equal(first.total, 1 + (10 + 2) + (10 + 2)); // text "aaaa" = 1; 40 chars = 10; {"a":1} = 7 chars = 2
  });
  test("prefix: identical until the first changed unit", () => {
    const a = sentStats(units, {}, null);
    const same = sentStats(units, {}, a.sent);
    assert.equal(same.common, same.total);
    const trimmed = sentStats(units, { c1: "[manta: trimmed]" }, a.sent);
    assert.equal(trimmed.common, 1, "only the first unit still matches the previous request");
    assert.ok(trimmed.total < a.total);
    const afterwards = sentStats(units, { c1: "[manta: trimmed]" }, trimmed.sent);
    assert.equal(afterwards.common, afterwards.total, "once trimmed, the prefix is stable again");
  });
});

describe("simulateSession", () => {
  test("sticky trimming beats no trimming on a long session, with a handful of growths", () => {
    const r = simulateSession({ history: session(150), lookupPrice: lookup, policy, window: WINDOW });
    assert.equal(r.requests, 150);
    assert.equal(r.unpricedRequests, 0);
    assert.ok(r.growths >= 1 && r.growthsInWindow <= MAX_GROWTHS_PER_SESSION, `growths ${r.growthsInWindow}`);
    assert.ok(r.sticky.usd < r.none.usd, `${r.sticky.usd} < ${r.none.usd}`);
    assert.ok(r.none.read > r.none.write, "a warm cache is mostly reads");
    assert.ok(r.sticky.read + r.sticky.write < r.none.read + r.none.write, "trimmed prompts are smaller");
  });

  test("a session too short to pay back an Opus re-cache never grows: sticky == no trimming", () => {
    const r = simulateSession({ history: session(25), lookupPrice: lookup, policy, window: WINDOW });
    assert.equal(r.growths, 0);
    assert.equal(r.sticky.usd, r.none.usd);
  });

  test("cache model: a gap longer than the TTL turns the whole prompt into a write", () => {
    const fast = simulateSession({ history: session(5, { stepMs: 10_000 }), lookupPrice: lookup, policy, window: WINDOW });
    const slow = simulateSession({ history: session(5, { stepMs: 600_000 }), lookupPrice: lookup, policy, window: WINDOW });
    assert.ok(fast.none.read > 0);
    assert.equal(slow.none.read, 0);
    const longTtl = simulateSession({ history: session(5, { stepMs: 600_000 }), lookupPrice: lookup, policy, window: WINDOW, ttlMs: 3_600_000 });
    assert.ok(longTtl.none.read > 0);
  });

  test("only requests inside the window are counted; earlier ones warm the sticky map up", () => {
    const h = session(150);
    const lateWindow = { from: T0 + 100 * 10_000, to: WINDOW.to };
    const r = simulateSession({ history: h, lookupPrice: lookup, policy, window: lateWindow });
    assert.equal(r.requests, 50);
    assert.ok(r.growths >= r.growthsInWindow);
  });

  test("an unpriced model is excluded from every column", () => {
    const r = simulateSession({ history: session(30), lookupPrice: () => null, policy, window: WINDOW });
    assert.equal(r.requests, 30);
    assert.equal(r.unpricedRequests, 30);
    assert.equal(r.none.usd + r.recorded.usd + r.sticky.usd, 0);
  });

  test("recorded column prices the ledger's actual cache read/write tokens", () => {
    const r = simulateSession({ history: session(4, { recordedPrompt: 200_000 }), lookupPrice: lookup, policy, window: WINDOW });
    assert.equal(r.recorded.read, 4 * 199_000);
    assert.equal(r.recorded.write, 4 * (995 + 5));
    assert.ok(Math.abs(r.recorded.usd - dollars(r.recorded.read, r.recorded.write, { cacheRead: 0.2, cacheWrite: 5 })) < 1e-9);
  });

  test("the planner runs exactly as in production: no growth with the switch semantics broken by a missing price", () => {
    const noPremium = priceLookup({ anthropic: { models: { "claude-opus-5-5": { cost: { input: 1, cache_read: 0.1 } } } } });
    const r = simulateSession({ history: session(60), lookupPrice: noPremium, policy, window: WINDOW });
    assert.ok(r.growths >= 1, "no write premium → trims pay back quickly");
    assert.ok(r.sticky.usd <= r.none.usd);
  });
});

describe("summarize / formatReport (pass criteria, spec §9)", () => {
  const col = (usd) => ({ usd, read: 1e6, write: 1e5 });
  const sess = (id, none, sticky, growthsInWindow) => ({ id, requests: 10, unpricedRequests: 0, growths: growthsInWindow, growthsInWindow, simPromptTokens: 1e6, recordedPromptTokens: 2e6, none: col(none), recorded: col(none * 2), sticky: col(sticky) });

  test("PASS: cheaper in total and no session grows more than 3 times", () => {
    const s = summarize([sess("a", 10, 6, 3), sess("b", 5, 5.5, 0)]);
    assert.equal(s.cheaper, true);
    assert.equal(s.calm, true);
    assert.equal(s.pass, true);
    assert.equal(s.total.none.usd, 15);
  });
  test("FAIL when not cheaper, or when one session grows 4 times", () => {
    assert.equal(summarize([sess("a", 10, 12, 1)]).pass, false);
    const s = summarize([sess("a", 10, 1, 4)]);
    assert.equal(s.cheaper, true);
    assert.equal(s.calm, false);
    assert.equal(s.pass, false);
  });
  test("the report prints the three columns per session and in total, growths, and the verdict", () => {
    const sessions = [sess("ses_a", 10, 6, 1), sess("ses_b", 5, 5.5, 0)];
    const out = formatReport({ sessions, summary: summarize(sessions), window: WINDOW, skipped: 2, ttlMs: 300_000 });
    assert.match(out, /no trimming\s+recorded\s+sticky \(sim\)\s+growths/);
    assert.match(out, /ses_a\s+10\s+\$10\.00\s+\$20\.00\s+\$6\.00\s+1\/1/);
    assert.match(out, /TOTAL\s+20\s+\$15\.00\s+\$30\.00\s+\$11\.50/);
    assert.match(out, /2 skipped \(missing parts\)/);
    assert.match(out, /RESULT: PASS/);
    assert.match(out, /2026-10-17T09:00:00Z \.\. 2026-10-17T13:00:00Z/);
    const failing = [sess("ses_x", 1, 2, 9)];
    assert.match(formatReport({ sessions: failing, summary: summarize(failing), window: WINDOW, skipped: 0, ttlMs: 300_000 }), /RESULT: FAIL/);
  });
});

describe("helpers", () => {
  test("the default window is 2026-10-17 09:00–13:00 UTC", () => {
    assert.equal(new Date(DEFAULT_WINDOW.from).toISOString(), "2026-10-17T09:00:00.000Z");
    assert.equal(new Date(DEFAULT_WINDOW.to).toISOString(), "2026-10-17T13:00:00.000Z");
    assert.equal(parseTime("2026-10-17T09:00:00Z"), DEFAULT_WINDOW.from);
    assert.throws(() => parseTime("nope"), /not a time/);
  });
  test("priceLookup is exact on (providerID, modelID) for both table shapes — never borrows another provider's price", () => {
    assert.deepEqual(lookup({ providerID: "anthropic", modelID: "claude-opus-5-5" }), { input: 4, output: 20, cache_read: 0.2, cache_write: 5 });
    assert.equal(lookup({ providerID: "openrouter", modelID: "claude-opus-5-5" }), null);
    assert.equal(lookup({ providerID: "anthropic", modelID: "other" }), null);
    assert.equal(lookup({ providerID: "anthropic" }), null);
    const manta = priceLookup({ openai: { "gpt-6-sol": { input: 2, cache_read: 0.2 } } }); // Manta's providers table
    assert.deepEqual(manta({ providerID: "openai", modelID: "gpt-6-sol" }), { input: 2, cache_read: 0.2 });
    assert.equal(priceLookup({ __proto__x: 1 })({ providerID: "__proto__", modelID: "x" }), null);
  });
});
