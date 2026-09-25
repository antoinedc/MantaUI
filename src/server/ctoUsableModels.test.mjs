// Usable-model checks (2026-09-25 audit): the router already knew the OpenAI
// plan was at 100% until its reset; CTO turns now consult the same answer.
import test from "node:test";
import assert from "node:assert/strict";
import { modelUsability } from "../shared/modelRouter.mjs";
import { resolveCtoTurnModel, usableModelsNow, describeUnusable } from "./ctoSessions.mjs";

const NOW = 1_790_300_000_000;
const RESET = NOW + 2 * 86_400_000;
const astra = { providerID: "openai", id: "gpt-6-astra" };
const opus = { providerID: "anthropic", id: "claude-opus-5-5" };
const sonnet = { providerID: "anthropic", id: "claude-sonnet-5" };
const exhaustedOpenai = {
  accounts: {
    openai: { kind: "subscription", windows: [{ pct: 100, resetsAt: RESET }, { pct: 40, resetsAt: NOW + 3600_000 }] },
    anthropic: { kind: "subscription", windows: [{ pct: 30, resetsAt: NOW + 3600_000 }] },
  },
};

test("modelUsability: an exhausted subscription window is unusable with its reset time; a healthy one is usable", () => {
  assert.deepEqual(modelUsability(astra, exhaustedOpenai, NOW), {
    model: "openai/gpt-6-astra", usable: false, reason: "plan usage limit reached", resetsAt: RESET,
  });
  assert.deepEqual(modelUsability(opus, exhaustedOpenai, NOW), {
    model: "anthropic/claude-opus-5-5", usable: true, reason: null, resetsAt: null,
  });
});

test("modelUsability: a stale 100% window (reset passed, no new numbers) does not count as exhausted", () => {
  const services = { accounts: { openai: { kind: "subscription", windows: [{ pct: 100, resetsAt: NOW - 1, stale: true }] } } };
  assert.equal(modelUsability(astra, services, NOW).usable, true);
});

test("modelUsability: account and endpoint health exclusions make a model unusable", () => {
  assert.equal(modelUsability(astra, { health: { openai: "rate-limited" } }, NOW).reason, "account rate-limited");
  assert.equal(modelUsability(astra, { health: { openai: "out-of-credit" } }, NOW).usable, false);
  assert.equal(modelUsability(astra, { endpointHealth: { "openai/gpt-6-astra": "dead" } }, NOW).reason, "endpoint dead");
  assert.equal(modelUsability(astra, { health: { openai: "degraded" } }, NOW).usable, true, "soft states never exclude");
});

const live = (services) => ({ cfg: {}, catalog: [astra, opus, sonnet], services });

test("resolveCtoTurnModel: keeps a usable cto default; routes off an exhausted one", async () => {
  assert.deepEqual(await resolveCtoTurnModel({ incumbent: { providerID: "anthropic", modelID: "claude-opus-5-5" }, live: live(exhaustedOpenai), nowMs: NOW }),
    { model: { providerID: "anthropic", modelID: "claude-opus-5-5" } });
  const routed = await resolveCtoTurnModel({ incumbent: { providerID: "openai", modelID: "gpt-6-astra" }, live: live(exhaustedOpenai), nowMs: NOW });
  assert.equal(routed.model.providerID, "anthropic", "never the exhausted plan");
});

test("resolveCtoTurnModel: a pinned exhausted model fails with the reason and reset time — never silently swapped", async () => {
  const r = await resolveCtoTurnModel({ pinned: { providerID: "openai", modelID: "gpt-6-astra" }, live: live(exhaustedOpenai), nowMs: NOW });
  assert.ok(r.fail);
  assert.match(r.fail, /openai\/gpt-6-astra.*plan usage limit reached.*until/);
  assert.equal(r.model, undefined);
  const ok = await resolveCtoTurnModel({ pinned: "anthropic/claude-opus-5-5", live: live(exhaustedOpenai), nowMs: NOW });
  assert.deepEqual(ok, { model: { providerID: "anthropic", modelID: "claude-opus-5-5" } });
});

test("resolveCtoTurnModel: nothing usable fails instead of sending", async () => {
  const services = { health: { openai: "rate-limited", anthropic: "out-of-credit" } };
  const r = await resolveCtoTurnModel({ incumbent: "openai/gpt-6-astra", live: live(services), nowMs: NOW });
  assert.match(r.fail, /no usable model/);
});

test("usableModelsNow: named candidates and the default whole-catalogue listing", async () => {
  const rows = await usableModelsNow({ candidates: ["openai/gpt-6-astra", "anthropic/claude-opus-5-5"], live: live(exhaustedOpenai), nowMs: NOW });
  assert.deepEqual(rows.map((r) => [r.model, r.usable]), [["openai/gpt-6-astra", false], ["anthropic/claude-opus-5-5", true]]);
  const all = await usableModelsNow({ live: live(exhaustedOpenai), nowMs: NOW });
  assert.equal(all.length, 3);
  assert.match(describeUnusable(rows[0]), /until 20\d\d-/);
});
