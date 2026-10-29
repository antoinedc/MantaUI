import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTurns, truncationOf, annotateView, annotateSingle, isBackgroundResultMessage } from "./transcriptView.mjs";
import { describeTruncation } from "../shared/streamInterpretation.mjs";

// ---- fixtures (ported from chatUtils.test.ts `computeTurnInfo` + the iOS TranscriptParityTests) ----
const user = (id) => ({ info: { role: "user", id }, parts: [] });
const asst = (id, o = {}) => ({
  info: {
    role: "assistant",
    id,
    ...(o.created != null || o.completed != null ? { time: { created: o.created, completed: o.completed } } : {}),
    ...(o.output != null || o.reasoning != null ? { tokens: { input: 0, output: o.output ?? 0, reasoning: o.reasoning ?? 0, cache: { read: 0, write: 0 } } } : {}),
    ...(o.finish ? { finish: o.finish } : {}),
  },
  parts: o.parts ?? [],
});
const bg = (id, o = {}) => asst(id, { ...o, parts: [{ type: "background-result", id: `${id}-p` }] });

test("running + transcript ends in an assistant message → no entry; idle → entry", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 42 })];
  assert.equal(computeTurns(m, { running: true }).size, 0);
  assert.deepEqual(computeTurns(m, { running: false }).get("a1"), { durationMs: 4000, tokens: 42, verbSeedId: "a1" });
});

test("running with the transcript ending in a USER message → the finished turn keeps its footer", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 9 }), user("u2")];
  assert.deepEqual(computeTurns(m, { running: true }).get("a1"), { durationMs: 4000, tokens: 9, verbSeedId: "a1" });
});

test("a multi-step turn: only the final assistant message gets the entry; tokens sum output+reasoning; seed is the FIRST", () => {
  const m = [
    user("u1"),
    asst("a1", { created: 1000, completed: 2000, output: 10, reasoning: 1 }),
    asst("a2", { created: 2000, completed: 3000, output: 20, reasoning: 2 }),
    asst("a3", { created: 3000, completed: 7000, output: 30, reasoning: 3 }),
  ];
  const t = computeTurns(m, { running: false });
  assert.equal(t.has("a1"), false);
  assert.equal(t.has("a2"), false);
  assert.deepEqual(t.get("a3"), { durationMs: 6000, tokens: 66, verbSeedId: "a1" });
  assert.equal(computeTurns(m, { running: true }).size, 0, "the still-streaming final assistant gets no footer");
});

test("zero tokens → null; a zero-length or missing duration → null", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 1000, output: 0, reasoning: 0 })];
  assert.deepEqual(computeTurns(m).get("a1"), { durationMs: null, tokens: null, verbSeedId: "a1" });
  const noTimes = [user("u1"), { info: { role: "assistant", id: "a1", time: { completed: 5 } }, parts: [] }];
  assert.deepEqual(computeTurns(noTimes).get("a1"), { durationMs: null, tokens: null, verbSeedId: "a1" });
});

test("the last assistant message must have time.completed (the iOS rule): an uncompleted one gets no footer", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 2000, output: 5 }), asst("a2", { created: 2000, output: 5 })];
  assert.equal(computeTurns(m, { running: false }).size, 0);
});

test("a null / empty transcript is an empty map", () => {
  assert.equal(computeTurns(null).size, 0);
  assert.equal(computeTurns([]).size, 0);
});

test("a background result starts a turn like a user message and is not part of the turn before it", () => {
  const m = [
    user("u1"),
    asst("a1", { created: 1000, completed: 2000, output: 5 }),
    bg("b1", { created: 50_000, completed: 51_000, output: 1 }),
    asst("a2", { created: 51_000, completed: 54_000, output: 7 }),
  ];
  assert.equal(isBackgroundResultMessage(m[2]), true);
  const t = computeTurns(m);
  // The earlier turn ends at a1 (its duration does not span the idle gap); the background result heads the next.
  assert.deepEqual(t.get("a1"), { durationMs: 1000, tokens: 5, verbSeedId: "a1" });
  assert.deepEqual(t.get("a2"), { durationMs: 3000, tokens: 7, verbSeedId: "a2" });
  assert.equal(t.has("b1"), false);
});

test("two turns: each user message starts its own", () => {
  const m = [user("u1"), asst("a1", { created: 0, completed: 1000, output: 1 }), user("u2"), asst("a2", { created: 2000, completed: 5000, output: 2 })];
  const t = computeTurns(m);
  assert.deepEqual([...t.keys()], ["a1", "a2"]);
});

// ---- truncation ----
const step = (reason) => ({ type: "step-finish", id: "sf", reason });

test("truncation per finish: output cap, context wall, tool cutoff, benign → none", () => {
  assert.equal(truncationOf(asst("a", { finish: "max_tokens" })).kind, "output-cap");
  assert.equal(truncationOf(asst("a", { finish: "length" })).kind, "output-cap");
  assert.equal(truncationOf(asst("a", { finish: "model_context_window_exceeded" })).kind, "context-wall");
  assert.equal(truncationOf(asst("a", { finish: "end_turn" })), null);
  assert.equal(truncationOf(asst("a", {})), null);
  assert.equal(truncationOf(user("u")), null);
});

test("a step-finish reason takes precedence over info.finish; tool-calls + a max_tokens reason is a tool cut-off", () => {
  assert.equal(truncationOf(asst("a", { finish: "tool-calls", parts: [step("max_tokens")] })).kind, "tool-cutoff");
  assert.equal(truncationOf(asst("a", { finish: "end_turn", parts: [step("max_tokens")] })).kind, "output-cap");
  assert.equal(truncationOf(asst("a", { finish: "max_tokens", parts: [step("end_turn")] })), null);
  // The LAST step-finish with a non-empty reason wins; an empty reason is skipped.
  assert.equal(truncationOf(asst("a", { finish: "end_turn", parts: [step("max_tokens"), step("")] })).kind, "output-cap");
});

test("the truncation carries the label AND hint (describeTruncation): the canonical view equals what the live frame sends", () => {
  const view = truncationOf(asst("a", { finish: "max_tokens" }));
  assert.deepEqual(view, { kind: "output-cap", ...describeTruncation("output-cap") });
});

test("annotateView: `view` only where there is something; getMessage-style single gets a truncation, never a turn", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 4, finish: "max_tokens" })];
  const out = annotateView(m, { running: false });
  assert.equal(out[0].view, undefined);
  assert.equal(out[1].view.turn.durationMs, 4000);
  assert.equal(out[1].view.truncation.kind, "output-cap");
  const single = annotateSingle(m[1]);
  assert.equal(single.view.turn, undefined);
  assert.equal(single.view.truncation.kind, "output-cap");
  assert.equal(annotateSingle(m[0]), m[0]);
  // The input is not mutated.
  assert.equal(m[1].view, undefined);
});
