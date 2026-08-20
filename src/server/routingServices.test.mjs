// routingServices.test.mjs — BET-1252 unit tests for the box-side assembly of
// the router's RoutingServices context. Pure assembly + injected I/O, so every
// block is testable with fakes — no live box, no DB, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDeclared,
  buildBenchmarkField,
  accountsFromSnapshots,
  healthFor,
  ledgerToServices,
  buildRoutingServices,
} from "./routingServices.mjs";

test("normalizeDeclared reads modelRouting.declaredModels and passes objects through", () => {
  const out = normalizeDeclared({
    modelRouting: {
      preset: "balanced",
      declaredModels: {
        "anthropic/claude-opus-4": { catalogId: "claude-opus-4", tierOverride: "deep" },
        "sample/custom": "not-an-object",
      },
    },
  });
  assert.deepEqual(out, {
    "anthropic/claude-opus-4": { catalogId: "claude-opus-4", tierOverride: "deep" },
  });
});

test("normalizeDeclared returns {} when absent or malformed", () => {
  assert.deepEqual(normalizeDeclared({}), {});
  assert.deepEqual(normalizeDeclared(null), {});
  assert.deepEqual(normalizeDeclared({ modelRouting: { declaredModels: "nope" } }), {});
});

test("buildBenchmarkField ranks a score against the same benchmark across the catalogue", () => {
  const catalogIndex = {
    allModels: () => [
      { benchmarks: [{ name: "SWE-Bench Verified", score: 10 }] },
      { benchmarks: [{ name: "SWE-Bench Verified", score: 20 }] },
      { benchmarks: [{ name: "SWE-Bench Verified", score: 30 }] },
      { benchmarks: [{ name: "Other", score: 99 }] },
    ],
  };
  const field = buildBenchmarkField(catalogIndex);
  assert.equal(typeof field.benchmarkPercentile, "function");
  // 20 is the median of [10,20,30] → 50% below
  assert.equal(field.benchmarkPercentile("SWE-Bench Verified", 20), 0.5);
  assert.equal(field.benchmarkPercentile("SWE-Bench Verified", 5), 0);
  assert.equal(field.benchmarkPercentile("SWE-Bench Verified", 31), 1);
  // A benchmark seen nowhere → null (falls through to family/structural).
  assert.equal(field.benchmarkPercentile("Nope", 1), null);
});

test("buildBenchmarkField degrades to a null-returning field when the catalogue is absent", () => {
  const field = buildBenchmarkField(null);
  assert.equal(field.benchmarkPercentile("x", 1), null);
});

test("accountsFromSnapshots maps each snapshot to all the providerIDs it covers", () => {
  const accounts = accountsFromSnapshots([
    { provider: "claude", providerIDs: ["anthropic"], balance: -2, overagePrice: 0.25, exhausted: true, windows: [{ pct: 90 }] },
    { provider: "codex", providerIDs: ["openai"], windows: [{ pct: 10 }] },
  ]);
  assert.deepEqual(accounts, {
    anthropic: { kind: "credit", windows: [{ pct: 90 }], balance: -2, overagePrice: 0.25, exhausted: true },
    openai: { kind: "subscription", windows: [{ pct: 10 }] },
  });
});

test("accountsFromSnapshots skips snapshots with no providerIDs and malformed rows", () => {
  assert.deepEqual(accountsFromSnapshots([{ provider: "x", balance: 1 }, null, "nope"]), {});
});

test("healthFor maps providerIDs through the state function, guarding a throwing reader", () => {
  let calls = 0;
  const health = healthFor(["anthropic", "openai", "bad", ""], (pid) => {
    calls += 1;
    if (pid === "bad") throw new Error("boom");
    return pid === "anthropic" ? "out-of-credit" : "ok";
  });
  assert.deepEqual(health, { anthropic: "out-of-credit", openai: "ok" });
  assert.ok(calls >= 3, "must still query the live providers");
});

test("healthFor is empty when no state reader is wired", () => {
  assert.deepEqual(healthFor(["anthropic"], null), {});
});

test("ledgerToServices folds reliability samples, per-model baselines and telemetry", () => {
  const stats = {
    "anthropic/claude-opus-4": {
      reliability: { requests: 30, errored: 3, rate: 0.1 },
      speed: { p50TokensPerSec: 100, p90TokensPerSec: 80 },
      latency: { p50Ms: 500, p90Ms: 900 },
      mix: { input: 5, output: 10, cacheRead: 20, cacheWrite: 30 },
    },
    "openai/claude-opus-4": {
      reliability: { requests: 10, errored: 5, rate: 0.5 },
      speed: { p50TokensPerSec: 60, p90TokensPerSec: 50 },
      latency: { p50Ms: 700, p90Ms: 1100 },
      mix: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    },
  };
  const { reliability, telemetry, mix } = ledgerToServices(stats);
  // samples keyed by endpoint
  assert.deepEqual(reliability.samples["anthropic/claude-opus-4"], { requests: 30, errored: 3, rate: 0.1 });
  // baseline keyed by MODEL id — aggregate across both endpoints of the model
  assert.deepEqual(reliability.baseline["claude-opus-4"], { rate: (3 + 5) / (30 + 10), n: 40 });
  // telemetry maps the >5-sample percentiles
  assert.deepEqual(telemetry["anthropic/claude-opus-4"], {
    tokensPerSec: 100,
    p50Ms: 500,
    p90Ms: 900,
    latencyMs: 900,
  });
  assert.deepEqual(mix["anthropic/claude-opus-4"], { input: 5, output: 10, cacheRead: 20, cacheWrite: 30 });
});

test("ledgerToServices is empty-safe and ignores degenerate rows", () => {
  const { reliability, telemetry, mix } = ledgerToServices({});
  assert.deepEqual(reliability, { samples: {}, baseline: {} });
  assert.deepEqual(telemetry, {});
  assert.deepEqual(mix, {});
});

test("buildRoutingServices assembles a full services object from live readers", async () => {
  const services = await buildRoutingServices(
    { modelRouting: { preset: "balanced", declaredModels: { "anthropic/claude-opus-4": { tierOverride: "deep" } } } },
    {
      catalogIndex: {
        lookupModel: (id) => (id === "claude-opus-4" ? { id } : null),
        matchModel: (id) =>
          id === "claude-opus-4"
            ? { kind: "exact", candidates: [{ id: "claude-opus-4", family: "claude", benchmarks: [{ name: "SWE-Bench Verified", score: 40 }] }] }
            : { kind: "none", candidates: [] },
        allModels: () => [{ id: "claude-opus-4", benchmarks: [{ name: "SWE-Bench Verified", score: 40 }] }],
      },
      endpoints: [
        { providerID: "anthropic", id: "claude-opus-4" },
        { providerID: "openai", id: "gpt-5" },
      ],
      snapshots: [{ provider: "claude", providerIDs: ["anthropic"], exhausted: true, windows: [] }],
      providerHealthState: (pid) => (pid === "openai" ? "rate-limited" : "ok"),
      endpointSummary: async () => ({
        supported: true,
        "anthropic/claude-opus-4": {
          reliability: { requests: 25, errored: 2, rate: 0.08 },
          speed: { p50TokensPerSec: 90 },
          latency: { p50Ms: 400, p90Ms: 800 },
          mix: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
      }),
    },
  );

  // catalogue matcher surfaces the exact candidate → identity resolvable
  assert.equal(services.catalogMatcher.matchModel("claude-opus-4").kind, "exact");
  assert.equal(services.catalogEntryFor({ id: "claude-opus-4" }).family, "claude");
  // quality field ranks the score
  assert.equal(typeof services.qualityField.benchmarkPercentile, "function");
  // declared from config
  assert.deepEqual(services.declared["anthropic/claude-opus-4"], { tierOverride: "deep" });
  // accounts keyed by providerID, exhausted carried
  assert.equal(services.accounts.anthropic.exhausted, true);
  // health excludes the rate-limited provider
  assert.equal(services.health.openai, "rate-limited");
  assert.equal(services.health.anthropic, "ok");
  // reliability sample + baseline present
  assert.equal(services.reliability.samples["anthropic/claude-opus-4"].requests, 25);
  assert.ok(services.reliability.baseline["claude-opus-4"]);
  // telemetry + mix present
  assert.equal(services.telemetry["anthropic/claude-opus-4"].tokensPerSec, 90);
  assert.deepEqual(services.mix["anthropic/claude-opus-4"], { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});

test("buildRoutingServices safety contract: a throwing reader degrades, never throws", async () => {
  // No readers at all → a services object with only the config-derived empty map.
  const bare = await buildRoutingServices({ modelRouting: { preset: "balanced" } }, {});
  assert.deepEqual(bare.declared, {});
  assert.equal(bare.catalogMatcher, undefined);
  assert.equal(bare.health, undefined);
  assert.equal(bare.accounts, undefined);
  assert.equal(bare.reliability, undefined);

  // A throwing endpoointSummary / catalogue / health reader must not abort.
  const throwing = await buildRoutingServices(
    { modelRouting: { preset: "balanced", declaredModels: { "a/b": { price: "free" } } } },
    {
      catalogIndex: { lookupModel: () => { throw new Error("cat"); }, matchModel: () => { throw new Error("cat"); }, allModels: () => { throw new Error("cat"); } },
      endpoints: [{ providerID: "anthropic", id: "x" }],
      snapshots: [{ provider: "claude", providerIDs: ["anthropic"], exhausted: false, windows: [] }],
      providerHealthState: () => { throw new Error("health"); },
      endpointSummary: async () => { throw new Error("ledger"); },
    },
  );
  // The one thing that cannot throw must still land: the declared pass-through.
  assert.deepEqual(throwing.declared, { "a/b": { price: "free" } });
  assert.equal(throwing.health, undefined);
  assert.equal(throwing.reliability, undefined);
});
