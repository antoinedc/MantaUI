// Tests for optimizer/constraints.mjs — the constraint store + pure transcript
// helpers (Optimizer P2.4, BET-1346, Part B). Injected throughout: `load` /
// `save` are in-memory, `now` is a controlled clock. No model calls, no state
// dir. Run via `npm run test:server`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createConstraintStore,
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
