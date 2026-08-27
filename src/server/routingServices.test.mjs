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
  buildMeteredEndpoints,
} from "./routingServices.mjs";
import { mixFromCounts } from "../shared/blendedPrice.mjs";
import { ROUTING_LEDGER_WINDOW_MS } from "./modelLedger.mjs";

test("normalizeDeclared reads modelRouting.declaredModels and passes objects through", () => {
  const out = normalizeDeclared({
    modelRouting: {
      preset: "balanced",
      declaredModels: {
        "anthropic/claude-opus-4": { price: { input: 1, output: 2 } },
        "sample/custom": "not-an-object",
      },
    },
  });
  assert.deepEqual(out, {
    "anthropic/claude-opus-4": { price: { input: 1, output: 2 } },
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
    anthropic: { kind: "subscription", windows: [{ pct: 90 }], balance: -2, overagePrice: 0.25, exhausted: true },
    openai: { kind: "subscription", windows: [{ pct: 10 }] },
  });
});

test("accountsFromSnapshots reads the DECLARED account kind, never the balance inference (5e)", () => {
  // A subscription that also reports a credit balance (codex) must stay a
  // subscription — it must not be priced as prepaid credit.
  const accounts = accountsFromSnapshots([
    { provider: "codex", providerIDs: ["openai"], kind: "subscription", balance: 14.2, windows: [{ pct: 20 }] },
    { provider: "openrouter", providerIDs: ["openrouter"], kind: "credit", balance: -0.07, windows: [] },
    { provider: "legacy", providerIDs: ["legacy"], balance: 5, windows: [] },
  ]);
  assert.equal(accounts.openai.kind, "subscription");
  assert.equal(accounts.openai.balance, 14.2);
  assert.equal(accounts.openrouter.kind, "credit");
  // No declared kind + balance-only → credit (the only safe inference).
  assert.equal(accounts.legacy.kind, "credit");
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

test("ledgerToServices folds reliability samples, per-model baselines, telemetry and a NORMALISED per-endpoint mix + overall mixDefault", () => {
  const stats = {
    supported: true,
    endpoints: {
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
    },
  };
  const { reliability, telemetry, mix, mixDefault } = ledgerToServices(stats);
  // samples keyed by endpoint
  assert.deepEqual(reliability.samples["anthropic/claude-opus-4"], { requests: 30, errored: 3, rate: 0.1 });
  // baseline keyed by MODEL id — aggregate across both endpoints of the model
  assert.deepEqual(reliability.baseline["claude-opus-4"], { rate: (3 + 5) / (30 + 10), n: 40 });
  // telemetry maps the >5-sample percentiles; p90 throughput is carried
  // through and there is NO `latencyMs` (7e — it was a duplicate of p90Ms)
  assert.deepEqual(telemetry["anthropic/claude-opus-4"], {
    tokensPerSec: 100,
    p90TokensPerSec: 80,
    p50Ms: 500,
    p90Ms: 900,
  });
  assert.deepEqual(telemetry["openai/claude-opus-4"], {
    tokensPerSec: 60,
    p90TokensPerSec: 50,
    p50Ms: 700,
    p90Ms: 1100,
  });
  // No bogus "supported" endpoint leaks into the telemetry map (7a).
  assert.deepEqual(Object.keys(telemetry).sort(), ["anthropic/claude-opus-4", "openai/claude-opus-4"]);
  // Mixes are NORMALISED to fractions (mixFromCounts), not raw counts (5a) —
  // an endpoint with no history is then priced on the box's overall mixDefault.
  assert.deepEqual(mix["anthropic/claude-opus-4"], mixFromCounts({ input: 5, output: 10, cacheRead: 20, cacheWrite: 30 }));
  assert.deepEqual(mix["openai/claude-opus-4"], mixFromCounts({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }));
  assert.deepEqual(mixDefault, mixFromCounts({ input: 6, output: 12, cacheRead: 23, cacheWrite: 34 }));
});

test("ledgerToServices is empty-safe and ignores degenerate rows; no mix => no mixDefault", () => {
  const { reliability, telemetry, mix, mixDefault } = ledgerToServices({ supported: true, endpoints: {} });
  assert.deepEqual(reliability, { samples: {}, baseline: {} });
  assert.deepEqual(telemetry, {});
  assert.deepEqual(mix, {});
  assert.equal(mixDefault, undefined);
});

test("ledgerToServices: an endpoint with zero tool-call requests is UNMEASURED, not rate 0 (BET-1297)", () => {
  // A `requests: 0` row means the ledger measured no tool-call requests for
  // that endpoint. Surfacing it as a `rate: 0` sample fabricated "perfect
  // reliability" for every unmeasured endpoint, which made the reliability
  // dimension uniformly 0 across the catalogue — the §12d inert signal. It
  // must be excluded so the router treats it as absent (unmeasured-average).
  const { reliability } = ledgerToServices({
    supported: true,
    endpoints: {
      // Measured: real tool-call evidence -> a real sample.
      "p/opus": { reliability: { requests: 40, errored: 4, rate: 0.1 } },
      // Unmeasured: no tool-call requests -> NO sample, NOT rate 0.
      "p/sonnet": { reliability: { requests: 0, errored: 0, rate: 0 } },
      // row entirely without a reliability field -> ignored as before
      "p/haiku": {},
    },
  });
  assert.deepEqual(reliability.samples, { "p/opus": { requests: 40, errored: 4, rate: 0.1 } });
  // The per-model baseline must not count the unmeasured (requests:0) endpoint.
  assert.deepEqual(reliability.baseline, { opus: { rate: 0.1, n: 40 } });
});

test("ledgerToServices: supported:false leaves reliability/telemetry undefined and emits no endpoint named 'supported' (7a)", () => {
  // An unsupported ledger (no DB) is NOT the same as a ledger with nothing in
  // it. The first must leave reliability/telemetry ABSENT (router's permissive
  // "no evidence, never derank" default); only the second yields present-empty.
  const { reliability, telemetry, mix, mixDefault } = ledgerToServices({ supported: false });
  assert.equal(reliability, undefined);
  assert.equal(telemetry, undefined);
  assert.equal(mix, undefined);
  assert.equal(mixDefault, undefined);
  // And a supported ledger with data must never surface an endpoint literally
  // named "supported" (the 7a bug: Object.entries over the flattened map).
  assert.equal(("supported" in ledgerToServices({ supported: true, endpoints: {} }).telemetry), false);
});

test("buildRoutingServices populates referenceByModel from the catalogue's typical input/output rates (5b)", async () => {
  const services = await buildRoutingServices(
    { modelRouting: { preset: "balanced", declaredModels: { "p/sonnet": { catalogId: "declared-sonnet" }, "p/haiku": { catalogId: "declared-haiku" } } } },
    {
      catalogIndex: {
        lookupModel: (id) =>
          id === "declared-sonnet"
            ? { id: "declared-sonnet", cost: { input: 3, output: 15 } }
            : id === "declared-haiku"
              ? { id: "declared-haiku", cost: { input: 0, output: 0 } }
              : null,
        matchModel: () => ({ kind: "none", candidates: [] }),
        allModels: () => [],
      },
      endpoints: [
        { providerID: "p", id: "sonnet" },
        { providerID: "p", id: "haiku" },
        { providerID: "p", id: "no-entry" },
      ],
    },
  );
  // Keyed by model id; only endpoint ids that resolve in the catalogue carry a
  // reference.
  assert.deepEqual(services.referenceByModel.sonnet, { input: 3, output: 15 });
  // A genuinely free catalogue model still carries a (zero) reference — the
  // implausible-zero rule only fires against a reference that costs money.
  assert.deepEqual(services.referenceByModel.haiku, { input: 0, output: 0 });
  assert.equal(services.referenceByModel["no-entry"], undefined);
});

test("buildRoutingServices: catalogEntryFor honours a declared catalogId over a fuzzy match (BET-1268)", async () => {
  // The fuzzy matcher would resolve `mystery` to the throwaway entry; the
  // user's declaration says it is really `declared-sonnet`. The declared
  // identity must win.
  const services = await buildRoutingServices(
    { modelRouting: { preset: "balanced", declaredModels: { "p/mystery": { catalogId: "declared-sonnet" } } } },
    {
      catalogIndex: {
        lookupModel: (id) =>
          id === "declared-sonnet" ? { id: "declared-sonnet", family: "sonnet" } : null,
        matchModel: (id) =>
          id === "mystery"
            ? { kind: "exact", candidates: [{ id: "fuzzy-entry", family: "haiku" }] }
            : { kind: "none", candidates: [] },
        allModels: () => [],
      },
    },
  );
  const entry = services.catalogEntryFor({ providerID: "p", id: "mystery" });
  assert.equal(entry.family, "sonnet"); // from the declared catalogue entry, not the fuzzy one
});

test("buildRoutingServices assembles a full services object from live readers", async () => {
  const services = await buildRoutingServices(
    { modelRouting: { preset: "balanced", declaredModels: { "anthropic/claude-opus-4": { price: { input: 1, output: 2 } } } } },
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
        endpoints: {
          "anthropic/claude-opus-4": {
            reliability: { requests: 25, errored: 2, rate: 0.08 },
            speed: { p50TokensPerSec: 90 },
            latency: { p50Ms: 400, p90Ms: 800 },
            mix: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          },
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
  assert.deepEqual(services.declared["anthropic/claude-opus-4"], { price: { input: 1, output: 2 } });
  // accounts keyed by providerID, exhausted carried
  assert.equal(services.accounts.anthropic.exhausted, true);
  // health excludes the rate-limited provider
  assert.equal(services.health.openai, "rate-limited");
  assert.equal(services.health.anthropic, "ok");
  // reliability sample + baseline present
  assert.equal(services.reliability.samples["anthropic/claude-opus-4"].requests, 25);
  assert.ok(services.reliability.baseline["claude-opus-4"]);
  // telemetry + mix present (mix normalised to fractions, mixDefault from the ledger)
  assert.equal(services.telemetry["anthropic/claude-opus-4"].tokensPerSec, 90);
  assert.deepEqual(services.mix["anthropic/claude-opus-4"], mixFromCounts({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }));
  assert.deepEqual(services.mixDefault, mixFromCounts({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }));
});

test("buildRoutingServices reads the ledger over a rolling window, not all history (7b)", async () => {
  let seenSinceMs = undefined;
  const now = 2_000_000_000_000;
  const spy = async ({ sinceMs }) => {
    seenSinceMs = sinceMs;
    return { supported: true, endpoints: {} };
  };
  await buildRoutingServices({ modelRouting: { preset: "balanced" } }, { endpointSummary: spy }, now);
  // The window edge is injected nowMs minus the 14-day constant — an all-
  // history read (sinceMs 0) would never recover from a bad week eight months
  // ago.
  assert.equal(seenSinceMs, now - ROUTING_LEDGER_WINDOW_MS);
});

test("buildRoutingServices memoises the ledger summary behind the TTL: one read per decision (7c)", async () => {
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { supported: true, endpoints: {} };
  };
  const now = 1_000_000_000_000;
  // First call populates the cache; a second call inside the 60s TTL reuses it
  // — two routing decisions must NOT each re-scan the whole message history.
  await buildRoutingServices({ modelRouting: { preset: "balanced" } }, { endpointSummary: counting }, now);
  await buildRoutingServices({ modelRouting: { preset: "balanced" } }, { endpointSummary: counting }, now + 30_000);
  assert.equal(calls, 1);
  // Outside the TTL → a fresh read.
  await buildRoutingServices({ modelRouting: { preset: "balanced" } }, { endpointSummary: counting }, now + 60_001);
  assert.equal(calls, 2);
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

test("optimizerEnabled gates pacing pressure + eco: off → absent, on → populated (BET-1345)", async () => {
  const pacing = {
    pressureFor: async () => ({ lambda: 1, tokensPerPct: 100, deficit: 30, ecoLevel: 2, protection: false }),
  };
  const deps = {
    endpoints: [{ providerID: "anthropic", id: "claude-opus-4" }],
    snapshots: [{ provider: "claude", providerIDs: ["anthropic"], exhausted: false, windows: [] }],
    pacing,
  };
  // Switch OFF → nothing reaches the services bag: route exactly as today.
  const off = await buildRoutingServices({ modelRouting: { preset: "balanced" }, optimizerEnabled: false }, deps, 0);
  assert.equal(off.pressure, undefined);
  assert.equal(off.ecoLevel, undefined);
  // Switch ON → per-provider pressure + the max eco level across providers.
  const on = await buildRoutingServices({ modelRouting: { preset: "balanced" }, optimizerEnabled: true }, deps, 0);
  assert.equal(on.pressure.anthropic.lambda, 1);
  assert.equal(on.pressure.anthropic.ecoLevel, 2);
  assert.equal(on.ecoLevel, 2);
});

test("optimizer on but no pacing reader → pressure absent, eco 0 (never a guess)", async () => {
  const s = await buildRoutingServices(
    { modelRouting: { preset: "balanced" }, optimizerEnabled: true },
    { endpoints: [{ providerID: "anthropic", id: "x" }] },
    0,
  );
  assert.equal(s.pressure, undefined);
  assert.equal(s.ecoLevel, 0);
});

// ---------------------------------------------------------------------------
// BET-1367: metered endpoints from the user's own endpoints + catalogue ref
// ---------------------------------------------------------------------------

test("buildMeteredEndpoints prices the user's own endpoints, excludes subscription providers, caps at 8", () => {
  const rows = buildMeteredEndpoints({
    models: [
      { providerID: "meta", id: "Meta-Llama-3.1-405B-Instruct-Turbo", cost: { input: 0.9, output: 0.9 } },
      { providerID: "qwen", id: "qwen3.6-27b", cost: { input: 1, output: 2 } },
      { providerID: "anthropic", id: "claude-opus-4", cost: { input: 5, output: 15 } },
    ],
    mix: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    subProviders: new Set(["anthropic"]),
    catalogEntryFor: () => null,
  });
  // The subscription-covered provider is dropped; the two metered ones remain.
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.name === "qwen · qwen3.6-27b"));
  assert.ok(rows.some((r) => r.name === "meta · Meta-Llama-3.1-405B-Instruct-Turbo"));
  assert.ok(!rows.some((r) => r.name.includes("claude-opus-4")));
  for (const r of rows) {
    assert.equal(r.role, "pay-per-token endpoint");
    assert.match(r.price, /\$[\d.]+ \/ Mtok blended$/);
  }
});

test("buildMeteredEndpoints drops a 0/0 endpoint the catalogue prices (implausible zero, catalogue ref)", () => {
  // The metered source is the user's endpoint, which quotes 0/0 for the META
  // model; the CATALOGUE says that model costs money. The invariant-zero rule
  // must fire from the catalogue reference (not the endpoint's own cost — it
  // has none), so the 0/0 row is dropped rather than shown as "free".
  const rows = buildMeteredEndpoints({
    models: [
      { providerID: "meta", id: "Meta-Llama-3.1-405B-Instruct-Turbo", cost: { input: 0, output: 0 } },
      { providerID: "qwen", id: "qwen3.6-27b", cost: { input: 1, output: 2 } },
    ],
    mix: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0 },
    subProviders: new Set(["anthropic"]),
    catalogEntryFor: (ep) =>
      ep?.id === "Meta-Llama-3.1-405B-Instruct-Turbo"
        ? { id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", cost: { input: 0.9, output: 0.9 } }
        : null,
  });
  assert.equal(rows.length, 1);
  assert.ok(rows.some((r) => r.name.startsWith("qwen")));
  assert.ok(!rows.some((r) => r.name.startsWith("meta")));
});

test("buildRoutingServices builds the catalogue-backed reference for the META model (routeable endpoint id)", async () => {
  const services = await buildRoutingServices(
    {},
    {
      catalogIndex: {
        lookupModel: () => null,
        matchModel: (id) =>
          /Meta-Llama/i.test(String(id))
            ? {
                kind: "exact",
                candidates: [
                  { id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", cost: { input: 0.9, output: 0.9 } },
                ],
              }
            : { kind: "none", candidates: [] },
        allModels: () => [],
      },
      endpoints: [{ providerID: "meta", id: "Meta-Llama-3.1-405B-Instruct-Turbo" }],
    },
  );
  assert.deepEqual(services.referenceByModel["Meta-Llama-3.1-405B-Instruct-Turbo"], {
    input: 0.9,
    output: 0.9,
  });
});
