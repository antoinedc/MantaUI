import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderHealth, PROVIDER_HEALTH_STATE, MIN_FAILURES_TO_DEPRIORITIZE } from "./providerHealth.mjs";
import { createEndpointAttemptRecorder, createEndpointAttemptsStore } from "./endpointAttempts.mjs";

// The facade integration: createProviderHealth wires the REAL endpoint-health
// engine (tmp stores) with its deps, and the Accounts/router surface reads
// through it. Attempts flow through the attempts recorder's post-persist hook
// — the composition index.mjs wires (W4/BET-1536).

async function withFacade(fn, deps = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ph-facade-"));
  try {
    const clock = { t: 1000 };
    const published = [];
    let engine = null;
    const attempts = createEndpointAttemptRecorder({
      store: createEndpointAttemptsStore({ path: join(dir, "endpoint-attempts.json"), now: () => clock.t }),
      now: () => clock.t,
      onAttempt: (a) => engine.engine.recordAttempt(a),
    });
    const facade = createProviderHealth({
      now: () => clock.t,
      publish: (evt) => published.push(evt),
      providerIDForAdapter: (a) => ({ claude: "anthropic" }[a] ?? null),
      adapterForProvider: (p) => ({ anthropic: "claude" }[p] ?? null),
      recheckAtLimit: async () => false,
      attempts,
      ...deps,
    });
    engine = facade; // the attempts hook folds into the facade's engine
    return await fn({
      facade,
      attempts,
      clock,
      published,
      record: (over = {}) =>
        attempts.recordProviderAttempt({
          at: clock.t,
          attemptId: over.attemptId ?? `a-${Math.random().toString(36).slice(2)}`,
          endpointKey: over.endpointKey ?? "anthropic/claude-x",
          accountKey: "anthropic",
          outcome: "failure",
          httpStatus: null,
          errorName: null,
          ...over,
        }),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("facade.state reads the account register (402 → out-of-credit, success → ok)", async () => {
  await withFacade(async ({ facade, clock, record }) => {
    await record({ httpStatus: 402 });
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // No elapsed time re-admits it (recovery is evidence-only, never a clock).
    clock.t += 30 * 24 * 3600 * 1000;
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    await record({ outcome: "success", attemptId: "ok-1" });
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("facade.all and facade.retryIn expose the provider-keyed compat view", async () => {
  await withFacade(async ({ facade, clock, record }) => {
    assert.deepEqual(facade.all(), {});
    assert.equal(facade.retryIn("anthropic"), null);
    await record({ httpStatus: 429, retryAfterMs: 5 * 60_000 });
    assert.deepEqual(facade.all(), { anthropic: PROVIDER_HEALTH_STATE.RATE_LIMITED });
    const ms = facade.retryIn("anthropic");
    assert.ok(ms > 4 * 60_000 && ms <= 5 * 60_000);
    // An unknown provider still reads a state (the rollup defaults to ok).
    assert.equal(facade.state("mystery"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("facade.retry performs the W8 manual reset through the engine (custom provider: clear + probe)", async () => {
  const probes = [];
  await withFacade(async ({ facade, record }) => {
    await record({ httpStatus: 402 });
    const res = await facade.retry("anthropic");
    assert.equal(res.cleared, true);
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OK);
    assert.ok(res.message.includes("verification probe"), "the probe result is reported");
  }, {
    probeRun: async ({ providerID, modelID }) => {
      probes.push(`${providerID}/${modelID}`);
      return { outcome: "success" };
    },
  });
  assert.deepEqual(probes, ["anthropic/claude-x"], "the facade's probeRun reached the engine");
});

test("facade.deliverSnapshots clears out-of-credit on affirmative funds (delegates to the engine)", async () => {
  await withFacade(async ({ facade, record }) => {
    await record({ httpStatus: 402 });
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // An exhausted snapshot is no evidence; funds clear it.
    await facade.deliverSnapshots([{ provider: "claude", exhausted: true }]);
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    await facade.deliverSnapshots([{ provider: "claude", exhausted: false }]);
    assert.equal(facade.state("anthropic"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("facade publishes ONE needs-attention event per transition into a non-ok state", async () => {
  await withFacade(async ({ facade, clock, published, record }) => {
    await record({ httpStatus: 402 });
    const events = published.filter((e) => e?.kind === "provider-health.needs-attention");
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.state, PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    clock.t += 1000;
    await record({ httpStatus: 402, attemptId: "again" });
    assert.equal(published.filter((e) => e?.kind === "provider-health.needs-attention").length, 1);
  });
});

test("the compatibility exports survive (MIN_FAILURES_TO_DEPRIORITIZE)", () => {
  assert.equal(MIN_FAILURES_TO_DEPRIORITIZE, 2);
});
