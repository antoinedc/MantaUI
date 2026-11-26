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
