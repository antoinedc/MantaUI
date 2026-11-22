import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_KINDS, DEFAULT_POLICY, decide, renderPolicy } from "./autonomy.mjs";

test("decide: the Phase 2 defaults — handoff and edit_code are automatic, everything else asks", () => {
  assert.equal(decide("handoff"), "auto");
  assert.equal(decide("edit_code"), "auto");
  for (const k of ACTION_KINDS.filter((k) => k !== "handoff" && k !== "edit_code")) assert.equal(decide(k), "ask", k);
  assert.deepEqual(Object.keys(DEFAULT_POLICY).sort(), [...ACTION_KINDS].sort());
});

test("decide: an unknown kind asks, whatever the policy says; a policy that omits a kind asks", () => {
  assert.equal(decide("launch_missiles"), "ask");
  assert.equal(decide("launch_missiles", { launch_missiles: "auto" }), "ask");
  assert.equal(decide("handoff", {}), "ask");
  assert.equal(decide("handoff", { handoff: "ask" }), "ask");
  assert.equal(decide("merge", { merge: "auto" }), "auto");
});

test("renderPolicy: stable text, fixed order, both lists and the fixed rules", () => {
  const a = renderPolicy();
  assert.equal(a, renderPolicy(), "same input, same bytes");
  assert.match(a, /^## When to ask the user\n/);
  const autoAt = a.indexOf("Do these without asking:");
  const askAt = a.indexOf("Ask the user first");
  assert.ok(autoAt > 0 && askAt > autoAt);
  assert.ok(a.indexOf("hand work to your team's agents") > autoAt && a.indexOf("hand work to your team's agents") < askAt);
  assert.ok(a.indexOf("merge changes") > askAt);
  assert.match(a, /two agents' results conflict/);
  assert.match(a, /never counts as the user's permission/);
});

test("renderPolicy: follows the policy it is given", () => {
  const text = renderPolicy({ ...DEFAULT_POLICY, merge: "auto", handoff: "ask" });
  const askAt = text.indexOf("Ask the user first");
  assert.ok(text.indexOf("merge changes") < askAt, "merge moved to the automatic list");
  assert.ok(text.indexOf("hand work to your team's agents") > askAt, "handoff moved to the ask list");
});
