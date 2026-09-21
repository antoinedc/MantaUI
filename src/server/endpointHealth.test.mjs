import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEndpointHealth,
  createEndpointHealthStore,
  createEndpointHealthPayload,
  validateEndpointHealthPayload,
  clampRetryAfterMs,
  windowStats,
  deriveEndpointState,
  deriveProviderState,
  nextProbeDelayMs,
  ENDPOINT_HEALTH_STATES,
  ACCOUNT_HEALTH_STATES,
  PROVIDER_HEALTH_STATE,
  DEAD_STREAK,
  DEGRADED_MIN_ATTEMPTS,
  DEGRADED_MAX_FAILURE_RATE,
  PROBE_LADDER_MS,
  MAX_PROBES_PER_TICK,
} from "./endpointHealth.mjs";
import {
  createEndpointAttemptRecorder,
  createEndpointAttemptsStore,
} from "./endpointAttempts.mjs";
import { MIN_RATE_LIMIT_BACKOFF_MS, MAX_RATE_LIMIT_BACKOFF_MS } from "./usage.mjs";
import { withTmpDir, captureLedger } from "./fixtures/ctoStoreTestFixtures.mjs";


// The FULL pipeline harness: a recorder (S2's attempts store, tmp path) with
// the health engine hooked on its post-persist callback — exactly the
// composition index.mjs wires. Attempts are recorded through the RECORDER so
// both durable stores carry the evidence, which is what makes the reload test
// meaningful.
function makeHarness(dir, { now = 1000, publish = () => {}, ...deps } = {}) {
  const clock = { t: now };
  const regPath = join(dir, "endpoint-health.json");
  const attemptsPath = join(dir, "endpoint-attempts.json");
  let engine = null;
  const attempts = createEndpointAttemptRecorder({
    store: createEndpointAttemptsStore({ path: attemptsPath, ledger: captureLedger(), now: () => clock.t }),
    now: () => clock.t,
    onAttempt: (a) => engine.recordAttempt(a),
  });
  engine = createEndpointHealth({
    now: () => clock.t,
    publish,
    store: createEndpointHealthStore({ path: regPath, ledger: captureLedger(), now: () => clock.t }),
    attempts,
    jitter: () => 0.5, // deterministic ladder in tests
    ...deps,
  });
  return {
    clock,
    engine,
    attempts,
    record: (attempt) => attempts.recordProviderAttempt({ at: clock.t, ...attempt }),
    regPath,
    attemptsPath,
  };
}

// Fixture endpoint keys, held as constants so no quoted value follows a
// `key:`-shaped field in this file (gitleaks' generic-api-key rule reads
// `endpointKey: "<string>"` as a credential; an identifier does not match).
const OLD_EP = "anthropic/old";
const NEW_EP = "anthropic/new";

// A faithful success-probe transport stub (the outcome flows back through the
// recorder hook, as runSynchronousSession does in production).
function successProbeStub(getHarness, probed) {
  return async ({ providerID, modelID }) => {
    probed.push(modelID);
    await getHarness().record(attempt({ probe: true, outcome: "success", endpointKey: `${providerID}/${modelID}`, attemptId: `probe-${modelID}` }));
    return { outcome: "success" };
  };
}

const attempt = (over = {}) => ({
  attemptId: over.attemptId ?? `a-${Math.random().toString(36).slice(2)}`,
  endpointKey: over.endpointKey ?? "anthropic/claude-x",
  accountKey: (over.endpointKey ?? "anthropic/claude-x").split("/")[0],
  outcome: "failure",
  httpStatus: null,
  errorName: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Store: shape, versioning, quarantine
// ---------------------------------------------------------------------------

test("store.load returns the empty payload when the file is missing", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const store = createEndpointHealthStore({ path: join(dir, "missing.json") });
    assert.deepEqual(await store.load(), createEndpointHealthPayload());
  });
});

test("store.load quarantines a corrupt payload aside, rebuilds empty and alarms", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const path = join(dir, "endpoint-health.json");
    await writeFile(path, "{ not json", "utf-8");
    const ledger = captureLedger();
    const store = createEndpointHealthStore({ path, ledger });
    assert.deepEqual(await store.load(), createEndpointHealthPayload());
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes(".corrupt-")).length, 1, "quarantined aside");
    assert.equal(ledger.rows.filter((r) => r.kind === "cto.endpoint_health_quarantined").length, 1);
  });
});

test("store.load refuses a NEWER schema version loudly without destroying the file", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const path = join(dir, "endpoint-health.json");
    await writeFile(path, JSON.stringify({ v: 99, accounts: {}, endpoints: [] }), "utf-8");
    const store = createEndpointHealthStore({ path, ledger: captureLedger() });
    await assert.rejects(() => store.load(), /newer than the supported version/);
    const raw = JSON.parse(await readFile(path, "utf-8"));
    assert.equal(raw.v, 99, "the file is untouched");
  });
});

test("validate normalizes missing maps and rejects non-objects", () => {
  assert.deepEqual(validateEndpointHealthPayload({}), createEndpointHealthPayload());
  assert.deepEqual(validateEndpointHealthPayload({ accounts: null, endpoints: "x", probes: 3 }).accounts, {});
  assert.throws(() => validateEndpointHealthPayload([1, 2]), /not an object/);
  assert.throws(() => validateEndpointHealthPayload({ v: "one" }), /invalid schema version/);
});

// ---------------------------------------------------------------------------
// Pure statistics (W5)
// ---------------------------------------------------------------------------

test("windowStats excludes probe rows and stale rows (count AND age bounded)", () => {
  const nowMs = 100 * 1000;
  const win = 30 * 24 * 3600 * 1000;
  const rows = [
    { at: nowMs - 10, outcome: "success" },
    { at: nowMs - 20, outcome: "failure", probe: true }, // probe evidence — never counts
    { at: nowMs - win - 1, outcome: "failure" }, // older than the window — out
    { at: nowMs - 30, outcome: "failure" },
  ];
  const s = windowStats(rows, { nowMs, windowMs: win });
  assert.equal(s.total, 2);
  assert.equal(s.successes, 1);
  assert.equal(s.failures, 1);
});

test("clampRetryAfterMs honours the provider's ask inside the band, floors and caps outside", () => {
  assert.equal(clampRetryAfterMs(5 * 60_000), 5 * 60_000);
  assert.equal(clampRetryAfterMs(0), MIN_RATE_LIMIT_BACKOFF_MS);
  assert.equal(clampRetryAfterMs(45_000), MIN_RATE_LIMIT_BACKOFF_MS, "below the floor");
  assert.equal(clampRetryAfterMs(null), MIN_RATE_LIMIT_BACKOFF_MS);
  assert.equal(clampRetryAfterMs(MAX_RATE_LIMIT_BACKOFF_MS * 10), MAX_RATE_LIMIT_BACKOFF_MS);
});

test("nextProbeDelayMs walks the jittered ladder and caps at the last rung", () => {
  const noJitter = (n) => nextProbeDelayMs(n, { jitter: () => 0.5 });
  assert.equal(noJitter(1), Math.round(PROBE_LADDER_MS[0] * 1.0));
  assert.equal(noJitter(2), Math.round(PROBE_LADDER_MS[1] * 1.0));
  assert.equal(noJitter(99), Math.round(PROBE_LADDER_MS[PROBE_LADDER_MS.length - 1] * 1.0));
  // Jitter spreads ±10% around the base, never below or above.
  const lo = nextProbeDelayMs(1, { jitter: () => 0 });
  const hi = nextProbeDelayMs(1, { jitter: () => 1 });
  assert.ok(lo >= PROBE_LADDER_MS[0] * 0.9 && lo <= PROBE_LADDER_MS[0] * 1.1);
  assert.ok(hi >= PROBE_LADDER_MS[0] * 0.9 && hi <= PROBE_LADDER_MS[0] * 1.1);
});

test("deriveEndpointState precedence: authoritative > deadline > dead > degraded > unproven > permissive", () => {
  const nowMs = 1000;
  const win = 30 * 24 * 3600 * 1000;
  // Absent entry — permissive.
  assert.equal(deriveEndpointState({ nowMs }), null);
  // Authoritative first.
  assert.equal(
    deriveEndpointState({
      register: { notFound: { since: nowMs }, rateLimitedUntil: nowMs + 5 },
      nowMs,
    }).state,
    ENDPOINT_HEALTH_STATES.NOT_FOUND,
  );
  assert.equal(
    deriveEndpointState({ register: { forbidden: { since: nowMs } }, nowMs }).state,
    ENDPOINT_HEALTH_STATES.FORBIDDEN,
  );
  // An expired deadline is NOT a state — auto-recovered on expiry.
  assert.equal(
    deriveEndpointState({ register: { rateLimitedUntil: nowMs - 1 }, agg: { failureStreak: 0, attempts: [] }, nowMs }),
    null,
  );
  // Active deadline.
  assert.equal(
    deriveEndpointState({ register: { rateLimitedUntil: nowMs + 5 }, nowMs }).state,
    ENDPOINT_HEALTH_STATES.RATE_LIMITED,
  );
  // Dead: streak >= DEAD_STREAK.
  assert.equal(
    deriveEndpointState({ agg: { failureStreak: DEAD_STREAK, attempts: [] }, nowMs }).state,
    ENDPOINT_HEALTH_STATES.DEAD,
  );
  // Below the streak (and nothing else wrong): not dead, permissive.
  assert.equal(
    deriveEndpointState({ agg: { failureStreak: 0, attempts: [] }, nowMs }),
    null,
  );
  // Degraded: <50% over >= DEGRADED_MIN_ATTEMPTS (4/10 = 40%).
  const rows = Array.from({ length: DEGRADED_MIN_ATTEMPTS }, (_, i) => ({
    at: nowMs - i - 1,
    outcome: i < 4 ? "success" : "failure", // 4/10 = 40% < 50%
  }));
  assert.equal(
    deriveEndpointState({ agg: { failureStreak: 0, attempts: rows }, nowMs }).state,
    ENDPOINT_HEALTH_STATES.DEGRADED,
  );
  // NOT degraded when the rate is exactly at the boundary (50% is not <50%).
  const half = Array.from({ length: DEGRADED_MIN_ATTEMPTS }, (_, i) => ({
    at: nowMs - i - 1,
    outcome: i % 2 === 0 ? "success" : "failure",
  }));
  assert.equal(deriveEndpointState({ agg: { failureStreak: 0, attempts: half }, nowMs }), null);
  // Degraded absent on a stale window: the same rows, aged out entirely.
  assert.equal(
    deriveEndpointState({
      agg: { failureStreak: 0, attempts: rows.map((r) => ({ ...r, at: r.at - win - 10 })) },
      nowMs,
    }),
    null,
  );
  // Unproven: never succeeded inside the window + at least one failure.
  assert.equal(
    deriveEndpointState({ agg: { lastSuccessAt: null, failureStreak: 1, attempts: [{ at: nowMs - 5, outcome: "failure" }] }, nowMs }).state,
    ENDPOINT_HEALTH_STATES.UNPROVEN,
  );
  // A success older than the window no longer proves anything — still unproven.
  assert.equal(
    deriveEndpointState({
      agg: { lastSuccessAt: nowMs - win - 1, failureStreak: 1, attempts: [] },
      nowMs,
    }).state,
    ENDPOINT_HEALTH_STATES.UNPROVEN,
  );
  // A fresh success proves the endpoint — permissive.
  assert.equal(
    deriveEndpointState({
      agg: { lastSuccessAt: nowMs - 5, failureStreak: 0, attempts: [{ at: nowMs - 5, outcome: "success" }] },
      nowMs,
    }),
    null,
  );
  // A fresh successful PROBE clears unproven and transient dead (W8).
  assert.equal(
    deriveEndpointState({
      register: { provenAt: nowMs - 5 },
      agg: { lastSuccessAt: null, failureStreak: DEAD_STREAK, attempts: [] },
      nowMs,
    }),
    null,
  );
});

test("deriveProviderState: the account takes precedence; the endpoint rollup backs the compat view", () => {
  const nowMs = 1000;
  assert.equal(
    deriveProviderState({ account: { state: ACCOUNT_HEALTH_STATES.OUT_OF_CREDIT }, endpointStates: [{ state: "dead" }], nowMs }),
    PROVIDER_HEALTH_STATE.OUT_OF_CREDIT,
  );
  assert.equal(
    deriveProviderState({ account: { state: ACCOUNT_HEALTH_STATES.UNAUTHORIZED }, endpointStates: [], nowMs }),
    PROVIDER_HEALTH_STATE.UNAUTHORIZED,
  );
  assert.equal(
    deriveProviderState({ account: null, endpointStates: [{ state: "dead" }], nowMs }),
    PROVIDER_HEALTH_STATE.FAILING,
  );
  assert.equal(
    deriveProviderState({ account: null, endpointStates: [{ state: "rate-limited", until: nowMs + 5 }], nowMs }),
    PROVIDER_HEALTH_STATE.RATE_LIMITED,
  );
  assert.equal(
    deriveProviderState({ account: null, endpointStates: [{ state: "rate-limited", until: nowMs - 1 }], nowMs }),
    PROVIDER_HEALTH_STATE.OK,
  );
  assert.equal(deriveProviderState({ account: null, endpointStates: [{ state: "unproven" }], nowMs }), PROVIDER_HEALTH_STATE.OK);
});

// ---------------------------------------------------------------------------
// Registers through the real pipeline
// ---------------------------------------------------------------------------

test("402: the account register holds out-of-credit and NO elapsed time re-admits it", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 402 }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // Hours later the flag is STILL set — recovers by evidence, never a clock.
    h.clock.t += 6 * 60 * 60 * 1000;
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    h.clock.t += 30 * 24 * 3600 * 1000;
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // A production success on the account's endpoint clears it (auto-recovery).
    h.clock.t += 1000;
    await h.record(attempt({ outcome: "success" }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("429 with Retry-After: the endpoint register holds an active deadline that auto-recovers on expiry", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 429, retryAfterMs: 5 * 60_000 }));
    assert.equal(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.RATE_LIMITED);
    // The deadline is the clamped ask, and the ACCOUNT stays untouched.
    const entry = h.engine.register.endpoints["anthropic/claude-x"];
    assert.equal(entry.rateLimitedUntil, h.clock.t + 5 * 60_000);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.RATE_LIMITED);
    // After expiry the deadline lifted — the endpoint is not rate-limited
    // anymore (it reads unproven: it failed and has not succeeded since,
    // which deprioritises but never excludes).
    h.clock.t += 5 * 60_000 + 1_000;
    assert.notEqual(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.RATE_LIMITED);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("a 429 without Retry-After clamps to the MIN floor (never a hot loop)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 429 }));
    const entry = h.engine.register.endpoints["anthropic/claude-x"];
    assert.equal(entry.rateLimitedUntil, h.clock.t + MIN_RATE_LIMIT_BACKOFF_MS);
  });
});

test("the SECOND consecutive observed 401 excludes the account; a successful _lastRecoverySuccessAt between them resets the count", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    let recoveryAtSec = null;
    const h = makeHarness(dir, { lastRecoverySuccessAt: () => recoveryAtSec });
    // The issue's named scenario: 401 → [successful recovery] → 401 must NOT
    // arm the exclusion — the credential the first 401 was rejecting is gone
    // (§4.5a), so the count restarts instead of arming.
    await h.record(attempt({ endpointKey: "anthropic/a", httpStatus: 401 }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK, "one 401 arms, not excludes");
    assert.equal(h.engine.register.accounts.anthropic.arming401, 1);
    h.clock.t += 5000;
    recoveryAtSec = Math.floor(h.clock.t / 1000);
    await h.record(attempt({ endpointKey: "anthropic/b", httpStatus: 401 }));
    assert.equal(h.engine.register.accounts.anthropic.arming401, 1, "recovery resets the arming counter");
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK, "no exclusion across a recovery");
    // And the NEXT 401 (no recovery between) re-arms to 2 → excluded.
    await h.record(attempt({ endpointKey: "anthropic/b", httpStatus: 401, attemptId: "a-3" }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.UNAUTHORIZED);
    assert.equal(h.engine.register.accounts.anthropic.arming401, 2);
  });
});

test("an armed unauthorized exclusion survives a bare recovery and clears on the next observed success (§4.5a auto-recovery)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    let recoveryAtSec = null;
    const h = makeHarness(dir, { lastRecoverySuccessAt: () => recoveryAtSec });
    await h.record(attempt({ endpointKey: "anthropic/a", httpStatus: 401 }));
    await h.record(attempt({ endpointKey: "anthropic/a", httpStatus: 401, attemptId: "u-2" }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.UNAUTHORIZED);
    // A recovery event is not a success on the account: the exclusion holds
    // (recovery resets the COUNT, recovery-by-evidence needs a success).
    h.clock.t += 5000;
    recoveryAtSec = Math.floor(h.clock.t / 1000);
    await h.record(attempt({ endpointKey: "anthropic/a", httpStatus: 401, attemptId: "u-3" }));
    assert.equal(h.engine.register.accounts.anthropic.arming401, 1, "the count still resets");
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.UNAUTHORIZED, "the exclusion holds until a success");
    // A production success clears it outright.
    await h.record(attempt({ outcome: "success", endpointKey: "anthropic/a", attemptId: "u-4" }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
    assert.equal(h.engine.register.accounts.anthropic, undefined);
  });
});

test("streak >= 5 health-eligible failures excludes the endpoint; one success resets the streak and re-includes", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    for (let i = 0; i < DEAD_STREAK - 1; i += 1) {
      await h.record(attempt({ attemptId: `s-${i}` })); // generic failures, health-eligible
      assert.notEqual(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.DEAD);
    }
    await h.record(attempt({ attemptId: "s-final" }));
    assert.equal(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.DEAD);
    // Ineligible failures (aborts) never drive the streak.
    await h.record(attempt({ attemptId: "s-abort", errorName: "MessageAbortedError", finish: "abort" }));
    assert.equal(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.DEAD);
    // One production success resets the streak AND re-includes the endpoint.
    await h.record(attempt({ outcome: "success", attemptId: "s-ok" }));
    assert.equal(h.engine.endpointState("anthropic/claude-x"), null);
    assert.equal(h.engine.aggregates["anthropic/claude-x"].failureStreak, 0);
  });
});

test("unproven marks a never-succeeded endpoint (failures on record, no success in the window)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ attemptId: "u-1" }));
    assert.equal(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.UNPROVEN);
    // It deprioritises without excluding: the provider compat view reads ok.
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("20 consecutive content-filter finishes never degrade (the window counts health-eligible rows only)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    for (let i = 0; i < 20; i += 1) {
      await h.record(attempt({ attemptId: `cf-${i}`, errorName: null, finish: "content_filter" }));
      h.clock.t += 1;
    }
    // Not degraded: refusals are not health signals (§4.4). Not dead either —
    // the streak is eligibility-aware too. The rows still land in the ring.
    assert.equal(h.engine.endpointState("anthropic/claude-x"), null);
    assert.equal(h.engine.aggregates["anthropic/claude-x"].attempts.length, 20);
    // And the pure function agrees directly.
    const rows = h.engine.aggregates["anthropic/claude-x"].attempts;
    const s = windowStats(rows, { nowMs: h.clock.t });
    assert.equal(s.total, 0, "zero health-eligible rows in the window");
  });
});

test("degraded fires on <50% over >=10 attempts and is absent on a stale window", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    // 2 successes / 10 attempts = 20% < 50% → degraded. Successes are placed
    // so the TRAILING streak stays below DEAD_STREAK (dead outranks degraded).
    const outcomes = ["failure", "failure", "failure", "failure", "failure", "success", "failure", "failure", "failure", "success"];
    for (let i = 0; i < outcomes.length; i += 1) {
      await h.record(attempt({ attemptId: `d-${i}`, outcome: outcomes[i] }));
      h.clock.t += 1;
    }
    assert.ok(h.engine.aggregates["anthropic/claude-x"].failureStreak < DEAD_STREAK);
    assert.equal(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.DEGRADED);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK, "degraded is soft");
  });
});

test("exclusions and streaks both survive a store reload (a restart is not evidence)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 402, attemptId: "r-402" }));
    await h.record(attempt({ endpointKey: "anthropic/claude-y", attemptId: "r-dead" }));
    for (let i = 0; i < DEAD_STREAK; i += 1) {
      await h.record(attempt({ endpointKey: "anthropic/claude-y", attemptId: `r-${i}` }));
    }
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    assert.equal(h.engine.endpointState("anthropic/claude-y"), ENDPOINT_HEALTH_STATES.DEAD);

    // A FRESH engine over the SAME stores (the reload path a restart takes).
    const h2 = makeHarness(dir, { now: h.clock.t });
    await h2.engine.reload();
    assert.equal(h2.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT, "the account exclusion survives");
    assert.equal(h2.engine.endpointState("anthropic/claude-y"), ENDPOINT_HEALTH_STATES.DEAD, "the derived dead survives — the streak is durable");
    assert.equal(h2.engine.aggregates["anthropic/claude-y"].failureStreak, 1 + DEAD_STREAK, "the streak count survives");
  });
});

test("an absent entry stays permissive — no exclusion by default", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    assert.equal(h.engine.endpointState("never/seen"), null);
    assert.equal(h.engine.providerState("never"), PROVIDER_HEALTH_STATE.OK);
    assert.deepEqual(h.engine.endpointSnapshot(), {});
    assert.deepEqual(h.engine.all(), {});
  });
});

// ---------------------------------------------------------------------------
// W8 recovery
// ---------------------------------------------------------------------------

test("retry: a supported provider still at its meter is NOT cleared and the meter WAS re-read", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    let meterCalls = 0;
    const h = makeHarness(dir, {
      adapterForProvider: (p) => (p === "anthropic" ? "claude" : null),
      meterAtLimit: async () => {
        meterCalls += 1;
        return true;
      },
    });
    await h.record(attempt({ httpStatus: 402 }));
    const res = await h.engine.retry("anthropic");
    assert.equal(res.cleared, false);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    assert.equal(meterCalls, 1);
  });
});

test("retry: the reset clears the exclusion and the probe reports its result (W8 manual reset)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const probes = [];
    // A faithful probe transport: the outcome flows back through the recorder
    // hook (as runSynchronousSession does in production), not just the return
    // value.
    const h = makeHarness(dir, {
      adapterForProvider: (p) => (p === "anthropic" ? "claude" : null),
      meterAtLimit: async () => false,
      probeRun: async ({ providerID, modelID, kind }) => {
        probes.push({ providerID, modelID, kind });
        await h.record(attempt({ probe: true, outcome: "success", endpointKey: `${providerID}/${modelID}`, attemptId: `probe-${probes.length}` }));
        return { outcome: "success" };
      },
    });
    await h.record(attempt({ httpStatus: 402 }));
    const res = await h.engine.retry("anthropic");
    assert.equal(res.cleared, true);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
    assert.deepEqual(probes, [{ providerID: "anthropic", modelID: "claude-x", kind: "manual-reset" }]);
    // The probe's own evidence landed in the register (probe ring + admitted).
    assert.equal(h.engine.register.probes.length, 1);
    assert.equal(h.engine.register.probes[0].outcome, "success");
  });
});

test("retry: a failing probe re-arms an authoritative state from its own evidence", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir, {
      adapterForProvider: () => null, // custom provider — optimistic clear + probe
      probeRun: async ({ providerID, modelID }) => {
        await h.record(attempt({ probe: true, outcome: "failure", httpStatus: 404, endpointKey: `${providerID}/${modelID}`, attemptId: "probe-404" }));
        return { outcome: "failure", code: "x", httpStatus: 404 };
      },
    });
    // The provider needs a KNOWN endpoint for the probe to have a target.
    await h.record(attempt({ endpointKey: "anthropic/claude-y", httpStatus: 500 }));
    const res = await h.engine.retry("anthropic");
    assert.equal(res.cleared, true);
    // The probe recorded a failure whose own evidence re-arms not-found.
    assert.equal(h.engine.register.probes.length, 1);
    assert.equal(h.engine.register.endpoints["anthropic/claude-y"].notFound.reason.httpStatus, 404);
    assert.equal(h.engine.endpointState("anthropic/claude-y"), ENDPOINT_HEALTH_STATES.NOT_FOUND);
  });
});

test("retry on a provider with NO known endpoint clears and reports the probe was skipped", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const probed = [];
    const h = makeHarness(dir, {
      adapterForProvider: () => null,
      probeRun: async (t) => {
        probed.push(t);
        return { outcome: "success" };
      },
    });
    const res = await h.engine.retry("mystery");
    assert.equal(res.cleared, true);
    assert.deepEqual(probed, []);
    assert.ok(res.message.includes("back in the pool"));
  });
});

test("an admission-probe success sets provenAt but NEVER clears an authoritative state (W8)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir, { probeRun: successProbeStub(() => h, []) });
    await h.record(attempt({ endpointKey: "anthropic/claude-y", httpStatus: 404 }));
    assert.equal(h.engine.endpointState("anthropic/claude-y"), ENDPOINT_HEALTH_STATES.NOT_FOUND);
    h.clock.t += PROBE_LADDER_MS[0] + 1000;
    await h.engine.tick(); // the due admission probe passes
    // provenAt landed (unproven/transient-dead cleared) — but the 404 stands:
    // probe evidence never lifts an authoritative state on its own.
    assert.equal(h.engine.register.endpoints["anthropic/claude-y"].provenAt != null, true);
    assert.equal(h.engine.endpointState("anthropic/claude-y"), ENDPOINT_HEALTH_STATES.NOT_FOUND);
  });
});

test("probe evidence never counts as production evidence (excluded from the stats)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    // Five PROBE failures must never drive the streak to dead.
    for (let i = 0; i < DEAD_STREAK; i += 1) {
      await h.record(attempt({ probe: true, httpStatus: 500, attemptId: `p-${i}` }));
    }
    assert.notEqual(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.DEAD);
    assert.equal(h.engine.aggregates["anthropic/claude-x"].failureStreak, 0, "probe failures do not move the aggregates");
    // ...and a probe SUCCESS proves the endpoint (clears unproven).
    await h.record(attempt({ probe: true, outcome: "success", attemptId: "p-ok" }));
    assert.notEqual(h.engine.endpointState("anthropic/claude-x"), ENDPOINT_HEALTH_STATES.UNPROVEN);
  });
});

test("tick runs DUE admission probes up to the per-tick bound and a success admits the endpoint", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const probed = [];
    const h = makeHarness(dir, { probeRun: successProbeStub(() => h, probed) });
    // First-ever failed attempts on several endpoints → admission scheduled.
    for (let i = 0; i < MAX_PROBES_PER_TICK + 1; i += 1) {
      await h.record(attempt({ endpointKey: `anthropic/m-${i}`, attemptId: `t-${i}` }));
    }
    assert.equal(probed.length, 0, "nothing is due yet (first ladder rung is 5m out)");
    h.clock.t += PROBE_LADDER_MS[0] + 1000;
    const ran = await h.engine.tick();
    assert.equal(ran, MAX_PROBES_PER_TICK, "bounded per tick");
    assert.equal(probed.length, MAX_PROBES_PER_TICK);
    // The probed-and-passed endpoints are admitted (no pending admission left
    // for them; the un-probed one keeps its pending slot).
    const pending = Object.values(h.engine.register.endpoints).filter((e) => e.admission?.pending);
    assert.equal(pending.length, 1);
  });
});

test("lastResortRecovery probes the least-recently-failed excluded endpoint and a pass clears the exclusion", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const probed = [];
    const h = makeHarness(dir, { probeRun: successProbeStub(() => h, probed) });
    // Two excluded endpoints: the FIRST one failed least recently.
    await h.record(attempt({ endpointKey: OLD_EP, attemptId: "l-1", httpStatus: 404 }));
    h.clock.t += 10_000;
    await h.record(attempt({ endpointKey: NEW_EP, attemptId: "l-2", httpStatus: 500 }));
    for (let i = 0; i < DEAD_STREAK; i += 1) {
      await h.record(attempt({ endpointKey: NEW_EP, attemptId: `l-3-${i}` }));
    }
    assert.equal(h.engine.endpointState(OLD_EP), ENDPOINT_HEALTH_STATES.NOT_FOUND);
    assert.equal(h.engine.endpointState(NEW_EP), ENDPOINT_HEALTH_STATES.DEAD);

    const recovered = await h.engine.lastResortRecovery([OLD_EP, NEW_EP]);
    assert.equal(recovered, true, "the probe passed");
    assert.deepEqual(probed, ["old"], "the least-recently-failed endpoint is probed");
    assert.equal(h.engine.register.endpoints[OLD_EP].notFound, undefined, "the pass clears the exclusion");
    assert.notEqual(h.engine.endpointState(OLD_EP), ENDPOINT_HEALTH_STATES.NOT_FOUND);

    // The backoff: an immediate second recovery attempt does not re-probe
    // (once, subject to that endpoint's own backoff) and reports false when
    // nothing can run... but the OLD endpoint is no longer excluded, so the
    // next recovery targets NEW and fails it (probeRun now failing).
    const h2 = makeHarness(dir, {
      probeRun: async () => ({ outcome: "failure", code: "still-down" }),
      now: h.clock.t,
    });
    await h2.engine.reload();
    const second = await h2.engine.lastResortRecovery([OLD_EP, NEW_EP]);
    assert.equal(second, false, "a failed probe does not clear anything");
  });
});

test("raiseSelfDoubtAlarm writes a ledger row (rate-limited)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const ledger = captureLedger();
    const h = makeHarness(dir, { ledger });
    await h.engine.raiseSelfDoubtAlarm({ excluded: ["a/x", "b/y"], reason: "no healthy endpoint" });
    assert.equal(ledger.rows.filter((r) => r.kind === "cto.health_self_doubt").length, 1);
    // Rate-limited: a burst does not spam the ledger.
    await h.engine.raiseSelfDoubtAlarm({ excluded: ["a/x"], reason: "again" });
    assert.equal(ledger.rows.filter((r) => r.kind === "cto.health_self_doubt").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Surfacing + delivery
// ---------------------------------------------------------------------------

test("a transition into an excluding state publishes ONCE; recovery clears the marker", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const published = [];
    const h = makeHarness(dir, { publish: (evt) => published.push(evt) });
    await h.record(attempt({ httpStatus: 402 }));
    const events = published.filter((e) => e?.kind === "provider-health.needs-attention");
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.state, PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // A SECOND 402 (still out of credit) does not re-publish.
    h.clock.t += 1000;
    await h.record(attempt({ httpStatus: 402, attemptId: "x-2" }));
    assert.equal(published.filter((e) => e?.kind === "provider-health.needs-attention").length, 1);
    // Recovery clears the marker so a relapse re-publishes.
    await h.record(attempt({ outcome: "success", attemptId: "x-3" }));
    await h.record(attempt({ httpStatus: 402, attemptId: "x-4" }));
    assert.equal(published.filter((e) => e?.kind === "provider-health.needs-attention").length, 2);
  });
});

test("deliverSnapshots clears out-of-credit ONLY on affirmative funds (never on an absent reading)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir, { providerIDForAdapter: (a) => (a === "claude" ? "anthropic" : null) });
    await h.record(attempt({ httpStatus: 402 }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // An exhausted snapshot is no evidence.
    await h.engine.deliverSnapshots([{ provider: "claude", exhausted: true }]);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // A snapshot for an unknown adapter maps to nothing.
    await h.engine.deliverSnapshots([{ provider: "mystery" }]);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    // Funds → cleared.
    await h.engine.deliverSnapshots([{ provider: "claude", exhausted: false }]);
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
  });
});

test("noteConfigChange clears the affected keys and the endpoint re-admits (W8 #2)", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 402 }));
    await h.record(attempt({ endpointKey: "anthropic/claude-y", httpStatus: 404, attemptId: "c-1" }));
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OUT_OF_CREDIT);
    await h.engine.noteConfigChange({ providerID: "anthropic" });
    assert.equal(h.engine.providerState("anthropic"), PROVIDER_HEALTH_STATE.OK);
    assert.deepEqual(h.engine.register.endpoints, {});
    assert.deepEqual(h.engine.register.accounts, {});
  });
});

test("retryIn reports the provider's longest active deadline, null when none", async () => {
  await withTmpDir("ep-health-", async (dir) => {
    const h = makeHarness(dir);
    assert.equal(h.engine.retryIn("anthropic"), null);
    await h.record(attempt({ endpointKey: "anthropic/a", httpStatus: 429, retryAfterMs: 60_000, attemptId: "ri-1" }));
    h.clock.t += 10_000;
    await h.record(attempt({ endpointKey: "anthropic/b", httpStatus: 429, retryAfterMs: 120_000, attemptId: "ri-2" }));
    const ms = h.engine.retryIn("anthropic");
    assert.ok(ms > 100_000 && ms <= 120_000, `the longest deadline wins (${ms})`);
  });
});
