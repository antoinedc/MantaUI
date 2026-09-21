// opencodeEndpointLifecycle.test.mjs — runSynchronousSession at the transport
// boundary (BET-1534, W2+W3). Drives the real runner against a mock ocFetch
// transport and an injected endpoint-attempt recorder, asserting the §4
// acceptance list: one operation record per taxonomy code, provider attempts
// from the CAUSATIVE row, §4.1a prompt-boundary semantics, §4.3 finalization
// order, abandoned sweeps and concurrent survival.

// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { runSynchronousSession, _setOcTransport } from "./opencode.mjs";
import { classifyModelErrorCode, safeSummaryCode } from "./ctoRunOutcome.mjs";
import { createEndpointAttemptsPayload, createEndpointAttemptRecorder } from "./endpointAttempts.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memoryStore() {
  let payload = createEndpointAttemptsPayload();
  return {
    name: "endpoint-attempts-lifecycle",
    path: "mem://endpoint-attempts-lifecycle",
    load: async () => JSON.parse(JSON.stringify(payload)),
    save: async (p) => { payload = p; },
  };
}

function makeRecorder({ now = () => 1000 } = {}) {
  const store = memoryStore();
  const rec = createEndpointAttemptRecorder({ store, now });
  return { store, rec };
}

const jsonRes = (body, status = 200, headers) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(headers ?? {}) } });

// Standard happy-path transport: create → prompt 204 → one assistant stop row.
function happyTransport(extra = {}) {
  const calls = [];
  return {
    calls,
    handler: async (url, opts) => {
      calls.push({ url: String(url), method: opts?.method, opts });
      const u = String(url);
      if (u.includes("/session?directory=")) return jsonRes({ id: "ses_lifecycle" });
      if (u.includes("/prompt_async")) {
        if (extra.promptStatus) return new Response("nope", { status: extra.promptStatus, headers: extra.promptHeaders });
        return new Response(null, { status: 204 });
      }
      if (u.endsWith("/message")) return jsonRes(extra.messages ?? [{
        info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "stop",
          providerID: "anthropic", modelID: "claude-x" },
        parts: [{ type: "text", text: "done" }],
      }]);
      if (opts?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 204 });
    },
  };
}

const PINNED = { providerID: "anthropic", modelID: "claude-x" };

async function run({ transport, recorder, ...rest }) {
  _setOcTransport(transport.handler);
  try {
    return await runSynchronousSession({
      directory: "/work", instruction: "test", pollIntervalMs: 0, maxAttempts: 3,
      attempts: recorder, trackCreation: () => async () => {}, ...rest,
    });
  } finally {
    _setOcTransport(null);
  }
}

// ---------------------------------------------------------------------------
// §4.1 — one operation record per dispatched operation, every taxonomy code
// ---------------------------------------------------------------------------

test("a successful run writes exactly one operation record, terminal ok/model, attribution observed", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport();
  const result = await run({ transport: t, recorder: rec, model: PINNED });
  assert.equal(result.ok, true);
  assert.equal(result.text, "done");
  const p = await store.load();
  assert.equal(p.operations.length, 1);
  const op = p.operations[0];
  assert.equal(op.terminal.code, "ok");
  assert.equal(op.terminal.stage, "model");
  assert.equal(op.attribution, "observed");
  assert.equal(op.intendedEndpointKey, "anthropic/claude-x");
  assert.equal(op.deadlineAt > op.startedAt, true);
  assert.equal(op.cleanupCode, undefined);
  // §4.2 — the success is also one provider attempt (finish persisted per §4.4)
  assert.equal(p.endpoints["anthropic/claude-x"].attempts.length, 1);
  const attempt = p.endpoints["anthropic/claude-x"].attempts[0];
  assert.equal(attempt.outcome, "success");
  assert.equal(attempt.attribution, "observed");
  assert.equal(attempt.finish, "stop");
  assert.equal(attempt.accountKey, "anthropic");
  assert.equal(p.endpoints["anthropic/claude-x"].lastSuccessAt > 0, true);
  assert.equal(p.endpoints["anthropic/claude-x"].failureStreak, 0);
});

test("every taxonomy code produces exactly one operation record with the right terminal stage", async () => {
  const scenarios = [
    { name: "create-http", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport();
      t.handler = async (url, opts) => {
        if (String(url).includes("/session?directory=")) return new Response("boom", { status: 503 });
        return new Response(null, { status: 204 });
      };
      return { rec, store, transport: t, expect: { code: "create-http", stage: "create", attribution: "not-dispatched" } };
    } },
    { name: "create-invalid", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport();
      t.handler = async (url, opts) => {
        if (String(url).includes("/session?directory=")) return jsonRes({});
        return new Response(null, { status: 204 });
      };
      return { rec, store, transport: t, expect: { code: "create-invalid", stage: "create", attribution: "not-dispatched" } };
    } },
    { name: "provenance-error", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport();
      return { rec, store, transport: t, trackCreation: () => async () => { throw new Error("x"); },
        expect: { code: "provenance-error", stage: "create", attribution: "not-dispatched" } };
    } },
    { name: "prompt-http (unpinned)", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ promptStatus: 503 });
      return { rec, store, transport: t, expect: { code: "prompt-http", stage: "prompt", attribution: "dispatched-unattributed" } };
    } },
    { name: "read-http", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ messages: null });
      t.handler = async (url, opts) => {
        const u = String(url);
        if (u.includes("/session?directory=")) return jsonRes({ id: "s" });
        if (u.includes("/prompt_async")) return new Response(null, { status: 204 });
        if (u.endsWith("/message")) return new Response("no", { status: 500 });
        if (opts?.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 204 });
      };
      return { rec, store, transport: t, expect: { code: "read-http", stage: "poll", attribution: "dispatched-unattributed" } };
    } },
    { name: "timeout", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ messages: [] });
      return { rec, store, transport: t, expect: { code: "timeout", stage: "poll", attribution: "dispatched-unattributed" } };
    } },
    { name: "empty-output", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ messages: [{ info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", providerID: "p", modelID: "m" }, parts: [] }] });
      return { rec, store, transport: t, expect: { code: "empty-output", stage: "model", attribution: "observed" } };
    } },
    { name: "model-output-cap", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ messages: [{ info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "max_tokens", providerID: "p", modelID: "m" }, parts: [] }] });
      return { rec, store, transport: t, expect: { code: "model-output-cap", stage: "model", attribution: "observed" } };
    } },
    { name: "model-context-cap", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ messages: [{ info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "model_context_window_exceeded", providerID: "p", modelID: "m" }, parts: [] }] });
      return { rec, store, transport: t, expect: { code: "model-context-cap", stage: "model", attribution: "observed" } };
    } },
    { name: "model-error-402 (bare providerID/modelID identity)", setup: () => {
      const { rec, store } = makeRecorder();
      const t = happyTransport({ messages: [{ info: { role: "assistant", time: { created: 1 }, error: { name: "APIError", data: { statusCode: 402 } }, providerID: "p", modelID: "m" } }] });
      return { rec, store, transport: t, expect: { code: "model-error-402", stage: "model", attribution: "observed" } };
    } },
  ];
  for (const scenario of scenarios) {
    const { rec, store, transport, expect, ...rest } = scenario.setup();
    const result = await run({ transport, recorder: rec, ...rest });
    assert.equal(result.code, expect.code, `scenario ${scenario.name}: result code`);
    const p = await store.load();
    assert.equal(p.operations.length, 1, `scenario ${scenario.name}: exactly one operation record`);
    const op = p.operations[0];
    assert.equal(op.terminal.code, expect.code, `scenario ${scenario.name}: terminal code`);
    assert.equal(op.terminal.stage, expect.stage, `scenario ${scenario.name}: terminal stage`);
    assert.equal(op.attribution, expect.attribution, `scenario ${scenario.name}: attribution`);
    assert.ok(op.attemptId, "the record carries its attemptId");
    assert.ok(op.operation, "the record carries the operation label");
  }
});

test("transport-error records the stage the run died in", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport();
  t.handler = async (url, opts) => {
    if (String(url).includes("/prompt_async")) throw new Error("ECONNRESET");
    if (String(url).includes("/session?directory=")) return jsonRes({ id: "s" });
    if (opts?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 204 });
  };
  const result = await run({ transport: t, recorder: rec });
  assert.equal(result.code, "transport-error");
  const p = await store.load();
  assert.equal(p.operations[0].terminal.code, "transport-error");
  assert.equal(p.operations[0].terminal.stage, "prompt");
  assert.equal(p.operations[0].attribution, "dispatched-unattributed");
});

test("a synchronous trackCreation() throw still yields a record (§4.3 fix)", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport();
  const result = await run({ transport: t, recorder: rec, trackCreation: () => { throw new Error("sync boom"); } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "transport-error");
  const p = await store.load();
  assert.equal(p.operations.length, 1);
  assert.equal(p.operations[0].terminal.stage, "create");
  assert.equal(p.operations[0].attribution, "not-dispatched");
});

// ---------------------------------------------------------------------------
// D7 — the provider attempt comes from the CAUSATIVE row
// ---------------------------------------------------------------------------

test("an error row wins over a later completed row for both code and attempt", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport({ messages: [
    { info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", providerID: "stale", modelID: "stale" }, parts: [{ type: "text", text: "stale" }] },
    { info: { role: "assistant", time: { created: 3 }, error: { name: "APIError", data: { statusCode: 402, isRetryable: false }, message: "SECRET body" }, providerID: "anthropic", modelID: "claude-x" } },
  ] });
  const result = await run({ transport: t, recorder: rec, model: PINNED });
  assert.equal(result.code, "model-error-402");
  assert.equal(result.httpStatus, 402);
  assert.equal(result.retryable, false);
  assert.equal(result.errorName, "APIError");
  assert.ok(!JSON.stringify(result).includes("SECRET"), "no exception text crosses the boundary");
  const p = await store.load();
  const ep = p.endpoints["anthropic/claude-x"];
  assert.equal(ep.attempts.length, 1);
  assert.equal(ep.attempts[0].httpStatus, 402);
  assert.equal(ep.attempts[0].errorName, "APIError");
  assert.equal(ep.attempts[0].retryable, false);
  assert.equal(ep.attempts[0].outcome, "failure");
  assert.equal(ep.attempts[0].endpointKey, "anthropic/claude-x");
  assert.equal(ep.failureStreak, 1);
  assert.equal(JSON.stringify(p).includes("SECRET"), false, "no exception text is persisted");
  // the stale row's identity must NOT be recorded
  assert.equal(p.endpoints["stale/stale"], undefined);
});

test("a row without identity yields no provider attempt but the run still records", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport({ messages: [{ info: { role: "assistant", time: { created: 1 }, error: { name: "APIError", data: { statusCode: 402 } } } }] });
  const result = await run({ transport: t, recorder: rec });
  assert.equal(result.code, "model-error-402");
  const p = await store.load();
  assert.deepEqual(p.endpoints, {});
  assert.equal(p.operations[0].attribution, "dispatched-unattributed");
  assert.equal(p.operations[0].terminal.code, "model-error-402");
});

// ---------------------------------------------------------------------------
// W3 — the status-bucket codes and their survival through safeSummaryCode
// ---------------------------------------------------------------------------

test("classifyModelErrorCode buckets statuses; unclassifiable stays bare model-error", () => {
  for (const status of [402, 401, 403, 404, 429]) {
    assert.equal(classifyModelErrorCode({ data: { statusCode: status } }), `model-error-${status}`);
  }
  assert.equal(classifyModelErrorCode({ data: { statusCode: 500 } }), "model-error-5xx");
  assert.equal(classifyModelErrorCode({ data: { statusCode: 503 } }), "model-error-5xx");
  assert.equal(classifyModelErrorCode({ data: {} }), "model-error");
  assert.equal(classifyModelErrorCode({}), "model-error");
  assert.equal(classifyModelErrorCode({ data: { statusCode: 400 } }), "model-error", "unclassifiable status");
});

test("the W3 buckets are closed-set codes that survive safeSummaryCode", () => {
  for (const code of ["model-error-402", "model-error-401", "model-error-403", "model-error-404", "model-error-429", "model-error-5xx"]) {
    assert.equal(safeSummaryCode(code), code);
  }
  assert.equal(safeSummaryCode("model-error"), "model-error");
});

test("5xx and 429 map through the runner as bucketed codes", async () => {
  for (const [status, expected] of [[500, "model-error-5xx"], [429, "model-error-429"]]) {
    const { rec, store } = makeRecorder();
    const t = happyTransport({ messages: [{ info: { role: "assistant", time: { created: 1 }, error: { name: "APIError", data: { statusCode: status, isRetryable: true } }, providerID: "p", modelID: "m" } }] });
    const result = await run({ transport: t, recorder: rec });
    assert.equal(result.code, expected);
    const p = await store.load();
    assert.equal(p.endpoints["p/m"].attempts[0].httpStatus, status);
  }
});

// ---------------------------------------------------------------------------
// §4.1a — prompt-boundary refusals preserve status + Retry-After
// ---------------------------------------------------------------------------

test("a 429 prompt refusal on a pinned model preserves status/Retry-After and records an intended attempt", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport({ promptStatus: 429, promptHeaders: { "retry-after": "30" } });
  const result = await run({ transport: t, recorder: rec, model: PINNED });
  assert.equal(result.code, "prompt-http");
  assert.equal(result.httpStatus, 429);
  assert.equal(result.retryAfterMs, 30000);
  const p = await store.load();
  assert.equal(p.operations.length, 1);
  const op = p.operations[0];
  assert.equal(op.terminal.code, "prompt-http");
  assert.equal(op.terminal.stage, "prompt");
  assert.equal(op.attribution, "intended");
  // §4.1a: the provider attempt exists, attributed "intended"
  const ep = p.endpoints["anthropic/claude-x"];
  assert.equal(ep.attempts.length, 1);
  assert.equal(ep.attempts[0].attribution, "intended");
  assert.equal(ep.attempts[0].httpStatus, 429);
  assert.equal(ep.attempts[0].retryAfterMs, 30000);
  assert.equal(ep.attempts[0].outcome, "failure");
  assert.equal(ep.failureStreak, 1);
});

test("a 402 prompt refusal records an intended attempt; other statuses record none", async () => {
  for (const [status, wantAttempt] of [[402, true], [401, false], [403, false], [404, false]]) {
    const { rec, store } = makeRecorder();
    const t = happyTransport({ promptStatus: status });
    const result = await run({ transport: t, recorder: rec, model: PINNED });
    assert.equal(result.code, "prompt-http");
    assert.equal(result.httpStatus, status);
    const p = await store.load();
    const attempts = p.endpoints["anthropic/claude-x"]?.attempts ?? [];
    assert.equal(attempts.length, wantAttempt ? 1 : 0, `status ${status}`);
    assert.equal(p.operations[0].attribution, "intended");
  }
});

test("an unpinned prompt refusal produces NO provider attempt (§4.1a pinned-only rule)", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport({ promptStatus: 429, promptHeaders: { "retry-after": "5" } });
  const result = await run({ transport: t, recorder: rec });
  assert.equal(result.code, "prompt-http");
  assert.equal(result.httpStatus, 429);
  const p = await store.load();
  assert.deepEqual(p.endpoints, {});
  assert.equal(p.operations[0].attribution, "dispatched-unattributed");
});

// ---------------------------------------------------------------------------
// §4.3 — finalization order, cleanup truth, persistence failures
// ---------------------------------------------------------------------------

test("cleanup failure leaves the provider attempt a model truth and the operation record states cleanupCode", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport();
  const inner = t.handler;
  t.handler = async (url, opts) => {
    if (opts?.method === "DELETE") return new Response(null, { status: 503 });
    return inner(url, opts);
  };
  const result = await run({ transport: t, recorder: rec, model: PINNED });
  assert.equal(result.ok, false, "never report a clean run when the session was left behind");
  assert.equal(result.code, "cleanup-error");
  const p = await store.load();
  const op = p.operations[0];
  assert.equal(op.terminal.code, "ok", "the model result is not rewritten by cleanup");
  assert.equal(op.cleanupCode, "cleanup-error");
  assert.equal(p.endpoints["anthropic/claude-x"].attempts[0].outcome, "success");
});

test("a model failure with failing cleanup keeps both truths separate", async () => {
  const { rec, store } = makeRecorder();
  const errorRow = { info: { role: "assistant", time: { created: 1 }, error: { name: "APIError", data: { statusCode: 402 } }, providerID: "p", modelID: "m" } };
  const t = happyTransport({ messages: [errorRow] });
  const inner = t.handler;
  t.handler = async (url, opts) => {
    if (opts?.method === "DELETE") return new Response(null, { status: 503 });
    return inner(url, opts);
  };
  const result = await run({ transport: t, recorder: rec });
  assert.equal(result.code, "model-error-402");
  const p = await store.load();
  const op = p.operations[0];
  assert.equal(op.terminal.code, "model-error-402");
  assert.equal(op.cleanupCode, "cleanup-error");
});

test("a persistence failure skips neither cleanup nor the result, and alarms", async () => {
  const ledgerRows = [];
  const failingRecorder = createEndpointAttemptRecorder({
    store: { name: "x", path: "mem://x", load: async () => createEndpointAttemptsPayload(), save: async () => { throw new Error("disk gone"); } },
    ledger: { append: async (r) => { ledgerRows.push(r); return true; } },
    now: () => 1000,
    warn: () => {},
  });
  const t = happyTransport();
  const result = await run({ transport: t, recorder: failingRecorder, model: PINNED });
  assert.equal(result.ok, true, "the caller's result is untouched");
  const deletes = t.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1, "cleanup still ran");
  assert.equal(ledgerRows.filter((r) => r.kind === "cto.endpoint_attempts_persist_failed").length >= 1, true);
});

// ---------------------------------------------------------------------------
// W2 acceptance — duplicate delivery, abandoned sweep, concurrency
// ---------------------------------------------------------------------------

test("duplicate terminal delivery produces one record, not two", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport();
  await run({ transport: t, recorder: rec, model: PINNED });
  const p0 = await store.load();
  const attemptId = p0.operations[0].attemptId;
  await rec.terminalizeOperation({
    attemptId, attribution: "not-dispatched",
    terminal: { at: 999, code: "abandoned", stage: null },
  });
  const p = await store.load();
  assert.equal(p.operations.length, 1);
  assert.equal(p.operations[0].terminal.code, "ok", "first writer wins");
});

test("a killed server's skeleton is terminalized as abandoned by the sweep", async () => {
  const { rec, store } = makeRecorder();
  const t = happyTransport();
  await run({ transport: t, recorder: rec, model: PINNED });
  // A later sweep must NOT touch the settled record; simulate a fresh skeleton
  // left behind by a dead process with a long-past deadline.
  await rec.beginOperation({ attemptId: "dead-run", operation: "orphan", startedAt: 0, deadlineAt: 1 });
  await rec.sweepAbandoned({ nowMs: 10_000_000 });
  const p = await store.load();
  const orphan = p.operations.find((o) => o.attemptId === "dead-run");
  const settled = p.operations.find((o) => o.attemptId !== "dead-run");
  assert.equal(orphan.terminal.code, "abandoned");
  assert.equal(settled.terminal.code, "ok");
});

test("concurrent completions both survive (patchStore serialization)", async () => {
  const { rec, store } = makeRecorder();
  const shared = happyTransport();
  _setOcTransport(shared.handler);
  try {
    const first = runSynchronousSession({
      directory: "/work", instruction: "a", pollIntervalMs: 0, maxAttempts: 3,
      attempts: rec, trackCreation: () => async () => {}, model: PINNED,
    });
    const second = runSynchronousSession({
      directory: "/work", instruction: "b", pollIntervalMs: 0, maxAttempts: 3,
      attempts: rec, trackCreation: () => async () => {}, model: PINNED,
    });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
  } finally {
    _setOcTransport(null);
  }
  const p = await store.load();
  assert.equal(p.operations.length, 2);
  const attemptIds = new Set(p.operations.map((o) => o.attemptId));
  assert.equal(attemptIds.size, 2);
  const ep = p.endpoints["anthropic/claude-x"];
  assert.equal(ep.attempts.length, 2);
  assert.equal(ep.lastSuccessAt > 0, true);
});

test("the recorder passed by default is the real singleton", async () => {
  const { endpointAttempts } = await import("./endpointAttempts.mjs");
  assert.ok(endpointAttempts.beginOperation);
  assert.ok(endpointAttempts.terminalizeOperation);
  assert.ok(endpointAttempts.recordProviderAttempt);
  assert.ok(endpointAttempts.sweepAbandoned);
});
