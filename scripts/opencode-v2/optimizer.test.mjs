// manta-optimizer V2 plugin: the mask on V2-shaped fixtures + the hook wiring.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta-optimizer");
const tree = await transpileTree(SRC, {
  rewrite: (code) =>
    code.replace(/from\s+["']@opencode\/plugin["']/, `from "${pathToFileURL(join(HERE, "v2-plugin-stub.mjs")).href}"`),
});
after(() => tree.cleanup());
const imp = (rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const mask = await imp("lib/mask.mjs");
const policyLib = await imp("lib/policy.mjs");
const plugin = (await imp("index.mjs")).default;

const BIG = "x".repeat(40_000); // ≈10k tokens
const POLICY = { ...mask.DEFAULT_POLICY, enabled: true, maskAfterUses: 2, protectTailTokens: 1000, batchTokens: 1000 };

/** LOWERED shape — what the `context` hook really delivers (observed on 2.0.30). */
function lowered(n) {
  const msgs = [{ id: "m0", role: "user", content: [{ type: "text", text: "do the thing" }], metadata: {} }];
  for (let i = 0; i < n; i++) {
    msgs.push({ id: `a${i}`, role: "assistant", content: [{ type: "tool-call", id: `c${i}`, name: "shell", input: { n: i }, providerExecuted: false }] });
    msgs.push({ role: "tool", content: [{ type: "tool-result", id: `c${i}`, name: "shell", result: { type: "text", value: BIG }, providerExecuted: false }] });
  }
  return msgs;
}
/** TIMELINE shape — typed session messages with `state.completed.content`. */
function timeline(n) {
  const msgs = [{ id: "m0", type: "user", text: "do the thing", time: { created: 1 } }];
  for (let i = 0; i < n; i++) {
    msgs.push({
      id: `a${i}`,
      type: "assistant",
      time: { created: i, completed: 1000 + i },
      content: [{ type: "tool", id: `c${i}`, name: "shell", state: { status: "completed", input: { n: i }, content: [{ type: "text", text: BIG }], metadata: {} }, time: {} }],
    });
  }
  return msgs;
}
const lowOutputs = (ms) => ms.filter((m) => m.role === "tool").map((m) => m.content[0].result.value);
const tlOutputs = (ms) => ms.filter((m) => m.type === "assistant").map((m) => m.content[0].state.content[0].text);

describe("mask on V2 fixtures", () => {
  test("LOWERED: old tool results become placeholders naming the tool + args; the newest stay; structure is intact", () => {
    const ms = lowered(10);
    const plan = mask.planMask({ messages: ms, policy: POLICY, now: () => 5_000_000, lastActivityMs: 4_999_000 });
    assert.equal(plan.bailed, null);
    assert.equal(plan.apply, true);
    assert.equal(plan.maskedParts, plan.eligible.length);
    assert.ok(plan.maskedTokens >= 10_000 * 5);
    mask.applyMask(plan.eligible, POLICY.placeholderFormat);
    const out = lowOutputs(ms);
    assert.equal(out.length, 10);
    assert.equal(out.filter((o) => o.startsWith(mask.PLACEHOLDER_PREFIX)).length, plan.maskedParts);
    assert.match(out[0], /re-run `shell` with {"n":0} to see this again/);
    assert.equal(out[9], BIG, "the newest result is protected");
    assert.equal(out[8], BIG);
    assert.equal(ms.length, 21, "no message added or removed");
    assert.equal(ms[1].content[0].type, "tool-call", "tool calls untouched (adjacency preserved)");
  });

  test("TIMELINE: state.content text is replaced; status/input/metadata untouched", () => {
    const ms = timeline(10);
    const plan = mask.planMask({ messages: ms, policy: POLICY, now: () => 2_000 });
    assert.equal(plan.apply, true);
    mask.applyMask(plan.eligible, POLICY.placeholderFormat);
    const out = tlOutputs(ms);
    assert.match(out[0], /^\[manta: trimmed/);
    assert.equal(out[9], BIG);
    assert.equal(ms[1].content[0].state.status, "completed");
    assert.deepEqual(ms[1].content[0].state.input, { n: 0 });
    assert.equal(ms[1].content[0].state.content.length, 1);
  });

  test("never masks: skill* tools, already-masked output, non-text results, non-completed tools", () => {
    const ms = lowered(8);
    ms[2].content[0].name = "skill_load";
    ms[4].content[0].result = { type: "json", value: { big: BIG } };
    ms[6].content[0].result.value = `${mask.PLACEHOLDER_PREFIX} — already`;
    const plan = mask.planMask({ messages: ms, policy: POLICY, now: () => 5_000_000, lastActivityMs: 1 });
    mask.applyMask(plan.eligible, POLICY.placeholderFormat);
    assert.equal(ms[2].content[0].result.value, BIG);
    assert.equal(ms[4].content[0].result.type, "json");
    assert.equal(ms[6].content[0].result.value, `${mask.PLACEHOLDER_PREFIX} — already`);

    const tl = timeline(6);
    tl[1].content[0].state = { status: "running", input: {}, metadata: {} };
    const p2 = mask.planMask({ messages: tl, policy: POLICY, now: () => 2_000 });
    assert.ok(!p2.eligible.some((e) => e.input?.n === 0));
  });

  test("protected by the tail budget and by recency: a short history masks nothing", () => {
    const plan = mask.planMask({ messages: lowered(2), policy: POLICY, now: () => 5_000_000 });
    assert.equal(plan.maskedParts, 0);
    assert.equal(plan.apply, false);
  });

  test("batch gate: below batchTokens and a warm cache → observe only; cache dead → apply", () => {
    const policy = { ...POLICY, batchTokens: 10_000_000 };
    const warm = mask.planMask({ messages: timeline(10), policy, now: () => 1_100 }); // last completed 1009, ttl 300000
    assert.equal(warm.apply, false);
    assert.ok(warm.maskedTokens > 0);
    assert.ok(warm.rewarmTokens > 0, "masking into a warm cache costs a re-warm");
    const dead = mask.planMask({ messages: timeline(10), policy, now: () => 1_100 + 301_000 });
    assert.equal(dead.apply, true);
    assert.equal(dead.cacheDead, true);
    assert.equal(dead.rewarmTokens, 0);
  });

  test("bail-outs: too many parts → untouched; transform budget exceeded → untouched", () => {
    const ms = lowered(10);
    const small = mask.planMask({ messages: ms, policy: { ...POLICY, maxTransformParts: 3 }, now: () => 1 });
    assert.equal(small.bailed, "parts");
    assert.equal(small.eligible.length, 0);
    let t = 0;
    const slow = mask.planMask({ messages: lowered(500), policy: { ...POLICY, transformBudgetMs: 5 }, now: () => (t += 10) });
    assert.equal(slow.bailed, "budget");
  });

  test("placeholder rendering is bounded and survives circular input", () => {
    const circ = {};
    circ.self = circ;
    assert.match(mask.renderPlaceholder("t", circ), /with {}/);
    assert.ok(mask.renderPlaceholder("t", { a: "y".repeat(5000) }).length < 400);
    assert.match(mask.renderPlaceholder(undefined, undefined, "[{tool}|{args}]"), /^\[tool\|{}\]$/);
  });
});

describe("constraint pinning helpers", () => {
  test("parse: bullets/numbering stripped, deduped, capped; block rendering", () => {
    assert.deepEqual(policyLib.parseConstraints("- a\n2) b\n\n* A\n"), ["a", "b"]);
    assert.equal(policyLib.parseConstraints(5).length, 0);
    assert.equal(policyLib.renderConstraintBlock([]), "");
    assert.match(policyLib.renderConstraintBlock(["x"]), /preserved verbatim across compaction:\n- x$/);
  });
});

// ------------------------------------------------------------- hook wiring

function harness({ policy, constraints = [], failFetch = false } = {}) {
  const reports = [];
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    asked.push(u);
    if (failFetch) throw new Error("down");
    if (u.includes("/api/optimizer/counterfactual")) {
      reports.push(JSON.parse(init.body));
      return new Response("{}");
    }
    if (u.includes("/api/optimizer/policy")) return new Response(JSON.stringify(policy ?? { enabled: false }));
    if (u.includes("/api/optimizer/constraints")) return new Response(JSON.stringify({ constraints }));
    return new Response("{}", { status: 404 });
  };
  const hooks = {};
  const ctx = { session: { hook: async (kind, fn) => void (hooks[kind] = fn), get: async () => ({ data: { time: { updated: 1 } } }) } };
  return {
    reports,
    asked,
    hooks,
    restore: () => (globalThis.fetch = realFetch),
    ready: plugin.setup(ctx),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("plugin hooks", () => {
  test("registers context + compaction hooks", async () => {
    const h = harness();
    await h.ready;
    assert.deepEqual(Object.keys(h.hooks).sort(), ["compaction", "context"]);
    h.restore();
  });

  test("default (cold policy cache): OBSERVE-ONLY — history untouched, counterfactual reported as observe", async () => {
    const h = harness({ policy: { ...POLICY, enabled: false } });
    await h.ready;
    const ms = lowered(10);
    const before = JSON.stringify(ms);
    // cold cache → DEFAULT_POLICY (enabled:false); thresholds are the defaults, so use a long history
    const big = lowered(40);
    const beforeBig = JSON.stringify(big);
    h.hooks.context({ sessionID: "ses_1", model: { id: "claude-haiku-5-5", providerID: "anthropic" }, messages: big });
    await settle();
    assert.equal(JSON.stringify(big), beforeBig);
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].mode, "observe");
    assert.equal(h.reports[0].applied, false);
    assert.equal(h.reports[0].providerID, "anthropic");
    assert.equal(h.reports[0].modelID, "claude-haiku-5-5");
    assert.equal(h.reports[0].sessionID, "ses_1");
    assert.ok(h.reports[0].maskedTokens > 0);
    assert.equal(before, JSON.stringify(ms));
    h.restore();
  });

  test("policy enabled (after the background refresh landed): the history IS masked and reported as act/applied", async () => {
    const h = harness({ policy: POLICY });
    await h.ready;
    h.hooks.context({ sessionID: "ses_2", messages: lowered(3), model: { id: "m", providerID: "anthropic" } }); // triggers the refresh
    await settle();
    const ms = lowered(10);
    h.hooks.context({ sessionID: "ses_2", messages: ms, model: { id: "claude-opus-4-5", providerID: "anthropic" } });
    await settle();
    assert.ok(lowOutputs(ms).some((o) => o.startsWith(mask.PLACEHOLDER_PREFIX)));
    const last = h.reports.at(-1);
    assert.equal(last.mode, "act");
    assert.equal(last.applied, true);
    assert.equal(last.modelID, "claude-opus-4-5");
    h.restore();
  });

  test("a model without both ids reports no provider/model fields", async () => {
    const h = harness();
    await h.ready;
    h.hooks.context({ sessionID: "s", messages: lowered(40) });
    await settle();
    assert.equal("providerID" in h.reports[0], false);
    assert.equal("modelID" in h.reports[0], false);
    h.restore();
  });

  test("FAIL OPEN: server down / malformed event → no throw, history untouched", async () => {
    const h = harness({ failFetch: true });
    await h.ready;
    const ms = lowered(40);
    const before = JSON.stringify(ms);
    assert.doesNotThrow(() => h.hooks.context({ sessionID: "s", messages: ms }));
    assert.doesNotThrow(() => h.hooks.context({}));
    assert.doesNotThrow(() => h.hooks.context(undefined));
    assert.doesNotThrow(() => h.hooks.compaction({ sessionID: "s" }));
    await settle();
    assert.equal(JSON.stringify(ms), before);
    h.restore();
  });

  test("compaction: constraints are APPENDED to system once the cache is warm; never replace; none → untouched", async () => {
    const h = harness({ constraints: ["Always answer in French"] });
    await h.ready;
    const cold = { sessionID: "s", system: [{ type: "text", text: "orig" }] };
    h.hooks.compaction(cold); // cold → no block, refresh fired
    assert.equal(cold.system.length, 1);
    await settle();
    const warm = { sessionID: "s", system: [{ type: "text", text: "orig" }] };
    h.hooks.compaction(warm);
    assert.equal(warm.system.length, 2);
    assert.equal(warm.system[0].text, "orig");
    assert.match(warm.system[1].text, /Always answer in French/);
    const h2 = harness({ constraints: [] });
    await h2.ready;
    h2.hooks.compaction({ sessionID: "t", system: [] });
    await settle();
    const none = { sessionID: "t", system: [] };
    h2.hooks.compaction(none);
    assert.equal(none.system.length, 0);
    h.restore();
    h2.restore();
  });
});
