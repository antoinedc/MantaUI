// Agent screens, server side (docs/superpowers/specs/2026-11-26-agents-screens.md §5, §6): the change store's retention,
// history + restore, seats, the fleet read model, needs-you, recap, the profile and the refresh routine's provisioning.
// A real temp folder stands in for ~/.manta/agents; opencode, tmux, the delegate, routines and the library are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "../shared/autonomyShared.mjs";
import { createAgentsEngine, pruneChangeRecords, fleetRecap, refreshDay, AgentError, CHANGE_KEEP_MS, CHANGE_MAX, AGENT_CHANGE_OFF, AGENTS_TMUX_SESSION } from "./agents.mjs";
import { fakeConfigWriter } from "./fixtures/agentConfigFake.mjs";

const REAL_TEMPLATES = fileURLToPath(new URL("./agentTemplates", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-25T12:00:00Z"); // a Wednesday

const DEV_V1 = "---\nname: Dev\ndescription: Writes code.\nisolation: worktree\n---\nDev prompt one.\n";
const DEV_V2 = "---\nname: Dev\ndescription: Writes code.\nisolation: worktree\n---\nDev prompt two.\n";

/** A box: the built-in Manta, Architect and Dev (in a temp folder), an engine over it and every fake a test may steer. */
async function fixture({ extra = {}, level = "auto", templates = ["dev", "manta", "architect"] } = {}) {
  const base = await mkdtemp(join(tmpdir(), "agents-screens-"));
  const root = join(base, "agents");
  const templatesDir = join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  for (const t of templates) await cp(join(REAL_TEMPLATES, t), join(templatesDir, t), { recursive: true });
  const w = {
    clock: T0,
    level,
    jobs: [],
    pubs: [],
    startJobs: [],
    startResult: { ok: true, job: { id: "job_new" } },
    newSessions: [],
    windows: [],
    tmuxProjects: [],
    registry: [
      { slug: "site-aaaaaaaaaa", displayName: "Site" },
      { slug: "api-bbbbbbbbbb", displayName: "API" },
    ],
    dirs: { "/repo/site": "site-aaaaaaaaaa", "/repo/api": "api-bbbbbbbbbb" },
    open: new Map(), // rootJobId → count of open questions
    openQuestions: [],
    pages: { "site-aaaaaaaaaa": 12 },
    sharing: { "site-aaaaaaaaaa": "share-and-read", "api-bbbbbbbbbb": "private" },
    routines: new Map(),
    routineCalls: [],
    library: [],
    used: {},
    scan: (text) => !text.includes("hunter2secret"),
  };
  const config = { cfg: { agent: {} }, edits: [], reloads: 0 };
  const make = (over = {}) =>
    createAgentsEngine({
      root,
      templatesDir,
      home: "/h",
      now: () => w.clock,
      isGitRepo: async () => true,
      editConfig: fakeConfigWriter(config),
      reload: async () => ({ ok: true, reloaded: true }),
      log: { warn: () => {} },
      retryDelayMs: 0,
      autonomyPolicy: async () => ({ ...MODES.balanced, agent_change: w.level }),
      publish: (p) => w.pubs.push(p),
      oc: { listMessages: async () => [], readSession: async () => ({ state: "found", session: { id: "ses", directory: "/repo/site" } }) },
      delegate: {
        startJob: async (i) => (w.startJobs.push(i), w.startResult),
        loadRecords: async () => w.jobs,
        loadRecordsStrict: async () => w.jobs,
      },
      tmux: {
        listProjects: async () => w.tmuxProjects,
        newSession: async (i) => (w.newSessions.push(i), (w.tmuxProjects = [{ tmuxSession: i.name, windows: [] }]), { windowIndex: 0 }),
        newWindow: async (i) => (w.windows.push(i), { windowIndex: 1 }),
      },
      registry: {
        identify: async (dir) => (w.dirs[dir] ? { slug: w.dirs[dir] } : null),
        list: async () => w.registry,
      },
      sharingOf: async (slug) => w.sharing[slug] ?? "private",
      countProjectPages: async (slug) => w.pages[slug] ?? null,
      taskQuestions: {
        hasOpen: (root) => (w.open.get(root) ?? 0) > 0,
        openCountFor: (root) => w.open.get(root) ?? 0,
        listOpen: async ({ sessionID } = {}) => w.openQuestions.filter((q) => sessionID === undefined || q.parentSessionID === sessionID),
        answer: async (id, answers) => ({ ok: true, question: { id, answers } }),
        dismiss: async (id) => ({ ok: true, question: { id } }),
      },
      library: {
        lookup: async ({ refs }) => refs.map((ref) => ({ ref, entry: w.library.find((e) => e.id === ref || e.topic === ref) ?? null })),
        usedBy: async (rootJobId) => w.used[rootJobId] ?? [],
      },
      routines: {
        createInternal: async (input) => {
          w.routineCalls.push(["create", input]);
          const id = `rt${w.routines.size + 1}`;
          w.routines.set(id, { id, enabled: true, ...input });
          return w.routines.get(id);
        },
        update: async (id, patch) => {
          w.routineCalls.push(["update", id, patch]);
          if (!w.routines.has(id)) throw Object.assign(new Error("That routine no longer exists."), { rpcStatus: 404 });
          Object.assign(w.routines.get(id), patch);
          return w.routines.get(id);
        },
        remove: async (id) => (w.routineCalls.push(["remove", id]), { deleted: w.routines.delete(id) }),
        get: async (id) => {
          if (!w.routines.has(id)) throw Object.assign(new Error("That routine no longer exists."), { rpcStatus: 404 });
          return { routine: w.routines.get(id), memory: "", runs: [] };
        },
      },
      loadSecretsStrict: async () => [],
      createScanner: () => ({ scan: async (text) => ({ clean: w.scan(text), unavailable: false, hits: [] }) }),
      ...over,
    });
  return {
    base,
    root,
    w,
    config,
    make,
    engine: make(extra),
    store: async () => JSON.parse(await readFile(join(root, ".changes.json"), "utf-8")),
    putChanges: (changes) => writeFile(join(root, ".changes.json"), JSON.stringify({ version: 2, changes, proposalSlots: {} })),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

let n = 0;
const change = (over = {}) => ({
  id: `ach_${++n}`,
  kind: "update",
  slug: "dev",
  agentName: "Dev",
  sessionID: "ses_chat",
  messageID: "msg",
  callID: "call",
  state: "applied",
  needsClick: false,
  reason: null,
  before: DEV_V1,
  after: DEV_V2,
  createdAt: T0 - DAY,
  decidedAt: T0 - DAY,
  error: null,
  ...over,
});

// ---------------------------------------------------------------------------
// retention: the exact prune set and eviction rank (§5.2)
// ---------------------------------------------------------------------------

test("prune: only discarded, expired and conflict records leave by age; undone, applied, pending and failed stay", () => {
  const old = T0 - CHANGE_KEEP_MS - DAY;
  const list = ["discarded", "expired", "conflict", "undone", "applied", "failed", "pending", "held"].map((state) => change({ id: state, state, createdAt: old, decidedAt: old, releasedAt: T0 }));
  const kept = pruneChangeRecords(list, T0).map((r) => r.id);
  assert.deepEqual(kept.sort(), ["applied", "failed", "held", "pending", "undone"].sort());
  // a record exactly at the limit stays; one just over it goes
  const edge = change({ id: "edge", state: "discarded", decidedAt: T0 - CHANGE_KEEP_MS });
  const over = change({ id: "over", state: "discarded", decidedAt: T0 - CHANGE_KEEP_MS - 1 });
  assert.deepEqual(pruneChangeRecords([edge, over], T0).map((r) => r.id), ["edge"]);
  // an unclicked proposal past its window becomes expired, and then ages out like any expired one
  const stale = change({ id: "stale", state: "pending", needsClick: true, reason: "ask", createdAt: T0 - 2 * DAY, releasedAt: T0 - 2 * DAY, decidedAt: null });
  assert.equal(pruneChangeRecords([stale], T0)[0].state, "expired");
  assert.deepEqual(pruneChangeRecords([stale], T0 + 9 * DAY), []);
});

test(`prune: at the ${CHANGE_MAX} cap the lowest rank goes first (discarded/expired/conflict/unclaimed failed, then undone, then applied, then pending), oldest first within a rank, never a journal record`, () => {
  let t = T0 - 100 * 1000;
  const make = (state, count, extra = {}) => Array.from({ length: count }, (_, i) => change({ id: `${state}${extra.claimed ? "C" : ""}-${i}`, state, createdAt: (t += 1000), decidedAt: T0 - 1000, releasedAt: T0 - 1000, ...extra }));
  const journal = [change({ id: "held-1", state: "held", createdAt: 1 }), change({ id: "applying-1", state: "applying", createdAt: 2 }), ...make("failed", 1, { kind: "create", claimed: true, slug: null })];
  const list = [...make("pending", 10, { needsClick: true, reason: "ask" }), ...make("applied", 100), ...make("undone", 40), ...make("discarded", 30), ...make("failed", 5), ...journal];
  assert.equal(list.length, 188);
  // 201st record: one over the cap evicts the oldest of rank 0 (the first discarded or unclaimed failed)
  const added = [...list, ...make("conflict", 13)];
  assert.equal(added.length, 201);
  const out = pruneChangeRecords(added, T0).map((r) => r.id);
  assert.equal(out.length, CHANGE_MAX);
  const lost = added.map((r) => r.id).filter((id) => !out.includes(id));
  assert.equal(lost.length, 1);
  assert.match(lost[0], /^(discarded|failed|conflict)-/, "a rank-0 record goes first");
  // far over: every rank-0 record goes before any undone one, every undone one before any applied one
  const many = [...list, ...make("conflict", 50)];
  const left = new Set(pruneChangeRecords(many, T0).map((r) => r.id));
  assert.equal(left.size, CHANGE_MAX);
  assert.ok(![...left].some((id) => /^(discarded|conflict)-/.test(id) && false));
  const stillRank0 = [...left].filter((id) => /^(discarded|conflict|failed-)/.test(id) && !id.includes("C-"));
  const undoneLeft = [...left].filter((id) => id.startsWith("undone-"));
  assert.equal(stillRank0.length, 0, "all of rank 0 went (the unclaimed failed ones too)");
  assert.equal(undoneLeft.length, 40, "undone only after rank 0 is gone, and not needed here");
  for (const j of journal) assert.ok(left.has(j.id), `${j.id} is a journal record`);
  // heavier: evicting into the undone rank takes the OLDEST undone first, then applied
  const heavy = [...make("undone", 120), ...make("applied", 100), ...journal];
  const heavyLeft = new Set(pruneChangeRecords(heavy, T0).map((r) => r.id));
  assert.equal(heavyLeft.size, CHANGE_MAX);
  assert.ok(!heavyLeft.has("undone-0") && heavyLeft.has("undone-119"));
  assert.ok(heavyLeft.has("applied-0"), "applied is kept while undone ones can go");
});

// ---------------------------------------------------------------------------
// history (§5.2)
// ---------------------------------------------------------------------------

test("history: the agent's own records, every state, newest first, at most 50; creates once applied; an unclicked proposal reads as expired", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const recs = [
      change({ id: "a1", createdAt: T0 - 5 * DAY, decidedAt: T0 - 5 * DAY }),
      change({ id: "a2", state: "undone", createdAt: T0 - 3 * DAY, decidedAt: T0 - 2 * DAY }),
      change({ id: "other", slug: "scout", agentName: "Scout" }),
      change({ id: "c1", kind: "create", before: null, state: "applied", createdAt: T0 - 9 * DAY, decidedAt: T0 - 9 * DAY }),
      change({ id: "p1", state: "pending", needsClick: true, reason: "ask", createdAt: T0 - 3 * DAY, releasedAt: T0 - 3 * DAY, decidedAt: null }),
      change({ id: "h1", state: "held", createdAt: T0 - DAY, decidedAt: null }),
    ];
    await f.putChanges(recs);
    const h = await f.engine.history("dev");
    assert.deepEqual(h.map((r) => r.id), ["h1", "a2", "p1", "a1", "c1"], "newest first by when it happened; the other agent's record is not here");
    assert.equal(h.find((r) => r.id === "p1").state, "expired");
    assert.equal(h.find((r) => r.id === "a2").state, "undone");
    assert.ok(!("prior" in h[0]) && !("invocation" in h[0]), "the wire shape, not the journal");
    // the cap of 50
    await f.putChanges(Array.from({ length: 60 }, (_, i) => change({ id: `x${i}`, createdAt: T0 - i * 1000, decidedAt: T0 - i * 1000 })));
    const many = await f.engine.history("dev");
    assert.equal(many.length, 50);
    assert.equal(many[0].id, "x0");
    await assert.rejects(f.engine.history("Bad Slug!"), AgentError);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// restore (§5.2)
// ---------------------------------------------------------------------------

const readDev = (f) => readFile(join(f.root, "dev", "agent.md"), "utf-8");

test("restore: writes the earlier version through the ordinary apply path, as the user's click; its card can undo it", async () => {
  const f = await fixture({ level: "ask" });
  try {
    await f.engine.init();
    await writeFile(join(f.root, "dev", "agent.md"), DEV_V2);
    const src = change({ id: "src1" });
    await f.putChanges([src]);
    const reloads = f.config.reloads;
    const rec = await f.engine.restore("src1");
    assert.equal(rec.state, "applied");
    assert.equal(rec.decidedBy, "click", "the press is the approval, whatever the level says");
    assert.deepEqual(rec.origin, { kind: "restore", fromChangeId: "src1" });
    assert.equal(rec.before, DEV_V2);
    assert.equal(rec.after, DEV_V1);
    assert.equal(await readDev(f), DEV_V1);
    assert.equal(await readFile(join(f.root, "dev", ".compiled.md"), "utf-8"), "Dev prompt one.\n");
    assert.ok(f.w.pubs.some((p) => p.id === rec.id && p.origin.kind === "restore"), "the change hint is published");
    assert.ok(f.config.reloads >= reloads);
    assert.deepEqual((await f.engine.history("dev")).map((r) => r.id).slice(0, 2), [rec.id, "src1"]);
    // undo of the restore puts V2 back
    const undone = await f.engine.undo(rec.id);
    assert.equal(undone.state, "undone");
    assert.equal(await readDev(f), DEV_V2);
    // an undone change can be restored too (it is listed with its "Undone" chip)
    await f.putChanges([{ ...src, state: "undone" }]);
    assert.equal((await f.engine.restore("src1")).state, "applied");
  } finally {
    await f.cleanup();
  }
});

test("restore: refusals are sentences and create no record — Never, already at that version, a create, an unreadable version, a missing agent", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await writeFile(join(f.root, "dev", "agent.md"), DEV_V2);
    await f.putChanges([
      change({ id: "ok" }),
      change({ id: "same", before: DEV_V2, after: DEV_V1 }),
      change({ id: "made", kind: "create", before: null }),
      change({ id: "broken", before: "no frontmatter here" }),
      change({ id: "gone", slug: "ghost" }),
    ]);
    const count = async () => (await f.store()).changes.length;
    const before = await count();
    await assert.rejects(f.engine.restore("same"), /Already at that version/);
    await assert.rejects(f.engine.restore("made"), /Only a change to an existing agent can be restored/);
    await assert.rejects(f.engine.restore("broken"), /That version can't be read any more/);
    await assert.rejects(f.engine.restore("gone"), /ghost|no longer/i);
    await assert.rejects(f.engine.restore("nope"), /no longer available/);
    f.w.level = "never";
    await assert.rejects(f.engine.restore("ok"), new RegExp(AGENT_CHANGE_OFF));
    assert.equal(await count(), before, "no refusal wrote a record");
    assert.equal(await readDev(f), DEV_V2);
  } finally {
    await f.cleanup();
  }
});

test("restore: an Architect version holding a credential in its sources is refused (fail-closed), and a YAML alias refuses the file", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const archPath = join(f.root, "architect", "agent.md");
    const current = await readFile(archPath, "utf-8");
    const withSource = (url) => current.replace("isolation: none\n", `isolation: none\nsources:\n  - id: forum\n    name: Forum\n    description: A forum.\n    url: ${url}\n`);
    const leaky = withSource("https://example.com/search?q={query}&key=hunter2secret");
    assert.notEqual(leaky, current);
    await f.putChanges([change({ id: "leak", slug: "architect", agentName: "Architect", before: leaky, after: current })]);
    await assert.rejects(f.engine.restore("leak"), /seems to hold a credential/);
    f.w.scan = () => false; // a scanner that can't be trusted: still refused
    await assert.rejects(f.engine.restore("leak"), /credential|Couldn't check/);
    f.w.scan = () => true;
    const aliased = current.replace("color:", "color: &c ").replace(/^use_when:/m, "use_when: *c\nxx:");
    await f.putChanges([change({ id: "alias", slug: "architect", agentName: "Architect", before: aliased, after: current })]);
    await assert.rejects(f.engine.restore("alias"), /anchors or aliases|can't be read/);
    assert.equal((await f.store()).changes.length, 1);
    assert.equal(await readFile(archPath, "utf-8"), current);
    // a clean earlier Architect version restores (the user is restoring their own file)
    const clean = withSource("https://example.com/search?q={query}");
    await f.putChanges([change({ id: "clean", slug: "architect", agentName: "Architect", before: clean, after: current })]);
    const rec = await f.engine.restore("clean");
    assert.equal(rec.state, "applied");
    assert.equal(await readFile(archPath, "utf-8"), clean);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// seats (§5.1)
// ---------------------------------------------------------------------------

const SITE = "site-aaaaaaaaaa";
const API = "api-bbbbbbbbbb";
const seatFile = (f, slug, project) => join(f.root, slug, "seats", `${project}.md`);

test("seats: a legacy seat file is a brief as it stands; add / edit / remove round-trip through frontmatter; the file moves, never deleted", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await mkdir(join(f.root, "dev", "seats"), { recursive: true });
    await writeFile(seatFile(f, "dev", SITE), "Use pnpm. Never touch billing.\n");
    let profile = await f.engine.profile("dev");
    assert.deepEqual(profile.info.seats, [SITE]);
    assert.equal(profile.seats.length, 1);
    assert.equal(profile.seats[0].project, SITE);
    assert.equal(profile.seats[0].projectName, "Site");
    assert.equal(profile.seats[0].brief, "Use pnpm. Never touch billing.");
    assert.equal(profile.seats[0].addedBy, "user", "no frontmatter: the user's");
    assert.equal(typeof profile.seats[0].addedAt, "number");
    assert.equal(profile.seats[0].notes, 12, "the knowledge page count of that project");

    const added = await f.engine.seatAdd({ slug: "dev", project: API, brief: "Uses npm." });
    assert.deepEqual({ project: added.project, projectName: added.projectName, brief: added.brief, addedBy: added.addedBy, addedAt: added.addedAt, notes: added.notes }, { project: API, projectName: "API", brief: "Uses npm.", addedBy: "user", addedAt: T0, notes: null });
    const text = await readFile(seatFile(f, "dev", API), "utf-8");
    assert.match(text, /^---\nadded_at: .*\nadded_by: user\n---\nUses npm\.\n$/);
    await assert.rejects(f.engine.seatAdd({ slug: "dev", project: API }), /already has a seat/);

    const edited = await f.engine.seatSet({ slug: "dev", project: API, brief: "Uses npm. Run lint first." });
    assert.equal(edited.brief, "Uses npm. Run lint first.");
    assert.equal(edited.addedAt, T0, "editing keeps when and by whom it was added");
    assert.match(await readFile(seatFile(f, "dev", API), "utf-8"), /added_by: user/);
    await assert.rejects(f.engine.seatSet({ slug: "dev", project: API, brief: "x".repeat(4001) }), /4000/);

    f.w.clock = T0 + 5000;
    assert.deepEqual(await f.engine.seatRemove({ slug: "dev", project: API }), { ok: true });
    assert.deepEqual((await f.engine.list()).find((a) => a.slug === "dev").seats, [SITE]);
    assert.equal(await readFile(join(f.root, "dev", "seats", ".removed", `${API}-${T0 + 5000}.md`), "utf-8").then((t) => t.includes("Run lint first.")), true);
    await assert.rejects(f.engine.seatRemove({ slug: "dev", project: API }), /no seat/);
    await assert.rejects(f.engine.seatSet({ slug: "dev", project: API, brief: "x" }), /no seat/);
  } finally {
    await f.cleanup();
  }
});

test("seats: refusals are sentences — unknown project, bad ids, the lead and the Architect work everywhere, a symlinked seats folder or file", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await assert.rejects(f.engine.seatAdd({ slug: "dev", project: "nope-0000000000" }), /No project/);
    await assert.rejects(f.engine.seatAdd({ slug: "dev", project: "../x" }), /No project|valid/);
    await assert.rejects(f.engine.seatAdd({ slug: "ghost", project: SITE }), /No agent named @ghost/);
    for (const slug of ["manta", "architect"]) {
      await assert.rejects(f.engine.seatAdd({ slug, project: SITE }), /every project/);
      assert.deepEqual((await f.engine.profile(slug)).seats, []);
    }
    // a symlinked seats folder is refused (never written through)
    const outside = join(f.base, "outside");
    await mkdir(outside);
    await symlink(outside, join(f.root, "dev", "seats"));
    await assert.rejects(f.engine.seatAdd({ slug: "dev", project: SITE, brief: "b" }), /can't be written safely|seats folder/);
    assert.deepEqual(await readdir(outside), []);
    await rm(join(f.root, "dev", "seats"));
    await mkdir(join(f.root, "dev", "seats"));
    await writeFile(join(outside, "x.md"), "outside");
    await symlink(join(outside, "x.md"), seatFile(f, "dev", API));
    await assert.rejects(f.engine.seatSet({ slug: "dev", project: API, brief: "b" }), /can't be written safely|seat file/);
    assert.equal(await readFile(join(outside, "x.md"), "utf-8"), "outside");
  } finally {
    await f.cleanup();
  }
});

test("seats: the notes count is null when the counter is absent, throws or is slow; the memory scope follows the project's sharing", async () => {
  const none = await fixture({ extra: { countProjectPages: null } });
  try {
    await none.engine.init();
    await none.engine.seatAdd({ slug: "dev", project: SITE });
    assert.equal((await none.engine.profile("dev")).seats[0].notes, null);
  } finally {
    await none.cleanup();
  }
  for (const counter of [async () => { throw new Error("db down"); }, () => new Promise(() => {})]) {
    const f = await fixture({ extra: { countProjectPages: counter, countTimeoutMs: 20 } });
    try {
      await f.engine.init();
      await f.engine.seatAdd({ slug: "dev", project: SITE });
      assert.equal((await f.engine.profile("dev")).seats[0].notes, null);
    } finally {
      await f.cleanup();
    }
  }
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.seatAdd({ slug: "dev", project: SITE });
    await f.engine.seatAdd({ slug: "dev", project: API });
    const [site, api] = (await f.engine.profile("dev")).seats;
    const access = (seat, re) => seat.memory.find((m) => re.test(m.label))?.access;
    assert.equal(access(site, /this project/i), "read-write");
    assert.equal(access(site, /your wiki/i), "read");
    assert.equal(access(site, /commons|shared/i), "read", "a sharing project reads the commons");
    assert.equal(access(api, /commons|shared/i), "none", "a private project does not");
    assert.ok(site.memory.some((m) => /know-how/i.test(m.label) && m.access === "read"));
    assert.ok(site.memory.some((m) => /research library/i.test(m.label)));
  } finally {
    await f.cleanup();
  }
});

const dispatchInput = (over = {}) => ({ sessionId: "ses_chat", slug: "dev", directory: "/repo/site", text: "fix the build", ...over });

test("seats: a dispatch appends the brief without its frontmatter; into a project with no seat it creates one and stamps the job; a seated project stamps nothing", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.seatAdd({ slug: "dev", project: SITE, brief: "Use pnpm." });
    await f.engine.dispatch(dispatchInput());
    const first = f.w.startJobs[0];
    assert.match(first.prompt, /Your brief for this project:\nUse pnpm\./);
    assert.doesNotMatch(first.prompt, /added_by|added_at/);
    assert.equal(first.seatAdded, undefined);

    await f.engine.dispatch(dispatchInput({ directory: "/repo/api", text: "add a route" }));
    const second = f.w.startJobs[1];
    assert.deepEqual(second.seatAdded, { project: API, projectName: "API" });
    assert.equal(second.request, "add a route", "the request text is never modified");
    const text = await readFile(seatFile(f, "dev", API), "utf-8");
    assert.match(text, /added_by: mention/);
    assert.equal((await f.engine.profile("dev")).seats.find((s) => s.project === API).addedBy, "mention");
    // a folder no project owns gets no seat, and nothing is stamped
    await f.engine.dispatch(dispatchInput({ directory: "/elsewhere" }));
    assert.equal(f.w.startJobs[2].seatAdded, undefined);
    // the Architect never gets a seat
    await f.engine.dispatch(dispatchInput({ slug: "architect", directory: "/repo/api", text: "create an agent" }));
    assert.equal(f.w.startJobs[3].seatAdded, undefined);
    await assert.rejects(readFile(seatFile(f, "architect", API), "utf-8"));
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the fleet read model (§5.3), needs you (§2.1), the recap (§6.4)
// ---------------------------------------------------------------------------

let jn = 0;
const job = (over = {}) => {
  const id = over.id ?? `job_${++jn}`;
  return {
    id,
    rootJobId: id,
    name: "fix the build",
    agent: "agent-dev",
    agentName: "Dev",
    specialist: true,
    parentSessionID: "ses_chat",
    parentDirectory: "/repo/site",
    status: "done",
    isolation: "worktree",
    branch: null,
    filesChanged: null,
    createdAt: T0 - 3600_000,
    finishedAt: T0 - 1800_000,
    result: "Done.",
    error: null,
    attempt: 1,
    ...over,
  };
};

test("fleet: rows are team agents without the lead and the Architect; columns are projects with a seat or a task this week; cells show the newest task, running first", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.seatAdd({ slug: "dev", project: API, brief: "b" });
    f.w.jobs = [
      job({ id: "old", createdAt: T0 - 2 * DAY, finishedAt: T0 - 2 * DAY + 1000, status: "done" }),
      job({ id: "run", status: "running", finishedAt: null, createdAt: T0 - 600_000, jobProgress: { checklist: [{ text: "a", status: "completed" }, { text: "b", status: "completed" }, { text: "c", status: "in_progress" }, { text: "d", status: "pending" }] } }),
      job({ id: "api1", parentDirectory: "/repo/api", status: "failed", error: "Gmail token expired\nsecond line", createdAt: T0 - 5 * 3600_000, finishedAt: T0 - 4 * 3600_000 }),
      job({ id: "arch", agent: "agent-architect", agentName: "Architect", createdAt: T0 - 1000 }),
      job({ id: "nonspec", specialist: false, agent: "agent-dev" }),
    ];
    f.w.open.set("run", 1);
    const fleet = await f.engine.fleet();
    assert.equal(fleet.asOf, T0);
    assert.deepEqual(fleet.projects.map((p) => p.slug).sort(), [API, SITE].sort());
    assert.deepEqual(fleet.projects.find((p) => p.slug === SITE), { slug: SITE, name: "Site" });
    assert.deepEqual(fleet.rows.map((r) => r.slug), ["dev"]);
    const dev = fleet.rows[0];
    assert.deepEqual(dev.seats, [API]);
    assert.equal(dev.name, "Dev");
    const site = dev.cells[SITE];
    assert.equal(site.jobId, "run");
    assert.equal(site.state, "working");
    assert.equal(site.detail, "2/4 · 1 question");
    assert.equal(site.title, "fix the build");
    const api = dev.cells[API];
    assert.equal(api.jobId, "api1");
    assert.equal(api.state, "failed");
    assert.equal(api.detail, "Gmail token expired", "the first line of the error");
    assert.equal(fleet.week.tasks, 0, "counted when launched through the engine, not read from the jobs");
  } finally {
    await f.cleanup();
  }
});

test("fleet: a seat with no task is idle; an old finished task reads 'last task Nd ago'; a finished task with changes nobody opened needs you; a quiet finished one is done", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.seatAdd({ slug: "dev", project: API, brief: "b" });
    f.w.jobs = [
      job({ id: "needs", filesChanged: 3, branch: "agent/dev-1" }),
      job({ id: "quiet", parentDirectory: "/repo/other", status: "done", filesChanged: 0, finishedAt: T0 - 2 * 3600_000 }),
      job({ id: "ancient", parentDirectory: "/repo/api", createdAt: T0 - 9 * DAY, finishedAt: T0 - 9 * DAY }),
    ];
    f.w.dirs["/repo/other"] = "other-cccccccccc";
    f.w.registry.push({ slug: "other-cccccccccc", displayName: "Other" });
    const fleet = await f.engine.fleet();
    const cells = fleet.rows[0].cells;
    assert.equal(cells[SITE].state, "needs-you");
    assert.equal(cells[SITE].detail, "3 files changed");
    assert.equal(cells["other-cccccccccc"].state, "done");
    assert.match(cells["other-cccccccccc"].detail, /ago/);
    assert.equal(cells[API].state, "idle");
    assert.equal(cells[API].detail, "last task 9d ago");
    await f.engine.reviewDone("needs");
    assert.equal((await f.engine.fleet()).rows[0].cells[SITE].state, "done", "a reviewed task no longer needs you");
    // a seat with no task at all
    f.w.jobs = [];
    const idle = (await f.engine.fleet()).rows[0].cells[API];
    assert.equal(idle.state, "idle");
    assert.equal(idle.jobId, "");
  } finally {
    await f.cleanup();
  }
});

test("fleet: launches are counted per ISO week by dispatch; last week is kept, older weeks dropped; reads are cheap (the store, the jobs, the seats)", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.dispatch(dispatchInput());
    await f.engine.dispatch(dispatchInput({ directory: "/repo/api" }));
    let fleet = await f.engine.fleet();
    assert.equal(fleet.week.tasks, 2);
    assert.equal(fleet.rows[0].tasksThisWeek, 2);
    const doc = JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8"));
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.counts["2026-W48"].dev, { [SITE]: 1, [API]: 1 });
    f.w.clock = T0 + 7 * DAY; // the next week
    assert.equal((await f.engine.fleet()).week.tasks, 0);
    await f.engine.dispatch(dispatchInput());
    f.w.clock = T0 + 21 * DAY;
    await f.engine.dispatch(dispatchInput());
    const kept = Object.keys(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).counts);
    assert.ok(kept.length <= 2, `only the current and previous week: ${kept}`);
    // a failed launch is not counted
    f.w.startResult = { ok: false, error: "busy" };
    const before = JSON.stringify(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).counts);
    await assert.rejects(f.engine.dispatch(dispatchInput()), /busy/);
    assert.equal(JSON.stringify(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).counts), before);
  } finally {
    await f.cleanup();
  }
});

test("fleet-seen records the time the page was left; the recap counts from it (24 h when never seen) with fixed templates, at most 6 lines", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    f.w.jobs = [
      job({ id: "m1", requestedBy: "manta", createdAt: T0 - 3600_000, finishedAt: T0 - 3000_000 }),
      job({ id: "m2", requestedBy: "manta", parentDirectory: "/repo/api", createdAt: T0 - 7200_000, finishedAt: T0 - 7000_000 }),
      job({ id: "f1", status: "failed", error: "x", createdAt: T0 - 7200_000, finishedAt: T0 - 7100_000 }),
      job({ id: "very-old", createdAt: T0 - 3 * DAY, finishedAt: T0 - 3 * DAY }),
    ];
    const recap = (await f.engine.fleet()).recap;
    assert.equal(recap.since, null);
    assert.deepEqual(recap.lines, ["Manta handed 2 requests to agents", "Dev finished 1 task in Site", "Dev finished 1 task in API", "Dev failed 1 task"]);
    assert.deepEqual(await f.engine.fleetSeen(), { ok: true });
    f.w.clock = T0 + 3600_000;
    f.w.jobs.push(job({ id: "n1", createdAt: T0 + 1000, finishedAt: T0 + 2000 }));
    const next = (await f.engine.fleet()).recap;
    assert.equal(next.since, T0);
    assert.deepEqual(next.lines, ["Dev finished 1 task in Site"]);
  } finally {
    await f.cleanup();
  }
});

test("fleetRecap: pure templates for changes and answers, plural forms, six lines at most", () => {
  const level = "tell";
  const lines = fleetRecap(
    [job({ requestedBy: "manta", createdAt: T0 + 1, finishedAt: T0 + 2 })],
    [change({ state: "applied", decidedBy: "auto", decidedAt: T0 + 5 }), change({ state: "pending", needsClick: true, agentName: "Scout", createdAt: T0 + 6, decidedAt: null, releasedAt: T0 + 6 }), change({ state: "applied", decidedBy: "click", agentName: "Dev", decidedAt: T0 + 7 })],
    T0,
    { level, answered: 2, projectNameOf: () => "Site" },
  );
  assert.deepEqual(lines, ["Manta handed 1 request to agents", "Dev finished 1 task in Site", "Dev was changed (your setting: Tell me)", "Scout is waiting for your click", "Dev was changed (you approved it)", "2 questions answered"]);
  const many = fleetRecap(Array.from({ length: 12 }, (_, i) => job({ agentName: `Agent${i}`, createdAt: T0 + 1, finishedAt: T0 + 2 })), [], T0, { projectNameOf: () => "Site" });
  assert.equal(many.length, 6);
  assert.deepEqual(fleetRecap([], [], T0), []);
});

test("needs you: open questions, pending changes box-wide (not expired), and finished worktree tasks nobody reviewed — newest first, one count", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    f.w.openQuestions = [{ id: "tq_1", parentSessionID: "ses_chat", state: "open", askedAt: T0 }];
    await f.putChanges([
      change({ id: "p1", state: "pending", needsClick: true, reason: "ask", releasedAt: T0 - 3600_000, createdAt: T0 - 3600_000, decidedAt: null }),
      change({ id: "p2", state: "pending", needsClick: true, reason: "lead", slug: "manta", agentName: "Manta", sessionID: "", releasedAt: T0 - 600_000, createdAt: T0 - 600_000, decidedAt: null, origin: { kind: "job", jobId: "x", rootJobId: "x", attempt: 1 } }),
      change({ id: "stale", state: "pending", needsClick: true, reason: "ask", releasedAt: T0 - 3 * DAY, createdAt: T0 - 3 * DAY, decidedAt: null }),
      change({ id: "done", state: "applied" }),
    ]);
    f.w.jobs = [
      job({ id: "r1", filesChanged: 2, branch: "agent/dev-2", finishedAt: T0 - 1000, result: "Fixed the build." }),
      job({ id: "r2", filesChanged: 4, branch: "agent/dev-3", finishedAt: T0 - 5000 }),
      job({ id: "r3", filesChanged: 0, branch: "agent/dev-4" }),
      job({ id: "r4", status: "running", filesChanged: 5, finishedAt: null }),
      job({ id: "r5", agent: "agent-architect", agentName: "Architect", filesChanged: 1, branch: "b" }),
    ];
    await f.engine.reviewDone("r2");
    const ny = await f.engine.needsYou();
    assert.deepEqual(ny.questions.map((q) => q.id), ["tq_1"]);
    assert.deepEqual(ny.changes.map((c) => c.id), ["p2", "p1"]);
    assert.deepEqual(ny.reviews.map((r) => r.jobId), ["r1"]);
    assert.deepEqual(ny.reviews[0], { jobId: "r1", agentSlug: "dev", project: SITE, name: "fix the build", finishedAt: T0 - 1000, filesChanged: 2, branch: "agent/dev-2", resultText: "Fixed the build." });
    assert.equal(ny.count, 4);
    assert.ok(!("prior" in ny.changes[0]), "the wire shape");
    // the review is remembered (≤200) in the counters file
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).reviewed, ["r2"]);
    assert.deepEqual(await f.engine.questions({ sessionID: "ses_chat" }), f.w.openQuestions);
    await assert.rejects(f.engine.reviewDone(""), /task/i);
  } finally {
    await f.cleanup();
  }
});

test("questions: answer and dismiss pass the task questions' result through; a refusal is thrown as a sentence", async () => {
  const f = await fixture({ extra: undefined });
  try {
    await f.engine.init();
    const ok = await f.engine.questionAnswer({ id: "tq_1", answers: [["Yes"]] });
    assert.deepEqual(ok, { id: "tq_1", answers: [["Yes"]] });
    assert.deepEqual(await f.engine.questionDismiss({ id: "tq_1" }), { id: "tq_1" });
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ extra: { taskQuestions: { hasOpen: () => false, openCountFor: () => 0, listOpen: async () => [], answer: async () => ({ ok: false, error: "Already sending your answer" }), dismiss: async () => ({ ok: false, error: "That question no longer exists." }) } } });
  try {
    await g.engine.init();
    await assert.rejects(g.engine.questionAnswer({ id: "tq_1", answers: [["a"]] }), (e) => e instanceof AgentError && /Already sending/.test(e.message) && e.rpcStatus === 400);
    await assert.rejects(g.engine.questionDismiss({ id: "tq_1" }), /no longer exists/);
  } finally {
    await g.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the profile (§2.2) and a task's research (§6.5)
// ---------------------------------------------------------------------------

const entry = (over = {}) => ({ id: "rl_1", topic: "Pricing pages", sourceCount: 4, ageDays: 3, status: "fresh", thin: false, ...over });

test("profile: who built it, when it last changed, and the research its applied changes rest on, resolved live (missing entries say so)", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await f.engine.seatAdd({ slug: "dev", project: SITE, brief: "b" });
    f.w.library = [entry(), entry({ id: "rl_2", topic: "Old topic", status: "stale", thin: true, sourceCount: 1, ageDays: 120 })];
    await f.putChanges([
      change({ id: "c1", kind: "create", before: null, state: "applied", origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 }, decidedAt: T0 - 9 * DAY, basis: [{ id: "rl_1", topic: "Pricing pages", sourceCount: 4, ageDays: 3 }] }),
      change({ id: "c2", state: "applied", decidedAt: T0 - 2 * DAY, basis: [{ id: "rl_2", topic: "Old topic", sourceCount: 1, ageDays: 120 }, { id: "rl_gone", topic: "Deleted topic", sourceCount: 3, ageDays: 5 }] }),
      change({ id: "c3", state: "discarded", decidedAt: T0 - DAY, basis: [{ id: "rl_x", topic: "Not applied", sourceCount: 3, ageDays: 1 }] }),
    ]);
    const p = await f.engine.profile("dev");
    assert.equal(p.info.slug, "dev");
    assert.equal(p.builtBy, "built-in");
    assert.equal(p.lastChangedAt, T0 - 2 * DAY);
    assert.deepEqual(p.research.map((r) => [r.id, r.status, r.thin]), [["rl_2", "stale", true], ["rl_gone", "missing", false], ["rl_1", "fresh", false]]);
    assert.deepEqual(p.research.find((r) => r.id === "rl_1"), { id: "rl_1", topic: "Pricing pages", sourceCount: 4, ageDays: 3, status: "fresh", thin: false });
    assert.deepEqual(p.research.find((r) => r.id === "rl_gone"), { id: "rl_gone", topic: "Deleted topic", sourceCount: null, ageDays: null, status: "missing", thin: false });
    await assert.rejects(f.engine.profile("ghost"), /No agent named @ghost/);
    // who built a made agent: a job → the Architect; a chat → Manta; otherwise the user
    await mkdir(join(f.root, "scout"));
    await writeFile(join(f.root, "scout", "agent.md"), "---\nname: Scout\ndescription: Looks things up.\nisolation: none\n---\nScout.\n");
    await mkdir(join(f.root, "chatty"));
    await writeFile(join(f.root, "chatty", "agent.md"), "---\nname: Chatty\ndescription: Talks.\nisolation: none\n---\nChat.\n");
    await mkdir(join(f.root, "handmade"));
    await writeFile(join(f.root, "handmade", "agent.md"), "---\nname: Hand\ndescription: By hand.\nisolation: none\n---\nHand.\n");
    await f.putChanges([
      change({ id: "s1", slug: "scout", agentName: "Scout", kind: "create", before: null, origin: { kind: "job", jobId: "j", rootJobId: "j", attempt: 1 } }),
      change({ id: "s2", slug: "chatty", agentName: "Chatty", kind: "create", before: null, origin: { kind: "chat" } }),
    ]);
    assert.equal((await f.engine.profile("scout")).builtBy, "architect");
    assert.equal((await f.engine.profile("chatty")).builtBy, "manta");
    assert.equal((await f.engine.profile("handmade")).builtBy, "user");
  } finally {
    await f.cleanup();
  }
});

test("task research: the entries the task found or saved, then its proposals' basis, resolved in the task's project; an unknown task is a sentence", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    f.w.library = [entry(), entry({ id: "rl_2", topic: "Team fit" })];
    f.w.jobs = [job({ id: "t1", rootJobId: "t1", agent: "agent-architect", agentName: "Architect" }), job({ id: "t2", rootJobId: "t1", attempt: 2, agent: "agent-architect" })];
    f.w.used = { t1: [{ id: "rl_1", topic: "Pricing pages" }, { id: "rl_old", topic: "Team fit" }] };
    await f.putChanges([change({ id: "p1", state: "held", origin: { kind: "job", jobId: "t2", rootJobId: "t1", attempt: 2 }, basis: [{ id: "rl_2", topic: "Team fit", sourceCount: 4, ageDays: 3 }, { id: "rl_1", topic: "Pricing pages", sourceCount: 4, ageDays: 3 }] })]);
    const r = await f.engine.taskResearch({ jobId: "t2" });
    assert.deepEqual(r.map((x) => x.id), ["rl_1", "rl_2"], "an id that was replaced resolves by its topic; each entry once");
    assert.equal(r[0].status, "fresh");
    assert.deepEqual(await f.engine.taskResearch({ jobId: "t1" }), r, "any round of the task gives the same list");
    await assert.rejects(f.engine.taskResearch({ jobId: "nope" }), /no longer exists/);
    assert.deepEqual((await f.engine.projects()), [{ slug: SITE, name: "Site" }, { slug: API, name: "API" }]);
  } finally {
    await f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the monthly refresh (§5.4): provisioning, the toggle, and the task it starts
// ---------------------------------------------------------------------------

test("refreshDay: one fixed day 1–28 per slug, spread", () => {
  const days = ["dev", "seo", "scout", "writer", "reviewer", "ops"].map(refreshDay);
  for (const d of days) assert.ok(Number.isInteger(d) && d >= 1 && d <= 28, String(d));
  assert.equal(refreshDay("dev"), refreshDay("dev"));
  assert.ok(new Set(days).size >= 3, `spread: ${days}`);
});

test("refresh provisioning: every team agent gets one monthly routine on sync; the lead and the Architect don't; idempotent; an Off or deleted routine is not recreated", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const created = f.w.routineCalls.filter((c) => c[0] === "create");
    assert.equal(created.length, 1, "Dev only");
    const input = created[0][1];
    assert.deepEqual({ kind: input.kind, agentSlug: input.agentSlug, name: input.name, enabled: input.enabled, rollUp: input.rollUp, access: input.access, directory: input.directory, cron: input.cron }, { kind: "agent-refresh", agentSlug: "dev", name: "Refresh @dev", enabled: true, rollUp: true, access: "read", directory: join(f.root, "dev", "home"), cron: `0 9 ${refreshDay("dev")} * *` });
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).refresh, { dev: "rt1" });
    await f.engine.sync();
    await f.engine.list();
    assert.equal(f.w.routineCalls.filter((c) => c[0] === "create").length, 1, "idempotent");
    // a new agent gets one at the next sync
    await mkdir(join(f.root, "scout", "home"), { recursive: true });
    await writeFile(join(f.root, "scout", "agent.md"), "---\nname: Scout\ndescription: Looks things up.\nisolation: none\n---\nScout.\n");
    await f.engine.list();
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).refresh).sort(), ["dev", "scout"]);
    // Off (the routine disabled, or deleted on the Routines page) stays Off
    f.w.routines.get("rt1").enabled = false;
    f.w.routines.delete("rt2");
    await f.engine.sync();
    assert.equal(f.w.routineCalls.filter((c) => c[0] === "create").length, 2, "nothing recreated");
    assert.deepEqual((await f.engine.profile("dev")).refresh, { enabled: false, routineId: "rt1" });
    assert.deepEqual((await f.engine.profile("scout")).refresh, { enabled: false, routineId: "rt2" });
    assert.deepEqual((await f.engine.profile("manta")).refresh, { enabled: false, routineId: null });
  } finally {
    await f.cleanup();
  }
});

test("refresh toggle: Off disables the routine, On enables it, a missing routine is recreated by On; team agents only", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    assert.deepEqual((await f.engine.profile("dev")).refresh, { enabled: true, routineId: "rt1" });
    assert.deepEqual(await f.engine.refreshSet({ slug: "dev", enabled: false }), { enabled: false, routineId: "rt1" });
    assert.deepEqual(f.w.routineCalls.at(-1), ["update", "rt1", { enabled: false }]);
    assert.deepEqual(await f.engine.refreshSet({ slug: "dev", enabled: true }), { enabled: true, routineId: "rt1" });
    f.w.routines.delete("rt1");
    const back = await f.engine.refreshSet({ slug: "dev", enabled: true });
    assert.deepEqual(back, { enabled: true, routineId: "rt2" });
    assert.equal(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).refresh.dev, "rt2");
    for (const slug of ["manta", "architect", "ghost"]) await assert.rejects(f.engine.refreshSet({ slug, enabled: true }), /team agents|No agent named/);
    await assert.rejects(f.engine.refreshSet({ slug: "dev", enabled: "yes" }), /on or off/i);
  } finally {
    await f.cleanup();
  }
});

test("refresh provisioning: a deleted or invalid agent's routine is removed with its entry", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    await rm(join(f.root, "dev"), { recursive: true });
    await f.engine.sync();
    assert.deepEqual(f.w.routineCalls.filter((c) => c[0] === "remove"), [["remove", "rt1"]]);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, ".fleet.json"), "utf-8")).refresh, {});
  } finally {
    await f.cleanup();
  }
});

test("agents.refresh: starts the Architect's task for @slug under the run's headless session — hidden workspace, no result posted, round mode unknown; refusals are sentences", async () => {
  const f = await fixture();
  try {
    await f.engine.init();
    const res = await f.engine.refresh("dev", { runId: "run1", runSessionId: "ses_run" });
    assert.deepEqual(res, { jobId: "job_new" });
    assert.equal(f.w.newSessions.length, 1, "the hidden workspace is made when missing");
    assert.equal(f.w.newSessions[0].name, AGENTS_TMUX_SESSION);
    const input = f.w.startJobs[0];
    assert.equal(input.parentSessionID, "ses_run");
    assert.equal(input.parentDirectory, join(f.root, "dev", "home"));
    assert.equal(input.agent, "agent-architect");
    assert.equal(input.targetProject, AGENTS_TMUX_SESSION);
    assert.equal(input.deliverResult, false);
    assert.deepEqual(input.architect, { mode: "unknown" });
    assert.equal(input.specialist, true);
    assert.match(input.prompt, /Refresh @dev: check the research it rests on and propose only changes your research supports\./);
    assert.match(input.prompt, /Research library/, "the research guidance every task gets");
    assert.match(input.prompt, /Current file of @dev/, "the Architect's context names the agent");
    assert.equal(input.isolation, "none");
    await f.engine.refresh("dev", { runId: "run2", runSessionId: "ses_run2" });
    assert.equal(f.w.newSessions.length, 1, "and not again once it exists");
    // refusals
    f.w.startResult = { ok: false, error: "All background slots on this box are busy right now." };
    await assert.rejects(f.engine.refresh("dev", { runId: "r", runSessionId: "s" }), /busy right now/);
    f.w.startResult = { ok: true, job: { id: "job_new" } };
    await assert.rejects(f.engine.refresh("ghost", { runId: "r", runSessionId: "s" }), /No agent named @ghost/);
    await assert.rejects(f.engine.refresh("architect", { runId: "r", runSessionId: "s" }), /team agents/);
    f.w.level = "never";
    await assert.rejects(f.engine.refresh("dev", { runId: "r", runSessionId: "s" }), new RegExp(AGENT_CHANGE_OFF));
  } finally {
    await f.cleanup();
  }
  const noArch = await fixture({ templates: ["dev", "manta"] });
  try {
    await noArch.engine.init();
    await assert.rejects(noArch.engine.refresh("dev", { runId: "r", runSessionId: "s" }), /The Architect isn't available/);
  } finally {
    await noArch.cleanup();
  }
});
