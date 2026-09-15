// ctoWork.test.mjs — P2a contract tests for the durable work-envelope store
// and operation receipts (unified-cto-spec §5.1/§6/§8.1).
//
// CONTRACT-ONLY (spec §15): these fixtures establish the state/receipt
// interfaces for U10/U13/U19. They do NOT prove an external worker was
// created, a worktree was made, or a deployment ran — no worker side effects
// exist yet in P2a.
//
// Every store path resolves under the MANTA_STATE_HOME sandbox
// (ctoPath → statePath); each test gets its own subdirectory. The only I/O is
// real fs against the sandbox — no live tmux/opencode/network.

// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCtoWork,
  canonicalArgsHash,
  canonicalJson,
  pruneOperationHistory,
  validateProjectRef,
  validateDeliveryTarget,
  workError,
  OPERATIONS_KEEP,
  LIST_DEFAULT_LIMIT,
  OPERATION_STATUSES,
  UNRESOLVED_OPERATION_STATUSES,
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

test("createWork rejects an unknown dependency and a duplicate id", async () => {
  const work = createCtoWork({ store: sandboxStore() });
  await assert.rejects(
    work.createWork({ id: "w_a", ...makeWork({ dependencies: ["w_missing"] }) }),
    (error) => error.code === "target_not_found" && /w_missing/.test(error.message),
  );
  await seedWork(work, "w_b");
  await assert.rejects(seedWork(work, "w_b"), (error) => error.code === "target_exists");
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

test("reviseWork rejects unknown fields and bad enums — invalid updates never write", async () => {
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

test("reviseWork spec changes are monotonic and hash-consistent", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  await seedWork(work, "w_r5");
  await assert.rejects(
    work.reviseWork("w_r5", { spec: { revision: 1, hash: "sha256:bbb", documentRef: "x" } }),
    /without a revision bump/,
  );
  await assert.rejects(
    work.reviseWork("w_r5", { spec: { revision: -1, hash: "sha256:bbb", documentRef: "x" } }),
    /monotonic|positive/,
  );
  const bumped = await work.reviseWork("w_r5", {
    spec: { revision: 2, hash: "sha256:bbb", documentRef: "docs/specs/alpha.md#rev2" },
  });
  assert.equal(bumped.spec.revision, 2);
  assert.equal(bumped.spec.hash, "sha256:bbb");
  // Reprioritization alone does not touch the spec (§5.2).
  const reprio = await work.reviseWork("w_r5", { priority: 3 });
  assert.deepEqual(reprio.spec, bumped.spec);
});

test("an empty revise patch is a pure no-op (no write, no revision bump)", async () => {
  const work = createCtoWork({ store: sandboxStore(), now: makeClock().now });
  const env = await seedWork(work, "w_r6");
  const same = await work.reviseWork("w_r6", {});
  assert.equal(same.revision, env.revision);
  assert.equal(same.updatedAt, env.updatedAt);
  assert.equal(same.objective, env.objective);
});

test("reviseWork rejects unknown dependencies and dependency cycles", async () => {
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

// ---------------------------------------------------------------------------
// Operation receipts: canonical args, idempotent reserve, leases (U10)
// ---------------------------------------------------------------------------

test("canonical args hashing is key-order independent and content sensitive", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { z: 1, y: 2 }] }), canonicalJson({ a: [2, { y: 2, z: 1 }], b: 1 }));
  assert.equal(canonicalArgsHash({ a: 1, b: "x" }), canonicalArgsHash({ b: "x", a: 1 }));
  assert.notEqual(canonicalArgsHash({ a: 1 }), canonicalArgsHash({ a: 2 }));
});

test("reserveOperation creates one receipt carrying key, args hash, expected revision, stage and spec hash", async () => {
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
  assert.equal(receipt.argsHash, canonicalArgsHash({ workId: "w_o1", isolationRequired: true }));
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
  // Same key, same logical args under a DIFFERENT key order → replay.
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

test("U10: a live lease replays; an expired lease is recovered exactly once per recovery", async () => {
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
// Operation outcomes: transitions, unknown reconciliation, stale spec (U13)
// ---------------------------------------------------------------------------

test("recordOperationOutcome persists observed results and is idempotent for the same status", async () => {
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

test("recordOperationOutcome rejects contradictory terminal transitions and unknown statuses", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p2");
  const { receipt } = await work.reserveOperation("w_p2", { key: "k8", op: "dispatch", args: {} });
  await work.recordOperationOutcome("w_p2", { receiptId: receipt.id, status: "failed", resultCode: "boom" });
  await assert.rejects(
    work.recordOperationOutcome("w_p2", { receiptId: receipt.id, status: "succeeded" }),
    (error) => error.code === "receipt_state_conflict",
  );
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
  // Reconciliation (a definitive outcome) resolves the unknown.
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
// Bounded operation history (U19: bounded retries; unresolved never evicted)
// ---------------------------------------------------------------------------

test("pruneOperationHistory trims oldest terminal receipts and NEVER evicts unresolved ones", () => {
  const terminal = (i) => ({
    id: `op_t${i}`,
    key: `k${i}`,
    status: "succeeded",
    resultAt: 1000 + i,
    updatedAt: 1000 + i,
  });
  const unknown = { id: "op_unknown", key: "kU", status: "unknown", updatedAt: 999 };
  const operations = [...Array.from({ length: OPERATIONS_KEEP + 2 }, (_, i) => terminal(i)), unknown];
  const pruned = pruneOperationHistory(operations);
  assert.equal(pruned.length, OPERATIONS_KEEP + 1); // cap terminals, keep unknown
  assert.ok(pruned.some((r) => r.id === "op_unknown"), "the uncertain receipt survives");
  assert.ok(!pruned.some((r) => r.id === "op_t0"), "the oldest terminal was pruned");
  assert.ok(pruned.some((r) => r.id === `op_t${OPERATIONS_KEEP + 1}`), "the newest terminal was kept");
  // Unresolved-only history is never pruned, whatever the requested cap.
  const pending = { id: "op_p", key: "kP", status: "pending", updatedAt: 1 };
  assert.deepEqual(pruneOperationHistory([pending], { keep: 0 }), [pending]);
});

test("stored operation history stays bounded while active unknown receipts are retained", async () => {
  const clock = makeClock();
  const work = createCtoWork({ store: sandboxStore(), now: clock.now });
  await seedWork(work, "w_p6");
  for (let i = 0; i < OPERATIONS_KEEP + 5; i++) {
    const { receipt } = await work.reserveOperation("w_p6", { key: `bulk_${i}`, op: "dispatch", args: { i } });
    await work.recordOperationOutcome("w_p6", { receiptId: receipt.id, status: "succeeded", resultCode: "ok" });
  }
  const { receipt: uncertain } = await work.reserveOperation("w_p6", {
    key: "bulk_uncertain",
    op: "dispatch",
    args: { i: "x" },
  });
  await work.recordOperationOutcome("w_p6", { receiptId: uncertain.id, status: "unknown" });
  const env = await work.getWork("w_p6");
  const terminals = env.operations.filter((r) => r.status === "succeeded" || r.status === "failed");
  const unresolved = env.operations.filter((r) => UNRESOLVED_OPERATION_STATUSES.includes(r.status));
  assert.equal(terminals.length, OPERATIONS_KEEP, "terminal history is capped");
  assert.ok(unresolved.some((r) => r.key === "bulk_uncertain"), "the active unknown receipt was not evicted");
  assert.ok(!env.operations.some((r) => r.key === "bulk_0"), "the oldest terminal receipt was pruned");
  assert.ok(env.operations.some((r) => r.key === `bulk_${OPERATIONS_KEEP + 4}`), "the newest terminal receipt was kept");
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
  await assert.rejects(work.getWork("w_c1"), /mismatched id/);
});

test("a payload stamped with a newer schema version fails loudly instead of truncating", async () => {
  const store = sandboxStore();
  const work = createCtoWork({ store, now: makeClock().now });
  await seedWork(work, "w_c2");
  await writeFile(
    store.pathFor("w_c2"),
    JSON.stringify({ v: 99, id: "w_c2" }),
    "utf-8",
  );
  await assert.rejects(work.getWork("w_c2"), /newer than the supported version/);
});

test("the default workStore hook writes versioned envelopes under the sandboxed cto root", async () => {
  // Uses the REAL additive ctoStores hook (workStore) — resolved through
  // ctoPath → statePath → MANTA_STATE_HOME, so this never touches a live box.
  const clock = makeClock();
  const work = createCtoWork({ store: workStore, now: clock.now });
  const id = `w_hook_${testSeq}`;
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
