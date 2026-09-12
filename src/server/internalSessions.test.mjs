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
