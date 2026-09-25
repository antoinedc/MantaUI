// endpointAttempts.test.mjs — the §4 attempt-lifecycle store (BET-1534, W2/W3).
//
// Pure ring/eligibility/abandon math, the quarantine+alarm store contract, and
// the recorder's idempotency + persistence-failure behavior. All I/O is either
// injected memory or an explicit tmp path (never the sandboxed live state).

// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENDPOINT_ATTEMPTS_VERSION,
  ATTEMPT_RING_CAP,
  ATTEMPT_RING_WINDOW_MS,
  ABANDON_GRACE_MS,
  createEndpointAttemptsPayload,
  validateEndpointAttemptsPayload,
  capAttemptRing,
  isHealthEligibleFailure,
  applyAttempt,
  abandonExpiredOperations,
  createEndpointAttemptsStore,
  createEndpointAttemptRecorder,
  newAttemptId,
} from "./endpointAttempts.mjs";
import { withTmpDir, captureLedger } from "./fixtures/ctoStoreTestFixtures.mjs";

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

test("validateEndpointAttemptsPayload accepts and normalizes a v1 payload", () => {
  const normalized = validateEndpointAttemptsPayload({ v: 1, operations: [], endpoints: {} });
  assert.equal(normalized.v, ENDPOINT_ATTEMPTS_VERSION);
  assert.deepEqual(normalized.operations, []);
  assert.deepEqual(normalized.endpoints, {});
});

test("validateEndpointAttemptsPayload treats a missing v as v1 and fills missing keys", () => {
  const normalized = validateEndpointAttemptsPayload({});
  assert.equal(normalized.v, ENDPOINT_ATTEMPTS_VERSION);
  assert.deepEqual(normalized.operations, []);
  assert.deepEqual(normalized.endpoints, {});
});

test("validateEndpointAttemptsPayload throws on corrupt (non-object) payloads", () => {
  for (const bad of [null, 42, "x", [], true]) {
    assert.throws(() => validateEndpointAttemptsPayload(bad), /not an object|corrupt/);
  }
});

test("validateEndpointAttemptsPayload throws on a NEWER schema version (never truncate)", () => {
  assert.throws(() => validateEndpointAttemptsPayload({ v: 999 }), /newer than the supported version/);
  assert.throws(() => validateEndpointAttemptsPayload({ v: -1 }), /invalid schema version/);
});

// ---------------------------------------------------------------------------
// Bounded ring: 200 entries or 30 days, whichever binds first (W2)
// ---------------------------------------------------------------------------

test("capAttemptRing evicts entries older than 30 days and caps at 200", () => {
  const nowMs = 1_000_000_000_000;
  const stale = { at: nowMs - ATTEMPT_RING_WINDOW_MS - 1 };
  // Append order is chronological (oldest first, newest last) — the store
  // never re-sorts, it only drops.
  const recent = Array.from({ length: 250 }, (_, i) => ({ at: nowMs - (249 - i) }));
  const ring = capAttemptRing([stale, ...recent], { nowMs });
  assert.equal(ring.length, ATTEMPT_RING_CAP); // 30d window binds nothing here; the cap does
  assert.equal(ring[0].at, nowMs - 199); // newest 200, chronological
  const justInside = { at: nowMs - ATTEMPT_RING_WINDOW_MS };
  assert.ok(capAttemptRing([justInside], { nowMs }).length === 1); // boundary-exact: kept
});

test("capAttemptRing uses startedAt as the age field for operation records", () => {
  const nowMs = 5_000_000_000;
  const op = { startedAt: nowMs - ATTEMPT_RING_WINDOW_MS - 1 };
  assert.deepEqual(capAttemptRing([op], { nowMs }), []);
});

// ---------------------------------------------------------------------------
// §4.4 health eligibility
// ---------------------------------------------------------------------------

test("isHealthEligibleFailure matrix per §4.4", () => {
  const base = { outcome: "failure", errorName: null, httpStatus: null, finish: null };
  assert.equal(isHealthEligibleFailure({ ...base, errorName: "APIError", httpStatus: 429 }), true);
  assert.equal(isHealthEligibleFailure({ ...base, errorName: "APIError" }), true, "no status → transient, one sample");
  assert.equal(isHealthEligibleFailure({ ...base, errorName: "UnknownError" }), true);
  assert.equal(isHealthEligibleFailure({ ...base, finish: "error" }), true, "finish error with no object → transient");
  assert.equal(isHealthEligibleFailure({ ...base, errorName: "MessageAbortedError" }), false);
  assert.equal(isHealthEligibleFailure({ ...base, errorName: "ContentFilterError" }), false);
  assert.equal(isHealthEligibleFailure({ ...base, finish: "content_filter" }), false);
  assert.equal(isHealthEligibleFailure({ ...base, finish: "refusal" }), false);
  assert.equal(isHealthEligibleFailure({ ...base, finish: "max_tokens" }), false, "output cap");
  assert.equal(isHealthEligibleFailure({ ...base, finish: "length" }), false, "output cap (OpenAI)");
  assert.equal(isHealthEligibleFailure({ ...base, finish: "model_context_window_exceeded" }), false, "context cap");
  assert.equal(isHealthEligibleFailure({ ...base, outcome: "success" }), false);
});

// ---------------------------------------------------------------------------
// Streak + lastSuccessAt aggregates
// ---------------------------------------------------------------------------

test("applyAttempt: success stamps lastSuccessAt and clears the streak", () => {
  const next = applyAttempt(
    { at: 111, outcome: "success" },
    { failureStreak: 4, attempts: [] },
  );
  assert.equal(next.lastSuccessAt, 111);
  assert.equal(next.failureStreak, 0);
});

test("applyAttempt: eligible failures increment; ineligible leave the streak; only success resets", () => {
  let ep = { attempts: [] };
  ep = applyAttempt({ at: 1, outcome: "failure", errorName: "APIError", httpStatus: 429 }, ep);
  ep = applyAttempt({ at: 2, outcome: "failure", errorName: "APIError", httpStatus: 429 }, ep);
  assert.equal(ep.failureStreak, 2);
  ep = applyAttempt({ at: 3, outcome: "failure", errorName: "ContentFilterError" }, ep);
  assert.equal(ep.failureStreak, 2, "content filter is not a health signal");
  ep = applyAttempt({ at: 4, outcome: "failure", finish: "refusal" }, ep);
  assert.equal(ep.failureStreak, 2);
  ep = applyAttempt({ at: 5, outcome: "failure", errorName: "APIError", httpStatus: 500 }, ep);
  assert.equal(ep.failureStreak, 3);
  ep = applyAttempt({ at: 6, outcome: "failure", errorName: "MessageAbortedError" }, ep);
  assert.equal(ep.failureStreak, 3, "abort is ignored entirely");
  ep = applyAttempt({ at: 7, outcome: "success" }, ep);
  assert.equal(ep.failureStreak, 0);
  assert.equal(ep.lastSuccessAt, 7);
});

// ---------------------------------------------------------------------------
// Abandoned sweep (§4.3)
// ---------------------------------------------------------------------------

test("abandonExpiredOperations terminalizes past deadlineAt+60s only", () => {
  const nowMs = 10_000_000;
  const stale = { attemptId: "a", deadlineAt: nowMs - ABANDON_GRACE_MS - 1 };
  const boundary = { attemptId: "b", deadlineAt: nowMs - ABANDON_GRACE_MS };
  const fresh = { attemptId: "c", deadlineAt: nowMs - ABANDON_GRACE_MS + 1 };
  const terminal = { attemptId: "d", deadlineAt: nowMs - ABANDON_GRACE_MS - 1000, terminal: { at: 1, code: "ok" } };
  const noDeadline = { attemptId: "e" };
  const { operations, changed } = abandonExpiredOperations(
    [stale, boundary, fresh, terminal, noDeadline], { nowMs },
  );
  assert.equal(changed, true);
  assert.equal(operations[0].terminal.code, "abandoned");
  assert.equal(operations[0].terminal.at, nowMs);
  assert.equal(operations[0].terminal.stage, null, "the swept stage is unknown");
  assert.equal(operations[1].terminal, undefined, "boundary-exact: not yet due");
  assert.equal(operations[2].terminal, undefined);
  assert.equal(operations[3].terminal.code, "ok", "an existing terminal is never overwritten");
  assert.equal(operations[4].terminal, undefined);
  const unchanged = abandonExpiredOperations([fresh], { nowMs });
  assert.equal(unchanged.changed, false);
});

// ---------------------------------------------------------------------------
// Store: quarantine + alarm, newer-version refusal
// ---------------------------------------------------------------------------


test("store.load quarantines a corrupt payload aside, rebuilds empty and alarms", async () => {
  await withTmpDir("ep-attempts-", async (dir) => {
    const path = join(dir, "endpoint-attempts.json");
    await writeFile(path, "{ not json at all", "utf-8");
    const ledger = captureLedger();
    const warns = [];
    const store = createEndpointAttemptsStore({
      path, ledger, now: () => 1234, warn: (m) => warns.push(m),
    });
    const payload = await store.load();
    assert.deepEqual(payload, createEndpointAttemptsPayload());
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes(".corrupt-")).length, 1, "quarantined aside");
    assert.equal(ledger.rows.filter((r) => r.kind === "cto.endpoint_attempts_quarantined").length, 1);
    assert.ok(warns.some((w) => w.includes("endpoint-attempts")));
  });
});

test("store.load quarantines a shape-corrupt (non-object) payload too", async () => {
  await withTmpDir("ep-attempts-", async (dir) => {
    const path = join(dir, "endpoint-attempts.json");
    await writeFile(path, JSON.stringify([1, 2, 3]), "utf-8");
    const ledger = captureLedger();
    const store = createEndpointAttemptsStore({ path, ledger, now: () => 1234 });
    assert.deepEqual(await store.load(), createEndpointAttemptsPayload());
    assert.equal(ledger.rows.length, 1);
  });
});

test("store.load refuses a NEWER schema version loudly without destroying the file", async () => {
  await withTmpDir("ep-attempts-", async (dir) => {
    const path = join(dir, "endpoint-attempts.json");
    await writeFile(path, JSON.stringify({ v: 99, operations: [] }), "utf-8");
    const store = createEndpointAttemptsStore({ path, ledger: captureLedger(), now: () => 1234 });
    await assert.rejects(() => store.load(), /newer than the supported version/);
    const raw = JSON.parse(await readFile(path, "utf-8"));
    assert.equal(raw.v, 99, "the future-schema file is untouched");
  });
});

test("store.load returns empty payload when the file does not exist", async () => {
  await withTmpDir("ep-attempts-", async (dir) => {
    const store = createEndpointAttemptsStore({ path: join(dir, "missing.json"), now: () => 1234 });
    assert.deepEqual(await store.load(), createEndpointAttemptsPayload());
  });
});

// ---------------------------------------------------------------------------
// Recorder: begin/dispatch/terminalize/attempt idempotency + sweep + alarms
// ---------------------------------------------------------------------------

function memoryStore(initial = createEndpointAttemptsPayload()) {
  let payload = initial;
  return {
    name: "endpoint-attempts-test",
    path: "mem://endpoint-attempts-test",
    load: async () => JSON.parse(JSON.stringify(payload)),
    save: async (p) => { payload = p; },
  };
}

function makeRecorder({ now = () => 1000, store } = {}) {
  const ledger = captureLedger();
  const warns = [];
  const rec = createEndpointAttemptRecorder({
    store: store ?? memoryStore(), ledger, now, warn: (m) => warns.push(m),
  });
  return { rec, ledger, warns };
}

test("beginOperation writes a not-dispatched skeleton; markDispatched refines it; terminalize settles it once", async () => {
  const store = memoryStore();
  const { rec } = makeRecorder({ store });
  // gitleaks:allow — a test fixture, not a credential (entropy false positive)
  await rec.beginOperation({ attemptId: "a1", operation: "segment-summary", startedAt: 10, deadlineAt: 100, intendedEndpointKey: "anthropic/m1" });  // gitleaks:allow
  let p = await store.load();
  assert.equal(p.operations.length, 1);
  assert.equal(p.operations[0].attribution, "not-dispatched");
  assert.equal(p.operations[0].intendedEndpointKey, "anthropic/m1");  // gitleaks:allow

  await rec.markDispatched("a1", true);
  p = await store.load();
  assert.equal(p.operations[0].attribution, "intended");

  await rec.terminalizeOperation({
    attemptId: "a1", attribution: "observed",
    terminal: { at: 50, code: "model-error-402", stage: "model" },
  });
  p = await store.load();
  assert.equal(p.operations.length, 1, "terminalize settles, never duplicates");
  assert.equal(p.operations[0].attribution, "observed");
  assert.deepEqual(p.operations[0].terminal, { at: 50, code: "model-error-402", stage: "model" });

  await rec.terminalizeOperation({
    attemptId: "a1", attribution: "not-dispatched",
    terminal: { at: 51, code: "abandoned", stage: null },
  });
  p = await store.load();
  assert.equal(p.operations.length, 1, "first-writer-wins on attemptId (duplicate delivery → one, not two)");
  assert.equal(p.operations[0].terminal.at, 50);
  assert.equal(p.operations[0].attribution, "observed");
});

test("terminalizeOperation for an unknown attemptId creates nothing", async () => {
  const store = memoryStore();
  const { rec } = makeRecorder({ store });
  await rec.terminalizeOperation({ attemptId: "ghost", attribution: "observed", terminal: { at: 1, code: "ok" } });
  assert.deepEqual((await store.load()).operations, []);
});

test("recordProviderAttempt appends to the endpoint ring, updates aggregates, and is idempotent", async () => {
  const store = memoryStore();
  const { rec } = makeRecorder({ store });
  const attempt = {
    attemptId: "a1", endpointKey: "anthropic/claude-x", accountKey: "anthropic",
    at: 10, attribution: "observed", outcome: "failure", errorName: "APIError",
    httpStatus: 402, retryable: false, finish: null,
  };
  await rec.recordProviderAttempt(attempt);
  await rec.recordProviderAttempt({ ...attempt }); // duplicate delivery → one
  const p = await store.load();
  const ep = p.endpoints["anthropic/claude-x"];
  assert.equal(ep.attempts.length, 1);
  assert.equal(ep.failureStreak, 1, "402 is a health-eligible failure");
  assert.equal(ep.lastSuccessAt, undefined);
  await rec.recordProviderAttempt({ ...attempt, attemptId: "a2", outcome: "success", errorName: null, httpStatus: null });
  const p2 = await store.load();
  const ep2 = p2.endpoints["anthropic/claude-x"];
  assert.equal(ep2.attempts.length, 2);
  assert.equal(ep2.failureStreak, 0);
  assert.equal(ep2.lastSuccessAt, 10);
});

test("recordProviderAttempt skips attempts without an endpoint identity", async () => {
  const store = memoryStore();
  const { rec } = makeRecorder({ store });
  await rec.recordProviderAttempt({ attemptId: "a1", endpointKey: "", outcome: "failure" });
  assert.deepEqual((await store.load()).endpoints, {});
});

test("sweepAbandoned closes stale skeletons as abandoned", async () => {
  const store = memoryStore();
  const { rec } = makeRecorder({ store, now: () => 1_000_000 });
  await rec.beginOperation({ attemptId: "stale", operation: "op", startedAt: 0, deadlineAt: 1_000_000 - ABANDON_GRACE_MS - 1 });
  await rec.beginOperation({ attemptId: "fresh", operation: "op", startedAt: 0, deadlineAt: 1_000_000 });
  await rec.sweepAbandoned();
  const p = await store.load();
  const stale = p.operations.find((o) => o.attemptId === "stale");
  const fresh = p.operations.find((o) => o.attemptId === "fresh");
  assert.equal(stale.terminal.code, "abandoned");
  assert.equal(fresh.terminal, undefined);
});

test("persistence failures alarm (rate-limited) and never throw", async () => {
  const ledger = captureLedger();
  let ticks = 0;
  const rec = createEndpointAttemptRecorder({
    store: { name: "x", path: "mem://x", load: async () => createEndpointAttemptsPayload(), save: async () => { throw new Error("disk gone"); } },
    ledger, now: () => 1000 + ticks++ * 1000, warn: () => {},
  });
  await rec.beginOperation({ attemptId: "a1", operation: "op", startedAt: 0, deadlineAt: 100 });
  await rec.recordProviderAttempt({ attemptId: "a2", endpointKey: "p/m", outcome: "failure" });
  await rec.terminalizeOperation({ attemptId: "a3", attribution: "observed", terminal: { at: 1, code: "ok" } });
  await rec.recordProviderAttempt({ attemptId: "a4", endpointKey: "p/m", outcome: "failure" });
  const kinds = ledger.rows.map((r) => r.kind);
  assert.ok(kinds.includes("cto.endpoint_attempts_persist_failed"));
  assert.equal(kinds.length, 1, "rate-limited to one alarm per window");
});

test("probe attempts are recorded in the ring but never move the aggregates (W8/BET-1536)", async () => {
  const store = memoryStore();
  const { rec } = makeRecorder({ store });
  const probe = {
    attemptId: "p1", endpointKey: "anthropic/claude-x", accountKey: "anthropic",
    at: 10, attribution: "observed", outcome: "failure", errorName: "APIError",
    httpStatus: 500, retryable: true, finish: null, probe: true,
  };
  await rec.recordProviderAttempt(probe);
  let ep = (await store.load()).endpoints["anthropic/claude-x"];
  assert.equal(ep.attempts.length, 1, "the probe row lands in the ring as evidence");
  assert.equal(ep.failureStreak, 0, "a probe failure never drives the streak");
  await rec.recordProviderAttempt({ ...probe, attemptId: "p2", outcome: "success", httpStatus: null });
  ep = (await store.load()).endpoints["anthropic/claude-x"];
  assert.equal(ep.lastSuccessAt, undefined, "a probe success never sets lastSuccessAt");
  // The pure reducer agrees (a reload can never disagree with the live fold).
  const folded = applyAttempt({ ...probe, outcome: "success" }, { failureStreak: 3, attempts: [] });
  assert.equal(folded.failureStreak, 3);
  assert.equal(folded.lastSuccessAt, undefined);
});

test("beginOperation stores the probe marker and the post-persist hook fires once per attempt", async () => {
  const store = memoryStore();
  const seen = [];
  const rec = createEndpointAttemptRecorder({
    store, ledger: captureLedger(), now: () => 1000, warn: () => {},
    onAttempt: async (a) => { seen.push(a.attemptId); },
  });
  await rec.beginOperation({ attemptId: "op1", operation: "health-probe:admission", startedAt: 0, deadlineAt: 100, probe: true });
  const op = (await store.load()).operations.find((o) => o.attemptId === "op1");
  assert.equal(op.probe, true, "the operation record carries the probe marker");
  const plain = { attemptId: "a1", endpointKey: "p/m", outcome: "failure" };
  await rec.recordProviderAttempt(plain);
  await rec.recordProviderAttempt(plain); // idempotent → the hook fires once
  assert.deepEqual(seen, ["a1"]);
  // A throwing hook must never break the recorder contract.
  const rec2 = createEndpointAttemptRecorder({
    store: memoryStore(), ledger: captureLedger(), now: () => 1000, warn: () => {},
    onAttempt: async () => { throw new Error("health engine exploded"); },
  });
  await assert.doesNotReject(() => rec2.recordProviderAttempt({ attemptId: "a2", endpointKey: "p/m", outcome: "failure" }));
});

test("newAttemptId returns unique ids", () => {
  assert.notEqual(newAttemptId(), newAttemptId());
});

// ---- BET-1537 (S5, §W7.3): the loss-signal rows for the infrastructure
// watcher's sustained-rate signal. ----

test("a terminalize that settles still-not-dispatched emits one loss row; a refined settle emits none", async () => {
  const { rec, ledger } = makeRecorder();
  await rec.beginOperation({ attemptId: "lost-1", operation: "triage", startedAt: 10, deadlineAt: 100 });
  await rec.terminalizeOperation({
    attemptId: "lost-1", attribution: "not-dispatched",
    terminal: { at: 50, code: "no-healthy-endpoint", stage: null },
  });
  let rows = ledger.rows.filter((r) => r.kind === "cto.operation_not_dispatched");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, "lost-1");

  // A settle whose attribution was REFINED before terminalizing is not a loss.
  await rec.beginOperation({ attemptId: "ran-1", operation: "triage", startedAt: 10, deadlineAt: 100 });
  await rec.markDispatched("ran-1", true);
  await rec.terminalizeOperation({
    attemptId: "ran-1", attribution: "observed",
    terminal: { at: 60, code: "ok", stage: null },
  });
  rows = ledger.rows.filter((r) => r.kind === "cto.operation_not_dispatched");
  assert.equal(rows.length, 1, "the dispatched run is not a loss");
});

test("sweepAbandoned emits ONE weighted row for the batch it closed", async () => {
  const { rec, ledger } = makeRecorder({ now: () => 1_000_000 });
  await rec.beginOperation({ attemptId: "g-1", operation: "triage", startedAt: 10, deadlineAt: 100 });
  await rec.beginOperation({ attemptId: "g-2", operation: "triage", startedAt: 10, deadlineAt: 100 });
  await rec.sweepAbandoned();
  const rows = ledger.rows.filter((r) => r.kind === "cto.operations_abandoned");
  assert.equal(rows.length, 1, "one row per sweep, not per record");
  assert.equal(rows[0].count, 2);
  // A second sweep with nothing to close emits nothing.
  await rec.sweepAbandoned();
  assert.equal(ledger.rows.filter((r) => r.kind === "cto.operations_abandoned").length, 1);
});

// 2026-09-25: an ordinary session's 429 now feeds the health registers.
import { attemptFromAssistantError } from "./endpointAttempts.mjs";

test("attemptFromAssistantError: a 429 usage-limit assistant error becomes an observed failure with the reset hint", () => {
  const info = {
    id: "msg_a1", role: "assistant", providerID: "openai", modelID: "gpt-6-astra",
    error: { name: "APIError", data: { message: "The usage limit has been reached", statusCode: 429, isRetryable: true,
      responseHeaders: { "x-codex-primary-reset-after-seconds": "222591" } } },
  };
  const a = attemptFromAssistantError(info, 1000);
  assert.equal(a.attemptId, "observed:msg_a1", "idempotent per message");
  assert.equal(a.endpointKey, "openai/gpt-6-astra");
  assert.equal(a.accountKey, "openai");
  assert.equal(a.httpStatus, 429);
  assert.equal(a.outcome, "failure");
  assert.equal(a.retryAfterMs, 222591000);
});

test("attemptFromAssistantError: only account-level refusals on assistant rows count", () => {
  const base = { id: "m", role: "assistant", providerID: "p", modelID: "m" };
  assert.equal(attemptFromAssistantError({ ...base, error: { data: { statusCode: 500 } } }), null);
  assert.equal(attemptFromAssistantError({ ...base }), null);
  assert.equal(attemptFromAssistantError({ ...base, role: "user", error: { data: { statusCode: 429 } } }), null);
  assert.equal(attemptFromAssistantError({ ...base, providerID: undefined, error: { data: { statusCode: 429 } } }), null);
  assert.equal(attemptFromAssistantError({ ...base, error: { data: { statusCode: 402 } } }).httpStatus, 402);
});
