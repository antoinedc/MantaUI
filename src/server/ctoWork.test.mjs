// ctoWork.test.mjs — P2a contract tests for the durable work-envelope store
// and operation receipts (unified-cto-spec §5.1/§6/§8.1).
//
// CONTRACT-ONLY (spec §15): these fixtures establish the state/receipt
// interfaces for U10/U13/U19. They do NOT prove an external worker was
// created, a worktree was made, or a deployment ran — no worker side effects
// exist yet in P2a.
//
// Every store path resolves under the MANTA_STATE_HOME sandbox
// (ctoPath → statePath); each test gets its own subdirectory, and the after()
// hook removes only THIS file's fixtures. The only I/O is real fs against the
// sandbox — no live tmux/opencode/network.

// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, chmod, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createCtoWork,
  canonicalArgsHash,
  canonicalJson,
  validateProjectRef,
  validateDeliveryTarget,
  workError,
  RECEIPT_TRANSITIONS,
  HISTORY_CAPACITY,
  MAX_LEASE_TTL_MS,
  LIST_DEFAULT_LIMIT,
  OPERATION_STATUSES,
  UNRESOLVED_OPERATION_STATUSES,
  TERMINAL_OPERATION_STATUSES,
  WORK_STATES,
  WORK_STAGES,
  WAITING_REASONS,
} from "./ctoWork.mjs";
import { ctoPath, workStore, migrateStore } from "./ctoStores.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testSeq = 0;

// A real-fs dir store under a unique sandbox subdirectory, shaped like
// ctoStores' dir stores (name/dir/pathFor/save). Loads go through
// ctoWork's strict reader; save mimics the version stamp.
function sandboxStore(labelSuffix = "") {
  testSeq += 1;
  const dir = ctoPath("work-test", `${testSeq}${labelSuffix}`);
  return {
    name: "work",
    dir,
    pathFor: (id) => join(dir, `${id}.json`),
    save: async (id, data) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ ...data, v: 1 }, null, 2));
    },
  };
}

// Observable store: counts COMMITTED writes and lets a test latch on "the
// Nth write has fully landed" — injected synchronization for deterministic
// interleaving (waiting for a seeded file proves nothing about the write
// under test).
function observableStore(labelSuffix = "") {
  const base = sandboxStore(labelSuffix);
  const state = { writes: 0 };
  const waiters = [];
  const notify = () => {
    const due = waiters.splice(0);
    for (const w of due) w();
  };
  return {
    ...base,
    save: async (id, data) => {
      await base.save(id, data);
      state.writes += 1;
      notify();
    },
    writes: () => state.writes,
    waitForWrites: (n) =>
      state.writes >= n ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
  };
}

// Deterministic clock: each call ticks 1ms; advance() jumps forward.
function makeClock() {
  let t = 1_700_000_000_000;
  return {
    now: () => (t += 1),
    advanceMs: (ms) => {
      t += ms;
    },
  };
}

function makeWork(overrides = {}) {
  return {
    origin: { conversationId: "conv_1", messageId: "msg_1" },
    project: {
      workspaceId: "ws_alpha",
      repositoryId: "repo_alpha",
      repositoryRoot: "/home/dev/projects/alpha",
    },
    spec: { revision: 1, hash: "sha256:aaa", documentRef: "docs/specs/alpha.md#rev1" },
    objective: "ship the thing",
    deliveryTarget: { kind: "pr" },
    ...overrides,
  };
}

async function seedWork(service, id, overrides = {}) {
  return service.createWork({ id, ...makeWork(overrides) });
}

// Teardown: remove ONLY this file's recorded fixtures (the box disk is tight;
// nothing outside the sandbox is ever touched).
const hookWorkIds = [];
after(async () => {
  await rm(ctoPath("work-test"), { recursive: true, force: true });
  for (const id of hookWorkIds) {
    await rm(workStore.pathFor(id), { force: true });
  }
});

// ---------------------------------------------------------------------------
// Envelope lifecycle: create / get / list (bounded)
// ---------------------------------------------------------------------------

test("createWork stores a valid envelope with revision 1 and default state/stage", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  const env = await work.createWork({ id: "w_basic", ...makeWork() });
  assert.equal(env.id, "w_basic");
  assert.equal(env.revision, 1);
  assert.equal(env.state, "draft");
  assert.equal(env.stage, "specify");
  assert.equal(env.priority, 0);
  assert.deepEqual(env.operations, []);
  assert.deepEqual(env.attempts, []);
  assert.deepEqual(env.decisions, []);
  assert.deepEqual(env.resources, []);
  assert.deepEqual(env.evidence, []);
  const fetched = await work.getWork("w_basic");
  assert.equal(fetched.revision, 1);
  assert.equal(fetched.objective, "ship the thing");
});

test("execution goal source uniqueness is atomic across concurrent work creations", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  const base = makeWork();
  const goalKey = "a".repeat(64);
  const charter = {
    version: 1,
    revision: 1,
    status: "active",
    goalKey,
    source: { kind: "ceo_instruction", sessionId: base.origin.conversationId, messageId: base.origin.messageId },
    acceptedAt: 123,
    scope: {
      workspaceId: base.project.workspaceId,
      repositoryId: base.project.repositoryId,
      objectiveHash: createHash("sha256").update(base.objective).digest("hex"),
      specHash: base.spec.hash,
      deliveryTargetHash: createHash("sha256").update(canonicalJson(base.deliveryTarget)).digest("hex"),
    },
    limits: { maxAttemptsPerStage: 3 },
    permissions: ["dispatch", "retry", "handoff", "review", "verify", "complete"],
  };
  const inputs = [
    { ...base, id: "w_goal_a", executionCharter: charter },
    { ...base, id: "w_goal_b", executionCharter: charter },
  ];
  const settled = await Promise.allSettled(inputs.map((input) => work.createWork(input)));
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = settled.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.code, "duplicate_execution_goal");
  const found = await work.findExecutionGoal(goalKey);
  assert.ok(found);
  assert.equal(found.id, settled.find((r) => r.status === "fulfilled").value.id);
});

test("getWork returns null for a missing work and never a fabricated envelope", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  assert.equal(await work.getWork("w_nope"), null);
});

test("createWork rejects structurally invalid targets without writing anything", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  await assert.rejects(
    work.createWork(makeWork({ project: { workspaceId: "ws", repositoryId: "repo", repositoryRoot: "relative/path" } })),
    /absolute path/,
  );
  await assert.rejects(
    work.createWork(makeWork({ project: { workspaceId: "", repositoryId: "repo", repositoryRoot: "/x" } })),
    /workspaceId/,
  );
  await assert.rejects(
    work.createWork(makeWork({ deliveryTarget: { kind: "ftp" } })),
    /deliveryTarget\.kind/,
  );
  await assert.rejects(
    work.createWork(makeWork({ deliveryTarget: { kind: "deployed", releaseTarget: "r", channel: "c" } })),
    /instance/,
  );
  await assert.rejects(work.createWork(makeWork({ stage: "party" })), /stage/);
  await assert.rejects(work.createWork(makeWork({ state: "semi-done" })), /state/);
  await assert.rejects(work.createWork(makeWork({ spec: { revision: 0, hash: "h", documentRef: "d" } })), /spec\.revision/);
  // Nothing was written: the store directory holds no envelopes.
  const listed = await work.listWorks();
  assert.equal(listed.total, 0);
});

test("createWork with a waiting state requires a waitingReason from the closed set", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  await assert.rejects(
    work.createWork(makeWork({ state: "waiting" })),
    /waitingReason/,
  );
  const env = await work.createWork(
    makeWork({ id: "w_wait", state: "waiting", waitingReason: "capacity" }),
  );
  assert.equal(env.waitingReason, "capacity");
  await assert.rejects(
    work.createWork(makeWork({ id: "w_bad", state: "waiting", waitingReason: "vibes" })),
    /waitingReason/,
  );
});

test("createWork rejects an unknown dependency and a sequential duplicate id", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  await assert.rejects(
    work.createWork({ id: "w_a", ...makeWork({ dependencies: ["w_missing"] }) }),
    (error) => error.code === "target_not_found" && /w_missing/.test(error.message),
  );
  await seedWork(work, "w_b");
  await assert.rejects(seedWork(work, "w_b"), (error) => error.code === "target_exists");
});

test("create race: concurrent creates of the SAME supplied id — exactly one wins, no overwrite erases it", async () => {
  const store = sandboxStore();
  const work = createCtoWork({ store, now: makeClock().now });
  const [a, b] = await Promise.allSettled([
    work.createWork({ id: "w_race", ...makeWork({ objective: "first" }) }),
    work.createWork({ id: "w_race", ...makeWork({ objective: "second" }) }),
  ]);
  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "the absence check + first write are serialized under the file lock");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "target_exists");
  const env = await work.getWork("w_race");
  assert.equal(env.objective, fulfilled[0].value.objective);
});

test("create race (deterministic latch on injected write signals): second create after commit rejects, never overwrites", async () => {
  const store = observableStore();
  const work = createCtoWork({ store, now: makeClock().now });
  const first = work.createWork({ id: "w_latch", ...makeWork({ attempts: [{ attempt: 1 }] }) });
  await store.waitForWrites(1); // the FIRST create fully committed (not a pre-existing file)
  await assert.rejects(
    work.createWork({ id: "w_latch", ...makeWork() }),
    (error) => error.code === "target_exists",
  );
  const winner = await first;
  assert.equal(winner.attempts.length, 1, "the winner's envelope was not clobbered");
});

test("listWorks is bounded and reports the true total (truncation is visible, never silent)", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  for (const id of ["w_l1", "w_l2", "w_l3"]) {
    await seedWork(work, id);
  }
  const page = await work.listWorks({ limit: 2 });
  assert.equal(page.works.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.limit, 2);
  const all = await work.listWorks();
  assert.equal(all.works.length, 3);
  assert.equal(all.total, 3);
  assert.equal(all.limit, LIST_DEFAULT_LIMIT);
  await assert.rejects(work.listWorks({ limit: 0 }), /limit/);
});

test("a missing store directory is an EMPTY portfolio (ENOENT), other readdir failures are explicit", async (t) => {
  const store = sandboxStore();
  const work = createCtoWork({ store, now: makeClock().now });
  // No store yet → ENOENT → legitimately empty, never an error.
  assert.deepEqual(await work.listWorks(), { works: [], total: 0, limit: LIST_DEFAULT_LIMIT });
  // The store "directory" is a FILE → ENOTDIR → visible store_unavailable.
  // (Build the blocked store fully — pathFor must address the new dir.)
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, "not-a-dir"), "x");
  const notADir = join(store.dir, "not-a-dir");
  const blocked = createCtoWork({
    store: {
      name: "work",
      dir: notADir,
      pathFor: (id) => join(notADir, `${id}.json`),
      save: store.save,
    },
    now: makeClock().now,
  });
  await assert.rejects(
    blocked.listWorks(),
    (error) => error.code === "store_unavailable" && /unavailable/.test(error.message),
  );
  await assert.rejects(
    blocked.getWork("anything"),
    (error) => error.code === "store_unavailable",
  );
  // Permission-denied directory → store_unavailable (root ignores modes: skip).
  if (process.getuid && process.getuid() === 0) {
    t.skip("running as root — file modes are not enforced");
    return;
  }
  await rm(join(store.dir, "not-a-dir"));
  const locked = join(store.dir, "locked");
  await mkdir(locked, { recursive: true });
  await writeFile(join(locked, "w_x.json"), "{}");
  await chmod(locked, 0o000);
  try {
    const denied = createCtoWork({
      store: {
        name: "work",
        dir: locked,
        pathFor: (id) => join(locked, `${id}.json`),
        save: store.save,
      },
      now: makeClock().now,
    });
    await assert.rejects(denied.listWorks(), (error) => error.code === "store_unavailable");
  } finally {
    await chmod(locked, 0o700);
  }
});

// ---------------------------------------------------------------------------
// Revise: expected revision, invalid updates never write, spec monotonicity
// ---------------------------------------------------------------------------

test("reviseWork bumps the revision and preserves unrelated references", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_r1", {
    attempts: [{ attempt: 1, stage: "implement", status: "running" }],
    evidence: [{ kind: "git", id: "abc123", observedAt: 1 }],
  });
  const revised = await work.reviseWork("w_r1", { objective: "ship it better", priority: 7 });
  assert.equal(revised.revision, 2);
  assert.equal(revised.objective, "ship it better");
  assert.equal(revised.priority, 7);
  assert.equal(revised.attempts.length, 1);
  assert.equal(revised.evidence.length, 1);
});

test("reviseWork with a stale expectedRevision is a revision_conflict and writes nothing", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  const env = await seedWork(work, "w_r2");
  await assert.rejects(
    work.reviseWork("w_r2", { objective: "mutated" }, { expectedRevision: env.revision + 5 }),
    (error) => error.code === "revision_conflict" && /nothing written/.test(error.message),
  );
  const after = await work.getWork("w_r2");
  assert.equal(after.revision, env.revision);
  assert.equal(after.objective, "ship the thing");
});

test("revise validation applies to loaded envelopes — invalid updates never write", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  const env = await seedWork(work, "w_r3");
  await assert.rejects(work.reviseWork("w_r3", { sneaky: true }), /unknown revise field/);
  await assert.rejects(work.reviseWork("w_r3", { state: "semi-done" }), /not a valid work state/);
  await assert.rejects(work.reviseWork("w_r3", { stage: "party" }), /not a valid work stage/);
  await assert.rejects(work.reviseWork("w_r3", { waitingReason: "capacity" }), /waitingReason requires/);
  const after = await work.getWork("w_r3");
  assert.equal(after.revision, env.revision);
  assert.equal(after.updatedAt, env.updatedAt);
});

test("reviseWork enforces the waiting invariant in both directions", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_r4");
  await assert.rejects(
    work.reviseWork("w_r4", { state: "waiting" }),
    /requires a waitingReason/,
  );
  const waiting = await work.reviseWork("w_r4", { state: "waiting", waitingReason: "provider" });
  assert.equal(waiting.waitingReason, "provider");
  const resumed = await work.reviseWork("w_r4", { state: "ready" });
  assert.equal(resumed.waitingReason, undefined);
  const got = await work.getWork("w_r4");
  assert.equal(got.waitingReason, undefined);
});

test("a spec change durably invalidates receipts reserved under the old spec (specHash preserved, never compacted)", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_r5", { state: "running" });
  await work.reserveOperation("w_r5", { key: "kr", op: "dispatch", args: {} });
  const revised = await work.reviseWork("w_r5", {
    spec: { revision: 2, hash: "sha256:bbb", documentRef: "docs/specs/alpha.md#rev2" },
  });
  assert.equal(revised.operations[0].superseded, true, "marked superseded AT revision time");
  assert.equal(revised.operations[0].specHash, "sha256:aaa", "the original spec binding is preserved on the receipt");
  const reloaded = await work.getWork("w_r5");
  assert.equal(reloaded.operations[0].superseded, true, "the invalidation is durable");
  assert.equal(reloaded.operations[0].specHash, "sha256:aaa", "specHash survives reload — no compaction, no eviction");
});

test("reviseWork spec changes are monotonic and hash-consistent", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_r6");
  await assert.rejects(
    work.reviseWork("w_r6", { spec: { revision: 1, hash: "sha256:bbb", documentRef: "x" } }),
    /without a revision bump/,
  );
  await assert.rejects(
    work.reviseWork("w_r6", { spec: { revision: -1, hash: "sha256:bbb", documentRef: "x" } }),
    /monotonic|positive/,
  );
  const bumped = await work.reviseWork("w_r6", {
    spec: { revision: 2, hash: "sha256:bbb", documentRef: "docs/specs/alpha.md#rev2" },
  });
  assert.equal(bumped.spec.revision, 2);
  assert.equal(bumped.spec.hash, "sha256:bbb");
  // Reprioritization alone does not touch the spec (§5.2).
  const reprio = await work.reviseWork("w_r6", { priority: 3 });
  assert.deepEqual(reprio.spec, bumped.spec);
});

test("an empty revise patch is a pure no-op (no write, no revision bump)", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  const env = await seedWork(work, "w_r7");
  const same = await work.reviseWork("w_r7", {});
  assert.equal(same.revision, env.revision);
  assert.equal(same.updatedAt, env.updatedAt);
  assert.equal(same.objective, env.objective);
});

test("reviseWork rejects unknown dependencies and sequential dependency cycles", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_d1");
  await seedWork(work, "w_d2");
  await work.reviseWork("w_d1", { dependencies: ["w_d2"] });
  await assert.rejects(
    work.reviseWork("w_d2", { dependencies: ["w_d1"] }),
    (error) => error.code === "dependency_cycle",
  );
  await assert.rejects(
    work.reviseWork("w_d2", { dependencies: ["w_ghost"] }),
    (error) => error.code === "target_not_found",
  );
  // The rejected revise wrote nothing: w_d2 still has no dependencies.
  const d2 = await work.getWork("w_d2");
  assert.deepEqual(d2.dependencies, []);
});

test("concurrent A→B / B→A dependency revisions — one commits, the cycle never persists", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_g1");
  await seedWork(work, "w_g2");
  // Both validate+commit sections run under the shared graph lock, so they
  // are serialized: the second sees the first's committed edge and rejects.
  const [a, b] = await Promise.allSettled([
    work.reviseWork("w_g1", { dependencies: ["w_g2"] }),
    work.reviseWork("w_g2", { dependencies: ["w_g1"] }),
  ]);
  const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
  const rejected = [a, b].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "dependency_cycle");
  const g1 = await work.getWork("w_g1");
  const g2 = await work.getWork("w_g2");
  const edges = (g1.dependencies.length > 0 ? 1 : 0) + (g2.dependencies.length > 0 ? 1 : 0);
  assert.equal(edges, 1, "exactly one edge was committed — never a persisted cycle");
});

// ---------------------------------------------------------------------------
// Operation receipts: canonical args, idempotent reserve, leases (U10)
// ---------------------------------------------------------------------------

test("canonical request hashing is key-order independent, content sensitive, and binds the op", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { z: 1, y: 2 }] }), canonicalJson({ a: [2, { y: 2, z: 1 }], b: 1 }));
  assert.equal(canonicalArgsHash("op", { a: 1, b: "x" }), canonicalArgsHash("op", { b: "x", a: 1 }));
  assert.notEqual(canonicalArgsHash("op", { a: 1 }), canonicalArgsHash("op", { a: 2 }));
  assert.notEqual(canonicalArgsHash("op1", { a: 1 }), canonicalArgsHash("op2", { a: 1 }), "op is part of the hash");
});

test("reserveOperation creates one receipt carrying key, op-bound args hash, expected revision, stage and spec hash", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  const env = await seedWork(work, "w_o1", { state: "ready", stage: "implement" });
  const { receipt, replay } = await work.reserveOperation("w_o1", {
    key: "dispatch-1",
    op: "dispatch",
    args: { workId: "w_o1", isolationRequired: true },
    expectedRevision: env.revision,
  });
  assert.equal(replay, false);
  assert.equal(receipt.status, "pending");
  assert.equal(receipt.key, "dispatch-1");
  assert.equal(receipt.op, "dispatch");
  assert.equal(receipt.argsHash, canonicalArgsHash("dispatch", { workId: "w_o1", isolationRequired: true }));
  assert.equal(receipt.workRevision, env.revision);
  assert.equal(receipt.stage, "implement");
  assert.equal(receipt.specHash, "sha256:aaa");
  assert.ok(receipt.lease.expiresAt > receipt.createdAt);
  // The reservation stored the receipt without moving the work-state revision
  // (receipt bookkeeping is not a work-state change; see module header).
  const after = await work.getWork("w_o1");
  assert.equal(after.revision, env.revision);
  assert.equal(after.operations.length, 1);
});

test("U10: two concurrent reserves with the same key produce exactly ONE reservation", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  const env = await seedWork(work, "w_o2");
  const [a, b] = await Promise.all([
    work.reserveOperation("w_o2", { key: "k1", op: "dispatch", args: { n: 1 }, expectedRevision: env.revision }),
    work.reserveOperation("w_o2", { key: "k1", op: "dispatch", args: { n: 1 }, expectedRevision: env.revision }),
  ]);
  const created = [a, b].filter((r) => r.replay === false);
  const replayed = [a, b].filter((r) => r.replay === true);
  assert.equal(created.length, 1, "exactly one caller creates the reservation");
  assert.equal(replayed.length, 1, "the other caller replays the prior receipt");
  assert.equal(created[0].receipt.id, replayed[0].receipt.id);
  // Only the creating reservation wrote, and neither moved the work revision.
  const after = await work.getWork("w_o2");
  assert.equal(after.revision, env.revision);
  assert.equal(after.operations.length, 1);
});

test("U10 (deterministic latch on injected write signals): after the first reserve commits, an interleaved same-key reserve replays", async () => {
  const store = observableStore();
  const clock = makeClock();
  const work = createCtoWork({ store, now: clock.now });
  const env = await seedWork(work, "w_o2b"); // write #1
  const first = work.reserveOperation("w_o2b", {
    key: "kl", op: "dispatch", args: { n: 1 }, expectedRevision: env.revision,
  });
  await store.waitForWrites(2); // the RESERVE (write #2) fully committed — not a pre-existing file
  const second = await work.reserveOperation("w_o2b", {
    key: "kl", op: "dispatch", args: { n: 1 }, expectedRevision: env.revision,
  });
  const r1 = await first;
  assert.equal(r1.replay, false);
  assert.equal(second.replay, true);
  assert.equal(second.receipt.id, r1.receipt.id);
});

test("U10: retrying the identical payload replays the prior operation with its original result", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_o3");
  const first = await work.reserveOperation("w_o3", {
    key: "k2",
    op: "dispatch",
    args: { branch: "feat/x", base: "main" },
  });
  await work.recordOperationOutcome("w_o3", {
    receiptId: first.receipt.id,
    status: "succeeded",
    resultCode: "candidate_ready",
    externalRef: "job_42",
  });
  // Same key, same op, same logical args under a DIFFERENT key order → replay.
  const second = await work.reserveOperation("w_o3", {
    key: "k2",
    op: "dispatch",
    args: { base: "main", branch: "feat/x" },
  });
  assert.equal(second.replay, true);
  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(second.receipt.status, "succeeded");
  assert.equal(second.receipt.resultCode, "candidate_ready");
  assert.equal(second.receipt.externalRef, "job_42");
});

test("U10: the same key with DIFFERENT arguments is rejected and reserves nothing", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_o4");
  await work.reserveOperation("w_o4", { key: "k3", op: "dispatch", args: { a: 1 } });
  await assert.rejects(
    work.reserveOperation("w_o4", { key: "k3", op: "dispatch", args: { a: 2 } }),
    (error) => error.code === "idempotency_key_args_mismatch",
  );
  const after = await work.getWork("w_o4");
  assert.equal(after.operations.length, 1);
});

test("the same key with the SAME args but a DIFFERENT op is rejected", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_o4b");
  await work.reserveOperation("w_o4b", { key: "k3b", op: "dispatch", args: { a: 1 } });
  await assert.rejects(
    work.reserveOperation("w_o4b", { key: "k3b", op: "retry-dispatch", args: { a: 1 } }),
    (error) => error.code === "idempotency_key_args_mismatch" && /"dispatch"/.test(error.message),
  );
  const after = await work.getWork("w_o4b");
  assert.equal(after.operations.length, 1);
});

test("U10: a live lease replays; an expired PENDING lease is recovered exactly once per recovery", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_o5");
  const first = await work.reserveOperation("w_o5", { key: "k4", op: "dispatch", args: {}, leaseTtlMs: 1000 });
  // Live lease: replay, no takeover, no write.
  const live = await work.reserveOperation("w_o5", { key: "k4", op: "dispatch", args: {} });
  assert.equal(live.replay, true);
  assert.equal(live.receipt.takeoverCount, 0);
  // After expiry: lease recovery re-arms the same receipt (never a second one).
  clock.advanceMs(2000);
  const recovered = await work.reserveOperation("w_o5", { key: "k4", op: "dispatch", args: {} });
  assert.equal(recovered.replay, false);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.receipt.id, first.receipt.id);
  assert.equal(recovered.receipt.takeoverCount, 1);
  assert.equal(recovered.receipt.status, "pending");
  const after = await work.getWork("w_o5");
  assert.equal(after.operations.length, 1);
});

test("an expired lease NEVER resets a terminal receipt — succeeded/failed still replay", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_o5b");
  const { receipt } = await work.reserveOperation("w_o5b", {
    key: "kt", op: "dispatch", args: {}, leaseTtlMs: 1000,
  });
  await work.recordOperationOutcome("w_o5b", {
    receiptId: receipt.id, status: "succeeded", resultCode: "done", externalRef: "job_t",
  });
  clock.advanceMs(2000); // lease long expired
  const replay = await work.reserveOperation("w_o5b", { key: "kt", op: "dispatch", args: {} });
  assert.equal(replay.replay, true, "terminal replays even with an expired lease");
  assert.equal(replay.recovered, undefined, "never re-armed");
  assert.equal(replay.receipt.status, "succeeded", "NOT reset to pending");
  assert.equal(replay.receipt.resultCode, "done");
  assert.equal(replay.receipt.externalRef, "job_t");
  assert.equal(replay.receipt.takeoverCount, 0);
  const after = await work.getWork("w_o5b");
  assert.equal(after.operations.length, 1);
  assert.equal(after.operations[0].status, "succeeded");
  // Same for failed.
  const { receipt: f } = await work.reserveOperation("w_o5b", { key: "kt2", op: "dispatch", args: {}, leaseTtlMs: 1000 });
  await work.recordOperationOutcome("w_o5b", { receiptId: f.id, status: "failed", resultCode: "boom" });
  clock.advanceMs(2000);
  const failedReplay = await work.reserveOperation("w_o5b", { key: "kt2", op: "dispatch", args: {} });
  assert.equal(failedReplay.replay, true);
  assert.equal(failedReplay.receipt.status, "failed");
});

test("an expired IN_FLIGHT lease becomes a durable UNKNOWN — reconcile, never re-execute", async () => {
  const store = sandboxStore();
  const clock = makeClock();
  const work = createCtoWork({ store, now: clock.now });
  await seedWork(work, "w_o5c");
  const { receipt } = await work.reserveOperation("w_o5c", {
    key: "ki", op: "dispatch", args: {}, leaseTtlMs: 1000,
  });
  await work.recordOperationOutcome("w_o5c", { receiptId: receipt.id, status: "in_flight", externalRef: "job_i" });
  clock.advanceMs(2000); // lease expires while the effect was in flight
  await assert.rejects(
    work.reserveOperation("w_o5c", { key: "ki", op: "dispatch", args: {} }),
    (error) =>
      error.code === "external_outcome_unknown" &&
      error.receipt?.status === "unknown" &&
      error.receipt?.reconcileReason === "lease_expired",
  );
  // The uncertainty is DURABLE: a fresh instance over the same store sees it.
  const fresh = createCtoWork({ store, now: clock.now });
  const env = await fresh.getWork("w_o5c");
  assert.equal(env.operations.length, 1, "no second reservation was created");
  assert.equal(env.operations[0].status, "unknown");
  await assert.rejects(
    fresh.reserveOperation("w_o5c", { key: "ki", op: "dispatch", args: {} }),
    (error) => error.code === "external_outcome_unknown",
  );
  // Reconciliation (with evidence) resolves it; only then does the key replay.
  const resolved = await fresh.recordOperationOutcome("w_o5c", {
    receiptId: receipt.id, status: "succeeded", resultCode: "reconciled:job_i_output_verified",
  });
  assert.equal(resolved.receipt.status, "succeeded");
  const replay = await fresh.reserveOperation("w_o5c", { key: "ki", op: "dispatch", args: {} });
  assert.equal(replay.replay, true);
  assert.equal(replay.receipt.status, "succeeded");
});

test("U10 crash load replay: a fresh service instance over the same store replays the receipt", async () => {
  const store = sandboxStore();
  const clock = makeClock();
  const before = createCtoWork({ store, now: clock.now });
  const env = await seedWork(before, "w_o6");
  const reserved = await before.reserveOperation("w_o6", {
    key: "k5",
    op: "dispatch",
    args: { attempt: 1 },
    expectedRevision: env.revision,
  });
  // Simulated crash: a brand-new service over the SAME store (no in-memory state).
  const after = createCtoWork({ store, now: clock.now });
  const replayed = await after.reserveOperation("w_o6", {
    key: "k5",
    op: "dispatch",
    args: { attempt: 1 },
  });
  assert.equal(replayed.replay, true);
  assert.equal(replayed.receipt.id, reserved.receipt.id);
  assert.equal(replayed.receipt.status, "pending");
  const got = await after.getWork("w_o6");
  assert.equal(got.operations.length, 1);
  assert.equal(got.revision, env.revision);
});

test("reserveOperation with a stale expectedRevision is a revision_conflict and reserves nothing", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  const env = await seedWork(work, "w_o7");
  await assert.rejects(
    work.reserveOperation("w_o7", { key: "k6", op: "dispatch", args: {}, expectedRevision: env.revision + 3 }),
    (error) => error.code === "revision_conflict" && /nothing reserved/.test(error.message),
  );
  const after = await work.getWork("w_o7");
  assert.equal(after.operations.length, 0);
  assert.equal(after.revision, env.revision);
});

// ---------------------------------------------------------------------------
// BLOCKER 5: lease inputs validated BEFORE any write
// ---------------------------------------------------------------------------

test("malformed lease inputs are rejected before any write", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_lz");
  for (const bad of ["1000", NaN, 0, -1000, Number.POSITIVE_INFINITY, 1.5, MAX_LEASE_TTL_MS + 1]) {
    await assert.rejects(
      work.reserveOperation("w_lz", { key: `k_${String(bad)}`, op: "dispatch", args: {}, leaseTtlMs: bad }),
      (error) => error.code === "unsupported" && /leaseTtlMs/.test(error.message),
      `leaseTtlMs ${String(bad)} must be rejected`,
    );
  }
  await assert.rejects(
    work.reserveOperation("w_lz", { key: "k_owner_empty", op: "dispatch", args: {}, leaseOwner: "" }),
    (error) => error.code === "unsupported" && /leaseOwner/.test(error.message),
  );
  await assert.rejects(
    work.reserveOperation("w_lz", { key: "k_owner_num", op: "dispatch", args: {}, leaseOwner: 42 }),
    (error) => error.code === "unsupported" && /leaseOwner/.test(error.message),
  );
  const after = await work.getWork("w_lz");
  assert.equal(after.operations.length, 0, "nothing was written by any rejected reserve");
  // The documented maximum itself is accepted.
  const ok = await work.reserveOperation("w_lz", { key: "k_max", op: "dispatch", args: {}, leaseTtlMs: MAX_LEASE_TTL_MS });
  assert.equal(ok.replay, false);
});

// ---------------------------------------------------------------------------
// BLOCKER 6: caller-mutable args — snapshot + hash taken synchronously
// ---------------------------------------------------------------------------

test("mutating the args object after reserve is called cannot desync stored data from the hash", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_sn");
  const args = { n: 1, nested: { deep: "v" } };
  const pending = work.reserveOperation("w_sn", { key: "ks", op: "dispatch", args });
  // Mutate WHILE the reserve is in flight — after the synchronous snapshot.
  args.n = 999;
  args.mutated = true;
  args.nested.deep = "changed";
  const { receipt } = await pending;
  assert.deepEqual(receipt.args, { n: 1, nested: { deep: "v" } }, "stored args are the synchronous snapshot");
  assert.equal("mutated" in receipt.args, false);
  assert.equal(receipt.argsHash, canonicalArgsHash("dispatch", { n: 1, nested: { deep: "v" } }));
  const reloaded = await work.getWork("w_sn");
  assert.deepEqual(reloaded.operations[0].args, { n: 1, nested: { deep: "v" } }, "the snapshot survives persistence");
  // Dedupe follows the snapshot, not the mutated caller object.
  const replay = await work.reserveOperation("w_sn", { key: "ks", op: "dispatch", args: { n: 1, nested: { deep: "v" } } });
  assert.equal(replay.replay, true);
  await assert.rejects(
    work.reserveOperation("w_sn", { key: "ks", op: "dispatch", args: { n: 999 } }),
    (error) => error.code === "idempotency_key_args_mismatch",
  );
});

test("non-JSON-safe args are rejected deterministically before any write", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_js");
  const cases = [
    ["function", { fn: () => {} }],
    ["date", { when: new Date(0) }],
    ["undefined value", { hole: undefined }],
    ["NaN", { x: NaN }],
    ["Infinity", { x: Number.POSITIVE_INFINITY }],
    ["bigint", { x: 1n }],
    ["class instance", { x: new (class Thing {})() }],
  ];
  for (const [label, badArgs] of cases) {
    await assert.rejects(
      work.reserveOperation("w_js", { key: `k_${label.replace(/\W+/g, "_")}`, op: "dispatch", args: badArgs }),
      (error) => error.code === "unsupported" && /args/.test(error.message),
      `args case "${label}" must be rejected`,
    );
  }
  // Cycles are rejected, not stack-overflowed.
  const cyclic = { self: null };
  cyclic.self = cyclic;
  await assert.rejects(
    work.reserveOperation("w_js", { key: "k_cycle", op: "dispatch", args: cyclic }),
    (error) => error.code === "unsupported" && /circular/.test(error.message),
  );
  const after = await work.getWork("w_js");
  assert.equal(after.operations.length, 0, "nothing was written by any rejected reserve");
});

test("BLOCKER 2: args contract — omitted ≡ {} (same op), explicit null rejected, nested null preserved and distinct", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_an");
  // An explicit null is rejected deterministically — never silently hashed as {}.
  await assert.rejects(
    work.reserveOperation("w_an", { key: "knull", op: "dispatch", args: null }),
    (error) => error.code === "unsupported" && /null/.test(error.message),
  );
  assert.equal((await work.getWork("w_an")).operations.length, 0, "the null reserve wrote nothing");
  // Omitted and {} are the SAME operation: reserve omitted, retry {} → replay.
  const first = await work.reserveOperation("w_an", { key: "kdef", op: "dispatch" });
  assert.deepEqual(first.receipt.args, {});
  assert.equal(first.receipt.argsHash, canonicalArgsHash("dispatch", {}));
  const retry = await work.reserveOperation("w_an", { key: "kdef", op: "dispatch", args: {} });
  assert.equal(retry.replay, true, "null-free default: {} retries the omitted-args operation");
  assert.equal(retry.receipt.id, first.receipt.id);
  // Nested null is ordinary JSON: persisted verbatim, hashed distinctly from {}.
  const nested = await work.reserveOperation("w_an", { key: "knest", op: "dispatch", args: { x: null } });
  assert.deepEqual(nested.receipt.args, { x: null });
  assert.equal(nested.receipt.argsHash, canonicalArgsHash("dispatch", { x: null }));
  assert.notEqual(nested.receipt.argsHash, canonicalArgsHash("dispatch", {}));
  const nestedRetry = await work.reserveOperation("w_an", { key: "knest", op: "dispatch", args: { x: null } });
  assert.equal(nestedRetry.replay, true);
  await assert.rejects(
    work.reserveOperation("w_an", { key: "knest", op: "dispatch", args: {} }),
    (error) => error.code === "idempotency_key_args_mismatch",
    "{} is a DIFFERENT request from {x: null}",
  );
});

// ---------------------------------------------------------------------------
// BLOCKER 2: the explicit receipt transition matrix
// ---------------------------------------------------------------------------

test("the transition matrix is explicit and never downgrades to pending", () => {
  assert.deepEqual(RECEIPT_TRANSITIONS.pending, ["in_flight", "succeeded", "failed", "unknown"]);
  assert.deepEqual(RECEIPT_TRANSITIONS.in_flight, ["succeeded", "failed", "unknown"]);
  assert.deepEqual(RECEIPT_TRANSITIONS.unknown, ["succeeded", "failed"]);
  assert.deepEqual(RECEIPT_TRANSITIONS.succeeded, []);
  assert.deepEqual(RECEIPT_TRANSITIONS.failed, []);
  for (const targets of Object.values(RECEIPT_TRANSITIONS)) {
    assert.equal(targets.includes("pending"), false, "no status may transition back to pending");
  }
});

test("recording outcomes follows the matrix: downgrades and invalid jumps are conflicts", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_m1");
  const { receipt } = await work.reserveOperation("w_m1", { key: "km", op: "dispatch", args: {} });
  await work.recordOperationOutcome("w_m1", { receiptId: receipt.id, status: "in_flight" });
  // The forbidden downgrade.
  await assert.rejects(
    work.recordOperationOutcome("w_m1", { receiptId: receipt.id, status: "pending" }),
    (error) => error.code === "receipt_state_conflict" && /in_flight → pending/.test(error.message),
  );
  // Terminal is immutable: any different record conflicts.
  await work.recordOperationOutcome("w_m1", { receiptId: receipt.id, status: "succeeded", resultCode: "ok" });
  await assert.rejects(
    work.recordOperationOutcome("w_m1", { receiptId: receipt.id, status: "failed" }),
    (error) => error.code === "receipt_state_conflict",
  );
  await assert.rejects(
    work.recordOperationOutcome("w_m1", { receiptId: receipt.id, status: "pending" }),
    (error) => error.code === "receipt_state_conflict",
  );
  // Same-status records remain idempotent replays.
  const again = await work.recordOperationOutcome("w_m1", { receiptId: receipt.id, status: "succeeded", resultCode: "ok" });
  assert.equal(again.replay, true);
});

test("resolving an UNKNOWN receipt requires explicit reconciliation evidence", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_m2");
  const { receipt } = await work.reserveOperation("w_m2", { key: "km2", op: "dispatch", args: {} });
  await work.recordOperationOutcome("w_m2", { receiptId: receipt.id, status: "unknown", externalRef: "job_m" });
  await assert.rejects(
    work.recordOperationOutcome("w_m2", { receiptId: receipt.id, status: "succeeded" }),
    (error) => error.code === "unsupported" && /reconciliation evidence/.test(error.message),
  );
  await assert.rejects(
    work.recordOperationOutcome("w_m2", { receiptId: receipt.id, status: "in_flight" }),
    (error) => error.code === "receipt_state_conflict",
  );
  const resolved = await work.recordOperationOutcome("w_m2", {
    receiptId: receipt.id,
    status: "succeeded",
    resultCode: "reconciled:inspected job_m output",
  });
  assert.equal(resolved.receipt.status, "succeeded");
});

test("BLOCKER 1: outcome fields are validated BEFORE any write — a rejected record leaves the store unchanged", async () => {
  const store = observableStore();
  const clock = makeClock();
  const work = createCtoWork({ store, now: clock.now });
  await seedWork(work, "w_pv"); // write 1
  const { receipt } = await work.reserveOperation("w_pv", { key: "kpv", op: "dispatch", args: {} }); // write 2
  // Typed-wrong outcomes are rejected on every path, before any write.
  for (const bad of [
    { resultCode: 42 },
    { externalRef: {} },
    { externalRef: [] },
    { resultCode: 42, externalRef: 7 },
  ]) {
    await assert.rejects(
      work.recordOperationOutcome("w_pv", { receiptId: receipt.id, status: "succeeded", ...bad }),
      (error) => error.code === "unsupported",
      `outcome ${JSON.stringify(bad)} must be rejected`,
    );
  }
  const afterRejects = await work.getWork("w_pv");
  assert.equal(afterRejects.operations[0].status, "pending", "no partial success was written");
  assert.equal(afterRejects.operations[0].resultCode, null);
  assert.equal(afterRejects.operations[0].externalRef, null);
  assert.equal(store.writes(), 2, "the store is byte-for-byte unchanged by the rejected records");
  // Same guard on the unknown-reconciliation path (evidence + typed fields).
  await work.recordOperationOutcome("w_pv", { receiptId: receipt.id, status: "unknown" }); // write 3
  await assert.rejects(
    work.recordOperationOutcome("w_pv", {
      receiptId: receipt.id, status: "succeeded", resultCode: "evidence", externalRef: {},
    }),
    (error) => error.code === "unsupported" && /externalRef/.test(error.message),
  );
  assert.equal((await work.getWork("w_pv")).operations[0].status, "unknown", "reconciliation did not half-apply");
  // A valid record still lands normally.
  const ok = await work.recordOperationOutcome("w_pv", {
    receiptId: receipt.id, status: "succeeded", resultCode: "evidence", externalRef: "job_ok",
  });
  assert.equal(ok.receipt.status, "succeeded");
  assert.equal(ok.receipt.externalRef, "job_ok");
});

// ---------------------------------------------------------------------------
// BLOCKER 1: hard history capacity — refuse new keys, never evict
// ---------------------------------------------------------------------------

test("at HISTORY_CAPACITY a NEW unique key is refused; identical retries and records keep working; nothing is evicted", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_cap");
  for (let i = 0; i < HISTORY_CAPACITY; i++) {
    await work.reserveOperation("w_cap", { key: `cap_${i}`, op: "dispatch", args: { i } });
  }
  let env = await work.getWork("w_cap");
  assert.equal(env.operations.length, HISTORY_CAPACITY);
  // The FIRST key still replays at full capacity.
  const firstReplay = await work.reserveOperation("w_cap", { key: "cap_0", op: "dispatch", args: { i: 0 } });
  assert.equal(firstReplay.replay, true);
  assert.equal(firstReplay.receipt.key, "cap_0");
  // ...and its outcome can still be recorded (no new receipt).
  const recorded = await work.recordOperationOutcome("w_cap", { key: "cap_0", status: "succeeded", resultCode: "ok" });
  assert.equal(recorded.receipt.status, "succeeded");
  // cap + 1: a NEW unique key is refused — never an eviction.
  await assert.rejects(
    work.reserveOperation("w_cap", { key: "over_the_cap", op: "dispatch", args: {} }),
    (error) => error.code === "history_capacity" && /capacity/.test(error.message),
  );
  // Even after the first receipt reached a terminal state, the ID history is
  // immutable: still refused, still no eviction.
  env = await work.getWork("w_cap");
  assert.equal(env.operations.length, HISTORY_CAPACITY, "no receipt was ever evicted or compacted");
  assert.equal(env.operations[0].status, "succeeded");
  assert.ok(env.operations.every((r) => r.specHash === "sha256:aaa"), "every receipt keeps its full spec binding");
  // And the first key STILL replays after the refusal.
  const still = await work.reserveOperation("w_cap", { key: "cap_0", op: "dispatch", args: { i: 0 } });
  assert.equal(still.replay, true);
  assert.equal(still.receipt.status, "succeeded");
});

// ---------------------------------------------------------------------------
// Operation outcomes: transitions, unknown reconciliation, stale spec (U13)
// ---------------------------------------------------------------------------

test("recordOperationOutcome persists observed results with external identity", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p1");
  const { receipt } = await work.reserveOperation("w_p1", { key: "k7", op: "dispatch", args: {} });
  await work.recordOperationOutcome("w_p1", {
    receiptId: receipt.id,
    status: "in_flight",
    externalRef: "job_7",
  });
  const done = await work.recordOperationOutcome("w_p1", {
    receiptId: receipt.id,
    status: "succeeded",
    resultCode: "ok",
  });
  assert.equal(done.replay, false);
  assert.equal(done.receipt.status, "succeeded");
  assert.equal(done.receipt.externalRef, "job_7");
  assert.equal(done.receipt.resultCode, "ok");
  assert.ok(done.receipt.resultAt);
  // Same status again → successful replay of the known operation, original result.
  const again = await work.recordOperationOutcome("w_p1", {
    receiptId: receipt.id,
    status: "succeeded",
    resultCode: "ok",
  });
  assert.equal(again.replay, true);
  assert.equal(again.receipt.resultCode, "ok");
});

test("recording an invalid status is rejected", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p2");
  const { receipt } = await work.reserveOperation("w_p2", { key: "k8", op: "dispatch", args: {} });
  await assert.rejects(
    work.recordOperationOutcome("w_p2", { receiptId: receipt.id, status: "nonsense" }),
    /not a valid operation status/,
  );
});

test("U19: recording UNKNOWN forbids blind re-dispatch until a definitive outcome resolves it", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p3");
  const { receipt } = await work.reserveOperation("w_p3", { key: "k9", op: "dispatch", args: {} });
  const unknown = await work.recordOperationOutcome("w_p3", {
    receiptId: receipt.id,
    status: "unknown",
    externalRef: "job_9",
  });
  assert.equal(unknown.receipt.status, "unknown");
  // A retry with the same key must NOT silently re-reserve: the uncertain
  // external effect blocks re-dispatch until reconciliation.
  await assert.rejects(
    work.reserveOperation("w_p3", { key: "k9", op: "dispatch", args: {} }),
    (error) => error.code === "external_outcome_unknown" && error.receipt?.id === receipt.id,
  );
  const after = await work.getWork("w_p3");
  assert.equal(after.operations.length, 1, "no second reservation was created");
  // Reconciliation (a definitive outcome with evidence) resolves the unknown.
  const resolved = await work.recordOperationOutcome("w_p3", {
    receiptId: receipt.id,
    status: "succeeded",
    resultCode: "verified_after_unknown",
  });
  assert.equal(resolved.receipt.status, "succeeded");
  // Now the same key replays the resolved operation.
  const replay = await work.reserveOperation("w_p3", { key: "k9", op: "dispatch", args: {} });
  assert.equal(replay.replay, true);
  assert.equal(replay.receipt.status, "succeeded");
});

test("U13: a result recorded after a spec change is marked superseded and does not advance the work", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p4", {
    state: "running",
    attempts: [{ attempt: 1, stage: "implement", status: "running" }],
    evidence: [{ kind: "git", id: "abc123", observedAt: 1 }],
  });
  const { receipt } = await work.reserveOperation("w_p4", { key: "k10", op: "dispatch", args: {} });
  assert.equal(receipt.specHash, "sha256:aaa");
  // Scope change mid-run: a new spec revision (checkpoint preserved).
  const revised = await work.reviseWork("w_p4", {
    spec: { revision: 2, hash: "sha256:bbb", documentRef: "docs/specs/alpha.md#rev2" },
  });
  assert.equal(revised.spec.hash, "sha256:bbb");
  assert.equal(revised.attempts.length, 1, "checkpoint preserved across the spec revision");
  assert.equal(revised.operations.length, 1, "receipt references preserved across the spec revision");
  // The old attempt completes after the spec change.
  const recorded = await work.recordOperationOutcome("w_p4", {
    receiptId: receipt.id,
    status: "succeeded",
    resultCode: "stale_candidate",
  });
  assert.equal(recorded.superseded, true, "stale-spec result is visibly rejected");
  assert.equal(recorded.receipt.superseded, true);
  const after = await work.getWork("w_p4");
  assert.equal(after.state, "running", "the stale result did not advance the work");
  assert.equal(after.spec.revision, 2);
  assert.equal(after.spec.hash, "sha256:bbb");
  assert.equal(after.attempts.length, 1);
  assert.equal(after.evidence.length, 1);
  // A fresh reservation under the NEW spec carries the new hash.
  const fresh = await work.reserveOperation("w_p4", { key: "k11", op: "dispatch", args: {} });
  assert.equal(fresh.receipt.specHash, "sha256:bbb");
});

test("a redelivered stale completion REPLAYS with superseded:true — never false", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p4b", { state: "running" });
  const { receipt } = await work.reserveOperation("w_p4b", { key: "k10b", op: "dispatch", args: {} });
  // Success recorded under spec A (before any revise).
  const done = await work.recordOperationOutcome("w_p4b", {
    receiptId: receipt.id, status: "succeeded", resultCode: "under_a",
  });
  assert.equal(done.superseded, false, "genuinely current at record time");
  // Scope changes afterwards; the redelivery of the SAME outcome arrives.
  await work.reviseWork("w_p4b", {
    spec: { revision: 2, hash: "sha256:bbb", documentRef: "docs/specs/alpha.md#rev2" },
  });
  const redelivery = await work.recordOperationOutcome("w_p4b", {
    receiptId: receipt.id, status: "succeeded", resultCode: "under_a",
  });
  assert.equal(redelivery.replay, true);
  assert.equal(redelivery.superseded, true, "the replay evaluates staleness BEFORE returning");
});

test("recordOperationOutcome on a missing work or receipt fails visibly", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await assert.rejects(
    work.recordOperationOutcome("w_ghost", { key: "kx", status: "succeeded" }),
    (error) => error.code === "target_not_found",
  );
  await seedWork(work, "w_p5");
  await assert.rejects(
    work.recordOperationOutcome("w_p5", { key: "k_missing", status: "succeeded" }),
    (error) => error.code === "target_not_found",
  );
});

// ---------------------------------------------------------------------------
// Durable storage contract: strict load, corruption is visible, version stamp
// ---------------------------------------------------------------------------

test("corrupt envelopes fail VISIBLY on get and list — never an empty success", async () => {
  const store = sandboxStore();
  const work = createCtoWork({ store, now: makeClock().now });
  await seedWork(work, "w_c1");
  const path = store.pathFor("w_c1");
  await writeFile(path, "{ this is not json", "utf-8");
  await assert.rejects(work.getWork("w_c1"), /corrupt \(invalid JSON\)/);
  await assert.rejects(work.listWorks(), /corrupt \(invalid JSON\)/);
  // A parseable payload with a mismatched id is corrupt too.
  await writeFile(path, JSON.stringify({ v: 1, id: "w_other" }), "utf-8");
  await assert.rejects(work.getWork("w_c1"), /id mismatch/);
});

test("structurally corrupt envelopes and receipts refuse to load (missing fields, bad statuses)", async () => {
  const store = sandboxStore();
  const work = createCtoWork({ store, now: makeClock().now });
  const env = await seedWork(work, "w_c2");
  const raw = JSON.parse(await readFile(store.pathFor("w_c2"), "utf-8"));
  // Missing a required envelope field.
  await writeFile(store.pathFor("w_c2"), JSON.stringify({ ...raw, objective: undefined }), "utf-8");
  await assert.rejects(work.getWork("w_c2"), (error) => error.code === "store_corrupt" && /objective/.test(error.message));
  // A receipt missing its SAFETY fields (specHash / stage) is corrupt.
  await writeFile(
    store.pathFor("w_c2"),
    JSON.stringify({
      ...raw,
      operations: [{ id: "op_x", key: "k", op: "dispatch", argsHash: "h", status: "pending", workRevision: 1, createdAt: 1, updatedAt: 1, lease: { owner: "o", expiresAt: 2 } }],
    }),
    "utf-8",
  );
  await assert.rejects(work.getWork("w_c2"), (error) => error.code === "store_corrupt" && /specHash/.test(error.message));
  // A receipt with an invalid stage is corrupt too.
  await writeFile(
    store.pathFor("w_c2"),
    JSON.stringify({
      ...raw,
      operations: [{ id: "op_x", key: "k", op: "dispatch", argsHash: "h", status: "pending", specHash: "s", stage: "party", workRevision: 1, createdAt: 1, updatedAt: 1, lease: { owner: "o", expiresAt: 2 } }],
    }),
    "utf-8",
  );
  await assert.rejects(work.getWork("w_c2"), (error) => error.code === "store_corrupt" && /stage/.test(error.message));
  // An invalid receipt status can never be misclassified by retention/recovery.
  await writeFile(
    store.pathFor("w_c2"),
    JSON.stringify({
      ...raw,
      operations: [{ id: "op_x", key: "k", op: "dispatch", argsHash: "h", status: "garbage", specHash: "s", stage: "specify", workRevision: 1, createdAt: 1, updatedAt: 1, lease: { owner: "o", expiresAt: 2 } }],
    }),
    "utf-8",
  );
  await assert.rejects(
    work.getWork("w_c2"),
    (error) => error.code === "store_corrupt" && /not a valid operation status/.test(error.message),
  );
  // A receipt without its lease (the recovery material) is corrupt.
  await writeFile(
    store.pathFor("w_c2"),
    JSON.stringify({
      ...raw,
      operations: [{ id: "op_x", key: "k", op: "dispatch", argsHash: "h", status: "pending", specHash: "s", stage: "specify", workRevision: 1, createdAt: 1, updatedAt: 1 }],
    }),
    "utf-8",
  );
  await assert.rejects(work.getWork("w_c2"), (error) => error.code === "store_corrupt" && /lease/.test(error.message));
  // listWorks surfaces the same corruption instead of skipping the entry.
  await writeFile(store.pathFor("w_c2"), JSON.stringify({ ...raw, objective: undefined }), "utf-8");
  await assert.rejects(work.listWorks(), (error) => error.code === "store_corrupt");
  // A valid envelope still round-trips through the validator untouched.
  await writeFile(store.pathFor("w_c2"), JSON.stringify({ ...env, v: 1 }), "utf-8");
  assert.equal((await work.getWork("w_c2")).id, "w_c2");
});

test("a payload stamped with a newer schema version fails loudly instead of truncating", async () => {
  const store = sandboxStore();
  const work = createCtoWork({ store, now: makeClock().now });
  await seedWork(work, "w_c3");
  await writeFile(
    store.pathFor("w_c3"),
    JSON.stringify({ v: 99, id: "w_c3" }),
    "utf-8",
  );
  await assert.rejects(work.getWork("w_c3"), /newer than the supported version/);
});

test("the default workStore hook writes versioned envelopes under the sandboxed cto root", async () => {
  // Uses the REAL additive ctoStores hook (workStore) — resolved through
  // ctoPath → statePath → MANTA_STATE_HOME, so this never touches a live box.
  const clock = makeClock();
  const work = createCtoWork({ store: workStore, now: clock.now });
  const id = `w_hook_${testSeq}`;
  hookWorkIds.push(id); // recorded for teardown — only OWN fixtures are removed
  const env = await work.createWork({ id, ...makeWork() });
  const raw = JSON.parse(await readFile(workStore.pathFor(id), "utf-8"));
  assert.equal(raw.v, 1);
  assert.equal(raw.id, id);
  assert.equal(raw.objective, env.objective);
  assert.deepEqual(migrateStore("work", raw), raw);
  // And a fresh instance replays from the real store.
  const again = createCtoWork({ store: workStore, now: clock.now });
  assert.equal((await again.getWork(id)).revision, 1);
});

// ---------------------------------------------------------------------------
// Enum vocabularies are exported and closed (stage/state enum check)
// ---------------------------------------------------------------------------

test("the closed vocabularies match spec §5.1", () => {
  assert.deepEqual([...WORK_STATES], [
    "draft", "ready", "running", "waiting", "paused",
    "needs_decision", "failed", "completed", "cancelled", "archived",
  ]);
  assert.deepEqual([...WORK_STAGES], ["specify", "implement", "review", "merge", "release", "verify"]);
  assert.deepEqual([...WAITING_REASONS], ["dependency", "capacity", "provider", "external", "reconcile"]);
  assert.deepEqual([...OPERATION_STATUSES], ["pending", "in_flight", "succeeded", "failed", "unknown"]);
  assert.deepEqual([...UNRESOLVED_OPERATION_STATUSES], ["pending", "in_flight", "unknown"]);
  assert.deepEqual([...TERMINAL_OPERATION_STATUSES], ["succeeded", "failed"]);
});

test("ProjectRef validation is structural only — it never resolves or verifies the target", () => {
  assert.doesNotThrow(() =>
    validateProjectRef({ workspaceId: "unmapped-id", repositoryId: "unmapped-repo", repositoryRoot: "/definitely/not/a/real/path" }),
  );
  assert.throws(() => validateProjectRef({ workspaceId: "ws", repositoryId: "repo" }), /repositoryRoot/);
  assert.throws(() => validateDeliveryTarget({ kind: "merged" }), /baseBranch/);
  const err = workError("x", "boom");
  assert.ok(err instanceof Error);
  assert.equal(err.code, "x");
  assert.equal(err.message, "boom");
});
