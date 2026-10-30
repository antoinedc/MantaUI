// Tests for optimizer/constraints.mjs — the constraint store + pure transcript
// helpers (Optimizer P2.4, BET-1346, Part B). Injected throughout: `load` /
// `save` are in-memory, `now` is a controlled clock. No model calls, no state
// dir. Run via `npm run test:server`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createConstraintStore,
  createConstraintExtractor,
  EXTRACT_MAX_TOKENS,
  transcriptText,
  extractionInstruction,
  CONSTRAINT_EXTRACT_PROMPT,
} from "./constraints.mjs";

const NOW = 1_000_000_000_000;

test("transcriptText: flattens user/assistant text parts, skips structural parts", () => {
  const msgs = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "  Use tabs in this repo  " }, { type: "tool", state: {} }],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Got it." }],
    },
    {
      info: { role: "system" }, // not user/assistant — skipped
      parts: [{ type: "text", text: "system note" }],
    },
  ];
  assert.equal(transcriptText(msgs), "user: Use tabs in this repo\n\nassistant: Got it.");
});

test("transcriptText: garbage in → ''", () => {
  assert.equal(transcriptText(null), "");
  assert.equal(transcriptText([]), "");
  assert.equal(transcriptText("nope"), "");
});

test("extractionInstruction: appends the conversation onto the verbatim prompt", () => {
  const inst = extractionInstruction("user: a\n\nassistant: b");
  assert.ok(inst.startsWith(CONSTRAINT_EXTRACT_PROMPT));
  assert.ok(inst.includes("\n\nConversation:\nuser: a\n\nassistant: b"));
});

test("extractionInstruction: empty transcript yields just the prompt", () => {
  assert.equal(extractionInstruction(""), CONSTRAINT_EXTRACT_PROMPT);
  assert.equal(extractionInstruction("   "), CONSTRAINT_EXTRACT_PROMPT);
});

test("store: set/get round-trips and persists", async () => {
  let state = {};
  const store = createConstraintStore({
    load: () => state,
    save: async (s) => { state = JSON.parse(JSON.stringify(s)); },
    now: () => NOW,
  });
  assert.deepEqual(await store.get("s1"), []);
  const entry = await store.set("s1", ["use tabs", "never touch deploy"]);
  assert.deepEqual(entry, { constraints: ["use tabs", "never touch deploy"], at: NOW });
  assert.deepEqual(await store.get("s1"), ["use tabs", "never touch deploy"]);
  assert.equal(state.sessions.s1.at, NOW);
});

test("store: normalizes garbage persisted state", async () => {
  const store = createConstraintStore({
    load: () => ({ sessions: { s1: { constraints: "bogus", at: 1 }, s2: null } }),
    save: async () => {},
  });
  assert.deepEqual(await store.get("s1"), []);
  assert.deepEqual(await store.get("s2"), []);
});

test("store: get on empty/missing sessionID is always []", async () => {
  const store = createConstraintStore({ load: () => ({}), save: async () => {} });
  assert.deepEqual(await store.get(""), []);
  assert.deepEqual(await store.get(undefined), []);
});

// ---------------------------------------------------------------------------
// createConstraintExtractor — Summary model → own model → skip; condensed; strict
// ---------------------------------------------------------------------------

const msg = (role, text, id) => ({ info: { id, role, time: { created: 1, completed: 2 } }, parts: [{ type: "text", text }] });

function extractorRig({ writer = { providerID: "p", modelID: "sum", from: "summary" }, limit = 200_000, reply = "use tabs\nno semicolons", fail = null, existing = ["old rule"] } = {}) {
  const r = { warnings: [], generated: [], listed: 0, stored: { s1: existing } };
  r.run = createConstraintExtractor({
    resolveWriter: async () => writer,
    listMessages: async () => (r.listed++, r.messages ?? [msg("user", "use tabs", "m1")]),
    contextLimitFor: () => limit,
    generate: async (a) => {
      r.generated.push(a);
      if (fail) throw fail;
      return reply;
    },
    store: { set: async (sid, c) => void (r.stored[sid] = c) },
    warn: (m) => r.warnings.push(m),
  });
  return r;
}

test("extractor: asks the resolved writer, strictly, and stores the parsed list", async () => {
  const r = extractorRig();
  await r.run("s1");
  assert.deepEqual(r.generated[0].model, { providerID: "p", modelID: "sum" }, "exactly the model the resolver returned");
  assert.ok(r.generated[0].instruction.startsWith(CONSTRAINT_EXTRACT_PROMPT));
  assert.deepEqual(r.stored.s1, ["use tabs", "no semicolons"]);
});

test("extractor: no writer → nothing is asked and the previous constraints stay", async () => {
  const r = extractorRig({ writer: null });
  await r.run("s1");
  assert.equal(r.generated.length, 0);
  assert.equal(r.listed, 0);
  assert.deepEqual(r.stored.s1, ["old rule"]);
});

test("extractor: a failed call keeps the PREVIOUS constraints (never overwritten with an empty list)", async () => {
  const r = extractorRig({ fail: Object.assign(new Error("rate limited"), { status: 429 }) });
  await r.run("s1");
  assert.deepEqual(r.stored.s1, ["old rule"]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /previous constraints kept/);
});

test("extractor: a reply that came back empty is a real 'no instructions' answer and is stored", async () => {
  const r = extractorRig({ reply: "" });
  await r.run("s1");
  assert.deepEqual(r.stored.s1, []);
});

test("extractor: the input is the condensed transcript, capped at 24k tokens (and by the writer's own window)", async () => {
  const big = Array.from({ length: 400 }, (_, i) => [msg("user", `request ${i} ` + "word ".repeat(400), `u${i}`), msg("assistant", "answer " + "text ".repeat(400), `a${i}`)]).flat();
  const r = extractorRig();
  r.messages = big;
  await r.run("s1");
  const tokens = Math.ceil(r.generated[0].instruction.length / 4);
  assert.ok(tokens <= EXTRACT_MAX_TOKENS + 1_000, `instruction ~${tokens} tokens`);
  assert.ok(big.map((m) => m.parts[0].text).join("").length / 4 > 100_000, "the fixture really is far larger than the cap");
  // a 64k writer's own budget (≈ 38k) is looser than 24k, so 24k binds; a tiny window binds harder
  const small = extractorRig({ limit: 20_000 });
  small.messages = big;
  await small.run("s1");
  assert.ok(Math.ceil(small.generated[0].instruction.length / 4) < 10_000);
});

test("extractor: messages passed in are used as-is (no second read)", async () => {
  const r = extractorRig();
  await r.run("s1", { messages: [msg("user", "from the caller", "m9")] });
  assert.equal(r.listed, 0);
  assert.match(r.generated[0].instruction, /from the caller/);
});

test("extractor: a session id is required; never throws", async () => {
  const r = extractorRig();
  await r.run("");
  assert.equal(r.generated.length, 0);
});
