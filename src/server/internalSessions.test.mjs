import "./ctoTestGuard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createInternalSessions } from "./internalSessions.mjs";
import { internalSessionsStore } from "./ctoStores.mjs";
import { createCtoEngine } from "./ctoEngine.mjs";
import { collectDbRows } from "./ctoToolScan.mjs";
import { createCtoPlanRunner } from "./ctoAct.mjs";

test("durable production store excludes late internal events after restart despite a user tmux match", async () => {
  const first = createInternalSessions();
  await first.beginInternalSession()("restart-internal");
  const child = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { isInternalSession } from ${JSON.stringify(new URL("./internalSessions.mjs", import.meta.url).href)};
    console.log(await isInternalSession("restart-internal"));
  `], { encoding: "utf8" });
  assert.equal(child.trim(), "true", "a new process loads durable provenance without memory caches");
  const restarted = createInternalSessions();
  const projects = async () => [{ tmuxSession: "work", windows: [{ opencodeSessionId: "restart-internal", owner: "user" }] }];
  assert.equal((await restarted.resolvePipelineSession("restart-internal", projects)).owner, "cto");
  let observations = 0;
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: false }),
    getSessionInfo: (sid) => restarted.resolvePipelineSession(sid, projects),
    segmenterOverride: { observe: () => { observations++; } },
    now: () => 123456,
  });
  const before = engine.getPresence();
  engine.observeEvent({ type: "user.message.created", properties: { sessionID: "restart-internal", message: { role: "user", text: "internal" } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(engine.getPresence(), before);
  assert.equal(observations, 0);
});

test("concurrent durable writers preserve all IDs and persistence failure prevents successful creation", async () => {
  const a = createInternalSessions();
  const b = createInternalSessions();
  await Promise.all([a.beginInternalSession()("a"), b.beginInternalSession()("b")]);
  const restart = createInternalSessions();
  assert.equal(await restart.isInternalSession("a"), true);
  assert.equal(await restart.isInternalSession("b"), true);
  const broken = createInternalSessions({ store: { load: async () => ({ v: 1 }), save: async () => { throw new Error("disk-full"); } } });
  await assert.rejects(broken.beginInternalSession()("failed-write"), /disk-full/);
});

test("corrupt provenance after restart fails closed instead of returning human ownership", async () => {
  const prior = await internalSessionsStore.load();
  try {
    await writeFile(internalSessionsStore.path, "not-json", { mode: 0o600 });
    assert.throws(() => internalSessionsStore.loadSync());
    const restart = createInternalSessions();
    await assert.rejects(restart.resolvePipelineSession("late", async () => {
      assert.fail("must not consult tmux when provenance is unreadable");
    }));
    await assert.rejects(collectDbRows({ prepare: () => ({ all: () => [] }) }, { sinceTs: 0, untilTs: 10 }));
  } finally { await internalSessionsStore.save(prior); }
});

test("headless plan execution also persists ownership before its first prompt", async () => {
  let sent = false;
  const run = createCtoPlanRunner({
    resolveParent: async () => ({ parentDirectory: "/work", parentSessionID: "parent" }),
    createSession: async () => ({ ok: true, id: "plan-headless" }),
    listMessages: async () => [],
    deleteSession: async () => {},
    sendPrompt: async () => {
      assert.equal(await createInternalSessions().isInternalSession("plan-headless"), true);
      sent = true;
      return { ok: false };
    },
  });
  await run({ plan: { id: "p", steps: ["inspect"], verify: { kind: "session-ok" } } });
  assert.equal(sent, true);
});

for (const cleanupFails of [false, true]) {
  test(`headless plan provenance failure stops prompting, cleanup failure=${cleanupFails}`, async () => {
    let deleted = false;
    const run = createCtoPlanRunner({
      trackCreation: () => async () => { throw new Error("disk-full"); },
      resolveParent: async () => ({ parentDirectory: "/work" }),
      createSession: async () => ({ ok: true, id: "failed-plan" }),
      sendPrompt: async () => assert.fail("provenance must persist before prompting"),
      deleteSession: async () => { deleted = true; if (cleanupFails) throw new Error("delete-failed"); },
    });
    const result = await run({ plan: { id: "p", steps: ["inspect"], verify: { kind: "session-ok" } } });
    assert.equal(result.reason, "provenance-error");
    assert.equal(result.cleanupCode, cleanupFails ? "cleanup-error" : undefined);
    assert.equal(deleted, true);
  });
}

// ---------------------------------------------------------------------------
// P3a1 review blocker 4 — the durable CEO conversation carries DISTINCT role
// provenance (from the binding record, never the generic tombstones): a human
// CEO instruction is recognized as CEO presence, while the conversation never
// produces evidence or segmentation input (the CTO must not summarize its own
// assistant output recursively). Ephemeral inference sessions stay
// cto_internal with none of that.
// ---------------------------------------------------------------------------

test("the conversation binding resolves as a DISTINCT role: cto_conversation wins over tmux; tombstones are cto_internal", async () => {
  const tombstones = createInternalSessions();
  await tombstones.beginInternalSession()("ephemeral-inference");
  let projects = async () => [
    { tmuxSession: "work", windows: [
      { opencodeSessionId: "ceo-convo", owner: "user" },
      { opencodeSessionId: "human-work", owner: "user" },
    ] },
  ];
  const is = createInternalSessions({
    conversationReader: async (sid) => sid === "ceo-convo",
  });
  const convo = await is.resolvePipelineSession("ceo-convo", projects);
  assert.equal(convo.owner, "cto");
  assert.equal(convo.role, "cto_conversation");
  const internal = await is.resolvePipelineSession("ephemeral-inference", projects);
  assert.equal(internal.owner, "cto");
  assert.equal(internal.role, "cto_internal");
  const human = await is.resolvePipelineSession("human-work", projects);
  assert.equal(human.owner, "user");
  assert.equal(human.role, undefined);
  // Non-conversation, non-internal, no tmux match → unchanged unknown shape.
  projects = async () => [];
  assert.deepEqual(await is.resolvePipelineSession("ses-mystery", projects), { owner: "unknown" });
  void tombstones;
});

test("event provenance: a human CEO instruction updates presence WITHOUT becoming evidence or segmentation input; ephemeral sessions do neither", async () => {
  let observations = 0;
  const engine = createCtoEngine({
    configGet: async () => ({ ctoEnabled: false }),
    getSessionInfo: async (sid) =>
      sid === "ceo-convo"
        ? { owner: "cto", role: "cto_conversation" }
        : { owner: "cto", role: "cto_internal" },
    segmenterOverride: { observe: () => { observations++; } },
    now: () => 1_000_000,
  });
  engine.observeEvent({ type: "user.message.created", properties: { sessionID: "ceo-convo", message: { role: "user", text: "CEO instruction" } } });
  await new Promise((r) => setTimeout(r, 30));
  const after = engine.getPresence();
  assert.ok(after.lastSeen >= 1_000_000, "a human CEO instruction counts as CEO presence");
  assert.equal(observations, 0, "the conversation is never segmentation input");

  const beforeEphemeral = engine.getPresence();
  engine.observeEvent({ type: "user.message.created", properties: { sessionID: "ephemeral-inference", message: { role: "user", text: "internal" } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(engine.getPresence(), beforeEphemeral, "ephemeral cto activity is not presence");
  assert.equal(observations, 0);
});
