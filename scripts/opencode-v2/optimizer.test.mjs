// manta-optimizer V2 plugin: sticky trims, priced per model — the V2 adapter, the
// verbatim planner port (parity with src/shared/maskPlan.mjs on shared fixtures),
// persistence, and the hook wiring. Spec:
// docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md (§4, §8).

import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "./ts-loader.mjs";
import * as shared from "../../src/shared/maskPlan.mjs";
import {
  POLICY,
  PRICE_OPUS,
  PRICE_NO_PREMIUM,
  MODEL,
  MODEL_KEY,
  PROVIDER,
  ratesOf,
  emptyState,
  calls,
  toV1,
  toV2,
  v2Outputs,
  boundaryV1,
} from "../../src/shared/maskPlan.fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "docs", "opencode-plugins-v2", "manta-optimizer");
const tree = await transpileTree(SRC, {
  rewrite: (code) =>
    code.replace(/from\s+["']@opencode\/plugin["']/, `from "${pathToFileURL(join(HERE, "v2-plugin-stub.mjs")).href}"`),
});
after(() => tree.cleanup());
const imp = (rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const mask = await imp("lib/mask.mjs");
const plan = await imp("lib/plan.mjs");
const trims = await imp("lib/trims.mjs");
const policyLib = await imp("lib/policy.mjs");
const pluginDef = (await imp("index.mjs")).default;

const isTrimmed = (o) => o.startsWith("[manta: trimmed");
const NOW = 1_100;

// ---------------------------------------------------------------- pinned facts

// Captured from a REAL opencode 2.0.30 `context` hook (scripted provider driving
// two `shell` calls; ids shortened). This is the ground truth the adapter is
// pinned to: if a future V2 changes the lowered shape, THIS test goes red.
const CAPTURED = [
  { id: "msg_158eb8496001hKFEtY34KvsZmD", role: "user", content: [{ type: "text", text: "Use shell to run echo hi" }], metadata: {} },
  { id: "msg_158eb851b001cKUxb76yEcWuss", role: "assistant", content: [{ type: "tool-call", id: "toolu_2", name: "shell", input: { command: "echo hi 2" }, providerExecuted: false }] },
  { role: "tool", content: [{ type: "tool-result", id: "toolu_2", name: "shell", result: { type: "text", value: "hi 2\n" }, providerExecuted: false }] },
  { id: "msg_158eb86b20013JiFhPV5HVfXZ7", role: "assistant", content: [{ type: "tool-call", id: "toolu_4", name: "shell", input: { command: "echo hi 4" }, providerExecuted: false }] },
  { role: "tool", content: [{ type: "tool-result", id: "toolu_4", name: "shell", result: { type: "text", value: "hi 4\n" }, providerExecuted: false }] },
];

describe("pinned V2 facts (opencode 2.0.30, observed live)", () => {
  test("identity = tool-result.id (== the tool-call id), stable across consecutive requests", () => {
    const first = mask.adaptV2(CAPTURED.slice(0, 3)); // request 2 of the live run
    const second = mask.adaptV2(CAPTURED); // request 3: same prefix + two more messages
    const ids = (a) => a.units.filter((u) => u.kind === "tool").map((u) => u.id);
    assert.deepEqual(ids(first), ["toolu_2"]);
    assert.deepEqual(ids(second), ["toolu_2", "toolu_4"]);
    assert.equal(CAPTURED[1].content[0].id, CAPTURED[2].content[0].id, "call and result share the id");
  });

  test("lastMessageKey: the message id when it has one; the role:'tool' message has none → tool-result call ids", () => {
    const a = mask.adaptV2(CAPTURED);
    assert.equal(a.messageKeyAt(0), "msg_158eb8496001hKFEtY34KvsZmD");
    assert.equal(a.messageKeyAt(1), "msg_158eb851b001cKUxb76yEcWuss");
    assert.equal(a.messageKeyAt(2), "tool:toolu_2");
    assert.equal(a.messageKeyAt(4), "tool:toolu_4");
    // a message with neither id nor tool-results falls back to a content hash
    const h = mask.messageKey({ role: "user", content: [{ type: "text", text: "hello" }] });
    assert.match(h, /^h:[0-9a-f]+$/);
    assert.equal(h, mask.messageKey({ role: "user", content: [{ type: "text", text: "hello" }] }));
    assert.notEqual(h, mask.messageKey({ role: "user", content: [{ type: "text", text: "hellp" }] }));
  });

  test("the boundary recorded on request k is valid for request k+1 (same prefix) and invalid after a revert", () => {
    const prev = plan.boundaryOf(mask.adaptV2(CAPTURED.slice(0, 3)));
    assert.deepEqual(prev, { messageCount: 3, lastMessageKey: "tool:toolu_2" });
    const next = mask.adaptV2(CAPTURED);
    const res = plan.planRequest({
      messages: next, policy: POLICY, authoritative: true, rates: null, state: emptyState({ reqCount: 2 }),
      boundary: prev, model: { providerID: "anthropic", modelID: "m" }, now: () => 1, lastCompletedMs: 0,
    });
    assert.equal(res.boundaryValid, true);
    const reverted = structuredClone(CAPTURED);
    reverted[2].content[0].id = "toolu_other";
    const res2 = plan.planRequest({
      messages: mask.adaptV2(reverted), policy: POLICY, authoritative: true, rates: null, state: emptyState({ reqCount: 2 }),
      boundary: prev, model: { providerID: "anthropic", modelID: "m" }, now: () => 1, lastCompletedMs: 0,
    });
    assert.equal(res2.boundaryValid, false);
  });

  test("V2 carries no completion times: lastCompletedMs is always 0 (never 'known dead')", () => {
    assert.equal(mask.adaptV2(CAPTURED).lastCompletedMs, 0);
  });
});

// -------------------------------------------------------------------- adapter

describe("adaptV2", () => {
  test("units: only plain-text tool results are trimmable; call inputs are counted ONCE (on the tool-call part)", () => {
    const a = mask.adaptV2(toV2(calls(3)));
    const tools = a.units.filter((u) => u.kind === "tool");
    assert.equal(tools.length, 3);
    assert.deepEqual(tools[0].input, { n: 0 }, "the result unit knows the call's input for the placeholder");
    assert.equal(tools[0].inTok, 0);
    const callUnits = a.units.filter((u) => u.kind === "text" && u.input !== undefined);
    assert.equal(callUnits.length, 3);
    assert.equal(a.assistantCount, 3);
    assert.equal(a.partCount, 1 + 3 + 3);
  });

  test("never trimmable: non-text results, id-less results; unknown shapes never throw", () => {
    const ms = toV2(calls(4));
    ms[2].content[0].result = { type: "json", value: { big: "x" } };
    delete ms[4].content[0].id;
    const a = mask.adaptV2(ms);
    assert.deepEqual(a.units.filter((u) => u.kind === "tool").map((u) => u.id), [null, "call_2", "call_3"]); // call_0 (json result) is not a tool unit; call_1 lost its id
    assert.doesNotThrow(() => mask.adaptV2([null, {}, { role: "tool", content: "nope" }, { role: "user" }]));
    assert.equal(mask.adaptV2(undefined).units.length, 0);
  });

  test("applyReal replaces stored text by call id; structure, tool-calls and other results are untouched", () => {
    const ms = toV2(calls(5));
    const a = mask.adaptV2(ms);
    const n = mask.applyReal(a, { call_0: "[manta: trimmed — A]", call_3: "[manta: trimmed — B]", ghost: "x" });
    assert.equal(n, 2);
    const out = v2Outputs(ms);
    assert.equal(out[0], "[manta: trimmed — A]");
    assert.equal(out[3], "[manta: trimmed — B]");
    assert.equal(out[1].length, 2000 * 4);
    assert.equal(ms.length, 11, "no message added or removed");
    assert.equal(ms[1].content[0].type, "tool-call");
    assert.equal(ms[2].content[0].result.type, "text");
  });
});

// --------------------------------------------------------------------- parity

describe("C5 parity: lib/plan.ts is src/shared/maskPlan.mjs", () => {
  test("the port's body is the shared module's body minus adaptV1 (no drift)", () => {
    const sharedSrc = readFileSync(join(HERE, "..", "..", "src", "shared", "maskPlan.mjs"), "utf8");
    let body = sharedSrc.slice(sharedSrc.indexOf("export const PLACEHOLDER_ARGS_MAX"));
    const a0 = body.indexOf("// ---------------------------------------------------------------------------\n// V1 adapter");
    const a1 = body.indexOf("/** The boundary to record AFTER");
    body = body.slice(0, a0) + body.slice(a1);
    const port = readFileSync(join(SRC, "lib", "plan.ts"), "utf8");
    assert.ok(port.endsWith(body), "lib/plan.ts must end with the shared module's body (adaptV1 omitted)");
  });

  const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === "ref" ? undefined : v)));

  test("resolveRates agrees", () => {
    for (const [rec, pt, o] of [
      [{ input: 4, cacheRead: 0.2, cacheWrite: 5, tiers: [{ minPromptTokens: 100, cacheRead: 0.3 }] }, 150, {}],
      [{ input: 1, cacheRead: 0.1 }, 0, {}],
      [{ input: 4, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }, 0, { oneHour: true }],
      [{ input: 4, cacheRead: 0.2, cacheWrite: 5 }, 0, { oneHour: true }],
      [{ input: 4, cacheRead: 0.2, context_over_200k: { cacheRead: 1 } }, 200_001, {}],
    ]) {
      assert.deepEqual(plan.resolveRates(rec, pt, o), shared.resolveRates(rec, pt, o));
    }
  });

  test("planRequest agrees with the shared module on a spread of scenarios (same adapted input)", () => {
    const states = [
      emptyState({ reqCount: 3 }),
      emptyState({ reqCount: 3, lastModel: "openai/x" }),
      emptyState({ reqCount: 3, real: { call_1: "[manta: trimmed — a]", call_5: "[manta: trimmed — b]", ghost: "[manta: trimmed]" } }),
      emptyState({ reqCount: 3, nextGrowthAllowedAt: 50, shadow: { call_2: "[manta: trimmed — c]" } }),
    ];
    let checked = 0;
    for (const n of [30, 60, 100]) {
      const ms = toV1(calls(n));
      for (const policy of [POLICY, { ...POLICY, enabled: false }, { ...POLICY, margin: 100 }]) {
        for (const authoritative of [true, false]) {
          for (const rate of [ratesOf(PRICE_OPUS), ratesOf(PRICE_NO_PREMIUM), null]) {
            for (const boundary of [boundaryV1(ms.slice(0, -1)), null, { messageCount: 500, lastMessageKey: "gone" }]) {
              for (const now of [NOW, 1_000 + 400_000]) {
                for (const state of states) {
                  const run = (mod) => {
                    const adapted = shared.adaptV1(ms);
                    return strip(mod.planRequest({
                      messages: adapted, policy, authoritative, rates: rate, state, boundary,
                      model: { providerID: PROVIDER, modelID: MODEL }, now: () => now, lastCompletedMs: adapted.lastCompletedMs,
                    }));
                  };
                  assert.deepEqual(run(plan), run(shared));
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    assert.ok(checked > 1000);
  });

  test("the SAME abstract history plans identically through the V2 adapter and the V1 adapter (V2 never known dead)", () => {
    for (const n of [30, 60, 100]) {
      const list = calls(n);
      const v1 = shared.adaptV1(toV1(list));
      const v2 = mask.adaptV2(toV2(list));
      const prevList = list.slice(0, -1);
      const b1 = boundaryV1(toV1(prevList));
      const b2 = plan.boundaryOf(mask.adaptV2(toV2(prevList)));
      for (const policy of [POLICY, { ...POLICY, enabled: false }]) {
        const common = { policy, authoritative: true, rates: ratesOf(PRICE_OPUS), state: emptyState({ reqCount: 4 }), model: { providerID: PROVIDER, modelID: MODEL }, now: () => NOW, lastCompletedMs: 0 };
        const r1 = shared.planRequest({ ...common, messages: v1, boundary: b1 });
        const r2 = plan.planRequest({ ...common, messages: v2, boundary: b2 });
        for (const k of ["decision", "R", "N", "reason", "applied"]) assert.deepEqual(r2[k], r1[k], `${k} @ n=${n}`);
        // In V2 a tool CALL precedes its result, so T (which starts at the earliest trimmed RESULT) leaves out
        // that one call's input tokens; in V1 call and result are one part. A couple of tokens, nothing more.
        for (const [k, tol] of [["T", 8], ["rewarmTokens", 8], ["shadowRewarmTokens", 8], ["breakEven", 0.001]]) {
          assert.ok(Math.abs(r2[k] - r1[k]) <= tol, `${k} @ n=${n}: ${r2[k]} vs ${r1[k]}`);
        }
        assert.deepEqual(r2.add, r1.add);
        assert.deepEqual({ ...r2.shadow, T: 0 }, { ...r1.shadow, T: 0 });
        assert.ok(Math.abs(r2.shadow.T - r1.shadow.T) <= 8);
        assert.deepEqual(r2.nextState.real, r1.nextState.real);
      }
    }
  });
});

// ----------------------------------------------------------------- persistence

describe("trim persistence (C4)", () => {
  let home;
  beforeEach(() => {
    home = mkdtempSync(join(process.env.MANTA_STATE_HOME, "v2-trims-"));
    process.env.MANTA_STATE_HOME = home;
  });
  const dir = () => join(home, ".manta", "optimizer-trims");

  test("round trip: dir 0700, file 0600, no temp left behind", () => {
    const s = { ...trims.freshState(), real: { c1: "[manta: trimmed — x]" }, reqCount: 7, lastModel: MODEL_KEY };
    assert.equal(trims.saveStateSync("ses_1", s), true);
    assert.equal(statSync(dir()).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir(), "ses_1.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir()), ["ses_1.json"]);
    const back = trims.loadState("ses_1");
    assert.deepEqual(back.real, s.real);
    assert.equal(back.reqCount, 7);
    assert.equal(back.lastModel, MODEL_KEY);
  });

  test("a failed rename keeps the old file and removes the temp (injected: a directory in the way)", () => {
    assert.equal(trims.saveStateSync("ses_2", { ...trims.freshState(), reqCount: 1 }), true);
    rmSync(join(dir(), "ses_2.json"));
    mkdirSync(join(dir(), "ses_2.json"));
    assert.equal(trims.saveStateSync("ses_2", { ...trims.freshState(), reqCount: 2 }), false);
    assert.deepEqual(readdirSync(dir()).filter((f) => f.includes(".tmp-")), []);
  });

  test("oversized (> 4 MB) and corrupt files load as empty; wrong version / junk fields are dropped", () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "big.json"), "x".repeat(trims.MAX_STATE_BYTES + 1));
    writeFileSync(join(dir(), "bad.json"), "{nope");
    writeFileSync(join(dir(), "v9.json"), JSON.stringify({ version: 9, real: { a: "b" } }));
    for (const id of ["big", "bad", "v9", "missing"]) assert.deepEqual(trims.loadState(id).real, {});
    const s = trims.sanitizeState({ version: 1, real: { ok: "t", num: 5, __proto__x: "y" }, shadow: [], reqCount: -3, lastModel: 5 });
    assert.deepEqual(s.real, { ok: "t", __proto__x: "y" });
    assert.equal(s.reqCount, 0);
    assert.equal(s.lastModel, null);
  });

  test("sessionID validation rejects path traversal", () => {
    for (const bad of ["../x", "a/b", "", "a".repeat(129), "sp ace", "ses.json"]) assert.equal(trims.SESSION_ID_RE.test(bad), false, bad);
    for (const good of ["ses_ea7147b96ffec5YpO5LDN5A04J", "a-b_C", "x".repeat(128)]) assert.equal(trims.SESSION_ID_RE.test(good), true, good);
  });

  test("the store: LRU, hourly touch, hourly 14-day prune", () => {
    const store = trims.createTrimStore();
    mkdirSync(dir(), { recursive: true });
    const old = join(dir(), "old.json");
    writeFileSync(old, "{}");
    const t = (Date.now() - 15 * 24 * 3_600_000) / 1000;
    utimesSync(old, t, t);
    const keep = join(dir(), "keep.json");
    writeFileSync(keep, "{}");
    const stale = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(keep, stale, stale);
    const now = Date.now();
    store.prune(now);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(keep), true);
    const e = store.get("keep");
    store.touch("keep", e, now);
    assert.ok(now - statSync(keep).mtimeMs < 60_000);
    const mtime = statSync(keep).mtimeMs;
    utimesSync(keep, stale, stale);
    store.touch("keep", e, now + 1000); // within the hour: no touch
    assert.ok(Math.abs(statSync(keep).mtimeMs - stale * 1000) < 2000);
    assert.notEqual(mtime, statSync(keep).mtimeMs);
    store.prune(now + 1000); // within the hour: no second prune pass
    for (let i = 0; i < trims.MAX_SESSIONS_IN_MEMORY + 5; i++) store.get(`s${i}`);
    assert.ok(store.get("s0").state.reqCount === 0); // evicted → reloaded fresh from "disk"
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

const realFetch = globalThis.fetch;
const savedHome = process.env.MANTA_STATE_HOME;
let home;
let reports;
let asked;
let policies;
let pricesBody;
let constraintsBody;
let clock;
const realNow = Date.now.bind(Date);
const trimsDirNow = () => join(home, ".manta", "optimizer-trims");
const readTrims = (sid) => JSON.parse(readFileSync(join(trimsDirNow(), `${sid}.json`), "utf8"));
const pricesWith = (record, key = MODEL_KEY) => ({ fetchedAt: realNow(), models: { [key]: record } });
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  home = mkdtempSync(join(savedHome, "v2-hooks-"));
  process.env.MANTA_STATE_HOME = home;
  reports = [];
  asked = [];
  policies = {};
  pricesBody = pricesWith(PRICE_OPUS);
  constraintsBody = [];
  clock = { offset: 0 };
  mock.method(Date, "now", () => realNow() + clock.offset);
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("/api/optimizer/counterfactual")) {
      reports.push(JSON.parse(init.body));
      return new Response("{}");
    }
    if (u.includes("/api/optimizer/policy")) {
      const sid = new URL(u).searchParams.get("sessionID") ?? "";
      return policies[sid] ? new Response(JSON.stringify(policies[sid])) : new Response("{}", { status: 503 });
    }
    if (u.includes("/api/optimizer/prices")) return pricesBody ? new Response(JSON.stringify(pricesBody)) : new Response("{}", { status: 503 });
    if (u.includes("/api/optimizer/constraints")) return new Response(JSON.stringify({ constraints: constraintsBody }));
    return new Response("{}", { status: 404 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  process.env.MANTA_STATE_HOME = savedHome;
});

/** A fresh plugin instance (fresh policy/price/trim state = a "restart"). */
async function boot({ location = { directory: "/proj/v2" }, get } = {}) {
  const hooks = {};
  const ctx = {
    location,
    session: {
      hook: async (kind, fn) => void (hooks[kind] = fn),
      get: get ?? (async () => ({ id: "x", location: { directory: "/from/session/get" } })),
    },
  };
  await pluginDef.setup(ctx);
  const run = async (event) => {
    hooks.context(event);
    await settle();
  };
  return { hooks, run };
}
const model = { id: MODEL, providerID: PROVIDER };
const hist = (sid, n, m = model) => ({ sessionID: sid, model: m, messages: toV2(calls(n)) });
const policyOn = { ...POLICY, enabled: true };
const policyOff = { ...POLICY, enabled: false };

describe("plugin hooks", () => {
  test("registers context + compaction hooks", async () => {
    const { hooks } = await boot();
    assert.deepEqual(Object.keys(hooks).sort(), ["compaction", "context"]);
  });

  test("a cold session: untouched, no report; policy fetch carries the directory, prices are fetched", async () => {
    const { run } = await boot();
    const ev = hist("ses_c", 80);
    const before = JSON.stringify(ev.messages);
    await run(ev);
    assert.equal(JSON.stringify(ev.messages), before);
    assert.equal(reports.length, 0);
    const policyReq = asked.find((u) => u.includes("/api/optimizer/policy"));
    assert.equal(new URL(policyReq).searchParams.get("sessionID"), "ses_c");
    assert.equal(new URL(policyReq).searchParams.get("directory"), "/proj/v2");
    assert.ok(asked.some((u) => u.includes("/api/optimizer/prices")));
    assert.equal(existsSync(trimsDirNow()), false);
  });

  test("directory falls back to ctx.session.get(...).location.directory when the plugin context has no location", async () => {
    const { run } = await boot({ location: null });
    await run(hist("ses_d", 5));
    await settle();
    await run(hist("ses_d", 5)); // the lookup landed; the policy is refetched when stale — force that
    clock.offset += 61_000;
    asked.length = 0;
    await run(hist("ses_d", 6));
    const policyReq = asked.find((u) => u.includes("/api/optimizer/policy"));
    assert.equal(new URL(policyReq).searchParams.get("directory"), "/from/session/get");
  });

  test("switch OFF (authoritative): observe-only — the SHADOW map grows, the request is never touched", async () => {
    policies.ses_s = policyOff;
    const { run } = await boot();
    const ev = hist("ses_s", 80);
    const before = JSON.stringify(ev.messages);
    await run(ev);
    await run(ev);
    assert.equal(JSON.stringify(ev.messages), before);
    assert.equal(reports.length, 1);
    const r = reports[0];
    assert.equal(r.v, 3);
    assert.equal(r.sessionID, "ses_s");
    assert.equal(r.providerID, PROVIDER);
    assert.equal(r.modelID, MODEL);
    assert.deepEqual(r.applied, { trimmedTokens: 0, trimmedParts: 0 });
    assert.ok(r.shadow.trimmedTokens > 0);
    assert.equal(r.change, "none");
    assert.equal(r.shadowChange, "grow");
    assert.ok(r.shadowRewarmTokens > 0);
    assert.equal(r.rewarmTokens, 0);
    assert.deepEqual(r.rates, { cacheRead: 0.2, cacheWrite: 5, source: "catalog", fetchedAt: pricesBody.fetchedAt });
    assert.equal(typeof r.ts, "number");
    assert.deepEqual(readTrims("ses_s").real, {});
  });

  test("switch ON: grows once (priced), then replays byte-identical text for every later request", async () => {
    policies.ses_a = policyOn;
    const { run } = await boot();
    await run(hist("ses_a", 80));
    const e2 = hist("ses_a", 80);
    await run(e2);
    const grown = v2Outputs(e2.messages).filter(isTrimmed);
    assert.ok(grown.length > 10);
    assert.equal(reports.at(-1).change, "grow");
    assert.ok(reports.at(-1).rewarmTokens > 0);
    assert.equal(reports.at(-1).applied.trimmedParts, grown.length);
    let prev = v2Outputs(e2.messages);
    for (let n = 81; n <= 83; n++) {
      const e = hist("ses_a", n);
      await run(e);
      const out = v2Outputs(e.messages);
      assert.deepEqual(out.slice(0, prev.length), prev, "the trimmed prefix never changes between growths");
      assert.equal(reports.at(-1).change, "none");
      prev = out;
    }
    assert.equal(statSync(join(trimsDirNow(), "ses_a.json")).mode & 0o777, 0o600);
    const file = readTrims("ses_a");
    assert.equal(file.lastModel, MODEL_KEY);
    assert.equal(Object.keys(file.real).length, grown.length);
  });

  test("V2 is NEVER known dead: an ancient session is still treated as a live cache (short history → no trim)", async () => {
    policies.ses_old = policyOn;
    const { run } = await boot();
    await run(hist("ses_old", 30));
    clock.offset += 10 * 24 * 3_600_000; // days of silence — V2 messages carry no timestamps to prove it
    const ev = hist("ses_old", 30);
    const before = JSON.stringify(ev.messages);
    await run(ev);
    assert.equal(JSON.stringify(ev.messages), before);
  });

  test("model switch is known dead for V2 too: trims right away, nothing re-written", async () => {
    pricesBody = { fetchedAt: realNow(), models: { [MODEL_KEY]: PRICE_OPUS, "openai/gpt-6-sol": PRICE_OPUS } };
    policies.ses_m = policyOn;
    const { run } = await boot();
    await run(hist("ses_m", 30));
    const stay = hist("ses_m", 30);
    await run(stay);
    assert.equal(v2Outputs(stay.messages).some(isTrimmed), false);
    const sw = hist("ses_m", 30, { id: "gpt-6-sol", providerID: "openai" });
    await run(sw);
    assert.ok(v2Outputs(sw.messages).some(isTrimmed));
    const g = reports.find((r) => r.change === "grow");
    assert.equal(g.rewarmTokens, 0);
    assert.equal(g.modelID, "gpt-6-sol");
  });

  test("unpriced model: never trimmed; a model without both ids reports no provider/model", async () => {
    pricesBody = pricesWith(PRICE_OPUS, "anthropic/other");
    policies.ses_u = policyOn;
    const { run } = await boot();
    const ev = hist("ses_u", 80);
    const before = JSON.stringify(ev.messages);
    await run(ev);
    await run(ev);
    assert.equal(JSON.stringify(ev.messages), before);
    assert.equal(reports.length, 0);
    policies.ses_nm = policyOff;
    const noModel = { sessionID: "ses_nm", messages: toV2(calls(80)) };
    await run(noModel);
    await run(noModel);
    assert.equal(reports.length, 0, "no model → unpriced → no shadow growth, nothing to report");
  });

  test("interleaved sessions A,B,A,B keep their own authoritative policies; a new session is provisional and never grows", async () => {
    policies.ses_A = policyOn;
    policies.ses_B = policyOff;
    const { run } = await boot();
    const sentA = [];
    for (let i = 0; i < 6; i++) {
      const a = hist("ses_A", 80 + i);
      await run(a);
      sentA.push(v2Outputs(a.messages));
      const b = hist("ses_B", 80 + i);
      const before = JSON.stringify(b.messages);
      await run(b);
      assert.equal(JSON.stringify(b.messages), before, "B is never trimmed whatever A is doing");
      if (i >= 2) {
        const prev = sentA.at(-2);
        assert.deepEqual(sentA.at(-1).slice(0, prev.length), prev, "A never flips back to untrimmed");
      }
    }
    assert.ok(Object.keys(readTrims("ses_A").real).length > 10);
    assert.deepEqual(readTrims("ses_B").real, {});
    policies.ses_new = policyOn;
    const fresh = hist("ses_new", 80);
    const before = JSON.stringify(fresh.messages);
    await run(fresh);
    assert.equal(JSON.stringify(fresh.messages), before);
    assert.equal(existsSync(join(trimsDirNow(), "ses_new.json")), false);
  });

  test("a CLEAR sends an UNTRIMMED request (plan → commit → apply) and reports change:clear", async () => {
    policies.ses_clr = policyOn;
    const { run } = await boot();
    await run(hist("ses_clr", 80));
    await run(hist("ses_clr", 80));
    assert.ok(Object.keys(readTrims("ses_clr").real).length > 10);
    policies.ses_clr = policyOff;
    clock.offset += 61_000;
    await run(hist("ses_clr", 81)); // stale (enabled) policy: replay; refresh fires
    const ev = hist("ses_clr", 82);
    const before = JSON.stringify(ev.messages);
    await run(ev); // refetched disabled policy is authoritative → clear
    assert.equal(JSON.stringify(ev.messages), before);
    const r = reports.at(-1);
    assert.equal(r.change, "clear");
    assert.ok(r.rewarmTokens > 0);
    assert.deepEqual(r.applied, { trimmedTokens: 0, trimmedParts: 0 });
    assert.deepEqual(readTrims("ses_clr").real, {});
  });

  test("a failed write keeps the previous committed state, reports change:none, sends no new trim", async () => {
    policies.ses_w = policyOn;
    const { run } = await boot();
    await run(hist("ses_w", 80));
    await run(hist("ses_w", 80));
    const nCommitted = Object.keys(readTrims("ses_w").real).length;
    assert.ok(nCommitted > 10);
    policies.ses_w = { ...policyOn, protectTailTokens: 500, maskAfterUses: 0 };
    rmSync(join(trimsDirNow(), "ses_w.json"));
    mkdirSync(join(trimsDirNow(), "ses_w.json"));
    clock.offset += 61_000;
    await run(hist("ses_w", 85));
    reports.length = 0;
    const ev = hist("ses_w", 150);
    await run(ev);
    const r = reports.at(-1);
    assert.equal(r.change, "none");
    assert.equal(r.rewarmTokens, 0);
    assert.equal(v2Outputs(ev.messages).filter(isTrimmed).length, nCommitted);
    assert.equal(r.applied.trimmedParts, nCommitted);
  });

  test("restart: byte-identical replay from the file, and no live-cache growth until a boundary exists", async () => {
    policies.ses_r = policyOn;
    const first = await boot();
    await first.run(hist("ses_r", 80));
    const e2 = hist("ses_r", 80);
    await first.run(e2);
    const sent = v2Outputs(e2.messages);
    const stored = readTrims("ses_r");
    assert.ok(Object.keys(stored.real).length > 10);
    const second = await boot();
    const e3 = hist("ses_r", 80);
    await second.run(e3); // provisional + replay
    assert.deepEqual(v2Outputs(e3.messages), sent);
    const e4 = hist("ses_r", 80);
    await second.run(e4);
    assert.deepEqual(v2Outputs(e4.messages), sent);
    assert.deepEqual(readTrims("ses_r").real, stored.real);

    policies.ses_r2 = policyOn;
    mkdirSync(trimsDirNow(), { recursive: true });
    writeFileSync(join(trimsDirNow(), "ses_r2.json"), JSON.stringify(emptyState({ reqCount: 9, lastModel: MODEL_KEY })));
    const third = await boot();
    await third.run(hist("ses_r2", 120));
    assert.deepEqual(readTrims("ses_r2").real, {});
    const e5 = hist("ses_r2", 120);
    await third.run(e5);
    assert.ok(v2Outputs(e5.messages).some(isTrimmed));
  });

  test("bail-outs (too many parts) keep existing replacements", async () => {
    policies.ses_b = { ...policyOn, maxTransformParts: 10 };
    mkdirSync(trimsDirNow(), { recursive: true });
    const real = Object.fromEntries(calls(80).slice(0, 30).map((c) => [c.id, "[manta: trimmed — kept]"]));
    writeFileSync(join(trimsDirNow(), "ses_b.json"), JSON.stringify(emptyState({ real })));
    const { run } = await boot();
    await run(hist("ses_b", 80));
    const ev = hist("ses_b", 80);
    await run(ev);
    assert.equal(v2Outputs(ev.messages).filter((o) => o === "[manta: trimmed — kept]").length, 30);
    assert.equal(reports.at(-1).change, "none");
  });

  test("a sessionID that is not a safe file name is never trimmed and never touches the disk", async () => {
    policies["../x"] = policyOn;
    const { run } = await boot();
    const ev = hist("../x", 80);
    const before = JSON.stringify(ev.messages);
    await run(ev);
    await run(ev);
    assert.equal(JSON.stringify(ev.messages), before);
    assert.equal(existsSync(trimsDirNow()), false);
  });

  test("FAIL OPEN: server down / malformed event → no throw, history untouched", async () => {
    globalThis.fetch = async () => {
      throw new Error("down");
    };
    const { hooks } = await boot();
    const ev = hist("s", 80);
    const before = JSON.stringify(ev.messages);
    assert.doesNotThrow(() => hooks.context(ev));
    assert.doesNotThrow(() => hooks.context({}));
    assert.doesNotThrow(() => hooks.context(undefined));
    assert.doesNotThrow(() => hooks.compaction({ sessionID: "s" }));
    await settle();
    assert.equal(JSON.stringify(ev.messages), before);
  });

  test("compaction: constraints are APPENDED to system once the cache is warm; never replace; none → untouched", async () => {
    constraintsBody = ["Always answer in French"];
    const { hooks } = await boot();
    const cold = { sessionID: "s", system: [{ type: "text", text: "orig" }] };
    hooks.compaction(cold);
    assert.equal(cold.system.length, 1);
    await settle();
    const warm = { sessionID: "s", system: [{ type: "text", text: "orig" }] };
    hooks.compaction(warm);
    assert.equal(warm.system.length, 2);
    assert.equal(warm.system[0].text, "orig");
    assert.match(warm.system[1].text, /Always answer in French/);
    constraintsBody = [];
    const b = await boot();
    b.hooks.compaction({ sessionID: "t", system: [] });
    await settle();
    const none = { sessionID: "t", system: [] };
    b.hooks.compaction(none);
    assert.equal(none.system.length, 0);
  });
});
