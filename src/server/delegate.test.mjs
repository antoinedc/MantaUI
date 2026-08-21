import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJobPrompt,
  buildCompletionText,
  deriveName,
  resolveOwner,
  resolveForgeOwner,
  startJob,
  observeEvent,
  finishJob,
  listJobs,
  sweepDelegateJobs,
  deleteJob,
  cleanupTerminalJob,
  stopJob,
  buildPermissionRuleset,
  createApprovalState,
  MAX_RUNNING_JOBS,
  createDelegateEngine,
  adoptSubagentJob,
  effectiveModelFromMessages,
  tickActivity,
  chooseSubagentModel,
  chooseMainModel,
  resolveNamedModel,
} from "./delegate.mjs";
import { familyKey } from "../shared/modelGuide.mjs";
// Per standing rule 9: a routing test may not hand-write a candidate literal.
// Build every candidate through the REAL normaliser so the fixtures can never
// drift from what production produces (that drift is how this epic's defects
// survived a fully green suite).
import { _normalizeProviderModel } from "./opencode.mjs";
import { chooseModel } from "../shared/modelRouter.mjs";

// ----------------------------------------------------------------------------
// Harness: in-memory load/save on a closure-held array, recorded publish +
// deliver. Mirrors the harness style of capabilities.test.mjs / schedule.test.
// No real tmux, no real opencode, no real git.
// ----------------------------------------------------------------------------

function harness(initialJobs = [], fixedNow = 1_700_000_000_000) {
  let jobs = initialJobs.map((j) => ({ ...j }));
  const published = [];
  const delivered = [];
  let nowMs = fixedNow;
  const deps = {
    load: async () => jobs.map((j) => ({ ...j })),
    save: async (next) => {
      jobs = next.map((j) => ({ ...j }));
    },
    publish: (evt) => published.push(evt),
    deliver: async (args) => {
      delivered.push(args);
      return { delivered: true, queued: false };
    },
    listMessages: async () => [],
    gitRun: async () => ({ stdout: "" }),
    now: () => nowMs,
    setNow: (n) => { nowMs = n; },
  };
  return {
    deps,
    published,
    delivered,
    setNow: (n) => { nowMs = n; },
    get jobs() { return jobs; },
  };
}

const CAP_ERROR =
  "too many background jobs running (5). Do not retry — either wait for one to finish, or do this work yourself.";

// BET-1236: the router gated a candidate on description completeness
// (autoEligibility). The routing-era tests must feed it the routing context
// (identity matcher + quality entry + declared price/caching) so the bare
// {providerID, id, status} fixtures are eligible, exactly as the box's wiring
// will when it lands. Without these the router honestly reports "no usable
// endpoint" and returns the incumbent.
function routingServicesFor(list, extra = {}) {
  const declared = {};
  for (const m of list ?? []) {
    if (!m || typeof m !== "object") continue;
    declared[`${m.providerID}/${m.id}`] = { catalogId: m.id, price: {}, caches: true };
  }
  return {
    catalogMatcher: { lookupModel: (id) => ({ id }), matchModel: (id) => ({ kind: "exact", candidates: [{ id }] }) },
    catalogEntryFor: (c) => ({ family: familyKey(c?.id) ?? undefined }),
    qualityField: {},
    declared,
    accounts: {},
    health: {},
    telemetry: {},
    ...extra,
  };
}

// A raw provider-model payload in the shape opencode's `/provider` emits, and
// the normaliser that turns it into the canonical OpencodeModel the router
// actually sees. Tests NEVER construct the router candidate by hand.
function rawProviderModel(over = {}) {
  return {
    id: "m",
    status: "active",
    limit: { context: 32000, output: 16000 },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3 } },
    capabilities: { toolcall: true, input: ["text", "image", "pdf"] },
    ...over,
  };
}
function normalize(providerID, modelId, raw) {
  const m = _normalizeProviderModel(providerID, modelId, raw);
  assert.ok(m, "candidate must normalise (fixture drift check)");
  return m;
}

// ----------------------------------------------------------------------------
// 1. buildJobPrompt — with and without a worktree
// ----------------------------------------------------------------------------

test("buildJobPrompt includes the git paragraph when a worktree is present", () => {
  const out = buildJobPrompt({
    prompt: "Fix the login bug",
    worktree: "/repo/wt-login",
    branch: "fix-login",
  });
  assert.match(out, /^Fix the login bug\n\n---\n/);
  assert.ok(out.includes("You are running as a background job."));
  assert.ok(out.includes("/repo/wt-login"));
  assert.ok(out.includes("branch fix-login"));
  assert.ok(out.includes("Commit your work to that branch before you finish."));
  // BET-794: a background job MAY open a draft pull request, but may NEVER merge
  // or force-push — the prohibition stays explicit in the prompt contract.
  assert.ok(out.includes("You may open a draft pull"));
  assert.ok(out.includes("never merge"));
  assert.ok(!out.includes("Do not push, do not open a"));
  assert.ok(out.includes("When you are done, end with a short summary"));
});

test("buildJobPrompt omits the git paragraph when there is no worktree", () => {
  const out = buildJobPrompt({ prompt: "Summarize the docs", worktree: null, branch: null });
  assert.match(out, /^Summarize the docs\n\n---\n/);
  assert.ok(out.includes("You are running as a background job."));
  assert.ok(!out.includes("git worktree"));
  assert.ok(!out.includes("Commit your work"));
  assert.ok(out.includes("When you are done, end with a short summary"));
});

// ----------------------------------------------------------------------------
// 2. buildCompletionText — done, failed, stopped, no-worktree
// ----------------------------------------------------------------------------

test("buildCompletionText done with a worktree", () => {
  const text = buildCompletionText({
    name: "fix-login", status: "done", branch: "fix-login",
    worktree: "/repo/wt-login", filesChanged: 3, result: "fixed it",
  });
  assert.equal(text, [
    '[background job "fix-login" done]',
    "Branch: fix-login (3 files changed)",
    "Worktree: /repo/wt-login",
    "",
    "fixed it",
  ].join("\n"));
});

test("buildCompletionText failed replaces result with Error", () => {
  const text = buildCompletionText({
    name: "fix-login", status: "failed", branch: "b", worktree: "/w",
    filesChanged: 0, error: "boom",
  });
  assert.ok(text.startsWith('[background job "fix-login" failed]'));
  assert.ok(text.includes("Error: boom"));
  assert.ok(!text.includes("undefined"));
});

test("buildCompletionText stopped uses Error too", () => {
  const text = buildCompletionText({
    name: "bg", status: "stopped", worktree: null, error: "stopped by user",
  });
  assert.ok(text.startsWith('[background job "bg" stopped]'));
  assert.ok(text.includes("Error: stopped by user"));
  // no worktree → no Branch/Worktree lines
  assert.ok(!text.includes("Branch:"));
  assert.ok(!text.includes("Worktree:"));
});

test("buildCompletionText no-worktree done omits Branch/Worktree lines", () => {
  const text = buildCompletionText({
    name: "sum", status: "done", worktree: null, result: "done summary",
  });
  assert.equal(text, [
    '[background job "sum" done]',
    "",
    "done summary",
  ].join("\n"));
});

test("buildCompletionText timeout status is failed with the timeout error", () => {
  const text = buildCompletionText({
    name: "bg", status: "failed", worktree: "/w", branch: "b", filesChanged: 0,
    error: "timed out after 30 minutes",
  });
  assert.ok(text.startsWith('[background job "bg" failed]'));
  assert.ok(text.includes("Error: timed out after 30 minutes"));
});

// ----------------------------------------------------------------------------
// 8. Name derivation from a long prompt (placed early, pure)
// ----------------------------------------------------------------------------

test("deriveName takes the first four words and slugifies", () => {
  assert.equal(
    deriveName("Fix the login bug by updating auth.ts and the session store"),
    "fix-the-login-bug",
  );
});

test("deriveName falls back to a slug for symbol-heavy prompts", () => {
  assert.equal(deriveName("!!! ??? @@@ something"), "something");
  assert.equal(deriveName("   "), "background");
});

// ----------------------------------------------------------------------------
// resolveOwner helper
// ----------------------------------------------------------------------------

test("resolveForgeOwner finds the project that owns the repo checkout (BET-844)", () => {
  const projects = [
    { tmuxSession: "other", defaultCwd: "/other" },
    {
      tmuxSession: "forge-work",
      defaultCwd: "/repo",
      windows: [{ index: 1, name: "p", opencodeSessionId: "ses_parent", paneCurrentPath: "/repo" }],
    },
  ];
  assert.deepEqual(resolveForgeOwner(projects, "/repo"), {
    parentSessionID: "ses_parent",
    tmuxSession: "forge-work",
  });
});

test("resolveForgeOwner matches a window whose cwd is nested inside the checkout", () => {
  const projects = [
    {
      tmuxSession: "repo-project",
      defaultCwd: "/",
      windows: [{ index: 2, name: "w", opencodeSessionId: "ses_par", paneCurrentPath: "/repo/sub" }],
    },
  ];
  const owner = resolveForgeOwner(projects, "/repo");
  assert.equal(owner.parentSessionID, "ses_par");
  assert.equal(owner.tmuxSession, "repo-project");
});

test("resolveForgeOwner returns null when no project wraps the directory", () => {
  assert.equal(resolveForgeOwner([{ tmuxSession: "a", defaultCwd: "/x", windows: [] }], "/repo"), null);
  assert.equal(resolveForgeOwner([], "/repo"), null);
});

test("resolveOwner finds the tmux session owning a session id", () => {
  const projects = [
    { tmuxSession: "proj-a", windows: [{ index: 0, opencodeSessionId: "ses_x", paneCurrentPath: "/a" }] },
    { tmuxSession: "proj-b", windows: [{ index: 1, opencodeSessionId: "ses_parent", paneCurrentPath: "/b" }] },
  ];
  assert.deepEqual(resolveOwner(projects, "ses_parent"), {
    tmuxSession: "proj-b", windowIndex: 1, cwd: "/b",
  });
  assert.equal(resolveOwner(projects, "ses_missing"), null);
});

// ----------------------------------------------------------------------------
// 3. The cap: a sixth concurrent start is refused with the exact error string
// ----------------------------------------------------------------------------

function runningJob(i) {
  return {
    id: `r${i}`, name: `job${i}`, prompt: "p", model: null,
    parentSessionID: `parent${i}`, parentDirectory: "/repo",
    childSessionID: `child${i}`, tmuxSession: "s", windowIndex: i,
    worktree: null, branch: null, baseSha: null,
    status: "running", activity: null,
    createdAt: 1, startedAt: 1, finishedAt: null,
    result: null, error: null, filesChanged: null,
  };
}

test("startJob refuses a sixth concurrent job with the exact cap error", async () => {
  const h = harness(Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => runningJob(i)));
  const res = await startJob(
    { prompt: "extra work", parentSessionID: "parentX", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, CAP_ERROR);
  // nothing persisted
  assert.equal(h.jobs.length, MAX_RUNNING_JOBS);
  assert.equal(h.delivered.length, 0);
});

// ----------------------------------------------------------------------------
// cleanupTerminalJob + finishJob/stopJob terminal cleanup (BET-418 §B)
// ----------------------------------------------------------------------------

function cleanupHarness() {
  const killWindowCalls = [];
  const removeCalls = [];
  return {
    killWindowCalls,
    removeCalls,
    killWindow: async (input) => { killWindowCalls.push(input); },
    gitRemoveWorktree: async (input) => { removeCalls.push(input); return { removed: true }; },
  };
}

function terminalJob(overrides = {}) {
  return {
    id: "jx",
    name: "fix",
    parentSessionID: "ses_p",
    childSessionID: "ses_c",
    tmuxSession: "proj",
    windowIndex: 3,
    worktree: "/tmp/wt",
    branch: "fix",
    baseSha: "abc",
    status: "done",
    finishedAt: 100,
    ...overrides,
  };
}

test("cleanupTerminalJob removes worktree then window on a clean worktree", async () => {
  const c = cleanupHarness();
  const res = await cleanupTerminalJob(terminalJob(), c);
  assert.equal(res.cleanedUp, true);
  assert.equal(c.removeCalls.length, 1);
  assert.deepEqual(c.removeCalls[0], { path: "/tmp/wt", force: false });
  assert.equal(c.killWindowCalls.length, 1);
  assert.deepEqual(c.killWindowCalls[0], { sessionName: "proj", windowIndex: 3 });
});

test("cleanupTerminalJob keeps both window + worktree on a dirty worktree", async () => {
  const c = cleanupHarness();
  c.gitRemoveWorktree = async (input) => { c.removeCalls.push(input); return { removed: false, reason: "dirty" }; };
  const res = await cleanupTerminalJob(terminalJob(), c);
  assert.equal(res.cleanedUp, false);
  assert.equal(res.reason, "dirty");
  assert.equal(c.removeCalls.length, 1, "worktree removal attempted (force:false)");
  assert.equal(c.killWindowCalls.length, 0, "window is NOT killed when the worktree is dirty");
});

test("cleanupTerminalJob with no worktree just kills the window", async () => {
  const c = cleanupHarness();
  const res = await cleanupTerminalJob(terminalJob({ worktree: null, branch: null }), c);
  assert.equal(res.cleanedUp, true);
  assert.equal(c.removeCalls.length, 0);
  assert.equal(c.killWindowCalls.length, 1);
});

test("finishJob runs terminal cleanup and stamps cleanedUp true on a clean worktree", async () => {
  const c = cleanupHarness();
  const job = { ...runningObserverJob(), id: "fin-clean", worktree: "/tmp/wt", branch: "fix", baseSha: "abc", tmuxSession: "proj", windowIndex: 2 };
  const h = harness([job], 1_700_000_000_000);
  const deps = { ...h.deps, ...c };
  await finishJob(job, "done", null, deps, new Map());
  const stored = h.jobs.find((j) => j.id === "fin-clean");
  assert.equal(stored.status, "done");
  assert.equal(stored.cleanedUp, true);
  assert.equal(c.killWindowCalls.length, 1);
  assert.equal(c.removeCalls.length, 1);
});

test("finishJob keeps the record (cleanedUp false) on a dirty worktree", async () => {
  const c = cleanupHarness();
  c.gitRemoveWorktree = async () => ({ removed: false, reason: "dirty" });
  const job = { ...runningObserverJob(), id: "fin-dirty", worktree: "/tmp/wt", branch: "fix", baseSha: "abc", tmuxSession: "proj", windowIndex: 2 };
  const h = harness([job], 1_700_000_000_000);
  const deps = { ...h.deps, ...c };
  await finishJob(job, "done", null, deps, new Map());
  const stored = h.jobs.find((j) => j.id === "fin-dirty");
  assert.equal(stored.cleanedUp, false);
  assert.equal(c.killWindowCalls.length, 0, "dirty worktree keeps the window");
});

test("stopJob runs terminal cleanup and stamps cleanedUp", async () => {
  const c = cleanupHarness();
  const job = { ...runningObserverJob(), id: "stop-clean", worktree: "/tmp/wt", branch: "fix", baseSha: "abc", tmuxSession: "proj", windowIndex: 2 };
  const h = harness([job], 1_700_000_000_000);
  const deps = { ...h.deps, ...c };
  const res = await stopJob("stop-clean", deps);
  assert.equal(res.ok, true);
  const stored = h.jobs.find((j) => j.id === "stop-clean");
  assert.equal(stored.status, "stopped");
  assert.equal(stored.cleanedUp, true);
  assert.equal(c.killWindowCalls.length, 1);
});

// ----------------------------------------------------------------------------
// Retention skips dirty-kept terminal jobs (BET-418 §B)
// ----------------------------------------------------------------------------

test("sweep does not prune a terminal dirty-kept job (cleanedUp false)", async () => {
  const old = 1_700_000_000_000;
  const cutoff = old - 8 * 24 * 60 * 60_000; // older than the 7-day retention
  const dirty = terminalJob({ id: "dirty", status: "done", finishedAt: cutoff, cleanedUp: false, worktree: "/tmp/wt" });
  const clean = terminalJob({ id: "clean", status: "done", finishedAt: cutoff, cleanedUp: true, worktree: "/tmp/wt" });
  const h = harness([dirty, clean], old);
  // No timed-out, no orphaned jobs → retention only.
  await sweepDelegateJobs(h.deps);
  const ids = h.jobs.map((j) => j.id);
  assert.ok(ids.includes("dirty"), "dirty-kept record is retained so its window stays a job");
  assert.ok(!ids.includes("clean"), "cleaned-up record is pruned normally");
});

// ----------------------------------------------------------------------------
// Parent-gone detection in the sweeper (BET-418 §B)
// ----------------------------------------------------------------------------

test("sweep stops a running job whose parent session is gone", async () => {
  const c = cleanupHarness();
  const job = { ...runningObserverJob(), id: "orphan", parentSessionID: "ses_gone", worktree: "/tmp/wt", branch: "fix", baseSha: "abc", tmuxSession: "proj", windowIndex: 2, startedAt: 1_700_000_000_000 };
  const h = harness([job], 1_700_000_000_000);
  const deps = {
    ...h.deps,
    ...c,
    sessionExists: async (sid) => sid !== "ses_gone",
    abortSession: async () => {},
  };
  await sweepDelegateJobs(deps);
  const stored = h.jobs.find((j) => j.id === "orphan");
  assert.equal(stored.status, "stopped", "orphaned job is stopped");
  assert.equal(stored.cleanedUp, true, "terminal cleanup ran on the orphaned job");
  assert.equal(c.killWindowCalls.length, 1);
});

test("sweep leaves a running job whose parent session is alive", async () => {
  const c = cleanupHarness();
  const job = { ...runningObserverJob(), id: "alive", parentSessionID: "ses_alive", worktree: "/tmp/wt", startedAt: 1_700_000_000_000 };
  const h = harness([job], 1_700_000_000_000);
  const deps = {
    ...h.deps,
    ...c,
    sessionExists: async () => true,
    abortSession: async () => {},
  };
  await sweepDelegateJobs(deps);
  const stored = h.jobs.find((j) => j.id === "alive");
  assert.equal(stored.status, "running", "alive-parent job is left running");
  assert.equal(c.killWindowCalls.length, 0);
});


// ----------------------------------------------------------------------------
// 4. Nesting: a start whose parentSessionID is a live job's childSessionID
// ----------------------------------------------------------------------------

test("startJob persists the session link on the job record (BET-844)", async () => {
  const h = harness([]);
  h.deps.gitAddWorktree = async ({ name }) => ({ path: `/repo/wt-${name}`, branch: name });
  const parentWin = { index: 1, name: "p", opencodeSessionId: "parent", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "forge-work", windows: [parentWin] }];
  h.deps.newWindow = async (input) => ({
    sessionId: "child_link",
    windowIndex: 5,
    projects: [{ tmuxSession: input.sessionName, windows: [parentWin] }],
  });
  const res = await startJob(
    {
      prompt: "complete the issue",
      parentSessionID: "parent",
      parentDirectory: "/repo",
      link: { issue: { repoKey: "github.com/owner/repo", number: 42 } },
    },
    h.deps,
  );
  assert.equal(res.ok, true);
  const job = h.jobs.find((j) => j.childSessionID === "child_link");
  assert.ok(job, "job persisted");
  assert.deepEqual(job.link, { issue: { repoKey: "github.com/owner/repo", number: 42 } });
});

test("startJob leaves the link null when none is provided", async () => {
  const h = harness([]);
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  const parentWin = { index: 1, name: "p", opencodeSessionId: "parent", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "s", windows: [parentWin] }];
  h.deps.newWindow = async () => ({ sessionId: "child_nolink", windowIndex: 1 });
  const res = await startJob(
    { prompt: "plain delegate", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  const job = h.jobs.find((j) => j.childSessionID === "child_nolink");
  assert.equal(job.link, null);
});

// ----------------------------------------------------------------------------
// BET-947 — startJob model threading (structured, free text, no-match, none)
// ----------------------------------------------------------------------------

function mockModels() {
  return [
    { providerID: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { providerID: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { providerID: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
  ];
}

function startHarness(childSessionId) {
  const h = harness([]);
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  h.deps.listProjects = async () => [
    { tmuxSession: "s", windows: [{ index: 1, opencodeSessionId: "parent", paneCurrentPath: "/repo" }] },
  ];
  h.deps.newWindow = async () => ({ sessionId: childSessionId, windowIndex: 1 });
  return h;
}

test("startJob with a structured model passes it to deliver and records requestedModel (BET-947)", async () => {
  const h = startHarness("child_struct");
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo",
      model: { providerID: "anthropic", modelID: "claude-opus-4-5" } },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-opus-4-5" });
  const job = h.jobs.find((j) => j.childSessionID === "child_struct");
  assert.equal(job.requestedModel, "anthropic/claude-opus-4-5");
});

test("startJob resolves free text matching a known model and passes it (BET-947)", async () => {
  const h = startHarness("child_freetext");
  h.deps.listModels = async () => mockModels();
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo", model: "opus" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-opus-4-5" });
  const job = h.jobs.find((j) => j.childSessionID === "child_freetext");
  assert.equal(job.requestedModel, "anthropic/claude-opus-4-5");
});

test("startJob with unmatchable free text rejects and names candidates (BET-947)", async () => {
  const h = harness([]);
  h.deps.listModels = async () => mockModels();
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo", model: "claude zzz" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /No model matched "claude zzz"/);
  assert.match(res.error, /Closest models: /);
  assert.match(res.error, /anthropic\/claude-/);
  assert.equal(h.delivered.length, 0, "no prompt delivered on a bad model");
  assert.equal(h.jobs.length, 0, "no job persisted on a bad model");
});

test("startJob with no model calls deliver without a model key (BET-947 regression)", async () => {
  const h = startHarness("child_default");
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  assert.equal("model" in h.delivered[0], false, "no model key on the default path");
  const job = h.jobs.find((j) => j.childSessionID === "child_default");
  assert.equal(job.requestedModel, null);
});

// ----------------------------------------------------------------------------
// BET-1220 — subagent model routing at spawn
// ----------------------------------------------------------------------------

test("startJob with routing off delivers the incumbent model byte-identical (BET-1220)", async () => {
  const h = startHarness("child_route_off");
  h.deps.configGet = async () => ({}); // no routing config → not activated
  h.deps.listSnapshots = () => [];
  h.deps.listModels = async () => mockModels();
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo",
      model: { providerID: "anthropic", modelID: "claude-opus-4-5" } },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  // routing off → the requested model passes through exactly as before BET-1220
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-opus-4-5" });
});

test("startJob survives a throwing listSnapshots and delivers the incumbent (BET-1220)", async () => {
  const h = startHarness("child_quota_throw");
  h.deps.listSnapshots = () => { throw new Error("usage dead"); };
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo",
      model: { providerID: "anthropic", modelID: "claude-opus-4-5" } },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1, "a throwing quota must never fail the spawn");
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-opus-4-5" });
});

test("chooseSubagentModel routes an explore agent to a fast-tier model when the conversation activates routing (BET-1220)", () => {
  const catalog = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),   // deep
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4" })), // fast
  ];
  const chosen = chooseSubagentModel({
    incumbent: { providerID: "anthropic", modelID: "claude-opus-4" },
    catalog,
    policy: { preset: "economy" }, // economy + explore → fast tier
    quota: [],
    agent: "explore",
    nowMs: 1_700_000_000_000,
    services: routingServicesFor(catalog),
  });
  // NOTE: this asserts the ROUTER WRAPPER's per-agent contract (the reusable
  // chooseSubagentModel — what any future explore-routing spawn would call).
  // It is not asserting end-to-end coverage: today every MANTA-controlled
  // delegate spawn is a general-purpose background job, so startJob routes with
  // `agent: "general"` — explore/build/plan subagents are spawned by opencode's
  // own task tool, which Manta never dispatches. The end-to-end wiring for a
  // general spawn is covered by the "startJob with routing on normalises the
  // winner to a deliver shape" test below.
  assert.equal(chosen?.providerID, "anthropic");
  assert.equal(chosen?.modelID, "claude-haiku-4", "explore under economy must land on the fast-tier model");
});

test("startJob with routing on normalises the catalog winner to a {providerID, modelID} deliver shape (BET-1220)", async () => {
  const h = startHarness("child_route_on");
  // PINS THE CONFIG KEY BY NAME (BET-1227): routing reads `modelRouting`, the
  // key Settings writes. A rename here fails by construction, so this asserts
  // the key, not just the behaviour.
  h.deps.configGet = async () => ({ modelRouting: { preset: "economy" } });
  h.deps.listSnapshots = () => [];
  const models = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),   // deep
    normalize("anthropic", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4" })), // balanced
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4" })),  // fast
  ];
  h.deps.listModels = async () => models;
  h.deps.routingServices = routingServicesFor(models);
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0].model, "routing on should deliver a decided model");
  assert.equal(h.delivered[0].model.providerID, "anthropic");
  // economy + general → the balanced floor wins; the winner is NORMALISED from
  // the catalog's {providerID, id} into sendPrompt's {providerID, modelID}.
  assert.equal(h.delivered[0].model.modelID, "claude-sonnet-4");
  assert.equal("id" in h.delivered[0].model, false, "deliver must receive modelID, not the catalog's id field");
});

// BET-1252 — the EXIT-CRITERIA path: startJob builds its RoutingServices from
// LIVE-style readers (catalogue + health + ledger) rather than a hand-built
// `routingServices` injection, and under a configured preset picks a real,
// non-incumbent model. A provider the reader reports as out-of-credit /
// rate-limited is excluded from the outcome.
test("startJob routes to a non-incumbent model from live routing readers (BET-1252)", async () => {
  const h = startHarness("child_live_routing");
  h.deps.configGet = async () => ({ modelRouting: { preset: "economy" } });
  h.deps.listSnapshots = () => [];
  const models = [
    // openai/gpt-5 is the CHEAPEST — but the health reader reports it
    // rate-limited, so it must be excluded from the decision.
    normalize("openai", "gpt-5", rawProviderModel({ id: "gpt-5", cost: { input: 0.1, output: 0.4, cache: { read: 0.05, write: 0.15 } }, capabilities: { toolcall: true } })),
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4", cost: { input: 15, output: 75, cache: { read: 1.5, write: 22.5 } }, capabilities: { reasoning: true, toolcall: true } })),
    normalize("anthropic", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4", cost: { input: 3, output: 15, cache: { read: 0.3, write: 4.5 } }, capabilities: { reasoning: true, toolcall: true } })),
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4", cost: { input: 1, output: 5, cache: { read: 0.1, write: 1.5 } }, capabilities: { toolcall: true } })),
  ];
  h.deps.listModels = async () => models;
  // Live-style readers (NOT a pre-built routingServices).
  const cat = (id) => ({ id, family: familyKey(id) });
  h.deps.catalogIndex = {
    lookupModel: (id) => cat(id),
    matchModel: (id) => ({ kind: "exact", candidates: [cat(id)] }),
    allModels: () => [],
  };
  h.deps.providerHealthState = (pid) => (pid === "openai" ? "rate-limited" : "ok");
  h.deps.endpointSummary = async () => ({ supported: true });

  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  // A decided, non-incumbent model — never the rate-limited openai/gpt-5.
  assert.ok(h.delivered[0].model, "live routing should decide a model");
  assert.notEqual(h.delivered[0].model.providerID, "openai", "rate-limited provider must be excluded");
  // economy + general → the cheapest survivor that MEETS the general agent's
  // balanced floor. gpt-5 (cheapest but rate-limited) and haiku-4 (below the
  // floor) are both excluded → sonnet-4 wins.
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-sonnet-4" });
});

// BET-1252 (reviewer nit): end-to-end through startJob — a reliability-DERANKED
// endpoint (bad tool-call rate vs the SAME model's baseline) sorts last, so the
// routed winner is the sibling endpoint serving the same model at the same
// price, never the broken one. Proves the ledger wiring actually reaches the
// router's derank and influences the outcome.
test("startJob routes to the non-deranked sibling when an endpoint is reliability-penalised (BET-1252)", async () => {
  const h = startHarness("child_derank");
  h.deps.configGet = async () => ({ modelRouting: { preset: "balanced" } });
  h.deps.listSnapshots = () => [];
  const models = [
    // Same model served by two endpoints at the SAME price — only reliability
    // can separate them. anthropic/claude-sonnet-4 is the alphabetical
    // tie-break winner, but its endpoint has a bad tool-call rate → it must be
    // reliability-penalised and lose to openai's clean copy. This pins that the
    // ledger's derank actually swings the outcome, not the model-id tie-break.
    normalize("anthropic", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4", cost: { input: 3, output: 15, cache: { read: 0.3, write: 4.5 } }, capabilities: { reasoning: true, toolcall: true } })),
    normalize("openai", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4", cost: { input: 3, output: 15, cache: { read: 0.3, write: 4.5 } }, capabilities: { reasoning: true, toolcall: true } })),
  ];
  h.deps.listModels = async () => models;
  const cat = (id) => ({ id, family: "sonnet" });
  h.deps.catalogIndex = {
    lookupModel: (id) => cat(id),
    matchModel: (id) => ({ kind: "exact", candidates: [cat(id)] }),
    allModels: () => [],
  };
  h.deps.providerHealthState = () => "ok";
  h.deps.endpointSummary = async () => ({
    supported: true,
    "anthropic/claude-sonnet-4": { reliability: { requests: 25, errored: 12, rate: 0.48 }, speed: {}, latency: {}, mix: {} },
    "openai/claude-sonnet-4": { reliability: { requests: 25, errored: 0, rate: 0 }, speed: {}, latency: {}, mix: {} },
  });

  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  // The deranked (anthropic, alphabetical winner) endpoint must NOT win the
  // same-model contest — the clean openai copy does.
  assert.deepEqual(h.delivered[0].model, { providerID: "openai", modelID: "claude-sonnet-4" });
});

test("startJob ignores the stale modelRouter key and delivers the incumbent (BET-1227)", async () => {
  const h = startHarness("child_stale_key");
  // The wrong, never-written key must NOT activate routing — a preset under
  // `modelRouter` is inert (the wire key is `modelRouting`), exactly as it has
  // been on every box since shipping.
  h.deps.configGet = async () => ({ modelRouter: { preset: "economy" } });
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo",
      model: { providerID: "anthropic", modelID: "claude-opus-4" } },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  // routing not activated → the requested model passes through byte-identical,
  // proving we are NOT reading the stale `modelRouter` name.
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-opus-4" });
});

// BET-1229 — a routed subagent spawn can only ever produce one of the models
// the user's ticks consent to. startJob hands the router listRoutableModels
// ("sub", cfg) instead of the raw connected catalogue, so models the user
// deactivated for subagents are excluded before the router ever sees them.
test("startJob routes only within the consent (sub) catalogue (BET-1229)", async () => {
  const h = startHarness("child_consent");
  // Routing on, and the user has deactivated every subagent model except
  // claude-opus-4 and gpt-5 (the "ticked" set).
  h.deps.configGet = async () => ({
    modelRouting: { preset: "economy" },
    deactivatedSubagents: ["anthropic/claude-sonnet-4", "anthropic/claude-haiku-4"],
  });
  h.deps.listSnapshots = () => [];
  const models = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),
    normalize("anthropic", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4" })),
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4" })),
    normalize("openai", "gpt-5", rawProviderModel({ id: "gpt-5" })),
  ];
  h.deps.listModels = async () => models;
  h.deps.routingServices = routingServicesFor(models);
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0].model, "routing should decide a model");
  const key = `${h.delivered[0].model.providerID}/${h.delivered[0].model.modelID}`;
  // The winner must be within the consented set — never a deactivated model.
  assert.ok(
    key === "anthropic/claude-opus-4" || key === "openai/gpt-5",
    `routed subagent landed on deactivated model ${key}`,
  );
});

// ----------------------------------------------------------------------------
// BET-1275 — delegate model precedence: an explicit model wins, silence routes
// on the subagent's own intent (11a), a named model is never routed over and
// must respect the Sub ticks (11b / rule 3).
// ----------------------------------------------------------------------------

function threeTierAnthropicModels() {
  return [
    { providerID: "anthropic", id: "claude-opus-4", status: "active" },    // deep
    { providerID: "anthropic", id: "claude-sonnet-4", status: "active" },  // balanced
    { providerID: "anthropic", id: "claude-haiku-4", status: "active" },   // fast
  ];
}

// Capture the `[router]` log lines chooseSubagentModel emits — the observable
// record that routing ran AND with which agent. Asserting on this (the intent)
// rather than the specific winner is what the issue asks for.
async function captureRouterLines(fn, ...args) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let out;
  try {
    out = await fn(...args);
  } finally {
    console.log = orig;
  }
  return { out, lines };
}

test("BET-1275 11b: a named Sub-ticked model runs on it, skip routing, and emits NO [router] line", async () => {
  const h = startHarness("child_named_ticked");
  h.deps.configGet = async () => ({ modelRouting: { preset: "economy" } }); // routing ON
  h.deps.listSnapshots = () => [];
  h.deps.listModels = async () => mockModels();
  // A throwing router stub: if routing ever runs for a NAMED model, this throws
  // (the named path skips routing entirely and never calls it). On main this
  // seam doesn't exist, so the [router]-line assertion below is the load-bearing
  // on-main failure — main ALWAYS routes a named model and logs a decision.
  h.deps.chooseSubagentModel = () => {
    throw new Error("router must not run for a named model");
  };
  const { out, lines } = await captureRouterLines((input) => startJob(input, h.deps), {
    prompt: "do it",
    parentSessionID: "parent",
    parentDirectory: "/repo",
    model: "opus",
  });
  assert.equal(out.ok, true);
  assert.equal(h.delivered.length, 1);
  // Named, ticked model is honoured verbatim — never routed over.
  assert.deepEqual(h.delivered[0].model, { providerID: "anthropic", modelID: "claude-opus-4-5" });
  // Routing is SKIPPED: no [router] decision line may be emitted for the spawn.
  assert.ok(
    !lines.some((l) => l.includes("[router]")),
    `a named model must not route; got [router] lines: ${lines.join(" | ")}`,
  );
});

test("BET-1275 rule 3: a named UN-ticked model fails loudly naming close candidates", async () => {
  const h = harness([]);
  h.deps.listModels = async () => mockModels();
  // The user unticked (deactivated for subagents) claude-sonnet-4-6; only
  // claude-opus-4-5 and deepseek-chat stay routable — so naming the unticked
  // sonnet must fail loudly, naming the closest routable sibling (opus).
  h.deps.configGet = async () => ({
    modelRouting: { preset: "balanced" },
    deactivatedSubagents: ["anthropic/claude-sonnet-4-6"],
  });
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /not routable/);
  assert.equal(h.delivered.length, 0, "no prompt delivered on an un-ticked model");
  assert.equal(h.jobs.length, 0, "no job persisted on an un-ticked model");
});

// resolveNamedModel reuses the SHARED suggestModels matcher for its retry hint
// (the issue forbids a second matcher). Assert the hint names a routable
// candidate when one shares tokens with the query — the "fails loudly, naming
// close candidates" contract at the unit level.
test("BET-1275 11b: resolveNamedModel names the closest routable candidate on no-match", () => {
  const routable = [{ providerID: "anthropic", id: "claude-opus-4-5" }];
  assert.throws(
    () => resolveNamedModel("opus 9", routable),
    /No model matched "opus 9".*Closest models: anthropic\/claude-opus-4-5/,
  );
});

test("BET-1275 11b: resolveNamedModel rejects a structured model missing from the routable (sub) catalogue", () => {
  const routable = [
    { providerID: "anthropic", id: "claude-opus-4-5" },
    { providerID: "deepseek", id: "deepseek-chat" },
  ];
  assert.throws(
    () => resolveNamedModel({ providerID: "anthropic", modelID: "claude-sonnet-4-6" }, routable),
    /"anthropic\/claude-sonnet-4-6" is not routable on this box/,
  );
});

test("BET-1275 11a: delegate({}) with subagent_type 'explore' routes with agent=explore (intent, not the winner)", async () => {
  const h = startHarness("child_explore");
  h.deps.configGet = async () => ({ modelRouting: { preset: "balanced" } });
  h.deps.listSnapshots = () => [];
  const models = threeTierAnthropicModels();
  h.deps.listModels = async () => models;
  h.deps.routingServices = routingServicesFor(models);
  const { out, lines } = await captureRouterLines((input) => startJob(input, h.deps), {
    prompt: "do it",
    parentSessionID: "parent",
    parentDirectory: "/repo",
    subagent_type: "explore",
  });
  assert.equal(out.ok, true);
  assert.equal(h.delivered.length, 1);
  // The requested subagent type IS the intent — the [router] line names the
  // agent the spawn routed as. Assert the intent, not which model won.
  assert.ok(
    lines.some((l) => l.includes("[router] subagent agent=explore")),
    `expected agent=explore in [router] line; got: ${lines.join(" | ")}`,
  );
});

test("BET-1275 11a: an absent/blank subagent_type routes with agent=general", async () => {
  const h = startHarness("child_blank_agent");
  h.deps.configGet = async () => ({ modelRouting: { preset: "balanced" } });
  h.deps.listSnapshots = () => [];
  const models = threeTierAnthropicModels();
  h.deps.listModels = async () => models;
  h.deps.routingServices = routingServicesFor(models);
  const { out, lines } = await captureRouterLines((input) => startJob(input, h.deps), {
    prompt: "do it",
    parentSessionID: "parent",
    parentDirectory: "/repo",
    subagent_type: "   ",
  });
  assert.equal(out.ok, true);
  // A blank subagent_type (unknown) must map to the general agent, not leak
  // through as an empty agent and not crash.
  assert.ok(
    lines.some((l) => l.includes("[router] subagent agent=general")),
    `expected agent=general in [router] line; got: ${lines.join(" | ")}`,
  );
});

test("BET-1275: a background job routes from the box config even with no parent-Auto input", async () => {
  const h = startHarness("child_routes_unaauto");
  h.deps.configGet = async () => ({ modelRouting: { preset: "economy" }, deactivatedSubagents: [] });
  h.deps.listSnapshots = () => [];
  const models = threeTierAnthropicModels();
  h.deps.listModels = async () => models;
  h.deps.routingServices = routingServicesFor(models);
  // No `model`, no subagent_type, no composer, NO path where the parent
  // conversation's Auto state could be consulted — the delegate has no
  // per-conversation auto choice to inherit (rule 4). Routing must still fire
  // from the box config's preset and decide a model.
  const res = await startJob(
    { prompt: "do it", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0].model, "routing decided a model with no parent-Auto input");
});

test("chooseSubagentModel returns the incumbent on an off-path and is load-bearing (BET-1220)", () => {
  const incumbent = { providerID: "anthropic", modelID: "claude-opus-4" };
  const catalog = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4" })),
  ];
  // routing not activated (no preset) → incumbent unchanged even though a cheaper fast model exists
  assert.deepEqual(
    chooseSubagentModel({ incumbent, catalog, policy: {}, agent: "explore", nowMs: 0 }),
    incumbent,
  );
  // an activated router with no survivors (all dead) still falls back to incumbent
  assert.deepEqual(
    chooseSubagentModel({
      incumbent,
      catalog: [normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4", status: "retired" }))],
      policy: { preset: "economy" },
      agent: "explore",
      nowMs: 0,
    }),
    incumbent,
  );
});

// ----------------------------------------------------------------------------
// BET-1225 — main-conversation ("build") routing decision
// ----------------------------------------------------------------------------

test("chooseMainModel returns the FULL decision — model, reason, incumbent — and normalises the winner to {providerID, modelID} (BET-1225)", () => {
  const catalog = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),     // deep
    normalize("anthropic", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4" })),   // balanced
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4" })),    // fast
  ];
  const incumbent = { providerID: "anthropic", modelID: "claude-opus-4" };
  const decision = chooseMainModel({
    incumbent,
    catalog,
    policy: { preset: "economy" }, // economy + build → balanced floor
    quota: [],
    agent: "build",
    nowMs: 1_700_000_000_000,
    services: routingServicesFor(catalog),
  });
  // The main-conversation decision is richer than the subagent wrapper: the
  // renderer needs the model, a reason, and the incumbent for the undo pill.
  assert.equal(decision.changed, true);
  assert.equal(decision.model?.providerID, "anthropic");
  assert.equal(decision.model?.modelID, "claude-sonnet-4", "build under economy must land on the balanced-tier floor");
  assert.equal("id" in decision.model, false, "the routed model must carry modelID, not the catalog's id");
  assert.match(decision.reason, /build → balanced tier/, "reason names the build agent and tier");
  assert.deepEqual(decision.incumbent, incumbent, "incumbent is preserved for the undo pill");
});

test("chooseMainModel on the off-path returns the incumbent with changed:false, never a hidden switch (BET-1225)", () => {
  const incumbent = { providerID: "anthropic", modelID: "claude-opus-4" };
  const catalog = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),
    normalize("anthropic", "claude-haiku-4", rawProviderModel({ id: "claude-haiku-4" })),
  ];
  // routing not activated (no preset) → no switch, even though a cheaper fast model exists
  const off = chooseMainModel({ incumbent, catalog, policy: {}, agent: "build", nowMs: 0 });
  assert.equal(off.changed, false);
  assert.deepEqual(off.model, incumbent);
  assert.equal(off.reason, "routing not activated for this conversation");
  // an activated router with no survivors (all dead) still falls back to incumbent
  const noSurvivors = chooseMainModel({
    incumbent,
    catalog: [normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4", status: "retired" }))],
    policy: { preset: "economy" },
    agent: "build",
    nowMs: 0,
  });
  assert.equal(noSurvivors.changed, false);
  assert.deepEqual(noSurvivors.model, incumbent);
});

test("chooseMainModel when the router picks the same model reports changed:false (BET-1225)", () => {
  // deep incumbent + performance preset → build stays deep → same model, no pill.
  const incumbent = { providerID: "anthropic", modelID: "claude-opus-4" };
  const catalog = [
    normalize("anthropic", "claude-opus-4", rawProviderModel({ id: "claude-opus-4" })),
    normalize("anthropic", "claude-sonnet-4", rawProviderModel({ id: "claude-sonnet-4" })),
  ];
  const decision = chooseMainModel({
    incumbent,
    catalog,
    policy: { preset: "performance" },
    quota: [],
    agent: "build",
    nowMs: 0,
  });
  assert.equal(decision.changed, false, "no model was substituted → the pill must not render");
  assert.deepEqual(decision.model, incumbent);
  assert.deepEqual(decision.incumbent, incumbent);
});

// ----------------------------------------------------------------------------
// BET-1267 — the hard filters must receive the turn's real facts. Every
// candidate here is built through _normalizeProviderModel (standing rule 9),
// and each case FAILS on main (the fixture feeds production's real shape, so a
// green suite can no longer hide the defect).
// ----------------------------------------------------------------------------

test("BET-1267 3a: an image turn against a real-normalised model that DECLARES image input survives", () => {
  const imageCapable = normalize("p", "imgm", rawProviderModel({ id: "imgm", capabilities: { toolcall: true, input: { text: true, image: true } } }));
  const decision = chooseModel({
    intent: { kind: "start", agent: "general", incumbent: null, contextTokens: 0, needs: { image: true } },
    catalog: [imageCapable],
    policy: { preset: "balanced" },
    nowMs: 0,
    services: routingServicesFor([imageCapable]),
  });
  assert.ok(decision.model, "an image-capable model must survive an image turn");
  assert.equal(decision.model?.id, "imgm");
  assert.ok(
    !decision.trace.dropped.some((d) => d.reason === "image input"),
    "must not be dropped for image input",
  );
});

test("BET-1267 3a: an image turn drops a text-only model (image input) and keeps the image-capable control", () => {
  const textOnly = normalize("p", "textm", rawProviderModel({ id: "textm", capabilities: { toolcall: true, input: ["text"] } }));
  const imageCapable = normalize("p", "imgm", rawProviderModel({ id: "imgm", capabilities: { toolcall: true, input: ["text", "image"] } }));
  const decision = chooseModel({
    intent: { kind: "start", agent: "general", incumbent: null, contextTokens: 0, needs: { image: true } },
    catalog: [textOnly, imageCapable],
    policy: { preset: "balanced" },
    nowMs: 0,
    services: routingServicesFor([textOnly, imageCapable]),
  });
  assert.ok(
    decision.trace.dropped.some((d) => d.stage === "capable" && d.reason === "image input"),
    "the text-only model must be dropped with 'image input'",
  );
  assert.equal(decision.model?.id, "imgm", "the image-capable control must win");
});

test("BET-1267 3a: an image turn against a model with NO declared modalities survives (unknown = allow)", () => {
  const noMods = normalize("p", "nomo", rawProviderModel({ id: "nomo", capabilities: { toolcall: true } }));
  const decision = chooseModel({
    intent: { kind: "start", agent: "general", incumbent: null, contextTokens: 0, needs: { image: true } },
    catalog: [noMods],
    policy: { preset: "balanced" },
    nowMs: 0,
    services: routingServicesFor([noMods]),
  });
  assert.ok(decision.model, "a model with no declared modalities must survive an image turn");
  assert.equal(decision.model?.id, "nomo");
  assert.ok(
    !decision.trace.dropped.some((d) => d.reason === "image input"),
    "must not be dropped for image input",
  );
});

test("BET-1267 3b: a 150k-token conversation drops a 32k-context model for context headroom — the real size reaches the decision", () => {
  const small = normalize("p", "ctx-32k", rawProviderModel({ id: "ctx-32k", limit: { context: 32000 }, capabilities: { toolcall: true } }));
  // The incumbent is a DIFFERENT model, absent from the catalog: whether the
  // 32k candidate is dropped (context headroom, real 150k size) is the only
  // thing separating "falls back to the incumbent" from "routes onto the 32k".
  const incumbent = { providerID: "p", modelID: "elsewhere" };
  const chosen = chooseSubagentModel({
    incumbent,
    catalog: [small],
    policy: { preset: "balanced" },
    quota: [],
    agent: "general",
    nowMs: 0,
    contextTokens: 150000,
    services: routingServicesFor([small]),
  });
  assert.deepEqual(
    chosen,
    incumbent,
    "a 32k model cannot hold a 150k conversation (1.25x headroom) and must drop, falling back to the incumbent",
  );
});

test("BET-1267 3d: an opted-in deprecated model survives the router (status is not re-litigated at the decision core)", () => {
  const deprecated = normalize("p", "legacy", rawProviderModel({ id: "legacy", status: "deprecated" }));
  const decision = chooseModel({
    intent: { kind: "start", agent: "general", incumbent: null, contextTokens: 0, needs: {} },
    catalog: [deprecated],
    policy: { preset: "balanced" },
    nowMs: 0,
    services: routingServicesFor([deprecated]),
  });
  assert.ok(decision.model, "an opted-in deprecated model must survive the router");
  assert.equal(decision.model?.id, "legacy");
  assert.ok(
    !decision.trace.dropped.some((d) => d.reason === "no active model"),
    "must not be dropped for status",
  );
});

test("requestedModel survives a tickActivity that rewrites job.model (BET-947)", async () => {
  const running = runningJob(0);
  running.requestedModel = "anthropic/claude-opus-4-5";
  running.model = "anthropic/claude-opus-4-5";
  running.activity = null;
  const h = harness([running]);
  h.deps.listMessages = async () => [
    modelMessage("anthropic", "claude-sonnet-4-6"), // observed differs from requested
  ];
  await tickActivity(h.deps);
  const job = h.jobs[0];
  assert.equal(job.model, "anthropic/claude-sonnet-4-6", "job.model reflects the OBSERVED model");
  assert.equal(job.requestedModel, "anthropic/claude-opus-4-5", "requestedModel is never overwritten");
});

test("startJob refuses nesting when parentSessionID is a live job's childSessionID", async () => {
  const live = { ...runningJob(0), childSessionID: "child_live", status: "running" };
  const h = harness([live]);
  const res = await startJob(
    { prompt: "nested work", parentSessionID: "child_live", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "a background job cannot start another background job");
  assert.equal(h.jobs.length, 1);
  assert.equal(h.delivered.length, 0);
});

test("startJob allows nesting when the blocking job is terminal", async () => {
  const done = { ...runningJob(0), childSessionID: "child_done", status: "done", finishedAt: 2 };
  const h = harness([done]);
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  const parentWin = { index: 1, name: "p", opencodeSessionId: "child_done", paneCurrentPath: "/repo" };
  const childWin = { index: 5, name: "nested-work", opencodeSessionId: "c2", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "s", windows: [parentWin] }];
  h.deps.newWindow = async (input) => ({
    sessionId: "c2",
    windowIndex: 5,
    projects: [{ tmuxSession: input.sessionName, windows: [parentWin, childWin] }],
  });
  const res = await startJob(
    { prompt: "nested work", parentSessionID: "child_done", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
});

// ----------------------------------------------------------------------------
// 7. Rollback: a throw at the window-creation step removes the worktree
// ----------------------------------------------------------------------------

test("startJob rolls back the worktree when window creation throws", async () => {
  const h = harness([]);
  let worktreeCreated = null;
  h.deps.gitAddWorktree = async ({ cwd, name }) => {
    worktreeCreated = { path: `/repo/wt-${name}`, branch: name };
    return worktreeCreated;
  };
  h.deps.gitRun = async (args) => ({ stdout: "abc123\n" }); // baseSha
  const parentWin = { index: 0, name: "parent", opencodeSessionId: "parent", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "s", windows: [parentWin] }];
  h.deps.newWindow = async () => { throw new Error("tmux new-window exploded"); };
  const removed = [];
  h.deps.gitRemoveWorktree = async (input) => { removed.push(input); return { removed: true }; };

  const res = await startJob(
    { prompt: "do work", parentSessionID: "parent", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /tmux new-window exploded/);
  // worktree was created then removed on rollback
  assert.ok(worktreeCreated, "worktree was created");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].path, worktreeCreated.path);
  assert.equal(removed[0].force, false);
  // no job persisted
  assert.equal(h.jobs.length, 0);
  assert.equal(h.delivered.length, 0);
});

// ----------------------------------------------------------------------------
// 5. observeEvent: idle before any busy does NOT complete; busy then idle DOES
// ----------------------------------------------------------------------------

function runningObserverJob() {
  return {
    id: "j1", name: "bg", prompt: "p", model: null,
    parentSessionID: "parent", parentDirectory: "/repo",
    childSessionID: "child", tmuxSession: "s", windowIndex: 1,
    worktree: null, branch: null, baseSha: null,
    status: "running", activity: null,
    createdAt: 1, startedAt: 1, finishedAt: null,
    result: null, error: null, filesChanged: null,
  };
}

test("observeEvent: idle before any busy does NOT complete the job", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  // stray idle arrives before the opening prompt lands
  await observeEvent({ type: "session.idle", properties: { sessionID: "child" } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.delivered.length, 0);
});

test("observeEvent: busy then idle DOES complete the job as done", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  h.deps.listMessages = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] },
  ];
  h.deps.gitRun = async () => ({ stdout: "" }); // no worktree → filesChanged null
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
  await observeEvent({ type: "session.idle", properties: { sessionID: "child" } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "done");
  assert.equal(h.jobs[0].result, "all done");
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, "parent");
  assert.match(h.delivered[0].text, /\[background job "bg" done\]/);
});

test("observeEvent: session.status idle (not session.idle) also completes after busy", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "done");
});

// ----------------------------------------------------------------------------
// 6. observeEvent: session.error fails the job, MessageAbortedError ignored
// ----------------------------------------------------------------------------

test("observeEvent: session.error fails the job", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  await observeEvent({
    type: "session.error",
    properties: { sessionID: "child", error: { name: "ProviderAuthError", message: "bad key" } },
  }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "failed");
  assert.equal(h.jobs[0].error, "bad key");
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].text, /failed/);
  assert.match(h.delivered[0].text, /Error: bad key/);
});

test("observeEvent: MessageAbortedError is ignored (intentional abort)", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } }, h.deps, sawBusy);
  await observeEvent({
    type: "session.error",
    properties: { sessionID: "child", error: { name: "MessageAbortedError", message: "aborted" } },
  }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.delivered.length, 0);
});

test("observeEvent ignores events for untracked sessions", async () => {
  const h = harness([runningObserverJob()]);
  const sawBusy = new Map();
  await observeEvent({ type: "session.idle", properties: { sessionID: "other" } }, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "running");
});

// ----------------------------------------------------------------------------
// BET-721: background subagent → delegate job adoption
// ----------------------------------------------------------------------------

function adoptHarness(initialJobs = []) {
  const h = harness(initialJobs);
  const newWindowCalls = [];
  let gitAddWorktree = 0;
  h.deps.listProjects = async () => [
    { tmuxSession: "proj", windows: [{ index: 0, opencodeSessionId: "ses_parent", paneCurrentPath: "/repo" }] },
  ];
  h.deps.newWindow = async (input) => {
    newWindowCalls.push(input);
    return {
      sessionId: input.existingSessionId ?? `ses_created_${newWindowCalls.length}`,
      windowIndex: 3,
      projects: [],
    };
  };
  h.deps.gitAddWorktree = async () => {
    gitAddWorktree += 1;
    throw new Error("adoptSubagentJob must never create a worktree");
  };
  h.newWindowCalls = newWindowCalls;
  Object.defineProperty(h, "gitAddWorktreeCalls", {
    get: () => gitAddWorktree,
    enumerable: true,
  });
  return h;
}

const ADOPT_INPUT = {
  parentSessionID: "ses_parent",
  parentDirectory: "/repo",
  childSessionID: "ses_child",
  name: "explore",
  prompt: "go explore",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
};

test("adoptSubagentJob adopts a window with existingSessionId, no worktree, origin subagent", async () => {
  const a = adoptHarness();
  const res = await adoptSubagentJob(ADOPT_INPUT, a.deps);
  assert.equal(res.ok, true);
  assert.equal(a.newWindowCalls.length, 1);
  assert.equal(a.newWindowCalls[0].existingSessionId, "ses_child");
  assert.equal(a.gitAddWorktreeCalls, 0, "no worktree is created");
  const stored = a.jobs[0];
  assert.equal(stored.childSessionID, "ses_child");
  assert.equal(stored.worktree, null);
  assert.equal(stored.branch, null);
  assert.equal(stored.baseSha, null);
  assert.equal(stored.origin, "subagent");
  assert.equal(stored.status, "running");
});

test("adoptSubagentJob never delivers the opening prompt", async () => {
  const a = adoptHarness();
  await adoptSubagentJob(ADOPT_INPUT, a.deps);
  assert.equal(a.delivered.length, 0);
});

test("adoptSubagentJob is idempotent for the same childSessionID", async () => {
  const a = adoptHarness();
  const first = await adoptSubagentJob(ADOPT_INPUT, a.deps);
  assert.equal(first.ok, true);
  const second = await adoptSubagentJob(ADOPT_INPUT, a.deps);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyAdopted, true);
  assert.equal(a.newWindowCalls.length, 1, "newWindow called only once");
  assert.equal(a.jobs.length, 1);
});

test("adoptSubagentJob ignores the running cap and the no-nesting rule", async () => {
  const atCap = adoptHarness(Array.from({ length: MAX_RUNNING_JOBS }, (_, i) => runningJob(i)));
  const resCap = await adoptSubagentJob(
    { ...ADOPT_INPUT, childSessionID: "ses_capchild" },
    atCap.deps,
  );
  assert.equal(resCap.ok, true, "adopts even at the running cap");
  assert.equal(
    atCap.jobs.filter((j) => j.status === "running").length,
    MAX_RUNNING_JOBS + 1,
  );

  // Parent is itself a running job's child → startJob would refuse nesting, but adoption allows it.
  const nestedParent = runningJob(0).childSessionID; // e.g. "child0"
  const nested = adoptHarness([runningJob(0)]);
  nested.deps.listProjects = async () => [
    { tmuxSession: "proj", windows: [{ index: 0, opencodeSessionId: nestedParent, paneCurrentPath: "/repo" }] },
  ];
  const resNested = await adoptSubagentJob(
    { ...ADOPT_INPUT, parentSessionID: nestedParent, childSessionID: "ses_nestedchild" },
    nested.deps,
  );
  assert.equal(resNested.ok, true, "adopts even when the parent is a running job's child");
});

function backgroundPart(overrides = {}) {
  return {
    type: "tool",
    tool: "task",
    state: {
      status: "running",
      input: { subagent_type: "explore", description: "go explore", prompt: "go explore" },
      metadata: { sessionId: "ses_child", background: true },
    },
    ...overrides,
  };
}

test("observeEvent adopts a running background:true subagent from a message.part.updated", async () => {
  const a = adoptHarness();
  const part = backgroundPart({
    state: {
      ...backgroundPart().state,
      metadata: {
        sessionId: "ses_child",
        background: true,
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      },
    },
  });
  const evt = { type: "message.part.updated", properties: { sessionID: "ses_parent", part } };
  await observeEvent(evt, a.deps, new Map());
  assert.equal(a.jobs.length, 1);
  assert.equal(a.jobs[0].childSessionID, "ses_child");
  assert.equal(a.jobs[0].origin, "subagent");
  assert.equal(a.jobs[0].status, "running");
  assert.equal(a.newWindowCalls[0].existingSessionId, "ses_child");
  assert.equal(
    a.jobs[0].model,
    "anthropic/claude-haiku-4-5",
    "adoption persists model as the canonical string, never an object",
  );
});

test("observeEvent adopts nothing when background is absent from the part", async () => {
  const a = adoptHarness();
  const part = backgroundPart();
  delete part.state.metadata.background;
  const evt = { type: "message.part.updated", properties: { sessionID: "ses_parent", part } };
  await observeEvent(evt, a.deps, new Map());
  assert.equal(a.jobs.length, 0);
  assert.equal(a.newWindowCalls.length, 0);
});

test("observeEvent adopts nothing for a completed background task", async () => {
  const a = adoptHarness();
  const evt = { type: "message.part.updated", properties: { sessionID: "ses_parent", part: backgroundPart({ state: { ...backgroundPart().state, status: "completed" } }) } };
  await observeEvent(evt, a.deps, new Map());
  assert.equal(a.jobs.length, 0);
  assert.equal(a.newWindowCalls.length, 0);
});

// ----------------------------------------------------------------------------
// effectiveModelFromMessages + tickActivity model stamping (BET-801)
// ----------------------------------------------------------------------------

function modelMessage(providerID, modelID) {
  return { info: { providerID, modelID }, parts: [] };
}

test("effectiveModelFromMessages returns the LAST model-bearing message's providerID/modelID", () => {
  const messages = [
    modelMessage("anthropic", "claude-opus-5"),
    { info: {}, parts: [] },
    modelMessage("anthropic", "claude-sonnet-4-6"),
    modelMessage("deepseek", "deepseek-chat"),
  ];
  assert.equal(effectiveModelFromMessages(messages), "deepseek/deepseek-chat");
});

test("effectiveModelFromMessages returns null for [], non-array, and messages without a model", () => {
  assert.equal(effectiveModelFromMessages([]), null);
  assert.equal(effectiveModelFromMessages(undefined), null);
  assert.equal(effectiveModelFromMessages("nope"), null);
  assert.equal(effectiveModelFromMessages(null), null);
  const noModel = [
    { info: { role: "user" }, parts: [] },
    { info: { providerID: "anthropic" }, parts: [] }, // only providerID
  ];
  assert.equal(effectiveModelFromMessages(noModel), null);
});

test("tickActivity stamps job.model from the transcript and publishes delegate.updated exactly once", async () => {
  const running = runningJob(0);
  running.model = null;
  running.activity = null;
  const h = harness([running]);
  h.deps.listMessages = async () => [
    modelMessage("anthropic", "claude-opus-5"),
    modelMessage("anthropic", "claude-sonnet-4-6"), // last → stripes model
  ];
  await tickActivity(h.deps);
  assert.equal(h.jobs[0].model, "anthropic/claude-sonnet-4-6");
  const modelPublishes = h.published.filter((p) => p.kind === "delegate.updated");
  assert.equal(modelPublishes.length, 1, "single delegate.updated for a both-changed tick");
  assert.equal(modelPublishes[0].payload.id, running.id);
  assert.equal(modelPublishes[0].payload.status, "running");
  assert.notEqual(h.jobs[0].activity, null, "activity changed too in this tick");
});

test("tickActivity does NOT publish when neither activity nor model changed", async () => {
  const running = runningJob(0);
  running.model = null;
  running.activity = null;
  const h = harness([running]);
  h.deps.listMessages = async () => [modelMessage("anthropic", "claude-sonnet-4-6")];
  await tickActivity(h.deps);
  assert.equal(h.published.length, 1, "first tick stamps model + activity");
  h.published.length = 0;
  await tickActivity(h.deps);
  assert.equal(h.published.length, 0, "second tick with nothing changed does not publish");
  assert.equal(h.jobs[0].model, "anthropic/claude-sonnet-4-6");
});


// several events per turn boundary and the pump calls observeEvent without
// awaiting it, so two invocations are in flight at once. Without per-session
// serialisation each read-store -> decide -> write-store sequence interleaves
// with itself: one subagent is adopted twice (two windows + two records) and
// one job reports completion twice. These tests go through createDelegateEngine
// so they exercise the serialising wrapper, not the raw observeEvent.
// ----------------------------------------------------------------------------

test("BET-773: two identical adoption events produce exactly one window + one record", async () => {
  const a = adoptHarness();
  const engine = createDelegateEngine(a.deps);
  const evt = { type: "message.part.updated", properties: { sessionID: "ses_parent", part: backgroundPart() } };
  // Fire both without awaiting the first — the overlapping case.
  await Promise.all([engine.observeEvent(evt), engine.observeEvent(evt)]);
  assert.equal(a.newWindowCalls.length, 1, "newWindow called exactly once");
  assert.equal(a.jobs.length, 1, "store holds exactly one record");
  assert.equal(a.jobs[0].origin, "subagent");
});

test("BET-773: overlapping session.status{idle} and session.idle deliver the completion exactly once", async () => {
  const h = harness([runningObserverJob()]);
  h.deps.listMessages = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] },
  ];
  h.deps.gitRun = async () => ({ stdout: "" });
  const engine = createDelegateEngine(h.deps);
  // Prime the engine's own sawBusy for the child session via a busy event.
  await engine.observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } });
  // Both terminal triggers fire overlapping.
  await Promise.all([
    engine.observeEvent({ type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } }),
    engine.observeEvent({ type: "session.idle", properties: { sessionID: "child" } }),
  ]);
  assert.equal(h.delivered.length, 1, "deliver called exactly once");
  const terminal = h.jobs.filter((j) => j.status === "done");
  assert.equal(terminal.length, 1, "store holds exactly one terminal record");
});

test("BET-773: events for different sessions are not serialised behind each other", async () => {
  const h = harness();
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  let loadCalls = 0;
  h.deps.load = async () => {
    loadCalls += 1;
    if (loadCalls === 1) {
      // The first event (session A) blocks on a gate until explicitly released.
      await gateA;
    }
    return [];
  };
  const engine = createDelegateEngine(h.deps);
  const a = engine.observeEvent({ type: "session.idle", properties: { sessionID: "A" } });
  // Give A time to enter its blocking load before B arrives.
  await new Promise((r) => setTimeout(r, 10));
  let bResolved = false;
  const b = engine.observeEvent({ type: "session.idle", properties: { sessionID: "B" } }).then(() => {
    bResolved = true;
  });
  // If B were queued behind A (a global chain), it could not resolve until A is
  // released. Per-session serialisation lets B run immediately.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bResolved, true, "session B processes without waiting for session A");
  releaseA();
  await Promise.all([a, b]);
});


test("finishJob does not deliver for origin subagent, but still does for delegate and legacy", async () => {
  const sub = harness([{ ...runningObserverJob(), id: "sub", worktree: null, origin: "subagent" }]);
  await finishJob(sub.jobs[0], "done", null, sub.deps, new Map());
  assert.equal(sub.delivered.length, 0, "opencode already injects the <task> result for adopted subagents");

  for (const job of [
    { ...runningObserverJob(), id: "del", worktree: null, origin: "delegate" },
    { ...runningObserverJob(), id: "legacy", worktree: null }, // no origin field (pre-change record)
  ]) {
    const h = harness([job]);
    await finishJob(h.jobs[0], "done", null, h.deps, new Map());
    assert.equal(h.delivered.length, 1, `delivers for ${job.id}`);
  }
});

// ----------------------------------------------------------------------------
// 9. Sweeper marks a 31-minute-old running job failed, leaves worktree intact
// ----------------------------------------------------------------------------

test("sweeper marks a 31-minute-old running job failed with the timeout error", async () => {
  const started = 1_700_000_000_000;
  const h = harness([{
    ...runningObserverJob(),
    id: "old", startedAt: started, worktree: "/repo/wt-old", branch: "old",
    baseSha: "abc",
  }], started + 31 * 60_000); // 31 minutes later
  h.deps.gitRun = async () => ({ stdout: "" });
  await sweepDelegateJobs(h.deps);
  assert.equal(h.jobs[0].status, "failed");
  assert.equal(h.jobs[0].error, "timed out after 30 minutes");
  // worktree field left intact (sweeper NEVER removes the worktree)
  assert.equal(h.jobs[0].worktree, "/repo/wt-old");
  assert.equal(h.jobs[0].branch, "old");
  // completion delivered to parent
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0].text, /timed out after 30 minutes/);
});

test("sweeper leaves a job younger than 30 minutes running", async () => {
  const started = 1_700_000_000_000;
  const h = harness([{
    ...runningObserverJob(), id: "young", startedAt: started,
  }], started + 10 * 60_000);
  await sweepDelegateJobs(h.deps);
  assert.equal(h.jobs[0].status, "running");
  assert.equal(h.delivered.length, 0);
});

// ----------------------------------------------------------------------------
// 10. deleteJob on a dirty worktree keeps worktree + record, reports dirty
// ----------------------------------------------------------------------------

test("deleteJob on a dirty worktree keeps the worktree and the record", async () => {
  const job = {
    ...runningObserverJob(), id: "d1", status: "done",
    worktree: "/repo/wt-dirty", branch: "dirty", finishedAt: 2,
    tmuxSession: "s", windowIndex: 3,
  };
  const h = harness([job]);
  const killed = [];
  h.deps.killWindow = async (input) => { killed.push(input); };
  h.deps.gitRemoveWorktree = async () => ({ removed: false, reason: "dirty" });

  const res = await deleteJob("d1", h.deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "dirty");
  // window was killed (best-effort) ...
  assert.equal(killed.length, 1);
  // ... but the worktree removal refused, so the record MUST be kept
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].id, "d1");
  assert.equal(h.jobs[0].worktree, "/repo/wt-dirty");
});

test("deleteJob removes the record when the worktree removes cleanly", async () => {
  const job = {
    ...runningObserverJob(), id: "d2", status: "done",
    worktree: "/repo/wt-clean", branch: "clean", finishedAt: 2,
    tmuxSession: "s", windowIndex: 4,
  };
  const h = harness([job]);
  h.deps.killWindow = async () => {};
  h.deps.gitRemoveWorktree = async () => ({ removed: true });
  const res = await deleteJob("d2", h.deps);
  assert.equal(res.ok, true);
  assert.equal(h.jobs.length, 0);
  assert.ok(h.published.some((e) => e.payload?.id === "d2" && e.payload?.status === "deleted"));
});

test("deleteJob on a job with no worktree just drops the record", async () => {
  const job = { ...runningObserverJob(), id: "d3", status: "done", worktree: null, finishedAt: 2 };
  const h = harness([job]);
  h.deps.killWindow = async () => {};
  const res = await deleteJob("d3", h.deps);
  assert.equal(res.ok, true);
  assert.equal(h.jobs.length, 0);
});

test("deleteJob returns not-found for an unknown id", async () => {
  const h = harness([]);
  h.deps.killWindow = async () => {};
  const res = await deleteJob("nope", h.deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, "not found");
});

// ----------------------------------------------------------------------------
// startJob happy path (no worktree) persists + delivers the opening prompt
// ----------------------------------------------------------------------------

test("startJob happy path (non-git cwd) persists a running job and delivers the prompt", async () => {
  const h = harness([]);
  h.deps.gitAddWorktree = async () => { throw new Error("not a git repository"); };
  const parentWin = { index: 1, name: "parent-h", opencodeSessionId: "parent-h", paneCurrentPath: "/repo" };
  const childWin = { index: 2, name: "fix-the-login-bug", opencodeSessionId: "child-h", paneCurrentPath: "/repo" };
  h.deps.listProjects = async () => [{ tmuxSession: "proj", windows: [parentWin] }];
  h.deps.newWindow = async (input) => ({
    sessionId: "child-h",
    windowIndex: 2,
    projects: [{ tmuxSession: input.sessionName, windows: [parentWin, childWin] }],
  });
  const res = await startJob(
    { prompt: "Fix the login bug please", parentSessionID: "parent-h", parentDirectory: "/repo" },
    h.deps,
  );
  assert.equal(res.ok, true);
  assert.equal(res.job.name, "fix-the-login-bug");
  assert.equal(res.job.worktree, null);
  assert.equal(res.job.branch, null);
  assert.equal(res.job.baseSha, null);
  assert.equal(res.job.childSessionID, "child-h");
  assert.equal(res.job.status, "running");
  assert.equal(h.jobs.length, 1);
  // opening prompt delivered to the child session
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, "child-h");
  assert.match(h.delivered[0].text, /Fix the login bug please/);
  assert.doesNotMatch(h.delivered[0].text, /git worktree/);
});

// ----------------------------------------------------------------------------
// finishJob filesChanged counts committed + uncommitted (with a worktree)
// ----------------------------------------------------------------------------

test("finishJob counts committed + uncommitted files when a worktree exists", async () => {
  const job = {
    ...runningObserverJob(), id: "fc", worktree: "/repo/wt", branch: "b", baseSha: "sha1",
  };
  const h = harness([job]);
  const sawBusy = new Map();
  h.deps.listMessages = async () => [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
  ];
  h.deps.gitRun = async (args) => {
    if (args.includes("diff")) return { stdout: "a.ts\nb.ts\n" }; // 2 committed
    if (args.includes("status")) return { stdout: " M c.ts\n?? d.ts\n" }; // 2 uncommitted
    return { stdout: "" };
  };
  await finishJob(job, "done", null, h.deps, sawBusy);
  assert.equal(h.jobs[0].status, "done");
  assert.equal(h.jobs[0].result, "done");
  assert.equal(h.jobs[0].filesChanged, 4);
});

test("finishJob is idempotent for an already-terminal job", async () => {
  const job = { ...runningObserverJob(), id: "idem", status: "done", finishedAt: 9 };
  const h = harness([job]);
  const res = await finishJob(job, "done", null, h.deps, new Map());
  assert.equal(res.ok, true);
  assert.equal(res.alreadyTerminal, true);
  assert.equal(h.delivered.length, 0);
});


// ----------------------------------------------------------------------------
// buildPermissionRuleset (BET-418 §A)
// ----------------------------------------------------------------------------

// REGRESSION (verified against live opencode v1.15.12): opencode resolves this
// list LAST-MATCH-WINS. The catch-all deny therefore has to sit FIRST, under
// the grants. When it was appended last it matched every call and beat every
// allow, so a delegated job could not run a single tool it had been granted:
//   [bash ** allow, * ** deny] → bash DENIED
//   [* ** deny, bash ** allow] → bash COMPLETED
test("buildPermissionRuleset puts the catch-all deny FIRST, under the grants", () => {
  const rs = buildPermissionRuleset([
    { permission: "bash", pattern: "pytest *" },
    { permission: "write", pattern: "**/*.ts" },
  ]);
  assert.deepEqual(rs, [
    { permission: "*", pattern: "**", action: "deny" },
    { permission: "bash", pattern: "pytest *", action: "allow" },
    { permission: "write", pattern: "**/*.ts", action: "allow" },
  ]);
  assert.equal(rs[0].action, "deny", "catch-all deny MUST be FIRST (last-match-wins)");
  assert.ok(
    rs.slice(1).every((r) => r.action === "allow"),
    "every grant must come AFTER the catch-all so it can override it",
  );
});

test("buildPermissionRuleset with no tools still applies the catch-all deny (job asks nothing, denies everything)", () => {
  const rs = buildPermissionRuleset([]);
  assert.deepEqual(rs, [{ permission: "*", pattern: "**", action: "deny" }]);
});

test("buildPermissionRuleset de-dups identical rules and defaults action to allow", () => {
  const rs = buildPermissionRuleset([
    { permission: "bash", pattern: "pytest *" },
    { permission: "bash", pattern: "pytest *" },
    { permission: "bash", pattern: "rm *", action: "deny" },
  ]);
  assert.equal(rs.length, 3, "catch-all + one de-duped allow + one explicit deny");
  assert.equal(rs[0].action, "deny", "catch-all first");
  assert.equal(rs[1].action, "allow");
  assert.equal(rs[2].action, "deny");
});

// BET-418 §A acceptance: a job whose ruleset omits `bash` must FAIL its first
// command, not stall. The ruleset has no bash-allow rule, so opencode resolves
// the bash tool against the catch-all deny and rejects it immediately — there
// is no `ask` path to hang on. This test pins the ruleset shape that produces
// that behavior (the live opencode denial is an integration concern).
test("a ruleset omitting bash has no bash-allow rule (command fails, no hang)", () => {
  const rs = buildPermissionRuleset([
    { permission: "write", pattern: "**/*.ts" },
  ]);
  const bashAllow = rs.find((r) => r.permission === "bash" && r.action === "allow");
  assert.equal(bashAllow, undefined, "no bash-allow rule — bash hits the catch-all deny");
  assert.equal(rs[0].action, "deny", "catch-all deny is the floor, and nothing lifts bash off it");
});

// ----------------------------------------------------------------------------
// createApprovalState (BET-418 §A)
// ----------------------------------------------------------------------------

test("approval awaitDecision resolves on approve with edited tools", async () => {
  const state = createApprovalState({ now: () => 1000 });
  const a = state.create({ parentSessionID: "ses_p", name: "fix", prompt: "do it", tools: [{ permission: "bash", pattern: "pytest *" }] });
  const p = state.awaitDecision(a.id, 10_000);
  assert.ok(state.resolve(a.id, "approve", [{ permission: "bash", pattern: "pytest * -x" }]));
  const res = await p;
  assert.equal(res.decision, "approve");
  assert.deepEqual(res.tools, [{ permission: "bash", pattern: "pytest * -x" }]);
  assert.equal(state.list().length, 0, "approval cleared after resolve");
});

test("approval awaitDecision resolves as declined on decline", async () => {
  const state = createApprovalState({ now: () => 1000 });
  const a = state.create({ parentSessionID: "ses_p", name: "fix", prompt: "do it", tools: [] });
  const p = state.awaitDecision(a.id, 10_000);
  state.resolve(a.id, "declined");
  const res = await p;
  assert.equal(res.decision, "declined");
});

test("approval awaitDecision resolves as timeout when nobody answers", async () => {
  const state = createApprovalState({ now: () => 1000 });
  const a = state.create({ parentSessionID: "ses_p", name: "fix", prompt: "do it", tools: [] });
  const res = await state.awaitDecision(a.id, 50);
  assert.equal(res.decision, "timeout");
  assert.equal(state.list().length, 0, "approval cleared after timeout");
});

test("approval list filters by parent session", () => {
  const state = createApprovalState({ now: () => 1000 });
  state.create({ parentSessionID: "ses_a", name: "a", prompt: "a", tools: [] });
  state.create({ parentSessionID: "ses_b", name: "b", prompt: "b", tools: [] });
  assert.equal(state.list("ses_a").length, 1);
  assert.equal(state.list("ses_a")[0].name, "a");
  assert.equal(state.list().length, 2);
});

// ----------------------------------------------------------------------------
// createDelegateEngine.startJobWithApproval (BET-418 §A)
// ----------------------------------------------------------------------------

function approvalEngineHarness(initialJobs = []) {
  let jobs = initialJobs.map((j) => ({ ...j }));
  const published = [];
  const newWindowCalls = [];
  const createSessionCalls = [];
  const parentWin = { index: 1, name: "parent", opencodeSessionId: "ses_p", paneCurrentPath: "/proj" };
  const childWin = { index: 2, name: "run-the-tests", opencodeSessionId: "ses_child", paneCurrentPath: "/proj" };
  const deps = {
    load: async () => jobs.map((j) => ({ ...j })),
    save: async (next) => { jobs = next.map((j) => ({ ...j })); },
    publish: (evt) => published.push(evt),
    deliver: async () => ({ delivered: true, queued: false }),
    listMessages: async () => [],
    gitRun: async () => ({ stdout: "" }),
    gitAddWorktree: async () => { throw new Error("not a git repository"); },
    gitRemoveWorktree: async () => ({ removed: true }),
    killWindow: async () => {},
    listProjects: async () => [{ tmuxSession: "proj", windows: [parentWin] }],
    newWindow: async (input) => {
      newWindowCalls.push(input);
      return {
        sessionId: "ses_child",
        windowIndex: 2,
        projects: [{ tmuxSession: input.sessionName, windows: [parentWin, { ...childWin, name: input.windowName }] }],
      };
    },
    oc: {
      createSession: async (input) => {
        createSessionCalls.push(input);
        return { id: "ses_child", directory: input?.directory };
      },
    },
    now: () => 1_700_000_000_000,
  };
  const engine = createDelegateEngine(deps);
  return { engine, published, get jobs() { return jobs; }, newWindowCalls, createSessionCalls };
}

test("startJobWithApproval auto-approves (no card) when trust mode is on", async () => {
  const h = approvalEngineHarness([]);
  const res = await h.engine.startJobWithApproval({
    prompt: "run the tests",
    parentSessionID: "ses_p",
    parentDirectory: "/proj",
    tools: [{ permission: "bash", pattern: "pytest *" }],
    trustMode: true,
  });
  assert.equal(res.ok, true);
  assert.equal(h.published.find((e) => e.kind === "delegate.approval.requested"), undefined, "no approval requested in trust mode");
});

test("startJobWithApproval requests approval + declines when the user says Not now", async () => {
  const h = approvalEngineHarness([]);
  const p = h.engine.startJobWithApproval({
    prompt: "run the tests",
    parentSessionID: "ses_p",
    parentDirectory: "/proj",
    tools: [{ permission: "bash", pattern: "pytest *" }],
    trustMode: false,
  });
  // The approval request was published.
  const req = h.published.find((e) => e.kind === "delegate.approval.requested");
  assert.ok(req, "approval requested");
  // User declines.
  assert.ok(h.engine.decline(req.payload.id));
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.error, "declined");
});

test("startJobWithApproval starts the job on approve and forwards the ruleset", async () => {
  const h = approvalEngineHarness([]);
  const p = h.engine.startJobWithApproval({
    prompt: "run the tests",
    parentSessionID: "ses_p",
    parentDirectory: "/proj",
    tools: [{ permission: "bash", pattern: "pytest *" }],
    trustMode: false,
  });
  const req = h.published.find((e) => e.kind === "delegate.approval.requested");
  // User approves with edited tools.
  assert.ok(h.engine.approve(req.payload.id, [{ permission: "bash", pattern: "pytest * -x" }]));
  const res = await p;
  assert.equal(res.ok, true);
  // newWindow received the ruleset: catch-all deny FIRST, then the approved
  // grant — the order that actually lets the grant take effect (last-match-wins).
  const perm = h.newWindowCalls[0]?.permission;
  assert.ok(Array.isArray(perm));
  assert.deepEqual(perm[0], { permission: "*", pattern: "**", action: "deny" });
  assert.equal(perm[1].permission, "bash");
  assert.equal(perm[1].pattern, "pytest * -x");
});

// ----------------------------------------------------------------------------
// §A4 deeper test — a job whose ruleset omits bash FAILS its first command,
// not stalls. Simulates the deny→fail path through the mocked oc layer:
//   1. start a job with tools that omit bash (ruleset has no bash-allow).
//   2. assert the catch-all deny reached oc.createSession (opencode WILL deny
//      an unmatched bash tool, never resolve it to `ask`).
//   3. simulate the denial as opencode would surface it — a session.error
//      event for the child session — and assert observeEvent completes the
//      job as `failed` immediately (no hang, no 30-min timeout).
// This bridges the gap the reviewer flagged: it observes the OUTCOME (job
// fails fast), not just the ruleset SHAPE.
// ----------------------------------------------------------------------------

test("§A4: a job omitting bash receives the catch-all deny at the session-creation boundary and fails fast on a denied command", async () => {
  const h = approvalEngineHarness([]);
  const res = await h.engine.startJobWithApproval({
    prompt: "edit the docs",
    parentSessionID: "ses_p",
    parentDirectory: "/proj",
    tools: [{ permission: "write", pattern: "**/*.md" }], // NO bash-allow
    trustMode: true, // skip the card; we are testing the ruleset, not approval
  });
  assert.equal(res.ok, true);

  // 1. The ruleset reached the session-creation boundary (newWindow forwards
  //    it to maybeCreateChatSession → oc.createSession in production). The
  //    harness intercepts at newWindow, so assert there.
  assert.equal(h.newWindowCalls.length, 1);
  const perm = h.newWindowCalls[0].permission;
  assert.ok(Array.isArray(perm), "the permission ruleset was forwarded to session creation");
  const bashAllow = perm.find((r) => r.permission === "bash" && r.action === "allow");
  assert.equal(bashAllow, undefined, "no bash-allow rule — bash hits the catch-all deny");
  assert.deepEqual(perm[0], { permission: "*", pattern: "**", action: "deny" });

  // 2. Simulate opencode denying the job's first bash command. opencode
  //    surfaces a tool denial as a session.error (the job's turn aborts); the
  //    engine's observeEvent must transition the job to `failed` immediately.
  const before = h.jobs[0].status;
  assert.equal(before, "running");
  await h.engine.observeEvent({
    type: "session.error",
    properties: {
      sessionID: "ses_child",
      error: { name: "PermissionDeniedError", message: "bash denied by ruleset" },
    },
  });
  const after = h.jobs[0];
  assert.equal(after.status, "failed", "job fails fast — does NOT stall for the 30-min timeout");
  assert.match(after.error ?? "", /denied|bash/i, "failure reason reflects the denial");
});

// ----------------------------------------------------------------------------
// Progress exposure (BET-790 §5): a job's list/get carries the child's live
// progress record, from the SAME progress store delegate reads — no second
// store/event.
// ----------------------------------------------------------------------------

test("listJobs attaches the child's progress record to the job (BET-790)", async () => {
  const h = harness([
    {
      id: "job1",
      name: "Job one",
      parentSessionID: "parent1",
      childSessionID: "child1",
      status: "running",
      activity: null,
    },
    {
      id: "job2",
      name: "Job two",
      parentSessionID: "parent1",
      childSessionID: "child2",
      status: "running",
      activity: null,
    },
  ]);
  // Injected progress reader: child2 reported step 3/5; child1 never reported.
  const readProgress = async (sid) =>
    sid === "child2" ? { sessionID: "child2", label: "step 3 of 5", step: 3, total: 5, state: "working", detail: "", updatedAt: 1 } : null;

  const scoped = await listJobs({ sessionID: "parent1" }, { load: h.deps.load, readProgress });
  assert.equal(scoped.length, 2);
  const job2 = scoped.find((j) => j.id === "job2");
  assert.equal(job2.progress.label, "step 3 of 5");
  const job1 = scoped.find((j) => j.id === "job1");
  assert.equal(job1.progress, null);
});

test("finishJob clears the child's progress record (BET-790)", async () => {
  const h = harness([
    {
      id: "job1",
      name: "Job one",
      parentSessionID: "parent1",
      childSessionID: "child1",
      status: "running",
      activity: null,
    },
  ]);
  const cleared = [];
  h.deps.clearProgress = async (sid) => { cleared.push(sid); return { ok: true, deleted: true }; };
  await finishJob(h.jobs[0], "done", null, h.deps, new Map());
  assert.deepEqual(cleared, ["child1"]);
});
