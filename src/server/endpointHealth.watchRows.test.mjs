// endpointHealth.watchRows.test.mjs — BET-1537 S5 (§W7.2): the health
// engine's durable-exclusion transition rows — the endpoint watcher's input.
// The engine emits `cto.endpoint_excluded` on ENTERING a durable excluding
// state (edge-detected; a re-confirming failure emits nothing) and
// `cto.endpoint_recovered` on an evidence-based clear. rate-limited and the
// soft states emit nothing. Hermetic — tmp stores, a capture ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEndpointAttemptRecorder, createEndpointAttemptsStore } from "./endpointAttempts.mjs";
import {
  createEndpointHealth,
  createEndpointHealthStore,
  createEndpointHealthPayload,
} from "./endpointHealth.mjs";
import { withTmpDir, captureLedger } from "./fixtures/ctoStoreTestFixtures.mjs";

const attempt = (over = {}) => ({
  attemptId: over.attemptId ?? `a-${Math.random().toString(36).slice(2)}`,
  endpointKey: over.endpointKey ?? "anthropic/claude-x",
  accountKey: (over.endpointKey ?? "anthropic/claude-x").split("/")[0],
  outcome: "failure",
  httpStatus: null,
  errorName: null,
  ...over,
});

// The full pipeline harness with ONE shared capture ledger for both stores,
// so the transition rows are visible next to the store alarm rows.
function makeHarness(dir, { now = 1000, probeRun = null } = {}) {
  const clock = { t: now };
  const ledger = captureLedger();
  let engine = null;
  const attempts = createEndpointAttemptRecorder({
    store: createEndpointAttemptsStore({ path: join(dir, "attempts.json"), ledger, now: () => clock.t }),
    now: () => clock.t,
    onAttempt: (a) => engine.recordAttempt(a),
  });
  engine = createEndpointHealth({
    now: () => clock.t,
    ledger,
    store: createEndpointHealthStore({ path: join(dir, "health.json"), ledger, now: () => clock.t }),
    attempts,
    jitter: () => 0.5,
    ...(probeRun ? { probeRun } : {}),
  });
  return {
    clock,
    engine,
    ledger,
    record: (a) => attempts.recordProviderAttempt({ at: clock.t, ...a }),
  };
}

const watchRows = (ledger) =>
  ledger.rows.filter((r) => r.kind === "cto.endpoint_excluded" || r.kind === "cto.endpoint_recovered");

test("the 5th consecutive failure enters `dead` and emits ONE exclusion row; re-confirms emit nothing", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    for (let i = 0; i < 5; i++) {
      await h.record(attempt({ httpStatus: 503, errorName: "APIError" }));
    }
    let rows = watchRows(h.ledger);
    assert.equal(rows.length, 1, "edge-detected: one row on entering");
    assert.equal(rows[0].kind, "cto.endpoint_excluded");
    assert.equal(rows[0].subject, "anthropic/claude-x");
    assert.equal(rows[0].scope, "endpoint");
    assert.equal(rows[0].state, "dead");
    assert.equal(rows[0].reason.httpStatus, 503);
    assert.equal(rows[0].reason.streak, 5);

    // The 6th+ failure re-confirms — no new row.
    await h.record(attempt({ httpStatus: 503, errorName: "APIError" }));
    rows = watchRows(h.ledger);
    assert.equal(rows.length, 1);
  });
});

test("a success after `dead` clears it and emits the recovery row", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    for (let i = 0; i < 5; i++) {
      await h.record(attempt({ httpStatus: 503, errorName: "APIError" }));
    }
    await h.record(attempt({ outcome: "success", httpStatus: 200 }));
    const rows = watchRows(h.ledger);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].kind, "cto.endpoint_recovered");
    assert.equal(rows[1].subject, "anthropic/claude-x");
    assert.equal(rows[1].scope, "endpoint");
  });
});

test("a FIRST 404/403 emits an authoritative exclusion row; a repeat emits nothing", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 404, errorName: "NotFoundError" }));
    let rows = watchRows(h.ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "not-found");
    assert.equal(rows[0].reason.httpStatus, 404);

    await h.record(attempt({ httpStatus: 404, errorName: "NotFoundError" }));
    assert.equal(watchRows(h.ledger).length, 1, "re-confirming 404 dedupes at the source");
  });
});

test("the SECOND consecutive 401 excludes the account and emits an account-scope row; a success recovers it", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 401, errorName: "APIError" }));
    assert.equal(watchRows(h.ledger).length, 0, "one 401 arms only — no row");

    await h.record(attempt({ httpStatus: 401, errorName: "APIError" }));
    let rows = watchRows(h.ledger);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "account");
    assert.equal(rows[0].subject, "anthropic");
    assert.equal(rows[0].state, "unauthorized");

    await h.record(attempt({ outcome: "success", httpStatus: 200 }));
    rows = watchRows(h.ledger);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].kind, "cto.endpoint_recovered");
    assert.equal(rows[1].scope, "account");
  });
});

test("a 429 (rate-limited) emits NO watcher row — the deadline is self-recovering", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 429, errorName: "APIError", retryAfterMs: 5 * 60_000 }));
    assert.equal(watchRows(h.ledger).length, 0);
  });
});

test("a manual reset emits recovery rows for the cleared subjects (the user is the evidence)", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ httpStatus: 404, errorName: "NotFoundError" }));
    assert.equal(watchRows(h.ledger).length, 1);
    await h.engine.resetProvider("anthropic");
    const rows = watchRows(h.ledger);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].kind, "cto.endpoint_recovered");
    assert.equal(rows[1].subject, "anthropic/claude-x");
  });
});

test("a probe pass clears a transient dead and emits the recovery row; a probe 404 re-excludes", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    let probed = false;
    let h = null;
    h = makeHarness(dir, {
      // The probe attempt flows through the RECORDER, exactly as production's
      // runSynchronousSession probe does — that is what lands the probe
      // evidence (and its transition rows) in the register.
      probeRun: async () => {
        probed = true;
        await h.record(attempt({ probe: true, outcome: "success", attemptId: "probe-ok" }));
        return { outcome: "success" };
      },
    });
    for (let i = 0; i < 5; i++) {
      await h.record(attempt({ httpStatus: 503, errorName: "APIError" }));
    }
    assert.equal(watchRows(h.ledger).length, 1); // dead, row emitted
    const r = await h.engine.probeEndpoint("anthropic/claude-x", { kind: "manual-reset", force: true });
    assert.equal(r?.outcome, "success");
    assert.equal(probed, true);
    const rows = watchRows(h.ledger);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].kind, "cto.endpoint_recovered");

    // A probe that hits 404 re-excludes — a new incident after recovery.
    const h2 = makeHarness(dir, {
      probeRun: async () => {
        await h2.record(attempt({ probe: true, outcome: "failure", httpStatus: 404, attemptId: "probe-404" }));
        return { outcome: "failure", code: "probe-http-404", httpStatus: 404 };
      },
    });
    await h2.engine.probeEndpoint("anthropic/claude-x", { kind: "manual-reset", force: true });
    const rows2 = watchRows(h2.ledger);
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0].kind, "cto.endpoint_excluded");
    assert.equal(rows2[0].state, "not-found");
  });
});

test("endpointDetail returns state, deadline, reason AND the §W9 window activity", async () => {
  await withTmpDir("manta-healthwatch-", async (dir) => {
    const h = makeHarness(dir);
    await h.record(attempt({ outcome: "success", httpStatus: 200 }));
    await h.record(attempt({ httpStatus: 503, errorName: "APIError" }));
    await h.record(attempt({ httpStatus: 429, errorName: "APIError", retryAfterMs: 5 * 60_000 }));
    const detail = h.engine.endpointDetail();
    const entry = detail["anthropic/claude-x"];
    assert.ok(entry, "the register knows the endpoint");
    assert.equal(entry.state, "rate-limited");
    assert.ok(entry.retryInMs > 0 && entry.retryInMs <= 5 * 60_000);
    assert.equal(entry.reason.httpStatus, 429);
    assert.equal(entry.reason.errorName, "APIError");
    // §W9 window activity from the aggregates (probe-excluded, exactly what
    // routing sees): last success + attempts + successes in the window.
    assert.equal(entry.lastSuccessAt, 1000);
    assert.equal(entry.attempts, 3);
    assert.equal(entry.successes, 1);
    assert.deepEqual(createEndpointHealthPayload().endpoints, {});
  });
});
