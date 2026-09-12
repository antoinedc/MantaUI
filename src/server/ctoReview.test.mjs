import "./ctoTestGuard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantCompletion, safeSummaryCode } from "./ctoRunOutcome.mjs";
import { createInternalSessions } from "./internalSessions.mjs";
import { runEphemeral } from "./ctoSessions.mjs";
import { createToolRegistry } from "./ctoToolRegistry.mjs";
import { collectFindings } from "./ctoSuggest.mjs";
import { createCtoEngine } from "./ctoEngine.mjs";
import { findingFromPromotedAsk, findingFromHealthGroup } from "./ctoCards.mjs";

const mem = (value = {}) => ({ load: async () => structuredClone(value), save: async (next) => { value = structuredClone(next); } });
const ledger = { append: async () => {} };

test("normalized and provider finishes never mistake a tool step or absent finish for terminal output", () => {
  const complete = (finish) => assistantCompletion({ time: { completed: 2 }, finish });
  for (const finish of [undefined, "unknown", "tool-calls", "tool_calls", "tool_use", "pause_turn"]) assert.equal(complete(finish), null);
  for (const finish of ["stop", "end_turn", "stop_sequence"]) assert.equal(complete(finish), "ok");
  for (const finish of ["length", "MAX_TOKENS", "max-tokens"]) assert.equal(complete(finish), "model-output-cap");
  for (const finish of ["content-filter", "content_filter", "error"]) assert.equal(complete(finish), "model-error");
  assert.equal(complete("model_context_window_exceeded"), "model-context-cap");
  assert.equal(assistantCompletion({ finish: "stop" }), null);
  assert.equal(safeSummaryCode("arbitrary SECRET"), "unknown-error");
});

test("ephemeral cascade retries output quality, never infrastructure or cleanup failure", async () => {
  for (const code of ["empty-output", "model-output-cap", "transport-error", "provenance-error"]) {
    let calls = 0;
    await runEphemeral({ taskClass: "ambient-summarize", deps: {
      engineState: mem(), ledger, resolveModel: async () => null,
      oc: { runEphemeralSession: async () => ++calls === 1 ? { ok: false, code } : { text: "valid" } },
    } });
    assert.equal(calls, ["empty-output", "model-output-cap"].includes(code) ? 2 : 1);
  }
});

test("ownership caches and singleflight bound repeated reads, but new internal provenance supersedes cached ownership", async () => {
  let time = 0, loads = 0, tmux = 0;
  const store = mem({ v: 1, ids: [] });
  const load = store.load;
  store.load = async () => { loads++; return load(); };
  const a = createInternalSessions({ store, now: () => time, report: async () => {} });
  const projects = async () => { tmux++; return []; };
  await Promise.all(Array.from({ length: 20 }, () => a.resolvePipelineSession("missing", projects)));
  assert.equal(loads, 1);
  assert.equal(tmux, 1);
  await a.resolvePipelineSession("missing", projects);
  assert.equal(tmux, 1);
  const b = createInternalSessions({ store });
  await b.beginInternalSession()("missing");
  assert.equal((await a.resolvePipelineSession("missing", projects)).owner, "cto");
  time = 6000;
  await a.resolvePipelineSession("another", projects);
  assert.equal(tmux, 2);
});

test("a hung creation fence is bounded and produces one deduplicated safe diagnostic", async () => {
  const reports = [];
  const a = createInternalSessions({ store: mem({ v: 1, ids: [] }), barrierMs: 5, report: (row) => reports.push(row) });
  const release = a.beginInternalSession();
  for (let n = 0; n < 2; n++) {
    await assert.rejects(a.resolvePipelineSession("human", async () => assert.fail("must fail closed")), /provenance-timeout/);
  }
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, "cto.provenance_unavailable");
  await release();
  assert.equal((await a.resolvePipelineSession("human", async () => [])).owner, "unknown");
});

test("unsupported scans and transient scans persist distinct bounded retry schedules without advancing the cursor", async () => {
  for (const code of ["unsupported-runtime", "db-unavailable"]) {
    let time = 1000, calls = 0;
    const registryStore = mem({ lastScanTs: 10 });
    const deps = { registryStore, classificationStore: mem(), usageStore: mem(), ledger, now: () => time,
      collectDb: async () => { calls++; throw Object.assign(new Error("private failure"), { code }); } };
    await createToolRegistry(deps).dailyScan();
    const saved = await registryStore.load();
    assert.equal(saved.lastScanTs, 10);
    assert.equal(saved.scanRetryAt, time + (code === "unsupported-runtime" ? 86400000 : 300000));
    await createToolRegistry(deps).dailyScan();
    assert.equal(calls, 1);
    time = saved.scanRetryAt;
    await createToolRegistry(deps).dailyScan();
    assert.equal(calls, 2);
  }
});

test("invalid full-page cursor never enters the persistent scan watermark", async () => {
  for (const value of [NaN, Infinity, "100", -1]) {
    const registryStore = mem({ lastScanTs: 10 });
    await createToolRegistry({ registryStore, usageStore: mem(), classificationStore: mem(), ledger, now: () => 1000,
      collectDb: async ({ cap }) => Array.from({ length: cap }, () => ({ id: "p", time_created: value })),
    }).dailyScan();
    assert.equal((await registryStore.load()).lastScanTs, 10);
  }
});

test("internal operation telemetry is not a suggestion finding source", () => {
  const ledgerRows = ["cto.operation_attempt", "cto.operation_outcome", "cto.segment_summary_failed", "cto.provenance_unavailable"]
    .map((kind) => ({ kind, actor: "cto", ts: 1000, code: "failed", message: "internal failure" }));
  assert.deepEqual(collectFindings([], [], { nowMs: 1000, ledgerRows }), []);
});

test("unknown activity pauses unattended work without becoming evidence; known internal prompts do neither", async () => {
  for (const owner of ["unknown", "cto"]) {
    const rows = [];
    let observed = 0;
    const engine = createCtoEngine({ configGet: async () => ({ ctoEnabled: false }), now: () => 123456,
      ledger: { append: async (r) => rows.push(r) }, getSessionInfo: async () => ({ owner }),
      segmenterOverride: { observe: () => { observed++; } },
    });
    const before = engine.getPresence();
    engine.observeEvent({ type: "user.message.created", properties: { sessionID: "s", message: { role: "user", text: "prompt" } } });
    await new Promise((r) => setTimeout(r, 20));
    if (owner === "cto") assert.deepEqual(engine.getPresence(), before);
    else assert.notDeepEqual(engine.getPresence(), before);
    assert.equal(observed, 0);
    assert.ok(!rows.some((r) => r.channel === "event"));
  }
});

test("ask and health producers carry only explicit known execution targets", () => {
  for (const finding of [
    findingFromPromotedAsk({ project: "p", cwd: "/p", sessionID: "s" }),
    findingFromHealthGroup({ latest: { project: "p", cwd: "/p", sessionID: "s" } }),
  ]) {
    assert.equal(finding.project, "p");
    assert.equal(finding.cwd, "/p");
    assert.equal(finding.sessionID, "s");
  }
  assert.equal(findingFromHealthGroup({ latest: {} }).cwd, undefined);
});

test("replayed results do not spend today's classification attempt", async () => {
  const tools = ["replay", "new"].map((tool) => ({ tool, raw: true, status: "observed", uses: 3 }));
  const registryStore = mem({ tools });
  const classificationStore = mem({ day: "1970-01-01", records: { replay: { status: "resolved", canonical: "replay", at: 1 } } });
  let calls = 0;
  await createToolRegistry({ registryStore, classificationStore, usageStore: mem(), ledger, now: () => 86400000,
    runEphemeral: async () => { calls++; return { text: "unknown" }; },
  }).dailyScan();
  assert.equal(calls, 1);
  assert.equal((await classificationStore.load()).records.new.status, "rejected");
});

test("classification pruning is bounded to applied old outcomes, preserving pending results and registry consent", async () => {
  const classificationStore = mem({ records: {
    old: { status: "resolved", canonical: "known", at: 1, appliedAt: 2 },
    orphan: { status: "rejected", at: 1, appliedAt: 2 },
    pending: { status: "resolved", canonical: "pending", at: 1 },
    reservation: { status: "reserved", at: 1 },
  } });
  const registryStore = mem({ tools: [{ tool: "known", raw: false, status: "integrated", aliases: ["old"], consent: { metadata: "never" } }] });
  await createToolRegistry({ registryStore, classificationStore, usageStore: mem(), ledger, now: () => 100 * 86400000 }).dailyScan();
  assert.deepEqual(Object.keys((await classificationStore.load()).records).sort(), ["pending", "reservation"]);
  const known = (await registryStore.load()).tools[0];
  assert.deepEqual(known.aliases, ["old"]);
  assert.equal(known.consent.metadata, "never");
});
