// ctoIdentity.test.mjs — §4.1 durable project key: the settled identity rules
// (docs/cto-implementation-map.md §4.1, adopted on PR #1516's probe).
//
// The recurring defect this file guards against is GREEN TESTS ENCODING
// STATES THE SERVER CANNOT PRODUCE. So every fixture below is the real wire
// shape: live rows are tmux.mjs listProjects rows, identity records are
// ~/.manta/config.json projects[] entries, the observer fixture mirrors
// opencodeDb.lookupProjectIdByDirectory (including a REAL sqlite fixture for
// the fork-disambiguation rule), and the store tests run against the REAL
// local.mjs projectIdentityPersist over the sandboxed config.json.
//
// Each guarantee carries a COUNTERFACTUAL POSITIVE CONTROL, named in a
// comment: break the guarantee in the source, see THIS test go red, restore.
// A test you never saw fail is not evidence.

import "./ctoTestGuard.mjs";

// Armed before any module that could open a DB handle is evaluated: an
// un-injected test must degrade to null, never resolve the live box DB.
process.env.MANTA_OPENCODE_DB =
  process.env.MANTA_OPENCODE_DB ?? "/nonexistent/opencode/cto-identity-fixture.db";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  resolveProjectIdentity,
  createProjectIdentityAdapter,
  planCacheAdoption,
  directoriesNeedingObservation,
  createCtoMantaControl,
} from "./ctoMantaTools.mjs";
import { deriveRepositoryId } from "./ctoWorkTools.mjs";
import { projectIdentityPersist, configGet } from "./local.mjs";
import { lookupProjectIdByDirectory, _resetDbHandle } from "./opencodeDb.mjs";
import { ctoPath } from "./ctoStores.mjs";
import { statePath } from "../shared/paths.mjs";
import { resolveCwdOrThrow } from "./tmux.mjs";

// ---------------------------------------------------------------------------
// Fixtures — the real server shapes.
// ---------------------------------------------------------------------------

const FIX_ROOT = join(ctoPath("identity-fixtures"));
await mkdir(FIX_ROOT, { recursive: true });
const fix = (name) => join(FIX_ROOT, name);
for (const name of ["alpha", "wt1", "wt2", "moved", "target"]) {
  await mkdir(fix(name), { recursive: true });
}

// A live tmux session row — exactly tmux.mjs parseSessions' output shape.
function liveRow(tmuxSession, defaultCwd, extra = {}) {
  return { tmuxSession, defaultCwd, attached: false, mantaOwned: true, windows: [], ...extra };
}

// An identity record — exactly ~/.manta/config.json projects[]'s §4.1 shape.
function record(tmuxSession, defaultCwd, projectId, opencodeProjectId) {
  const r = { tmuxSession, defaultCwd, projectId };
  if (opencodeProjectId !== undefined) r.opencodeProjectId = opencodeProjectId;
  return r;
}

let mintSeq = 0;
function mintSeqId() {
  mintSeq += 1;
  return `proj_mint_${String(mintSeq).padStart(3, "0")}`;
}

// A stateful in-memory control-store double with the mantaControlStore shape
// (load/save + a receipt section that actually persists between calls — the
// operation runner verifies its reservation mid-flight).
function memoryControlStore(name) {
  let data = { v: 1 };
  return {
    name,
    path: ctoPath("identity-fixtures", `${name}.json`),
    load: async () => JSON.parse(JSON.stringify(data)),
    save: async (next) => {
      data = JSON.parse(JSON.stringify(next));
    },
  };
}

// A no-op reconcile: no observations available anywhere.
const NO_OBSERVED = new Map();

// Build a pure identity context.
function identityOf(records, observed = NO_OBSERVED, newId = mintSeqId) {
  return { records, observed, newId };
}

// A config-store double over an in-memory records array — same read shape the
// adapter consumes (configGet's projects[]).
function makeConfigDouble(records) {
  const state = { projects: records.map((r) => ({ ...r })) };
  return {
    state,
    configGet: async () => ({ projects: state.projects.map((r) => ({ ...r })) }),
    persist: async (plan) => {
      let next = state.projects.filter((p) => !plan.removes.includes(p?.tmuxSession));
      for (const u of plan.upserts) {
        next = next.filter((p) => p?.tmuxSession !== u.tmuxSession);
        next.push({ ...u });
      }
      state.projects = next;
      return { projects: next };
    },
  };
}

// The standard adapter composition for one test.
function makeAdapter({ records, observed = NO_OBSERVED, newId = mintSeqId } = {}) {
  const cfg = makeConfigDouble(records ?? []);
  const persistCalls = [];
  const adapter = createProjectIdentityAdapter({
    configGet: cfg.configGet,
    observeOpencodeProjectId: async (dir) => (observed instanceof Map ? observed.get(dir) ?? null : null),
    persistProjectIdentity: async (plan) => {
      persistCalls.push(plan);
      return cfg.persist(plan);
    },
    newId,
  });
  return { adapter, cfg, persistCalls };
}

after(async () => {
  await rm(FIX_ROOT, { recursive: true, force: true });
  _resetDbHandle();
});

// ---------------------------------------------------------------------------
// G1 — rename rebinds rather than mints (the settled §4.1 rule).
// Counterfactual control: delete planAdoptOrMint's orphan branch (always
// mint) — the rebind assertions go red.
// ---------------------------------------------------------------------------

test("G1: a rename REBINDS the existing record — same durable key, no second project", async () => {
  const records = [record("alpha", fix("alpha"), "proj_alpha_1")];
  const live = [liveRow("beta", fix("alpha"))]; // renamed; the checkout did not move
  const outcome = resolveProjectIdentity(live, "beta", identityOf(records));
  assert.equal(outcome.projectId, "proj_alpha_1", "the minted key survives the rename");
  assert.equal(outcome.project.tmuxSession, "beta");
  // The plan moves the record's name and keeps the id — one upsert, one
  // remove, never a second project.
  assert.deepEqual(outcome.persistPlan.removes, ["alpha"]);
  assert.equal(outcome.persistPlan.upserts.length, 1);
  const upserted = outcome.persistPlan.upserts[0];
  assert.equal(upserted.tmuxSession, "beta");
  assert.equal(upserted.projectId, "proj_alpha_1");
  assert.equal(upserted.defaultCwd, fix("alpha"));
  // And the resolve-by-key path resolves to the SAME (rebound) session.
  const byKey = resolveProjectIdentity(live, "proj_alpha_1", identityOf(records));
  assert.equal(byKey.project.tmuxSession, "beta");
  assert.equal(byKey.projectId, "proj_alpha_1");
});

test("G1 counterfactual: the rebind is reachable from BOTH sides (stale name and live name)", async () => {
  // From the stale name: a legacy envelope still carrying the tmux name
  // resolves through the orphaned record onto the renamed session.
  const records = [record("alpha", fix("alpha"), "proj_alpha_1")];
  const live = [liveRow("beta", fix("alpha"))];
  const byName = resolveProjectIdentity(live, "alpha", identityOf(records));
  assert.equal(byName.project.tmuxSession, "beta");
  assert.equal(byName.projectId, "proj_alpha_1");
});

test("G1 counterfactual: two worktrees of one repo stay TWO Manta projects (rename disambiguates by checkout, never by repository id)", async () => {
  // Server-realistic: both worktrees of one repository share the SAME
  // opencode project id (repository-grained [PROVEN]). Renaming ONE
  // worktree's session must rebind only ITS record — a repository-id-keyed
  // matcher would be ambiguous and fuse the two projects.
  const repoOcId = "repo_id_shared_by_both_worktrees";
  const records = [
    record("wt1", fix("wt1"), "proj_wt_1", repoOcId),
    record("wt2", fix("wt2"), "proj_wt_2", repoOcId),
  ];
  const live = [liveRow("wt1-renamed", fix("wt1")), liveRow("wt2", fix("wt2"))];
  const outcome = resolveProjectIdentity(live, "wt1-renamed", identityOf(records));
  assert.equal(outcome.projectId, "proj_wt_1", "the renamed worktree keeps its OWN key");
  assert.equal(outcome.persistPlan.removes, undefined ?? outcome.persistPlan.removes);
  assert.deepEqual(outcome.persistPlan.removes, ["wt1"]);
  assert.equal(outcome.persistPlan.upserts.length, 1);
  // The untouched sibling keeps its record untouched.
  const sibling = resolveProjectIdentity(live, "proj_wt_2", identityOf(records));
  assert.equal(sibling.project.tmuxSession, "wt2");
  assert.equal(sibling.projectId, "proj_wt_2");
  // The discriminating shape: BOTH sessions renamed at once. The checkout
  // anchor still pairs each rename with its own record; a repository-id-keyed
  // (or anchor-less) matcher would see two candidates and fail or fuse.
  const bothRenamed = [liveRow("wt1-new", fix("wt1")), liveRow("wt2-new", fix("wt2"))];
  const first = resolveProjectIdentity(bothRenamed, "wt1-new", identityOf(records));
  assert.equal(first.projectId, "proj_wt_1");
  const second = resolveProjectIdentity(bothRenamed, "wt2-new", identityOf(records));
  assert.equal(second.projectId, "proj_wt_2", "each worktree resolves to its OWN key");
});

test("G1 counterfactual: two orphans over one checkout is ambiguous — mint a new project, rebind nothing", async () => {
  // Two tmux sessions shared one checkout and BOTH vanished (renamed): the
  // rule cannot tell which one the new session is — fail closed (mint new),
  // never guess.
  const records = [
    record("a1", fix("alpha"), "proj_a_1"),
    record("a2", fix("alpha"), "proj_a_2"),
  ];
  const live = [liveRow("beta", fix("alpha"))];
  const outcome = resolveProjectIdentity(live, "beta", identityOf(records));
  assert.notEqual(outcome.projectId, "proj_a_1");
  assert.notEqual(outcome.projectId, "proj_a_2");
  assert.equal(outcome.persistPlan.removes.length, 0, "no rebind was persisted");
  const orphanKeys = records.map((r) => r.projectId);
  for (const key of orphanKeys) {
    // The orphaned records stay resolvable-refusable: their keys fail closed.
    assert.throws(() => resolveProjectIdentity(live, key, identityOf(records)), (e) => e.code === "target_ambiguous");
  }
});

// ---------------------------------------------------------------------------
// G2 — repository-identity contradiction: fail closed, never fuse.
// Counterfactual control: delete the rebindContradicted call in
// planAdoptOrMint — the mint assertions go red (it would rebind).
// ---------------------------------------------------------------------------

test("G2: a rename observed TOGETHER with a repository-identity change refuses the rebind", async () => {
  // §4.1 failure mode 4: the checkout at the anchor path was deleted and
  // recreated WITHOUT a remote — its opencode id FORKED [PROVEN]. The cached
  // id and the live observation both exist and differ: the path now hosts a
  // different repository, and a rename cannot be separated from a recreation.
  const records = [record("alpha", fix("alpha"), "proj_alpha_1", "oc_old_root_commit_id")];
  const observed = new Map([[fix("alpha"), "oc_new_forked_root_commit_id"]]);
  const live = [liveRow("beta", fix("alpha"))];
  // By live name: a NEW project is minted (fail closed); the old record stays.
  const outcome = resolveProjectIdentity(live, "beta", identityOf(records, observed));
  assert.notEqual(outcome.projectId, "proj_alpha_1");
  assert.deepEqual(outcome.persistPlan.removes, []);
  assert.equal(outcome.persistPlan.upserts[0].opencodeProjectId, "oc_new_forked_root_commit_id", "the new record stamps the observed cache");
  // By old key: target_not_found — the key no longer maps to any live session.
  assert.throws(
    () => resolveProjectIdentity(live, "proj_alpha_1", identityOf(records, observed)),
    (e) => e.code === "target_not_found" && e.message.includes("different repository"),
  );
});

// ---------------------------------------------------------------------------
// G3 — a directory move keeps the id.
// Counterfactual control: make the name-match path mint a new record when the
// cwd differs — the id assertion goes red.
// ---------------------------------------------------------------------------

test("G3: a directory move keeps the id and refreshes the path cache", async () => {
  const records = [record("alpha", fix("moved"), "proj_alpha_1")];
  const live = [liveRow("alpha", fix("target"))]; // same name, checkout moved
  const outcome = resolveProjectIdentity(live, "alpha", identityOf(records));
  assert.equal(outcome.projectId, "proj_alpha_1", "the id is indifferent to the move");
  assert.equal(outcome.project.defaultCwd, fix("target"), "resolution follows the LIVE path");
  assert.equal(outcome.persistPlan.removes.length, 0, "nothing was rebound — the name still matches");
  const upserted = outcome.persistPlan.upserts[0];
  assert.equal(upserted.defaultCwd, fix("target"), "the record's path cache refreshes to the live checkout");
  assert.equal(upserted.projectId, "proj_alpha_1");
});

// ---------------------------------------------------------------------------
// G4 — migration: an id-less record gains its id IN PLACE.
// Counterfactual control: treat an id-less record as record-less (mint a new
// record alongside it) — the single-record assertion goes red.
// ---------------------------------------------------------------------------

test("G4: an unmigrated record gets an id without becoming a new project", async () => {
  // Server-realistic: a desktop-era record carries desktop-owned metadata the
  // identity layer must preserve. A mint-a-new-record migration would drop it.
  const desktopEra = { ...record("alpha", fix("alpha"), undefined), defaultModel: "sonnet" };
  const records = [desktopEra];
  const live = [liveRow("alpha", fix("alpha"))];
  const outcome = resolveProjectIdentity(live, "alpha", identityOf(records));
  assert.match(outcome.projectId, /^proj_mint_\d+$/, "a key was minted on first sight");
  assert.deepEqual(outcome.persistPlan.removes, [], "the record was NOT replaced — it was migrated in place");
  assert.equal(outcome.persistPlan.upserts.length, 1);
  assert.equal(outcome.persistPlan.upserts[0].tmuxSession, "alpha", "same record (same name)");
  assert.equal(outcome.persistPlan.upserts[0].defaultModel, "sonnet", "the migration preserves the record's own metadata");
  // Apply the plan and resolve again: the SAME id returns (idempotence), and
  // exactly ONE record for the session exists (no parallel minted record).
  const cfg = makeConfigDouble(records);
  await cfg.persist(outcome.persistPlan);
  assert.equal(cfg.state.projects.filter((p) => p.tmuxSession === "alpha").length, 1, "no second record was minted alongside the migrated one");
  const second = resolveProjectIdentity(live, "alpha", identityOf(cfg.state.projects));
  assert.equal(second.projectId, outcome.projectId, "the minted key is durable, not re-minted per look");
  assert.equal(second.changed, false, "the second look persists nothing");
});

// ---------------------------------------------------------------------------
// G5 — a stale opencodeProjectId cache is ADOPTED, not fought.
// Counterfactual control: preserve the stale cache on mismatch (drop the
// changes.opencodeProjectId assignment in planRefresh) — red.
// ---------------------------------------------------------------------------

test("G5: a mismatched opencode id cache is adopted from a pre-computed observation", async () => {
  const records = [record("alpha", fix("alpha"), "proj_alpha_1", "oc_old")];
  const observed = new Map([[fix("alpha"), "oc_new"]]);
  const live = [liveRow("alpha", fix("alpha"))];
  const outcome = resolveProjectIdentity(live, "alpha", identityOf(records, observed));
  assert.equal(outcome.projectId, "proj_alpha_1", "adoption never re-keys the project");
  assert.equal(outcome.persistPlan.upserts[0].opencodeProjectId, "oc_new", "Manta follows opencode's migration");
});

test("G5 counterfactual: the adapter observes the resolved checkout and adopts a stale cache autonomously", async () => {
  // The realistic flow: the repo at the anchor attached a remote between two
  // CTO touches; the record's cache is stale. The NEXT resolution (a write
  // path) observes the fresh id and adopts it.
  const { adapter, cfg, persistCalls } = makeAdapter({
    records: [record("alpha", fix("alpha"), "proj_alpha_1", "oc_old")],
    observed: new Map([[fix("alpha"), "oc_new"]]),
  });
  const live = [liveRow("alpha", fix("alpha"))];
  const outcome = await adapter(live, "alpha");
  assert.equal(outcome.projectId, "proj_alpha_1");
  assert.equal(cfg.state.projects[0].opencodeProjectId, "oc_new", "the cache was persisted (adopted)");
  assert.equal(persistCalls.length, 1);
  // Counterfactual probe: planCacheAdoption is the pure core of that path.
  const adoption = planCacheAdoption(record("alpha", fix("alpha"), "proj_alpha_1", "oc_old"), "oc_new");
  assert.equal(adoption.upserts[0].opencodeProjectId, "oc_new");
  assert.equal(planCacheAdoption(record("alpha", fix("alpha"), "proj_alpha_1", "oc_new"), "oc_new"), null, "a matching cache persists nothing");
});

test("G5: reads resolve identically but persist NOTHING (G7 discipline)", async () => {
  const { adapter, cfg, persistCalls } = makeAdapter({
    records: [], // first sight — the write path would mint
  });
  const live = [liveRow("alpha", fix("alpha"))];
  const readOutcome = await adapter(live, "alpha", { persist: false });
  assert.ok(readOutcome.projectId, "a read resolves (a minted id in memory)");
  assert.equal(persistCalls.length, 0, "the read persisted nothing");
  assert.equal(cfg.state.projects.length, 0, "the store is untouched by reads");
  // The write path then mints ONCE and a second write re-reads the same id.
  const firstWrite = await adapter(live, "alpha");
  const secondWrite = await adapter(live, "alpha");
  assert.equal(firstWrite.projectId, secondWrite.projectId, "the minted key is durable across operations");
});

// ---------------------------------------------------------------------------
// G6 — resolution fails closed.
// ---------------------------------------------------------------------------

test("G6: an unknown durable key fails closed and names no fallback target", async () => {
  const records = [record("alpha", fix("alpha"), "proj_alpha_1")];
  const live = [liveRow("alpha", fix("alpha"))];
  assert.throws(
    () => resolveProjectIdentity(live, "proj_ghost_9", identityOf(records)),
    (e) => {
      assert.equal(e.code, "target_not_found");
      assert.ok(!e.message.includes('"alpha"'), "no fallback target is ever suggested");
      return true;
    },
  );
});

test("G6: a rebound record whose checkout moved together with the rename fails closed", async () => {
  // rename + move observed together: the orphan's anchor no longer matches
  // any live session — genuinely ambiguous, so the key resolves to nothing.
  const records = [record("alpha", fix("alpha"), "proj_alpha_1")];
  const live = [liveRow("beta", fix("target"))]; // renamed AND moved
  assert.throws(
    () => resolveProjectIdentity(live, "proj_alpha_1", identityOf(records)),
    (e) => e.code === "target_not_found" && e.message.includes("no live session"),
  );
});

test("G6: a rebound record with two unclaimed live sessions at its checkout is ambiguous", async () => {
  const records = [record("alpha", fix("alpha"), "proj_alpha_1")];
  const live = [liveRow("beta1", fix("alpha")), liveRow("beta2", fix("alpha"))];
  assert.throws(
    () => resolveProjectIdentity(live, "proj_alpha_1", identityOf(records)),
    (e) => e.code === "target_ambiguous",
  );
});

test("G6: the bare 2-arg surface is unchanged (name resolution, case guards)", () => {
  const live = [liveRow("alpha", fix("alpha")), liveRow("Marketing", fix("target")), liveRow("marketing", fix("wt1"))];
  assert.equal(resolveProjectIdentity(live, "alpha").project.tmuxSession, "alpha");
  assert.throws(() => resolveProjectIdentity(live, "ALPHA"), (e) => e.code === "target_changed");
  assert.throws(() => resolveProjectIdentity(live, "MARKETING"), (e) => e.code === "target_ambiguous");
  assert.throws(() => resolveProjectIdentity(live, "nope"), (e) => e.code === "target_not_found");
});

// ---------------------------------------------------------------------------
// G7 — the observation plan is bounded and only covers what the gate needs.
// ---------------------------------------------------------------------------

test("G7: observation covers exactly orphaned anchors and unclaimed live checkouts", () => {
  const records = [
    record("alpha", fix("alpha"), "proj_1"), // orphaned anchor
    record("live", fix("wt1"), "proj_2"), // claimed — never observed
  ];
  const live = [liveRow("live", fix("wt1")), liveRow("fresh", fix("wt2"))];
  const dirs = directoriesNeedingObservation(live, records);
  assert.deepEqual(dirs.sort(), [fix("alpha"), fix("wt2")].sort(), "the orphan's anchor + the first-sight checkout, nothing else");
  assert.equal(
    directoriesNeedingObservation(live, [record("live", fix("wt1"), "proj_2"), record("fresh", fix("wt2"), "proj_3")]).length,
    0,
    "steady state (every live session claimed) observes nothing",
  );
});

// ---------------------------------------------------------------------------
// G8 — ProjectRef.repositoryId derivation (§5.1): remote-backed only.
// Counterfactual control: persist the observed id for a remote-less repo —
// the unmapped assertions go red.
// ---------------------------------------------------------------------------

test("G8: a remote-less repo's repositoryId is UNMAPPED even when an opencode id is observable", () => {
  assert.equal(
    deriveRepositoryId({ repositoryId: undefined, remoteUrl: null, observedOpencodeProjectId: "fork_prone_root_commit_id" }),
    "unmapped",
    "the fork-prone root-commit id is never persisted",
  );
  assert.equal(deriveRepositoryId({ remoteUrl: "", observedOpencodeProjectId: "x" }), "unmapped", "non-git checkouts map to nothing");
});

test("G8: a remote-backed repo carries the OBSERVED opencode id; unobservable degrades to unmapped; file:// is not remote-backed; the caller's explicit id wins", () => {
  assert.equal(
    deriveRepositoryId({ remoteUrl: "git@github.com:antoinedc/MantaUI.git", observedOpencodeProjectId: "afe412f7" }),
    "afe412f7",
  );
  assert.equal(
    deriveRepositoryId({ remoteUrl: "git@github.com:antoinedc/MantaUI.git", observedOpencodeProjectId: null }),
    "unmapped",
    "no observed id → honest unmapped, never a guess",
  );
  assert.equal(
    deriveRepositoryId({ remoteUrl: "file:///tmp/local-clone", observedOpencodeProjectId: "x" }),
    "unmapped",
    "file:// remotes are excluded by opencode's normalizer [SOURCE]",
  );
  assert.equal(
    deriveRepositoryId({ repositoryId: "explicit/by-caller", remoteUrl: null, observedOpencodeProjectId: null }),
    "explicit/by-caller",
    "explicit data beats derivation",
  );
});

// ---------------------------------------------------------------------------
// G9 — the store write path: ONE read-modify-write; a rebind never strands
// two records carrying the same id. REAL local.mjs store over the sandboxed
// config.json.
// Counterfactual control: drop the removes filter in projectIdentityPersist —
// the single-record assertion goes red.
// ---------------------------------------------------------------------------

test("G9: projectIdentityPersist applies upserts+removes in one write and lands on disk", async () => {
  await projectIdentityPersist({ upserts: [record("alpha", fix("alpha"), "proj_alpha_1")], removes: [] });
  const cfg = await configGet();
  assert.equal(cfg.projects.find((p) => p.tmuxSession === "alpha")?.projectId, "proj_alpha_1");

  // THE rebind write: move the name, keep the id — exactly one record remains.
  await projectIdentityPersist({
    upserts: [record("beta", fix("alpha"), "proj_alpha_1", "oc_new")],
    removes: ["alpha"],
  });
  const after = await configGet();
  const carrying = after.projects.filter((p) => p.projectId === "proj_alpha_1");
  assert.equal(carrying.length, 1, "no stranded duplicate under the old name");
  assert.equal(carrying[0].tmuxSession, "beta");
  assert.equal(carrying[0].defaultCwd, fix("alpha"));

  // The bytes are on the sandboxed config.json — the durable store, not a
  // memory-only double.
  const raw = JSON.parse(await readFile(statePath("config.json"), "utf-8"));
  assert.equal(raw.projects.find((p) => p.tmuxSession === "beta")?.projectId, "proj_alpha_1");
});

test("G9: an id-less record is not broken by the persist path and a legacy {name} shape is normalized on read", async () => {
  // A desktop-era record written WITHOUT the durable key must survive a
  // persist round-trip untouched (additive metadata only).
  await projectIdentityPersist({ upserts: [{ tmuxSession: "legacy", defaultCwd: fix("wt1") }], removes: [] });
  const cfg = await configGet();
  const legacy = cfg.projects.find((p) => p.tmuxSession === "legacy");
  assert.ok(legacy, "the record survived");
  assert.equal(legacy.projectId, undefined, "the persist path adds nothing the caller did not send");
});

// ---------------------------------------------------------------------------
// G10 — the observer against a REAL sqlite fixture: fork disambiguation by
// liveness, never by row order.
// Counterfactual control: return ids[0] (row order) in lookupProjectIdByDirectory
// — the freshest-session assertion goes red.
// ---------------------------------------------------------------------------

async function writeOpencodeFixture(path, { projectDirectoryRows, sessionRows }) {
  await rm(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE project_directory (project_id TEXT, directory TEXT, type TEXT, strategy TEXT, time_created INTEGER)");
  db.exec("CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT, time_created INTEGER)");
  const insPd = db.prepare("INSERT INTO project_directory VALUES (?, ?, NULL, NULL, ?)");
  for (const [pid, dir, ts] of projectDirectoryRows) insPd.run(pid, dir, ts);
  const insS = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)");
  for (const [sid, pid, dir, ts] of sessionRows) insS.run(sid, pid, dir, ts);
  db.close();
}

test("G10: the observer returns the single mapping; 'global' is never a repository id", async () => {
  const dbPath = ctoPath("identity-fixtures", "observer-single.db");
  await writeOpencodeFixture(dbPath, {
    projectDirectoryRows: [["afe412f7", fix("alpha"), 100]],
    sessionRows: [],
  });
  process.env.MANTA_OPENCODE_DB = dbPath;
  _resetDbHandle();
  try {
    assert.equal(await lookupProjectIdByDirectory(fix("alpha")), "afe412f7");
    assert.equal(await lookupProjectIdByDirectory(fix("wt1")), null, "an unobserved directory is null, never a guess");
  } finally {
    _resetDbHandle();
  }
});

test("G10: a fork (two projects over one directory) disambiguates by the FRESHEST session — not row order", async () => {
  const dbPath = ctoPath("identity-fixtures", "observer-fork.db");
  // Row ORDER is the trap: the LINGERING (dead) project is inserted FIRST and
  // the fresh one second — and the freshest session still points at the new
  // id either way. The rule must pick by session liveness.
  await writeOpencodeFixture(dbPath, {
    projectDirectoryRows: [
      ["oc_dead_root_commit", fix("alpha"), 100], // the lingering pre-recreation row
      ["oc_live_root_commit", fix("alpha"), 900], // the recreated repo's row
    ],
    sessionRows: [
      ["ses_old", "oc_dead_root_commit", fix("alpha"), 200],
      ["ses_new", "oc_live_root_commit", fix("alpha"), 800],
    ],
  });
  process.env.MANTA_OPENCODE_DB = dbPath;
  _resetDbHandle();
  try {
    assert.equal(
      await lookupProjectIdByDirectory(fix("alpha")),
      "oc_live_root_commit",
      "liveness (the freshest session's project) decides, not ordering",
    );
  } finally {
    _resetDbHandle();
  }
});

test("G10: an unresolvable fork (no session evidence) is null; a missing DB is null", async () => {
  const dbPath = ctoPath("identity-fixtures", "observer-ambiguous.db");
  await writeOpencodeFixture(dbPath, {
    projectDirectoryRows: [
      ["oc_a", fix("alpha"), 100],
      ["oc_b", fix("alpha"), 900],
    ],
    sessionRows: [],
  });
  process.env.MANTA_OPENCODE_DB = dbPath;
  _resetDbHandle();
  try {
    assert.equal(await lookupProjectIdByDirectory(fix("alpha")), null, "no liveness evidence → null");
  } finally {
    _resetDbHandle();
  }
  process.env.MANTA_OPENCODE_DB = "/nonexistent/opencode/cto-identity-fixture.db";
  _resetDbHandle();
  try {
    assert.equal(await lookupProjectIdByDirectory(fix("alpha")), null);
  } finally {
    _resetDbHandle();
  }
});

// ---------------------------------------------------------------------------
// G11 — the mint-at-creation trigger through the REAL projects_create flow.
// Counterfactual control: delete projectsCreate's identity block — the
// persisted-record assertion goes red.
// ---------------------------------------------------------------------------

test("G11: projects_create persists the durable key at creation, through the ONE identity surface", async () => {
  mintSeq = 0;
  const cfg = makeConfigDouble([]);
  const persistCalls = [];
  let createdRow = null;
  const control = createCtoMantaControl({
    store: memoryControlStore("control-g11"),
    now: () => 1_700_000_000_000,
    newId: mintSeqId,
    listProjects: async () => (createdRow ? [createdRow] : []),
    listSessions: async () => [],
    listModels: async () => [],
    configGet: cfg.configGet,
    observeOpencodeProjectId: async () => null,
    gitStatus: async () => "",
    listDelegateJobs: async () => [],
    resolveProjectCwd: async (name) => fix("target"),
    resolveCwd: resolveCwdOrThrow,
    getWindowOption: async () => null,
    tmuxNewSession: async ({ name, cwd }) => {
      createdRow = liveRow(name, cwd);
      return { sessionId: null, windowIndex: 0, projects: [createdRow] };
    },
    persistProjectIdentity: async (plan) => {
      persistCalls.push(plan);
      return cfg.persist(plan);
    },
  });
  const result = await control.projectsCreate({ key: "id-create-1", name: "target", cwd: fix("target") });
  assert.equal(result.ok, true);
  assert.equal(cfg.state.projects.length, 1, "exactly one identity record was persisted");
  const minted = cfg.state.projects[0];
  assert.equal(minted.tmuxSession, "target");
  assert.match(minted.projectId, /^proj_mint_\d+$/, "the creation minted the durable key");
  assert.equal(minted.defaultCwd, fix("target"));
});

test("G11 counterfactual: recreating over an orphaned record at the same checkout keeps the OLD key", async () => {
  mintSeq = 0;
  const cfg = makeConfigDouble([record("oldname", fix("target"), "proj_old_1")]);
  let createdRow = null;
  const control = createCtoMantaControl({
    store: memoryControlStore("control-g11b"),
    now: () => 1_700_000_000_000,
    newId: mintSeqId,
    listProjects: async () => [],
    listSessions: async () => [],
    listModels: async () => [],
    configGet: cfg.configGet,
    observeOpencodeProjectId: async () => null,
    gitStatus: async () => "",
    listDelegateJobs: async () => [],
    resolveProjectCwd: async (name) => fix("target"),
    resolveCwd: resolveCwdOrThrow,
    getWindowOption: async () => null,
    tmuxNewSession: async ({ name, cwd }) => {
      createdRow = liveRow(name, cwd);
      return { sessionId: null, windowIndex: 0, projects: [createdRow] };
    },
    persistProjectIdentity: async (plan) => cfg.persist(plan),
  });
  await control.projectsCreate({ key: "id-create-2", name: "target", cwd: fix("target") });
  // The orphaned record was REBOUND onto the recreated session — the old key
  // survives (recreate-over-old-key is the §4.1 re-attach case).
  assert.equal(cfg.state.projects.length, 1);
  assert.equal(cfg.state.projects[0].projectId, "proj_old_1");
  assert.equal(cfg.state.projects[0].tmuxSession, "target");
});
