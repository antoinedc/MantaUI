// ctoSessions.failover.test.mjs — BET-1537 S5 (W6): the endpoint failover
// split of the shared two-call budget. Hermetic — injected oc/resolveModel/
// ledger, no live opencode, no fs.

import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEphemeral } from "./ctoSessions.mjs";
import { runFailureClass, canFailover } from "./ctoRunOutcome.mjs";

function fakeEngineState(initial = {}) {
  let payload = { ...initial };
  return {
    async load() {
      return payload;
    },
    async save(p) {
      payload = p;
    },
    peek() {
      return payload;
    },
  };
}

function fakeLedger() {
  const rows = [];
  return {
    rows,
    async append(row) {
      rows.push(row);
    },
    outcomeCodes() {
      return rows.filter((r) => r.kind === "cto.operation_outcome").map((r) => r.code);
    },
  };
}

// The oc stub: `script` is a list of per-call results (or a constant).
function fakeOc(script) {
  const calls = [];
  const list = Array.isArray(script) ? script : null;
  const oc = {
    get calls() {
      return calls;
    },
    async runEphemeralSession({ model, onCreated }) {
      calls.push(model ?? null);
      await onCreated(`sid-${calls.length}`);
      const res = list ? list[Math.min(calls.length - 1, list.length - 1)] : script;
      return { text: "", sid: `sid-${calls.length}`, ...(typeof res === "function" ? res() : res) };
    },
  };
  return oc;
}

// A resolver that honors the exclusion set exactly like defaultResolveModel:
// endpoint "p/a" is the default choice; when excluded it falls to "p/b".
const aThenB = async ({ excludeEndpointKeys = [] } = {}) =>
  excludeEndpointKeys.includes("p/a") ? { providerID: "p", modelID: "b" } : { providerID: "p", modelID: "a" };

const fail429 = { ok: false, code: "model-error-429", httpStatus: 429, errorName: "APIError", retryable: true };

// ---------------------------------------------------------------------------
// runFailureClass / canFailover — the W6 classification (pure)
// ---------------------------------------------------------------------------

test("runFailureClass: provider / quality / local three-way split", () => {
  assert.equal(runFailureClass({ ok: false, code: "model-error-429" }), "provider");
  assert.equal(runFailureClass({ ok: false, code: "model-error" }), "provider");
  assert.equal(runFailureClass({ ok: false, code: "model-error-5xx", httpStatus: 503 }), "provider");
  // §4.1a: a prompt-http 402/429 on a PINNED model is provider evidence.
  assert.equal(runFailureClass({ ok: false, code: "prompt-http", httpStatus: 402, pinned: true }), "provider");
  assert.equal(runFailureClass({ ok: false, code: "prompt-http", httpStatus: 429, pinned: true }), "provider");
  // …and on an UNPINNED default it is ambiguous — local.
  assert.equal(runFailureClass({ ok: false, code: "prompt-http", httpStatus: 402, pinned: false }), "local");
  // Quality cascade unchanged.
  assert.equal(runFailureClass({ ok: false, code: "empty-output" }), "quality");
  assert.equal(runFailureClass({ ok: false, code: "schema-invalid" }), "quality");
  // Local lifecycle + verdicts.
  assert.equal(runFailureClass({ ok: false, code: "create-http", httpStatus: 500 }), "local");
  assert.equal(runFailureClass({ ok: false, code: "provenance-error" }), "local");
  assert.equal(runFailureClass({ ok: false, code: "no-healthy-endpoint" }), "local");
  assert.equal(runFailureClass({ ok: false, code: "no-alternate-endpoint" }), "local");
  assert.equal(runFailureClass({ ok: true }), null);
});

test("canFailover: never a non-retryable failure or an authoritative status", () => {
  assert.equal(canFailover({ ok: false, code: "model-error-429", httpStatus: 429, retryable: true }), true);
  assert.equal(canFailover({ ok: false, code: "model-error-5xx", httpStatus: 503 }), true);
  assert.equal(canFailover({ ok: false, code: "model-error", retryable: true }), true);
  // The provider itself said non-retryable.
  assert.equal(canFailover({ ok: false, code: "model-error-429", httpStatus: 429, retryable: false }), false);
  // §4.5 authoritative: out-of-credit / forbidden / not-found exclude on first occurrence.
  assert.equal(canFailover({ ok: false, code: "model-error-402", httpStatus: 402 }), false);
  assert.equal(canFailover({ ok: false, code: "model-error-403", httpStatus: 403 }), false);
  assert.equal(canFailover({ ok: false, code: "model-error-404", httpStatus: 404 }), false);
  // 401 is arming (§4.5a), not authoritative — governed by isRetryable.
  assert.equal(canFailover({ ok: false, code: "model-error-401", httpStatus: 401, retryable: true }), true);
  assert.equal(canFailover({ ok: false, code: "model-error-401", httpStatus: 401, retryable: false }), false);
});

// ---------------------------------------------------------------------------
// The failover retry (W6)
// ---------------------------------------------------------------------------

test("a pinned-model 429 with an alternate endpoint reroutes and succeeds", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([fail429, { ok: true, text: "second-try" }]);
  const resolverCalls = [];
  const resolveModel = async (args) => {
    resolverCalls.push({ ...args, excludeEndpointKeys: [...(args.excludeEndpointKeys ?? [])] });
    return aThenB(args);
  };
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel, validate: async () => true },
  });
  assert.equal(oc.calls.length, 2, "failover spent exactly the second call");
  assert.equal(out.text, "second-try");
  // The exclusion set was built from THIS operation's prior attempt.
  assert.deepEqual(resolverCalls[1].excludeEndpointKeys, ["p/a"]);
  // …and the second call actually ran on the DIFFERENT endpoint.
  assert.equal(oc.calls[1]?.modelID, "b");
  assert.equal(oc.calls[0]?.modelID, "a");
  assert.deepEqual(ledger.outcomeCodes(), ["model-error-429", "ok"]);
});

test("an identical re-resolution stops with no-alternate-endpoint (raises Part A)", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  // The resolver ignores the exclusion set — re-resolution is provably identical.
  const oc = fakeOc([fail429, { ok: true, text: "must-not-run" }]);
  const resolveModel = async () => ({ providerID: "p", modelID: "a" });
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel, validate: async () => true },
  });
  assert.equal(oc.calls.length, 1, "no model call on a provable repeat");
  assert.equal(out.ok, false);
  assert.equal(out.code, "no-alternate-endpoint");
  assert.deepEqual(ledger.outcomeCodes(), ["model-error-429", "no-alternate-endpoint"]);
});

test("an unpinned prior attempt does not failover (nothing to exclude)", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([{ ok: false, code: "model-error-429", httpStatus: 429 }]);
  let resolverCalls = 0;
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: async () => (resolverCalls++, null), validate: async () => true },
  });
  assert.equal(resolverCalls, 1, "no re-resolution when the box default cannot be excluded");
  assert.equal(oc.calls.length, 1);
  assert.equal(out.code, "model-error-429");
});

test("an authoritative 402 does not spend the second call", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([{ ok: false, code: "model-error-402", httpStatus: 402, retryable: false }]);
  let resolverCalls = 0;
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: async () => (resolverCalls++, aThenB({})), validate: async () => true },
  });
  assert.equal(resolverCalls, 1, "retrying a 402 is guaranteed waste");
  assert.equal(oc.calls.length, 1);
  assert.equal(out.code, "model-error-402");
});

test("a local lifecycle failure does not trigger endpoint failover", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([{ ok: false, code: "create-http", httpStatus: 503 }]);
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: aThenB, validate: async () => true },
  });
  assert.equal(oc.calls.length, 1, "a local failure is not evidence against the provider");
  assert.equal(out.ok, false);
  assert.equal(out.code, "create-http");
  assert.ok(!ledger.outcomeCodes().includes("no-alternate-endpoint"));
});

test("a pinned prompt-http 402 is provider evidence but AUTHORITATIVE — no failover", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([{ ok: false, code: "prompt-http", httpStatus: 402 }]);
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: aThenB, validate: async () => true },
  });
  assert.equal(oc.calls.length, 1, "retrying a 402 is guaranteed waste (§4.5)");
  assert.equal(out.code, "prompt-http");
  assert.deepEqual(ledger.outcomeCodes(), ["prompt-http"]);
});

test("a pinned prompt-http 429 IS provider evidence and fails over (§4.1a)", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([{ ok: false, code: "prompt-http", httpStatus: 429 }, { ok: true, text: "recovered" }]);
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: aThenB, validate: async () => true },
  });
  assert.equal(oc.calls.length, 2);
  assert.equal(oc.calls[1]?.modelID, "b");
  assert.equal(out.text, "recovered");
});

// ---------------------------------------------------------------------------
// The SHARED budget — quality cascade and endpoint failover compose to ≤2 calls
// ---------------------------------------------------------------------------

test("the shared budget: a failover whose second call quality-fails returns without a third call", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([fail429, { ok: true, text: "garbage", code: "empty-output" }]);
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: aThenB, validate: async () => false },
  });
  assert.equal(oc.calls.length, 2, "one budget, two model calls total");
  assert.equal(out.ok, false);
  assert.equal(out.code, "schema-invalid", "the validation failure is the terminal code — no third call");
});

test("the shared budget: an escalation whose second call provider-fails does not failover a third time", async () => {
  const engineState = fakeEngineState();
  const ledger = fakeLedger();
  const oc = fakeOc([
    { ok: true, text: "garbage", code: "empty-output" },
    { ok: false, code: "model-error-429", httpStatus: 429, retryable: true },
  ]);
  const out = await runEphemeral({
    taskClass: "ambient-summarize",
    context: [],
    deps: { oc, engineState, ledger, resolveModel: aThenB, validate: async () => false },
  });
  assert.equal(oc.calls.length, 2);
  assert.equal(out.ok, false);
  assert.equal(out.code, "model-error-429");
});
