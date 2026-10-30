// The production assembly (wiring.mjs) over fake clients, plus a source scan of
// index.mjs (which boots the server on import, so it cannot be imported — same
// approach as errorBodyContract.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionHandoff } from "./wiring.mjs";
import { FULL_BODY, settle } from "./testWorld.mjs";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakes(over = {}) {
  const calls = [];
  const sessions = new Map([["ses_p", { id: "ses_p", title: "Fix auth", directory: "/proj", agent: "build", model: { providerID: "anthropic", id: "claude-opus-4-8" } }]]);
  const oc = {
    readSession: async (sid) => (sessions.has(sid) ? { state: "found", session: sessions.get(sid) } : { state: "missing" }),
    createSession: async (i) => (calls.push(["createSession", i]), sessions.set(i.id, { id: i.id, directory: i.directory })),
    deleteSessionRaw: async (sid) => void calls.push(["delete", sid]),
    generateInSession: async (sid, prompt) => (calls.push(["generate", sid, prompt]), FULL_BODY),
    sendPrompt: async (a) => void calls.push(["sendPrompt", a]),
    postSynthetic: async (sid, b) => void calls.push(["postSynthetic", sid, b]),
    listInbox: async () => [],
    getMessage: async () => null,
    listActiveSessionIds: async () => [],
    listMessages: async () => [
      { info: { role: "user", time: { created: 100 } }, parts: [] },
      { info: { role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-8", tokens: { input: 10, cache: { read: 200, write: 30 } } }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "/proj/a.ts" } } }, { type: "text", text: "Patched. Should I also run the migration?" }] },
    ],
    getVcsBranch: async () => "feat/x",
    abortSession: async (sid) => void calls.push(["abortSession", sid]),
  };
  const tmux = {
    findWindowBySessionId: async (sid) => (sid === "ses_p" ? { sessionName: "proj", windowIndex: 3, name: "work", cwd: "/proj" } : null),
    findWindowByName: async () => null,
    restampSessionId: async (...a) => void calls.push(["restamp", ...a]),
    createStampedChatWindow: async () => 9,
    renameWindow: async () => {},
    run: async (cmd, args) => (calls.push(["run", cmd, args]), { stdout: " M src/a.ts\n?? new.txt\n" }),
  };
  const disk = { json: null };
  const published = [];
  const delegate = {
    repointSessions: async (a) => void calls.push(["repoint", a]),
    reconcileV2: async () => void calls.push(["reconcileV2"]),
    isRunningJobSession: async (sid) => sid === "ses_job" || sid === "ses_adopted",
    runningJobOwner: async (sid) => (sid === "ses_job" ? "manta" : sid === "ses_adopted" ? "opencode" : null),
  };
  const p = {
    oc,
    tmux,
    configGet: async () => ({ handoffMode: "suggest" }),
    publish: (e) => published.push(e),
    delegate: () => delegate,
    isCtoConversationSession: async (sid) => sid === "ses_cto",
    contextLimitFor: () => 1_000_000,
    constraints: { snapshot: async () => ({ sessions: { ses_p: { constraints: ["no emojis"], at: 5 } } }) },
    extractConstraints: async (sid) => void calls.push(["extract", sid]),
    loadState: () => (disk.json ? JSON.parse(disk.json) : null),
    saveState: async (s) => void (disk.json = JSON.stringify(s)),
    ...over,
  };
  return { p, calls, published, disk, sessions };
}

test("the production engine builds a ready card from the box's real-shaped reads: facts are observed/inferred, constraints re-extracted when stale", async () => {
  const f = fakes();
  const engine = createProductionHandoff(f.p);
  const rec = await engine.create({ sessionId: "ses_p", trigger: "user", goal: "auth" });
  await settle(10);
  const done = engine.get(rec.id);
  assert.equal(done.state, "ready");
  assert.ok(done.text.startsWith(FULL_BODY));
  assert.match(done.text, /previous session: ses_p — “Fix auth”/);
  assert.match(done.text, /- \(observed\) branch: feat\/x/);
  assert.match(done.text, /  - M src\/a\.ts/);
  assert.match(done.text, /files this session edited: 1/);
  assert.match(done.text, /ask it again as your first action/);
  assert.match(done.text, /  > Patched\. Should I also run the migration\?/);
  assert.match(done.text, /- \(inferred\) standing instructions/);
  assert.ok(f.calls.some((c) => c[0] === "extract" && c[1] === "ses_p"), "the constraints (at=5) predate the last user message (100): re-extracted first");
  assert.ok(f.calls.find((c) => c[0] === "generate")[2].startsWith("<!-- manta-handoff-generate -->"));
  assert.ok(f.published.some((e) => e.kind === "handoff"));
  assert.ok(JSON.parse(f.disk.json).records[rec.id], "persisted");
});

test("the cold-cache params reach the engine: a long-idle big session is written by the Summary model from a condensed transcript; the user's own requests are carried verbatim", async () => {
  const cheap = [];
  const f = fakes({
    summaryModel: async () => ({ providerID: "deepseek", modelID: "deepseek-chat", name: "DeepSeek Chat", limit: { context: 128_000 } }),
    cacheTtlMs: async () => 300_000,
    generateCheap: async (model, instruction) => (cheap.push({ model, instruction }), FULL_BODY),
    listPrice: async () => ({ listPrice: { input: 15, output: 75, cacheWrite: 18.75 }, oneHour: false, subscription: false }),
  });
  f.p.oc.listMessages = async (sid, opts) => [
    { info: { role: "user", time: { created: 100 } }, parts: [{ type: "text", text: "Please fix the login bug" }] },
    { info: { role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-8", time: { completed: 200 }, tokens: { input: 10, cache: { read: 90_000, write: 30_000 } } }, parts: [{ type: "text", text: "Patched." }] },
  ];
  const engine = createProductionHandoff({ ...f.p, delegate: f.p.delegate });
  const rec = await engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle(10);
  const done = engine.get(rec.id);
  assert.equal(done.state, "ready");
  assert.equal(cheap.length, 1);
  assert.deepEqual(cheap[0].model, { providerID: "deepseek", modelID: "deepseek-chat" });
  assert.match(cheap[0].instruction, /user: Please fix the login bug/);
  assert.equal(f.calls.some((c) => c[0] === "generate"), false, "the session's own model was not asked");
  assert.match(done.text, /your requests in this conversation \(verbatim, oldest first\):\n {2}> Please fix the login bug/);
  assert.equal(done.writer.path, "condensed");
  assert.equal(done.canRewrite, true);
});

test("without the cold-cache params (an un-updated caller) every handoff is written by the session itself", async () => {
  const f = fakes();
  f.p.oc.listMessages = async () => [{ info: { role: "assistant", providerID: "anthropic", modelID: "claude-opus-4-8", time: { completed: 1 }, tokens: { input: 10, cache: { read: 400_000, write: 0 } } }, parts: [] }];
  const engine = createProductionHandoff(f.p);
  const rec = await engine.create({ sessionId: "ses_p", trigger: "user" });
  await settle(10);
  assert.equal(engine.get(rec.id).state, "ready");
  assert.ok(f.calls.some((c) => c[0] === "generate"));
  assert.equal(engine.get(rec.id).canRewrite, false);
});

test("start through the production adapters: restamps the window, re-points jobs, copies settings, posts to the successor", async () => {
  const f = fakes({ configGet: async () => ({ handoffMode: "auto" }) });
  const engine = createProductionHandoff(f.p);
  const rec = await engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  const out = await engine.start(rec.id, { how: "clear", disposition: "send" });
  assert.equal(out.state, "committed");
  const kinds = f.calls.map((c) => c[0]);
  assert.ok(kinds.indexOf("createSession") < kinds.indexOf("sendPrompt") && kinds.indexOf("sendPrompt") < kinds.indexOf("restamp") && kinds.indexOf("restamp") < kinds.indexOf("repoint"), "create → send → attach → re-point");
  const create = f.calls.find((c) => c[0] === "createSession")[1];
  assert.deepEqual(create.model, { providerID: "anthropic", modelID: "claude-opus-4-8" });
  assert.deepEqual(f.calls.find((c) => c[0] === "restamp").slice(1), ["proj", 3, out.successorId]);
  assert.deepEqual(f.calls.find((c) => c[0] === "repoint")[1], { fromSessionId: "ses_p", toSessionId: out.successorId });
});

test("a failed send handoff tells the delegate engine to re-settle; held-message failures reach the bus", async () => {
  const f = fakes({ configGet: async () => ({ handoffMode: "auto" }) });
  f.p.oc = { ...f.p.oc, createSession: async () => { throw Object.assign(new Error("no"), { status: 400 }); } };
  const engine = createProductionHandoff(f.p);
  const rec = await engine.create({ sessionId: "ses_p", trigger: "agent", action: "handoff", body: FULL_BODY });
  await engine.onTurnEnd("ses_p", { success: true });
  assert.equal(engine.get(rec.id).state, "failed");
  await settle();
  assert.ok(f.calls.some((c) => c[0] === "reconcileV2"));
});

test("the mode comes from config handoffMode (garbage → the suggest default); CTO conversations and running job sessions are recognised", async () => {
  const f = fakes({ configGet: async () => ({ handoffMode: "nonsense" }) });
  const engine = createProductionHandoff(f.p);
  engine.observeEvent({ type: "session.next.step.ended", properties: { sessionID: "ses_p", tokens: { input: 1000, cache: { read: 0, write: 0 } }, providerID: "anthropic", modelID: "claude-opus-4-8" } });
  assert.equal((await engine.policyFor("ses_p")).mode, "suggest");
});

test("a manta-owned running job resolves to auto through the delegate adapter; an adopted one and a plain session follow the box default", async () => {
  const f = fakes({ configGet: async () => ({ handoffMode: "off" }) });
  const engine = createProductionHandoff(f.p);
  assert.deepEqual(await engine.resolveMode("ses_job"), { mode: "auto", isDefault: true, source: "job", unattended: true });
  assert.equal((await engine.resolveMode("ses_adopted")).mode, "off");
  assert.equal((await engine.resolveMode("ses_p")).mode, "off");
});

test("a handoff of a job stopped after its first message interrupts the successor through the opencode abort (the existing interrupt, resume=false)", async () => {
  const f = fakes({ configGet: async () => ({ handoffMode: "suggest" }) });
  let stopped = false;
  const base = f.p.delegate();
  f.p.delegate = () => ({ ...base, runningJobOwner: async (sid) => (sid === "ses_p" && !stopped ? "manta" : null), jobStatusOf: async () => (stopped ? "stopped" : "running") }); // the re-point moved the record onto the successor
  const send = f.p.oc.sendPrompt;
  f.p.oc.sendPrompt = async (a) => {
    await send(a);
    stopped = true; // stopJob wrote `stopped` right after the handoff's first message went out
  };
  const engine = createProductionHandoff(f.p);
  const rec = await engine.create({ sessionId: "ses_p", trigger: "agent", action: "suggest", body: FULL_BODY });
  await engine.onTurnEnd("ses_p", { success: true });
  const out = engine.get(rec.id);
  assert.equal(out.state, "committed");
  assert.deepEqual(f.calls.filter((c) => c[0] === "abortSession"), [["abortSession", out.successorId]]);
});

test("index.mjs: the engine is wired into every seam the spec names", () => {
  const index = readFileSync(join(SERVER, "index.mjs"), "utf8");
  // REST routes behind the same gate as every /api route
  assert.match(index, /if \(await handoffHandler\(req, res, url\)\) return;/);
  // rpc channels
  assert.match(index, /delegate: delegateEngine,\s*handoff: handoffEngine,/);
  // triggers: the lifecycle tap
  assert.match(index, /handoffEngine\.observeEvent\(evt\)/);
  // §4.5: idle compaction stands aside per session unless that session's mode is off, and shares the operation registry (§6.2)
  assert.match(index, /eligible: async \(sid\) => \(await handoffEngine\.modeFor\(sid\)\) === "off"/);
  assert.match(index, /acquire: \(sid\) => handoffEngine\.acquireOperation\(sid, "compaction"\)/);
  assert.match(index, /release: \(sid, token\) => handoffEngine\.releaseOperation\(sid, token\)/);
  // §6.3 ownership
  assert.match(index, /deferSettlement: \(sid\) => handoffEngine\.hasPendingSend\(sid\)/);
  assert.match(index, /cancelPendingHandoff: \(sid\) => handoffEngine\.cancelPendingSends\(sid\)/);
  assert.match(index, /isHandoffSuccessor: \(sid\) => handoffEngine\.isSuccessor\(sid\)/);
  assert.match(index, /replacementChain: \(sid\) => handoffEngine\.chainOf\(sid\)/);
  // display parent of an adopted row (delegate.resolveDisplayParents)
  assert.match(index, /successorOf: \(sid\) => handoffEngine\.successorOf\(sid\)/);
  assert.match(index, /findSessionReferences:[\s\S]{0,160}runDbTask\("sessionReferences"/);
  // §15 policy block, per session
  assert.match(index, /handoff: sessionID \? await handoffEngine\.policyFor\(sessionID\) : null/);
  // §5.5 boot recovery runs after the delegate engine exists, and is the FIRST step of the explicit boot chain:
  // handoff recovery → V2 job reconciliation → the first active-session reconciliation → its poller.
  const engineAt = index.indexOf("const delegateEngine = createDelegateEngine(");
  const recover = index.indexOf("await handoffEngine.recover()");
  const v2 = index.indexOf("await delegateEngine.reconcileV2()");
  const active = index.indexOf("await delegateEngine.reconcileActiveSessions()");
  const poller = index.indexOf("delegateEngine.startActiveSessionReconciler()");
  assert.ok(engineAt > -1 && recover > engineAt && v2 > recover && active > v2 && poller > active, "boot recovery order");
});

test("the handoff state lives under the sandboxed state home, never a literal $HOME path", () => {
  const index = readFileSync(join(SERVER, "index.mjs"), "utf8");
  assert.match(index, /statePath\("handoffs\.json"\)/);
  for (const f of ["handoff/engine.mjs", "handoff/state.mjs", "handoff/wiring.mjs", "handoffRoute.mjs"]) {
    assert.ok(!/homedir\(\)|process\.env\.HOME|\.manta\//.test(readFileSync(join(SERVER, f), "utf8").replace(/\/\/.*$/gm, "")), `${f} must not resolve state paths itself`);
  }
});
