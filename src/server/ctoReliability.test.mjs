import "./ctoTestGuard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { beginInternalSession, resolvePipelineSession } from "./internalSessions.mjs";
import { resolvePlanParent, createCtoPlanRunner } from "./ctoAct.mjs";
import { collectDbRows, extractFromDbRows, SCAN_ROW_CAP } from "./ctoToolScan.mjs";
import { readSegmentEvidence } from "./ctoSegmentEvidence.mjs";
import { createToolRegistry, fuseRow, retainUnresolved, UNRESOLVED_PRUNE_LIMIT, UNRESOLVED_RETENTION_MS, recoverLegacyClassification } from "./ctoToolRegistry.mjs";

const store = (value = {}) => ({
  load: async () => structuredClone(value),
  save: async (next) => { value = structuredClone(next); },
});

async function openSqlite(t) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
    t.skip("node:sqlite unavailable on this runtime");
    return null;
  }
  return new DatabaseSync(":memory:");
}

test("production ownership resolver fences creation, retains deleted internal identity, and retries unknown ownership", async () => {
  const finish = beginInternalSession();
  let settled = false;
  const pending = resolvePipelineSession("internal-race", async () => []).then((r) => { settled = true; return r; });
  await Promise.resolve();
  assert.equal(settled, false);
  await finish("internal-race");
  assert.equal((await pending).owner, "cto");
  assert.equal((await resolvePipelineSession("internal-race", async () => [])).owner, "cto");
  assert.equal((await resolvePipelineSession("new-human", async () => [])).owner, "unknown");
  assert.equal((await resolvePipelineSession("new-human", async () => [
    { tmuxSession: "project", windows: [{ opencodeSessionId: "new-human" }] },
  ])).owner, "user");
});

test("production target resolver never picks the first project for an unknown target", async () => {
  const projects = ["a", "b"].map((name) => ({ tmuxSession: name, windows: [
    { opencodeSessionId: name, paneCurrentPath: `/work/${name}` },
  ] }));
  assert.equal(resolvePlanParent(projects, {}), null);
  assert.equal(resolvePlanParent(projects, { project: "missing", finding: { senderSessionID: "a" } }), null);
  assert.equal(resolvePlanParent(projects, { plan: { project: "b", cwd: "/work/b" } }).parentSessionID, "b");
  assert.equal(resolvePlanParent(projects, { plan: { project: "b", cwd: "/work/a" } }), null);
  projects[1].defaultCwd = "/work/default-b";
  assert.equal(resolvePlanParent(projects, { project: "/work/default-b" }), null);
  assert.equal(resolvePlanParent(projects, { project: "/work/b" }).parentDirectory, "/work/b");
  assert.equal(resolvePlanParent(projects, { project: "b" }).parentDirectory, "/work/b");
  projects[1].windows.push({ opencodeSessionId: "b2", paneCurrentPath: "/work/b-other" });
  assert.equal(resolvePlanParent(projects, { project: "b" }), null);
  const run = createCtoPlanRunner({ createSession: () => assert.fail("must not create") });
  const result = await run({ plan: { id: "p", steps: ["inspect"], verify: { kind: "session-ok" } } });
  assert.equal(result.reason, "unknown-project");
});

test("real SQLite discovery paginates equal timestamps and excludes internal transcript", async (t) => {
  const db = await openSqlite(t);
  if (!db) return;
  try {
    db.exec("CREATE TABLE session(id TEXT, title TEXT); CREATE TABLE part(id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    db.exec("INSERT INTO session VALUES ('human','work'),('internal','cto:ambient-summarize')");
    const insert = db.prepare("INSERT INTO part VALUES (?,?,?,?)");
    for (const id of ["a", "b", "c"]) insert.run(id, "human", 10, "{}");
    insert.run("d", "internal", 10, "{}");
    await beginInternalSession()("internal");
    const first = await collectDbRows(db, { sinceTs: 0, untilTs: 20, cap: 2 });
    const second = await collectDbRows(db, { sinceTs: 10, afterId: "b", untilTs: 20, cap: 2 });
    assert.deepEqual(first.map((r) => r.id), ["a", "b"]);
    assert.deepEqual(second.map((r) => r.id), ["c", "d"]);
    assert.equal(second[1].internal, true);
    assert.deepEqual(extractFromDbRows([{
      ...second[1], data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "gh pr list" } } }),
    }]), []);
    // A title is not authoritative provenance, even when it resembles ours.
    db.exec("UPDATE session SET title = 'cto:ambient-summarize' WHERE id = 'human'");
    assert.equal((await collectDbRows(db, { sinceTs: 0, untilTs: 20 }))[0].internal, false);
  } finally { db.close(); }
});

test("real SQLite summary evidence is session/time scoped and bounded", async (t) => {
  const db = await openSqlite(t);
  if (!db) return;
  try {
    db.exec("CREATE TABLE message(id TEXT, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO message VALUES (?,?)").run("m", JSON.stringify({ role: "assistant" }));
    const insert = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
    insert.run("p", "m", "s", 10, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", output: "Tests passed" } }));
    insert.run("next", "m", "s", 30, JSON.stringify({ type: "text", text: "NEXT TURN" }));
    const evidence = readSegmentEvidence(db, { sessionID: "s", start: 0, end: 20 });
    assert.match(evidence, /Tests passed/);
    assert.ok(!evidence.includes("NEXT TURN"));
    assert.equal(readSegmentEvidence(db, { sessionID: "other", start: 0, end: 20 }), "");
    for (let n = 0; n < 50; n++) insert.run(`long${n}`, "m", "s", 15, JSON.stringify({ type: "text", text: "x".repeat(10000) }));
    assert.ok(readSegmentEvidence(db, { sessionID: "s", start: 0, end: 20 }).length <= 6000);
  } finally { db.close(); }
});

test("failed discovery preserves cursor; transient classification retries and aliases survive restart", async () => {
  let now = 100;
  let tools = [];
  for (let n = 1; n <= 3; n++) tools = fuseRow(tools, { identity: "somecli", source: "raw", ts: n, detail: "cli:somecli" });
  const registryStore = store({ tools, lastScanTs: 10 });
  const classificationStore = store();
  const usageStore = store();
  let mode = "failed";
  let asks = 0;
  const make = () => createToolRegistry({ registryStore, classificationStore, usageStore, now: () => now,
    ledger: { append: async () => {} },
    collectDb: async () => { if (mode === "failed") throw new Error("SECRET"); return []; },
    runEphemeral: async () => mode === "failed" ? { ok: false, code: "timeout" } : { text: "github" },
    cards: { listOpen: async () => [], upsertConnect: async () => { asks++; } },
  });
  assert.equal((await make().dailyScan()).ok, false);
  let saved = await registryStore.load();
  assert.equal(saved.lastScanTs, 10);
  assert.equal(saved.tools[0].unclassifiable, false);
  assert.equal(asks, 0);
  mode = "ok";
  now += 2 * 86400000;
  await make().dailyScan();
  saved = await registryStore.load();
  assert.deepEqual(saved.tools[0].aliases, ["somecli"]);
  const fused = fuseRow(saved.tools, { identity: "somecli", source: "raw", ts: now + 1 });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].tool, "github");
});

test("retention removes only old singletons in bounded batches, never recent candidates or consent", () => {
  const now = 10000000000;
  const raw = (id) => ({ tool: id, raw: true, status: "observed", uses: 1, firstSeenTs: now });
  const never = { ...raw("never"), consent: { metadata: "never" } };
  const known = { ...raw("known"), raw: false };
  const recent = raw("recent");
  const rows = Array.from({ length: UNRESOLVED_PRUNE_LIMIT + 10 }, (_, n) => ({ ...raw(`x${n}`), firstSeenTs: now - UNRESOLVED_RETENTION_MS - 1 }));
  const kept = retainUnresolved([...rows, never, known, recent], now);
  assert.equal(kept.length, 13);
  assert.ok(kept.includes(never));
  assert.ok(kept.includes(known));
  assert.ok(kept.includes(recent));
});

test("legacy rejection recovery requires fresh evidence and never resets human or explicit decisions", () => {
  const legacy = { tool: "candidate", raw: true, unclassifiable: true, llmAt: 100, uses: 3,
    status: "observed", engagement: { last_used: 200 }, consent: {} };
  for (const over of [
    { engagement: { last_used: 100 } }, { consent: { metadata: "never" } },
    { askRound: 1 }, { deepAskRound: 1 }, { status: "integrated" },
    { classificationOutcome: { status: "rejected" } },
  ]) {
    const row = { ...structuredClone(legacy), ...over };
    const before = structuredClone(row);
    assert.equal(recoverLegacyClassification([row], 300), null);
    assert.deepEqual(row, before);
  }
  assert.equal(recoverLegacyClassification([legacy], 300), "candidate");
  assert.equal(legacy.llmAt, null);
  assert.equal(legacy.unclassifiable, false);
  assert.equal(legacy.classificationRecovery.previousLlmAt, 100);
  assert.equal(recoverLegacyClassification([legacy], 400), null);
});

test("production scan persists legacy recovery and a restarted classifier honors explicit rejection", async () => {
  const row = { tool: "legacy", raw: true, unclassifiable: true, llmAt: 100, uses: 3,
    status: "observed", engagement: { last_used: 200 }, consent: {} };
  const registryStore = store({ tools: [row] });
  const classificationStore = store();
  let calls = 0;
  let time = 300;
  const make = () => createToolRegistry({ registryStore, classificationStore, usageStore: store(), now: () => time,
    ledger: { append: async () => {} },
    runEphemeral: async () => { calls++; return { text: "unknown" }; },
  });
  await make().dailyScan();
  const recovered = (await registryStore.load()).tools[0];
  assert.equal(calls, 1);
  assert.equal(recovered.classificationRecovery.previousLlmAt, 100);
  assert.equal(recovered.classificationOutcome.status, "rejected");
  time += 2 * 86400000;
  await make().dailyScan();
  assert.equal(calls, 1);
  assert.equal((await registryStore.load()).tools[0].tool, "legacy");
});

test("production registry commits every page atomically and does not re-fuse its diagnostic FIFO", async () => {
  const registryStore = store({ lastScanTs: 0 });
  const usageStore = store();
  const rows = Array.from({ length: SCAN_ROW_CAP + 1 }, (_, n) => ({
    id: String(n).padStart(5, "0"), session_id: "s", time_created: 10,
    data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "gh pr list" } } }),
  }));
  const registry = createToolRegistry({ registryStore, usageStore,
    now: () => 20, ledger: { append: async () => {} },
    collectDb: async ({ sinceTs, afterId, cap }) => rows.filter((r) => r.time_created > sinceTs ||
      (r.time_created === sinceTs && afterId && r.id > afterId)).slice(0, cap),
  });
  assert.equal((await registry.dailyScan()).partial, true);
  assert.equal((await registryStore.load()).tools[0].uses, SCAN_ROW_CAP);
  assert.equal((await registry.dailyScan()).partial, false);
  assert.equal((await registryStore.load()).tools[0].uses, SCAN_ROW_CAP + 1);
  await registry.dailyScan();
  assert.equal((await registryStore.load()).tools[0].uses, SCAN_ROW_CAP + 1);
});
