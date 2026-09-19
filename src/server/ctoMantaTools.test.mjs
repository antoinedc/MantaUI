// ctoMantaTools.test.mjs — contract tests for the unified-CTO spec §7
// `projects` + `sessions` control-tool families.
//
// Guarantees under test, each with its counterfactual (the positive control
// that proves the guard is load-bearing — delete the guard in the
// implementation and the paired assertion goes red):
//
//   G1  fail-closed target resolution (never infer cwd / first project)
//   G2  idempotency: replay returns the ORIGINAL result; same key with
//       different args is an error; execute runs exactly once
//   G3  receipt crash windows: expired in_flight → external_outcome_unknown
//       (never re-executed); expired pending → safe resume
//   G4  expected-revision CAS on update/configure (revision_conflict, no write)
//   G5  archive ≠ remove: archive touches no destroyer; remove does
//   G6  removal protections: borrowed_resource / dirty_resource /
//       active_resource, destroyer never called while protected
//   G7  read/write separation at the production composition boundary:
//       every read succeeds with ALL write deps wired as throwing spies,
//       and no spy is ever called
//   G8  server-owned model/effort at create/configure (durable record, no
//       renderer event), validated against the model catalog
//   G9  successful mutations carry operation ID, resource ID, revision,
//       state and a visible summary
//  G10  success never lies: every mutation actually drives its external dep
//
// Sandbox discipline: ctoTestGuard aborts without MANTA_STATE_HOME; every
// store is a per-test fixture file under the sandbox. MANTA_OPENCODE_DB is
// armed before any test runs and before any DB handle could open (nothing in
// this module's dependency graph opens one — these tests are pure/injected —
// but the var is set so a future import of opencodeDb can never resolve the
// live box DB).

// BET-1490: shared fail-fast guard — must stay the first import.
import "./ctoTestGuard.mjs";

process.env.MANTA_OPENCODE_DB =
  process.env.MANTA_OPENCODE_DB ?? "/nonexistent/opencode/cto-manta-tools-fixture.db";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createCtoMantaControl,
  resolveProjectIdentity,
  registerCtoMantaControlTools,
  controlError,
  MANTA_CONTROL_RECEIPTS_CAP,
} from "./ctoMantaTools.mjs";
import { ctoPath, lockForStore, mantaControlStore } from "./ctoStores.mjs";
import { canonicalArgsHash } from "./ctoWork.mjs";
import { stateHome } from "../shared/paths.mjs";
import { resolveProjectCwd as sharedResolveProjectCwd } from "./projectCwd.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";
import { makeJsonStoreFixture } from "./ctoTestJsonStore.mjs";

// ---------------------------------------------------------------------------
// Fixtures — what the real server produces (tmux.mjs parseSessions shape,
// oc.listSessions items, oc.listModels items), plus a spy recorder for the
// write deps so every mutation is observed, never assumed.
//
// Cwd fixtures are REAL directories under the MANTA_STATE_HOME sandbox: the
// implementation resolves every cwd through tmux.resolveCwdOrThrow (the
// chokepoint that rejects a missing dir), so fixture paths must exist — that
// rejection is itself part of the behavior under test.
// ---------------------------------------------------------------------------

const FIX_ROOT = join(stateHome(), "cto-manta-fixtures");
mkdirSync(FIX_ROOT, { recursive: true });
const fix = (name) => join(FIX_ROOT, name);
for (const name of ["better-ui", "ethernal", "marketing", "marketing-two", "create-target", "resp", "truth", "cto-fixture"]) {
  mkdirSync(fix(name), { recursive: true });
}
// Fixtures — what the real server produces (tmux.mjs parseSessions shape,
// oc.listSessions items, oc.listModels items), plus a spy recorder for the
// write deps so every mutation is observed, never assumed.
// ---------------------------------------------------------------------------

function fixtureProjects() {
  return [
    {
      tmuxSession: "manta",
      defaultCwd: fix("better-ui"),
      attached: false,
      mantaOwned: true,
      windows: [
        { index: 0, name: "shell", active: true, paneCurrentPath: fix("better-ui"), opencodeSessionId: null, worktreePath: null, owner: "user" },
        { index: 1, name: "chat", active: false, paneCurrentPath: fix("better-ui"), opencodeSessionId: "ses_a", worktreePath: null, owner: "user" },
      ],
    },
    {
      tmuxSession: "ethernal",
      defaultCwd: fix("ethernal"),
      attached: true,
      mantaOwned: true,
      windows: [
        { index: 2, name: "worker", active: false, paneCurrentPath: fix("ethernal"), opencodeSessionId: "ses_job", worktreePath: fix("ethernal"), owner: "job" },
      ],
    },
    { tmuxSession: "marketing", defaultCwd: fix("marketing"), attached: false, mantaOwned: false, windows: [] },
    { tmuxSession: "Marketing", defaultCwd: fix("marketing-two"), attached: true, mantaOwned: false, windows: [] },
  ];
}

function fixtureSessions() {
  return [
    {
      id: "ses_a",
      title: "Fix the export crash",
      directory: fix("better-ui"),
      time: { created: 1000, updated: 2000 },
      tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
      cost: 0.25,
      info: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    },
    {
      id: "ses_bare",
      title: "cto-created bare session",
      directory: fix("ethernal"),
      time: { created: 3000, updated: 3000 },
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      info: { providerID: "anthropic", modelID: "claude-opus-4" },
    },
  ];
}

function fixtureModels() {
  return [
    { providerID: "anthropic", id: "claude-sonnet-4" },
    { providerID: "anthropic", id: "claude-opus-4" },
  ];
}

// Records every write-dep call (name + args) so tests assert the SIDE EFFECT,
// not just the return value. `throwing: true` wires every write impl to throw
// (the spec's read/write-separation probe: reads must never reach them);
// `overrides` replaces individual impls (used for failure injection).
function makeSpies({ throwing = false, overrides = {} } = {}) {
  const calls = [];
  // Mutable §4.1 config-store double, shared with the projectIdentityPersist
  // spy: a stateful server-realistic identity record store (records live on
  // ~/.manta/config.json projects[] in production).
  const configState = { projects: [] };
  const spy = (name, impl) => async (input) => {
    calls.push({ name, input });
    const effective = overrides[name] ?? impl;
    if (effective && !throwing) return effective(input);
    throw new Error(`write dep ${name} must not be called`);
  };
  const list = {
    tmuxNewSession: spy("tmuxNewSession", ({ name, cwd }) => ({
      sessionId: null,
      windowIndex: 0,
      projects: [{ tmuxSession: name, defaultCwd: cwd, attached: false, mantaOwned: true, windows: [] }],
    })),
    tmuxNewWindow: spy("tmuxNewWindow", ({ existingSessionId }) => ({
      sessionId: existingSessionId ?? "ses_new",
      windowIndex: 9,
      projects: [],
    })),
    tmuxKillSession: spy("tmuxKillSession", () => []),
    tmuxKillWindow: spy("tmuxKillWindow", () => []),
    tmuxRenameSession: spy("tmuxRenameSession", ({ newName }) => [
      { tmuxSession: newName, defaultCwd: fix("better-ui"), attached: false, mantaOwned: true, windows: [] },
    ]),
    tmuxRenameWindow: spy("tmuxRenameWindow", () => []),
    ocCreateSession: spy("ocCreateSession", ({ directory }) => ({
      id: `ses_${calls.filter((c) => c.name === "ocCreateSession").length + 1}`,
      directory,
      title: "",
    })),
    ocForkSession: spy("ocForkSession", ({ sessionId }) => ({ id: `ses_fork_${sessionId}`, directory: fix("better-ui") })),
    ocCompactSession: spy("ocCompactSession", () => true),
    ocDeleteSessionRaw: spy("ocDeleteSessionRaw", () => undefined),
    // §4.1 identity persist — a WRITE dep (reads must never call it: the G7
    // throwing mode covers it). In recording mode it mutates the shared
    // configState so identity records behave like the real config store.
    projectIdentityPersist: spy("projectIdentityPersist", ({ upserts = [], removes = [] }) => {
      let projects = (configState.projects ?? []).filter((p) => !removes.includes(p?.tmuxSession));
      for (const u of upserts) {
        projects = projects.filter((p) => p?.tmuxSession !== u.tmuxSession);
        projects.push({ ...u });
      }
      configState.projects = projects;
      return { projects };
    }),
  };
  return { calls, list, configState };
}

// A per-test control store under the sandbox (same shape ctoStores' JSON
// stores expose: name/path/load/save; locking goes through lockForStore).
// The fixture body is shared (ctoTestStores.mjs) — the duplication gate
// scans every changed file pairwise.
function controlStoreFixture() {
  return makeJsonStoreFixture("manta-control-test", "control");
}

// The standard composition: real read data from fixtures, all writes spied.
function makeControl({ projects = fixtureProjects(), sessions = fixtureSessions(), models = fixtureModels(), jobs = [], gitStatus = "", store, spies, listModels, getWindowOption, configRecords } = {}) {
  const s = spies ?? makeSpies();
  if (configRecords) s.configState.projects = configRecords.map((r) => ({ ...r }));
  const control = createCtoMantaControl({
    store: store ?? controlStoreFixture(),
    now: (() => { let t = 1_700_000_000_000; return () => (t += 1000); })(),
    listProjects: async () => projects,
    listSessions: async () => sessions,
    listModels: listModels ?? (async () => models),
    configGet: async () => ({ projects: s.configState.projects.map((r) => ({ ...r })) }),
    gitStatus: async () => gitStatus,
    // §4.1 identity observer — deterministic stub; tests never touch a real
    // opencode DB (the factory default would try MANTA_OPENCODE_DB and warn).
    observeOpencodeProjectId: async () => null,
    listDelegateJobs: async () => jobs,
    resolveProjectCwd: sharedResolveProjectCwd,
    resolveCwd: resolveCwdOrThrow,
    getWindowOption: getWindowOption ?? (async () => null),
    ...s.list,
  });
  return { control, calls: s.calls, configState: s.configState };
}

async function seedReceipt(store, { key, op, input, status, leaseExpiresAt, result, error }) {
  const now = Date.now();
  await lockForStore(store).runExclusive(async () => {
    const data = await store.load();
    data.receipts = data.receipts ?? {};
    data.receipts[key] = {
      key,
      op,
      argsHash: canonicalArgsHash(op, { key, ...input }),
      args: { key, ...input },
      status,
      operationId: `op_seed_${key}`,
      resourceId: null,
      result: result ?? null,
      error: error ?? null,
      // leaseExpiresAt is ABSOLUTE (not relative to Date.now()) because the
      // service under test runs on an injected fake clock — an expired seed
      // must be past BOTH the fake now and the real one, a live seed past
      // neither.
      lease: { owner: "seed", expiresAt: leaseExpiresAt ?? 0 },
      takeoverCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await store.save(data);
  });
}

after(async () => {
  await rm(ctoPath("manta-control-test"), { recursive: true, force: true });
  await rm(FIX_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// G1 — fail-closed identity resolution
// ---------------------------------------------------------------------------

test("resolveProjectIdentity: exact name resolves; unknown fails closed naming nothing", () => {
  const projects = fixtureProjects();
  const hit = resolveProjectIdentity(projects, "manta");
  assert.equal(hit.project.tmuxSession, "manta");
  // Counterfactual pair: a name that matches nothing must NOT fall back to
  // any existing project (the first-project failure mode).
  assert.throws(() => resolveProjectIdentity(projects, "manta-dev"), (error) => {
    assert.equal(error.code, "target_not_found");
    for (const p of projects) {
      assert.ok(!error.message.includes(`"${p.tmuxSession}"`), "error must not suggest a fallback target");
    }
    return true;
  });
});

test("resolveProjectIdentity: renamed (unique case-insensitive) → target_changed with the current name", () => {
  const projects = [{ tmuxSession: "better-ui", defaultCwd: "/x", windows: [] }];
  assert.throws(() => resolveProjectIdentity(projects, "Better-UI"), (error) => {
    assert.equal(error.code, "target_changed");
    assert.ok(error.message.includes("better-ui"), "names the current name");
    return true;
  });
});

test("resolveProjectIdentity: two case-variants → target_ambiguous (never a guess)", () => {
  const projects = fixtureProjects(); // marketing + Marketing
  assert.throws(() => resolveProjectIdentity(projects, "MARKETING"), (error) => {
    assert.equal(error.code, "target_ambiguous");
    return true;
  });
});

test("mutations never infer a target: sessions_create with no project and no cwd is rejected", async () => {
  const { control } = makeControl();
  await assert.rejects(
    control.sessionsCreate({ key: "k-target-required", attach: false }),
    (error) => error.code === "unsupported" && /project|cwd/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// G2 — idempotency
// ---------------------------------------------------------------------------

test("replay: same key + same args returns the ORIGINAL result without re-executing", async () => {
  const { control, calls } = makeControl();
  const first = await control.projectsCreate({ key: "c1", name: "cto-fixture-proj", cwd: fix("cto-fixture") });
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  const before = calls.filter((c) => c.name === "tmuxNewSession").length;
  const second = await control.projectsCreate({ key: "c1", name: "cto-fixture-proj", cwd: fix("cto-fixture") });
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.operationId, first.operationId, "same operation identity on replay");
  assert.equal(second.summary, first.summary, "original result preserved verbatim");
  assert.equal(calls.filter((c) => c.name === "tmuxNewSession").length, before, "execute ran exactly once");
});

test("counterfactual: a DIFFERENT key on the same op re-executes (replay is key-scoped, not op-scoped)", async () => {
  const { control, calls } = makeControl();
  await control.sessionsCompact({ key: "s1", session: "ses_a" });
  await control.sessionsCompact({ key: "s2", session: "ses_a" });
  const executes = calls.filter((c) => c.name === "ocCompactSession").length;
  assert.equal(executes, 2, "each distinct key is its own operation — the external dep runs once per key");
});

test("same key with different arguments is an error and never executes", async () => {
  const { control, calls } = makeControl();
  await control.projectsCreate({ key: "k-mismatch", name: "proj-one", cwd: fix("marketing") });
  const before = calls.length;
  await assert.rejects(
    control.projectsCreate({ key: "k-mismatch", name: "proj-two", cwd: fix("marketing") }),
    (error) => error.code === "idempotency_key_args_mismatch",
  );
  assert.equal(calls.length, before);
});

test("failed operation replays its original failure without re-executing", async () => {
  const failing = makeSpies({ overrides: { ocCompactSession: async () => { throw new Error("boom"); } } });
  const { control, calls } = makeControl({ spies: failing });
  const first = await control.sessionsCompact({ key: "cmp1", session: "ses_a" }).catch((error) => error);
  assert.equal(first.code, "provider_unavailable");
  const before = calls.filter((c) => c.name === "ocCompactSession").length;
  const second = await control.sessionsCompact({ key: "cmp1", session: "ses_a" });
  assert.equal(second.ok, false);
  assert.equal(second.replayed, true);
  assert.equal(second.code, first.code);
  assert.equal(calls.filter((c) => c.name === "ocCompactSession").length, before);
});

// ---------------------------------------------------------------------------
// G3 — receipt crash windows
// ---------------------------------------------------------------------------

test("expired in_flight receipt → external_outcome_unknown, never re-executed", async () => {
  const store = controlStoreFixture();
  await seedReceipt(store, { key: "crash1", op: "projects.remove", input: { project: "manta" }, status: "in_flight", leaseExpiresAt: 0 });
  const { control, calls } = makeControl({ store });
  await assert.rejects(
    control.projectsRemove({ key: "crash1", project: "manta" }),
    (error) => {
      assert.equal(error.code, "external_outcome_unknown");
      assert.equal(error.retrySafe, false, "unknown outcome must not invite a blind retry");
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 0);
});

test("counterfactual: expired PENDING receipt safely resumes and executes", async () => {
  const store = controlStoreFixture();
  await seedReceipt(store, { key: "crash2", op: "projects.remove", input: { project: "manta" }, status: "pending", leaseExpiresAt: 0 });
  const { control, calls } = makeControl({ store });
  const result = await control.projectsRemove({ key: "crash2", project: "manta" });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 1, "pending never touched tmux, so resume is safe");
});

test("live-lease duplicate of the same key does not double-execute", async () => {
  const store = controlStoreFixture();
  await seedReceipt(store, { key: "live1", op: "projects.remove", input: { project: "manta" }, status: "in_flight", leaseExpiresAt: 9007199254740991 });
  const { control, calls } = makeControl({ store });
  await assert.rejects(
    control.projectsRemove({ key: "live1", project: "manta" }),
    (error) => error.code === "external_outcome_unknown" && error.retrySafe === true,
  );
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 0);
});

// ---------------------------------------------------------------------------
// G4 — expected-revision CAS
// ---------------------------------------------------------------------------

test("projects_update with a stale expectedRevision → revision_conflict, nothing written", async () => {
  const store = controlStoreFixture();
  const { control, calls } = makeControl({ store });
  await control.projectsArchive({ key: "rev-seed", project: "manta" });
  const fresh = await control.projectsList({});
  const record = fresh.data.projects.find((p) => p.name === "manta");
  assert.ok(record.control, "seed created a control record");
  const stale = record.control.revision - 1;
  await assert.rejects(
    control.projectsUpdate({ key: "rev-1", project: "manta", expectedRevision: stale, unarchive: true }),
    (error) => {
      assert.equal(error.code, "revision_conflict");
      assert.equal(error.retrySafe, false);
      return true;
    },
  );
  const after = await control.projectsList({});
  assert.equal(after.data.projects.find((p) => p.name === "manta").archived, true, "no write happened");
  assert.equal(calls.filter((c) => c.name === "tmuxRenameSession").length, 0);
});

test("counterfactual: matching expectedRevision applies the update and bumps the revision", async () => {
  const store = controlStoreFixture();
  const { control } = makeControl({ store });
  await control.projectsArchive({ key: "rev-seed-2", project: "manta" });
  const { data: before } = await control.projectsList({});
  const revision = before.projects.find((p) => p.name === "manta").control.revision;
  const result = await control.projectsUpdate({ key: "rev-2", project: "manta", expectedRevision: revision, unarchive: true });
  assert.equal(result.ok, true);
  assert.equal(result.revision, revision + 1);
  const { data: after } = await control.projectsList({});
  assert.equal(after.projects.find((p) => p.name === "manta").archived, false);
});

test("sessions_configure first-touch with expectedRevision → revision_conflict (no record to CAS against)", async () => {
  const { control } = makeControl();
  await assert.rejects(
    control.sessionsConfigure({ key: "cfg-cas", session: "ses_a", expectedRevision: 3, model: "opus" }),
    (error) => error.code === "revision_conflict",
  );
});

// ---------------------------------------------------------------------------
// G5 — archive ≠ remove
// ---------------------------------------------------------------------------

test("projects_archive never calls a destroyer; projects_remove does", async () => {
  const { control, calls } = makeControl();
  await control.projectsArchive({ key: "arch1", project: "manta" });
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 0, "archive destroyed nothing");
  const { data } = await control.projectsList({});
  const row = data.projects.find((p) => p.name === "manta");
  assert.equal(row.archived, true, "archive state is visible in list");
  await control.projectsRemove({ key: "rm1", project: "marketing" });
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 1, "remove drove the destroyer");
});

test("sessions_archive never deletes the opencode session; sessions_remove does", async () => {
  const { control, calls } = makeControl();
  await control.sessionsArchive({ key: "sarch1", session: "ses_a" });
  assert.equal(calls.filter((c) => c.name === "ocDeleteSessionRaw").length, 0, "archive is not a delete");
  const { data } = await control.sessionsList({});
  assert.equal(data.sessions.find((s) => s.sessionID === "ses_a").archived, true);
  await control.sessionsRemove({ key: "srm1", session: "ses_bare" });
  assert.equal(calls.filter((c) => c.name === "ocDeleteSessionRaw").length, 1);
});

// ---------------------------------------------------------------------------
// G6 — removal protections
// ---------------------------------------------------------------------------

test("project with a delegate-owned window → borrowed_resource, kill not called", async () => {
  const { control, calls } = makeControl();
  await assert.rejects(
    control.projectsRemove({ key: "prot1", project: "ethernal" }),
    (error) => {
      assert.equal(error.code, "borrowed_resource");
      assert.equal(error.retrySafe, false);
      assert.ok(error.message.includes("job"), "names the owning actor");
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 0);
});

test("dirty checkout → dirty_resource, kill not called", async () => {
  const { control, calls } = makeControl({ gitStatus: " M src/foo.ts\n?? new.txt" });
  await assert.rejects(
    control.projectsRemove({ key: "prot2", project: "marketing" }),
    (error) => {
      assert.equal(error.code, "dirty_resource");
      assert.equal(error.retrySafe, false);
      return true;
    },
  );
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 0);
});

test("attached project → active_resource (retry safe once detached)", async () => {
  const { control, calls } = makeControl();
  await assert.rejects(
    control.projectsRemove({ key: "prot3", project: "Marketing" }),
    (error) => error.code === "active_resource" && error.retrySafe === true,
  );
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 0);
});

test("counterfactual: clean, unattached, un-borrowed project removes successfully", async () => {
  const { control, calls } = makeControl();
  const result = await control.projectsRemove({ key: "prot-ok", project: "marketing" });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((c) => c.name === "tmuxKillSession").length, 1);
});

test("session owned by a running delegate job → active_resource; terminal job record → borrowed_resource", async () => {
  const running = [{ childSessionID: "ses_a", status: "running", id: "job1" }];
  const { control: c1, calls: calls1 } = makeControl({ jobs: running });
  await assert.rejects(
    c1.sessionsRemove({ key: "prot4", session: "ses_a" }),
    (error) => {
      assert.equal(error.code, "active_resource");
      assert.equal(error.retrySafe, true);
      return true;
    },
  );
  assert.equal(calls1.filter((c) => c.name === "ocDeleteSessionRaw").length, 0);

  const terminal = [{ childSessionID: "ses_a", status: "done", id: "job0" }];
  const { control: c2, calls: calls2 } = makeControl({ jobs: terminal });
  await assert.rejects(
    c2.sessionsRemove({ key: "prot5", session: "ses_a" }),
    (error) => {
      assert.equal(error.code, "borrowed_resource");
      assert.equal(error.retrySafe, false);
      return true;
    },
  );
  assert.equal(calls2.filter((c) => c.name === "ocDeleteSessionRaw").length, 0);
});

test("counterfactual: session with no delegate record removes cleanly", async () => {
  const { control, calls } = makeControl();
  const result = await control.sessionsRemove({ key: "prot6", session: "ses_bare" });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((c) => c.name === "ocDeleteSessionRaw").length, 1);
});

// ---------------------------------------------------------------------------
// G7 — read/write separation at the production composition boundary
// ---------------------------------------------------------------------------

test("reads succeed with every write dep throwing, and no write spy is ever called", async () => {
  const throwing = makeSpies({ throwing: true });
  const { control } = makeControl({ spies: throwing });
  const reads = [
    control.projectsList({}),
    control.projectsInspect({ project: "manta" }),
    control.sessionsList({}),
    control.sessionsInspect({ session: "ses_a" }),
    control.sessionsUsage({ session: "ses_a" }),
  ];
  const results = await Promise.all(reads);
  for (const r of results) {
    assert.equal(r.ok, true, `read must succeed: ${JSON.stringify(r).slice(0, 200)}`);
  }
  assert.deepEqual(throwing.calls, [], "zero write-dep calls for the five reads");
});

test("counterfactual: the same boundary DOES drive writes for the paired mutation", async () => {
  const spies = makeSpies({ overrides: { ocCompactSession: async () => true } });
  const { control, calls } = makeControl({ spies });
  const result = await control.sessionsCompact({ key: "sep1", session: "ses_a" });
  assert.equal(result.ok, true);
  assert.equal(calls.filter((c) => c.name === "ocCompactSession").length, 1);
});

// ---------------------------------------------------------------------------
// G8 — server-owned model/effort selection
// ---------------------------------------------------------------------------

test("sessions_create persists a validated model override; configure changes it with a revision bump", async () => {
  const { control } = makeControl();
  const created = await control.sessionsCreate({
    key: "model1",
    project: "manta",
    name: "worker",
    attach: false,
    model: "sonnet",
    effort: "high",
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.model, { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" });
  const { data } = await control.sessionsList({});
  assert.deepEqual(data.sessions.find((s) => s.sessionID === created.resourceId.replace("session:", "")).model, {
    providerID: "anthropic",
    modelID: "claude-sonnet-4",
    variant: "high",
  });
  const configured = await control.sessionsConfigure({ key: "model2", session: created.resourceId.replace("session:", ""), model: "opus" });
  assert.equal(configured.ok, true);
  assert.deepEqual(configured.model, { providerID: "anthropic", modelID: "claude-opus-4" });
});

test("unmatchable model → unsupported; missing catalog → still unsupported; broken catalog → provider_unavailable (retry safe)", async () => {
  const { control } = makeControl();
  await assert.rejects(
    control.sessionsCreate({ key: "model3", project: "manta", attach: false, model: "gpt-99" }),
    (error) => {
      assert.equal(error.code, "unsupported");
      assert.ok(/No model matched/.test(error.message));
      return true;
    },
  );
  const noCatalog = makeControl({ models: [] });
  await assert.rejects(
    noCatalog.control.sessionsCreate({ key: "model4", project: "manta", attach: false, model: "sonnet" }),
    (error) => error.code === "unsupported",
  );
  const brokenCatalog = makeControl({ models: [], listModels: async () => { throw new Error("opencode down"); } });
  await assert.rejects(
    brokenCatalog.control.sessionsCreate({ key: "model5", project: "manta", attach: false, model: "sonnet" }),
    (error) => error.code === "provider_unavailable" && error.retrySafe === true,
  );
});

test("sessions_create attaches through the target project's resolved cwd (never the caller's cwd)", async () => {
  const spies = makeSpies();
  const projects = fixtureProjects();
  const control = createCtoMantaControl({
    store: controlStoreFixture(),
    listProjects: async () => projects,
    listSessions: async () => [],
    listModels: async () => fixtureModels(),
    configGet: async () => ({ projects: [{ tmuxSession: "manta", defaultCwd: fix("better-ui") }] }),
    observeOpencodeProjectId: async () => null,
    gitStatus: async () => "",
    listDelegateJobs: async () => [],
    resolveProjectCwd: sharedResolveProjectCwd,
    resolveCwd: resolveCwdOrThrow,
    getWindowOption: async () => null,
    ...spies.list,
  });
  const result = await control.sessionsCreate({ key: "attach1", project: "manta", name: "fixer" });
  assert.equal(result.ok, true);
  const win = spies.calls.find((c) => c.name === "tmuxNewWindow");
  assert.ok(win, "attached create drives tmuxNewWindow");
  assert.equal(win.input.cwd, fix("better-ui"), "cwd came from the project, not the caller");
  assert.equal(win.input.chatMode, true);
  // The opencode session is created through the SAME creation path the UI
  // uses: the window creator receives the oc.createSession dep (the real
  // tmux.newWindow calls it before creating the window and stamps the result).
  assert.equal(typeof win.input.oc?.createSession, "function", "oc.createSession delegated to the window creator");
});

// ---------------------------------------------------------------------------
// G9 — successful responses carry operation ID, resource ID, revision, state, summary
// ---------------------------------------------------------------------------

test("every successful mutation response carries operationId, resourceId, revision, state and summary", async () => {
  const { control } = makeControl();
  const checks = [
    control.projectsCreate({ key: "resp1", name: "resp-proj", cwd: fix("resp") }),
    control.projectsArchive({ key: "resp2", project: "marketing" }),
    control.sessionsArchive({ key: "resp3", session: "ses_a" }),
    control.sessionsCompact({ key: "resp4", session: "ses_a" }),
  ];
  for (const result of await Promise.all(checks)) {
    assert.equal(result.ok, true);
    assert.match(result.operationId, /^op_/);
    assert.ok(result.resourceId, "resource ID present");
    assert.ok("revision" in result && (result.revision === null || Number.isInteger(result.revision)), "revision present (or null when the resource carries no control record)");
    assert.ok(result.state, "state present");
    assert.ok(typeof result.summary === "string" && result.summary.length > 0, "visible summary present");
  }
});

// ---------------------------------------------------------------------------
// G10 — success never lies (no-op stub rule)
// ---------------------------------------------------------------------------

test("no mutation returns ok without driving its external dep", async () => {
  const { control, calls } = makeControl();
  await control.projectsCreate({ key: "truth1", name: "truth-proj", cwd: fix("truth") });
  await control.sessionsCreate({ key: "truth2", project: "manta", attach: false });
  await control.sessionsFork({ key: "truth3", session: "ses_a", attach: false });
  await control.sessionsCompact({ key: "truth4", session: "ses_a" });
  await control.sessionsRemove({ key: "truth5", session: "ses_bare" });
  await control.projectsRemove({ key: "truth6", project: "marketing" });
  const driven = new Set(calls.map((c) => c.name));
  for (const dep of ["tmuxNewSession", "ocCreateSession", "ocForkSession", "ocCompactSession", "ocDeleteSessionRaw", "tmuxKillSession"]) {
    assert.ok(driven.has(dep), `${dep} must have been driven by its mutation`);
  }
});

test("sessions_remove kills the window that still stamps the session, skips a restamped one", async () => {
  const projects = [
    {
      tmuxSession: "manta",
      defaultCwd: fix("better-ui"),
      attached: false,
      mantaOwned: true,
      windows: [
        { index: 1, name: "chat", active: false, paneCurrentPath: "/x", opencodeSessionId: "ses_a", worktreePath: null, owner: "user" },
        { index: 2, name: "moved", active: false, paneCurrentPath: "/x", opencodeSessionId: "ses_other", worktreePath: null, owner: "user" },
      ],
    },
  ];
  const { control, calls } = makeControl({
    projects,
    getWindowOption: async (_sessionName, windowIndex) => (windowIndex === 1 ? "ses_a" : windowIndex === 2 ? "ses_other" : null),
  });
  const result = await control.sessionsRemove({ key: "killwin1", session: "ses_a" });
  assert.equal(result.ok, true);
  const kills = calls.filter((c) => c.name === "tmuxKillWindow");
  assert.equal(kills.length, 1);
  assert.equal(kills[0].input.windowIndex, 1);
});

// ---------------------------------------------------------------------------
// Provider mapping + capacity + sandbox canary
// ---------------------------------------------------------------------------

test("opencode 4xx → provider_unavailable (not retry safe); 5xx/network → retry safe", async () => {
  const err4 = new Error("opencode createSession 400: bad request");
  err4.status = 400;
  const c4 = makeControl({ spies: makeSpies({ overrides: { ocCreateSession: async () => { throw err4; } } }) });
  await assert.rejects(
    c4.control.sessionsCreate({ key: "prov1", project: "manta", attach: false }),
    (error) => error.code === "provider_unavailable" && error.retrySafe === false,
  );
  const err5 = new Error("opencode createSession 503");
  err5.status = 503;
  const c5 = makeControl({ spies: makeSpies({ overrides: { ocCreateSession: async () => { throw err5; } } }) });
  await assert.rejects(
    c5.control.sessionsCreate({ key: "prov2", project: "manta", attach: false }),
    (error) => error.code === "provider_unavailable" && error.retrySafe === true,
  );
});

test("receipt ledger at cap refuses a NEW key with capacity_wait while existing keys still replay", async () => {
  const store = controlStoreFixture();
  await seedReceipt(store, { key: "seed-a", op: "projects.archive", input: { project: "manta" }, status: "succeeded", result: { summary: "seeded" } });
  const { control } = makeControl({ store });
  const filler = createCtoMantaControl({
    store,
    listProjects: async () => fixtureProjects(),
    listSessions: async () => [],
    listModels: async () => fixtureModels(),
    configGet: async () => ({}),
    observeOpencodeProjectId: async () => null,
    gitStatus: async () => "",
    listDelegateJobs: async () => [],
    resolveProjectCwd: sharedResolveProjectCwd,
    resolveCwd: resolveCwdOrThrow,
    getWindowOption: async () => null,
    receiptsCap: 1,
  });
  await assert.rejects(
    filler.projectsArchive({ key: "seed-b", project: "manta" }),
    (error) => error.code === "capacity_wait" && error.retrySafe === true,
  );
  const replay = await control.projectsArchive({ key: "seed-a", project: "manta" });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(typeof MANTA_CONTROL_RECEIPTS_CAP, "number");
});

test("sandbox canary: the production control store resolves under MANTA_STATE_HOME", () => {
  assert.ok(mantaControlStore.path.startsWith(stateHome()), `store must be sandboxed, got ${mantaControlStore.path}`);
});

test("tool registration: 15 family tools, reads auto, mutations confirm, params are action-specific", () => {
  const { control } = makeControl();
  const tools = [];
  registerCtoMantaControlTools((def) => tools.push(def), control);
  assert.equal(tools.length, 15);
  const reads = new Set(["projects_list", "projects_inspect", "sessions_list", "sessions_inspect", "sessions_usage"]);
  for (const t of tools) {
    assert.ok(t.name.startsWith("projects_") || t.name.startsWith("sessions_"));
    assert.equal(t.mode, reads.has(t.name) ? "auto" : "confirm");
    assert.ok(t.description.length > 20);
    assert.ok(t.params && typeof t.params === "object");
  }
  // Action-specific schemas: the create schema requires a target, the remove
  // schema does not accept model/effort — no shared args bag.
  const createParams = JSON.stringify(tools.find((t) => t.name === "sessions_create").params);
  const removeParams = JSON.stringify(tools.find((t) => t.name === "sessions_remove").params);
  assert.ok(createParams.includes("model"));
  assert.ok(!removeParams.includes("model"), "remove must not accept model/effort");
});

test("every mutation validates its idempotency key", async () => {
  const { control } = makeControl();
  await assert.rejects(control.projectsArchive({ project: "manta" }), (error) => /idempotency key/.test(error.message));
  await assert.rejects(control.projectsArchive({ key: "", project: "manta" }), (error) => /idempotency key/.test(error.message));
});

test("controlError carries the stable code and retry-safety flag", () => {
  const error = controlError("dirty_resource", "dirty", { retrySafe: false });
  assert.equal(error.code, "dirty_resource");
  assert.equal(error.retrySafe, false);
});

// ---------------------------------------------------------------------------
// Shared cwd resolver extraction — the §7 families and rpc.mjs go through ONE
// resolver (never a reimplementation).
// ---------------------------------------------------------------------------

test("projectCwd: explicit non-tilde cwd wins; stored meta beats live tmux; live tmux beats ~", async () => {
  const io = {
    configGet: async () => ({ projects: [{ tmuxSession: "proj", defaultCwd: "/stored/cwd" }] }),
    listProjects: async () => [{ tmuxSession: "proj", defaultCwd: "/live/cwd" }],
  };
  assert.equal(await sharedResolveProjectCwd("proj", "/explicit/cwd", io), "/explicit/cwd");
  assert.equal(await sharedResolveProjectCwd("proj", "", io), "/stored/cwd");
  assert.equal(await sharedResolveProjectCwd("proj", undefined, io), "/stored/cwd");
  const noMeta = { configGet: async () => ({}), listProjects: async () => [{ tmuxSession: "proj", defaultCwd: "/live/cwd" }] };
  assert.equal(await sharedResolveProjectCwd("proj", "", noMeta), "/live/cwd");
  assert.equal(await sharedResolveProjectCwd("proj", "~", noMeta), "/live/cwd");
  const nothing = { configGet: async () => ({}), listProjects: async () => { throw new Error("tmux down"); } };
  assert.equal(await sharedResolveProjectCwd("proj", "", nothing), "~");
});
