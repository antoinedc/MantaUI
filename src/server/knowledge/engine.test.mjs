import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createKnowledgeEngine } from "./engine.mjs";
import { buildKnowledgeChannels, handleKnowledgeRoute } from "./routes.mjs";
import { execGitRunner, makeRepo, tmpDir } from "./testHelpers.mjs";

const fakeLint = async () => ({ preset: { meta: { id: "p" } }, lintSource: async () => ({ messages: [] }) });

async function rig({ stored, sessions = {}, over = {}, repoRemote = "https://github.com/acme/widget.git" } = {}) {
  const dir = await tmpDir("knowledge-engine-");
  const repo = await makeRepo({ remote: repoRemote });
  let cfg = { knowledge: stored };
  const updates = [];
  const notes = [];
  const engine = createKnowledgeEngine({
    dir,
    git: execGitRunner(dir),
    config: { get: async () => cfg, update: async (p) => (updates.push(p), (cfg = { ...cfg, ...p })) },
    getSession: async (id) => sessions[id] ?? { directory: repo },
    isCtoSession: async () => false,
    loadLint: fakeLint,
    secretValues: () => [],
    fireNotify: async (n) => notes.push(n),
    maintenanceMs: 3_600_000,
    log: () => {},
    // never the box's real opencode.db (the default source): the suite runs on a live box
    listSessionsPage: async () => [],
    ...over,
  });
  return { engine, dir, repo, updates, notes, getCfg: () => cfg };
}
const started = (id, extra = {}) => ({ type: "session.execution.started", data: { sessionID: id, ...extra } });

test("start creates the git store and state, reports `on`, and the engine does not depend on the CTO engine", async () => {
  const { engine, dir } = await rig();
  const s = await engine.start();
  assert.equal(s.state, "on");
  await access(join(dir, ".git"));
  await access(join(dir, "state.sqlite"));
  assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /\.briefings\//);
  assert.equal(s.capReached, false);
  await engine.stop();
});

test("without node:sqlite the subsystem is off and says why; tools answer 503 disabled; briefing is empty; settings still work", async () => {
  const { engine, updates } = await rig({ over: { importSqlite: async () => { throw new Error("no sqlite"); } } });
  const s = await engine.start();
  assert.equal(s.state, "unsupported");
  assert.match(s.reason, /Node 24/);
  await assert.rejects(engine.enqueueNote({ sessionID: "ses_x1", kind: "howto", text: "x", refs: ["commit:abcdef1"] }), (e) => e.code === "disabled" && e.status === 503);
  await assert.rejects(engine.search({ sessionID: "ses_x1", query: "x" }), (e) => e.status === 503);
  await assert.rejects(engine.readPage({ sessionID: "ses_x1", ref: "page:user/x.md" }), (e) => e.status === 503);
  assert.deepEqual(await engine.briefing({ sessionID: "ses_x1", assistantMessages: 0 }), { text: "", token: null });
  assert.equal((await engine.settingsGet()).status.state, "unsupported");
  await engine.settingsSet({ dailyCapUsd: 3 });
  assert.equal(updates[0].knowledge.dailyCapUsd, 3);
  assert.deepEqual(await engine.changes(), { items: [], nextCursor: null });
  assert.equal((await engine.undo({ id: "c_x" })).ok, false);
  await engine.observeRaw(started("ses_x1")); // no throw
});

test("a session is pinned at its first prompt; knowledge_note then lands in that project's queue, redacted and bounded", async () => {
  const { engine } = await rig();
  await engine.start();
  await engine.observeRaw(started("ses_one"));
  const mapping = engine.sessionMap.get("ses_one");
  assert.match(mapping.slug, /^widget-[0-9a-f]{10}$/);
  const r = await engine.enqueueNote({ sessionID: "ses_one", kind: "howto", text: "Run npm test", refs: ["msg:ses_one/msg_1"] });
  assert.equal(r.accepted, true);
  assert.match(r.id, /^n_/);
  assert.equal((await engine.queue.list(mapping.slug)).length, 1);
  assert.equal((await engine.enqueueNote({ sessionID: "ses_one", kind: "howto", text: "Run npm test", refs: ["msg:ses_one/msg_1"] })).accepted, false);
  await assert.rejects(engine.enqueueNote({ sessionID: "ses_one", kind: "bogus", text: "x", refs: ["commit:abcdef1"] }), (e) => e.code === "invalid-note" && e.status === 400);
  await engine.stop();
});

test("a note from a session that never started a turn is pinned lazily; from an unmappable session it is politely refused", async () => {
  const { engine } = await rig({ sessions: { ses_gone: { directory: "/nowhere/at/all" } } });
  await engine.start();
  const ok = await engine.enqueueNote({ sessionID: "ses_late", kind: "gotcha", text: "Mind the cache", refs: ["commit:abcdef1"] });
  assert.equal(ok.accepted, true);
  const no = await engine.enqueueNote({ sessionID: "ses_gone", kind: "gotcha", text: "Mind the cache", refs: ["commit:abcdef1"] });
  assert.equal(no.accepted, false);
  assert.match(no.reason, /isn't part of a known project/);
  await engine.stop();
});

test("master switch off: capture, tools and briefing are all off (503 / empty); observeOnly keeps notes but turns tools and briefing off", async () => {
  const off = await rig({ stored: { enabled: false } });
  await off.engine.start();
  await assert.rejects(off.engine.enqueueNote({ sessionID: "ses_a1", kind: "howto", text: "x", refs: ["commit:abcdef1"] }), (e) => e.status === 503);
  assert.deepEqual(await off.engine.briefing({ sessionID: "ses_a1", assistantMessages: 0 }), { text: "", token: null });
  await off.engine.observeRaw(started("ses_a1"));
  assert.equal(off.engine.sessionMap.get("ses_a1"), null);
  assert.equal((await off.engine.status()).state, "off");
  assert.equal(off.notes.length, 0); // no upgrade notification while off

  const obs = await rig({ stored: { observeOnly: true } });
  await obs.engine.start();
  await obs.engine.observeRaw(started("ses_b1"));
  assert.equal((await obs.engine.enqueueNote({ sessionID: "ses_b1", kind: "howto", text: "x", refs: ["commit:abcdef1"] })).accepted, true);
  await assert.rejects(obs.engine.search({ sessionID: "ses_b1", query: "x" }), (e) => e.status === 503);
  assert.deepEqual(await obs.engine.briefing({ sessionID: "ses_b1", assistantMessages: 0 }), { text: "", token: null });
  assert.equal((await obs.engine.status()).observeOnly, true);
});

test("a store commit refreshes the page index and the project briefing; the briefing flow works end to end", async () => {
  const { engine } = await rig();
  await engine.start();
  await engine.observeRaw(started("ses_main"));
  const slug = engine.sessionMap.get("ses_main").slug;
  await engine.store.commit({ path: `projects/${slug}/overview.md`, content: "# Overview\n\n## Briefing\n\nMonorepo with an API.\n", message: "Add overview" });
  await engine.store.commit({ path: `projects/${slug}/runbooks/deploy.md`, content: "---\ntitle: Deploy\n---\nTag the release and push the tag.\n", message: "Add deploy" });
  await engine.refreshDerived();
  const hits = await engine.search({ sessionID: "ses_main", query: "tag the release", sources: ["wiki"] });
  assert.deepEqual(hits.hits.map((h) => h.ref), [`page:projects/${slug}/runbooks/deploy.md`]);
  const b = await engine.briefing({ sessionID: "ses_main", assistantMessages: 0 });
  assert.match(b.text, /Monorepo with an API\./);
  assert.match(b.text, /Deploy/);
  assert.deepEqual(await engine.briefingAck({ sessionID: "ses_main", token: b.token }), { ok: true });
  const page = await engine.readPage({ sessionID: "ses_main", ref: `page:projects/${slug}/runbooks/deploy.md` });
  assert.equal(page.title, "Deploy");
  assert.equal((await engine.status()).briefings.startedThisWeek, 1);
  await assert.rejects(engine.briefingAck({ sessionID: "ses_main", token: "nope" }), (e) => e.status === 409);
  await engine.stop();
});

test("projects.json is committed by the registry on first sight of a project", async () => {
  const { engine } = await rig();
  await engine.start();
  await engine.observeRaw(started("ses_p"));
  const doc = JSON.parse(await engine.store.read("projects.json"));
  const slug = engine.sessionMap.get("ses_p").slug;
  assert.equal(doc.projects[slug].canonicalId, "github.com/acme/widget");
  assert.match((await engine.store.log({ path: "projects.json", limit: 1 }))[0].subject, /Register project/);
  await engine.stop();
});

test("settings: get lists detected projects; set validates (400 invalid-setting), persists, and fires onSettingsChanged", async () => {
  const changed = [];
  const { engine, getCfg } = await rig({ over: { onSettingsChanged: async (c) => changed.push(c) } });
  await engine.start();
  await engine.observeRaw(started("ses_s"));
  const slug = engine.sessionMap.get("ses_s").slug;
  const view = await engine.settingsGet();
  assert.equal(view.projects[0].slug, slug);
  assert.equal(view.enabled, true);
  await assert.rejects(engine.settingsSet({ sharing: "nope" }), (e) => e.code === "invalid-setting" && e.status === 400);
  const next = await engine.settingsSet({ projects: { [slug]: { sharing: "private" } } });
  assert.equal(next.projects[0].sharing, "private");
  assert.equal(getCfg().knowledge.projects[slug].sharing, "private");
  assert.equal(changed.length, 1);
  assert.equal(changed[0].prev.projects[slug], undefined);
  assert.equal(changed[0].next.projects[slug].sharing, "private");
  await engine.stop();
});

test("the upgrade notification is sent once, when the feature is on, and says what it spends", async () => {
  const { engine, notes, dir } = await rig();
  await engine.start();
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /\$1\.00 a day/);
  assert.match(notes[0].message, /Settings → Knowledge/);
  await engine.stop();
  const again = createKnowledgeEngine({ dir, git: execGitRunner(dir), config: { get: async () => ({}), update: async () => {} }, loadLint: fakeLint, secretValues: () => [], listSessionsPage: async () => [], fireNotify: async (n) => notes.push(n), log: () => {} });
  await again.start();
  assert.equal(notes.length, 1);
  await again.stop();
});

test("changes + undo: the record is listed newest-first; undo calls the injected curator undo and records every outcome", async () => {
  const calls = [];
  const { engine } = await rig({
    over: {
      undo: async (change) => {
        calls.push(change.id);
        return change.summary === "conflicting" ? { ok: false, reason: "Conflicts with a later change.", conflictWith: { sha: "abc1234", subject: "later" } } : { ok: true };
      },
    },
  });
  await engine.start();
  const good = engine.changesLog.add({ kind: "applied", summary: "fine", undoable: true, commitSha: "aaaaaaa" });
  const bad = engine.changesLog.add({ kind: "applied", summary: "conflicting", undoable: true, commitSha: "bbbbbbb" });
  const info = engine.changesLog.add({ kind: "waiting", summary: "waiting for a model" });
  assert.equal((await engine.changes()).items[0].id, info);
  assert.deepEqual(await engine.undo({ id: good }), { ok: true });
  assert.deepEqual(await engine.undo({ id: bad }), { ok: false, reason: "Conflicts with a later change.", conflictWith: { sha: "abc1234", subject: "later" } });
  const items = (await engine.changes()).items;
  assert.equal(items.find((i) => i.id === good).undoable, false);
  assert.ok(items.find((i) => i.id === good).undoneAt);
  assert.equal(items.find((i) => i.id === bad).error, "Conflicts with a later change.");
  assert.equal((await engine.undo({ id: good })).reason, "That change was already undone.");
  assert.equal((await engine.undo({ id: info })).reason, "That change can't be undone.");
  assert.equal((await engine.undo({ id: "c_missing" })).reason, "That change no longer exists.");
  assert.deepEqual(calls, [good, bad]);
  await engine.stop();
});

test("undo without a curator layer says so (never a silent no-op)", async () => {
  const { engine } = await rig();
  await engine.start();
  const id = engine.changesLog.add({ kind: "applied", summary: "x", undoable: true });
  assert.match((await engine.undo({ id })).reason, /isn't available yet/);
  await engine.stop();
});

test("the RPC channels: settings-get/-set (patch wrapper), status, changes, undo; an unwired box answers 503", async () => {
  const { engine } = await rig();
  await engine.start();
  const ch = buildKnowledgeChannels(engine);
  assert.deepEqual(Object.keys(ch).sort(), ["knowledge:changes", "knowledge:settings-get", "knowledge:settings-set", "knowledge:status", "knowledge:undo"]);
  assert.equal((await ch["knowledge:settings-set"]({ patch: { dailyCapUsd: 4 } })).dailyCapUsd, 4);
  assert.equal((await ch["knowledge:settings-get"]()).dailyCapUsd, 4);
  assert.equal((await ch["knowledge:status"]()).state, "on");
  assert.deepEqual((await ch["knowledge:changes"]({})).items, []);
  assert.equal((await ch["knowledge:undo"]({ id: "c_nope" })).ok, false);
  await assert.rejects(ch["knowledge:settings-set"]({ patch: { color: "red" } }), (e) => e.rpcStatus === 400);
  const bare = buildKnowledgeChannels(null);
  assert.throws(() => bare["knowledge:status"](), (e) => e.rpcStatus === 503);
  await engine.stop();
});

function http(method, urlPath, body) {
  const url = new URL(`http://x${urlPath}`);
  const out = { status: null, body: null };
  return {
    out,
    args: {
      req: { method },
      res: {},
      path: url.pathname,
      url,
      readJsonBody: async () => body,
      respondJson: (_res, status, obj) => Object.assign(out, { status, body: obj }),
    },
  };
}

test("HTTP routes (§11.2): statuses and bodies", async () => {
  const { engine } = await rig();
  await engine.start();
  await engine.observeRaw(started("ses_http"));
  const call = async (method, path, body) => {
    const h = http(method, path, body);
    const handled = await handleKnowledgeRoute({ engine, ...h.args });
    assert.equal(handled, true);
    return h.out;
  };
  const note = await call("POST", "/api/knowledge/notes", { sessionID: "ses_http", kind: "howto", text: "Use pnpm", refs: ["commit:abcdef1"] });
  assert.equal(note.status, 200);
  assert.equal(note.body.accepted, true);
  const dup = await call("POST", "/api/knowledge/notes", { sessionID: "ses_http", kind: "howto", text: "Use pnpm", refs: ["commit:abcdef1"] });
  assert.deepEqual([dup.status, dup.body.accepted], [200, false]);
  const bad = await call("POST", "/api/knowledge/notes", { sessionID: "ses_http", kind: "nope", text: "x", refs: [] });
  assert.deepEqual([bad.status, bad.body.error], [400, "invalid-note"]);
  const s = await call("GET", "/api/knowledge/search?sessionID=ses_http&query=pnpm&sources=wiki&limit=3");
  assert.equal(s.status, 200);
  assert.deepEqual(Object.keys(s.body).sort(), ["hits", "truncated"]);
  const sBad = await call("GET", "/api/knowledge/search?sessionID=ses_http&query=");
  assert.deepEqual([sBad.status, sBad.body.error], [400, "invalid-query"]);
  const p404 = await call("GET", "/api/knowledge/page?sessionID=ses_http&ref=page:user/none.md");
  assert.deepEqual([p404.status, p404.body.error], [404, "not-found"]);
  const p403 = await call("GET", "/api/knowledge/page?sessionID=ses_http&ref=msg:ses_nobody/msg_1");
  assert.deepEqual([p403.status, p403.body.error], [403, "not-shared"]);
  const br = await call("GET", "/api/knowledge/briefing?sessionID=ses_http&assistantMessages=0");
  assert.deepEqual([br.status, br.body], [200, { text: "", token: null }]); // nothing in the wiki yet
  const ack = await call("POST", "/api/knowledge/briefing/ack", { sessionID: "ses_http", token: "x" });
  assert.deepEqual([ack.status, ack.body.error], [409, "stale-token"]);
  const reset = await call("POST", "/api/knowledge/briefing/reset", { sessionID: "ses_http" });
  assert.deepEqual([reset.status, reset.body], [200, { ok: true }]);
  assert.equal((await call("GET", "/api/knowledge/nope")).status, 404);
  assert.equal((await call("GET", "/api/knowledge/notes")).status, 405);
  const other = http("GET", "/api/other");
  assert.equal(await handleKnowledgeRoute({ engine, ...other.args }), false);
  await engine.stop();
});

test("HTTP: disabled → 503 disabled for the tools, but the briefing never errors", async () => {
  const { engine } = await rig({ stored: { enabled: false } });
  await engine.start();
  const run = async (method, path, body) => {
    const h = http(method, path, body);
    await handleKnowledgeRoute({ engine, ...h.args });
    return h.out;
  };
  assert.deepEqual((await run("GET", "/api/knowledge/search?sessionID=ses_x1&query=x")).body.error, "disabled");
  assert.equal((await run("GET", "/api/knowledge/search?sessionID=ses_x1&query=x")).status, 503);
  const b = await run("GET", "/api/knowledge/briefing?sessionID=ses_x1");
  assert.deepEqual([b.status, b.body], [200, { text: "", token: null }]);
  await engine.stop();
});

test("maintenance runs the backfill and the missed-prefetch sweep and never throws", async () => {
  const { engine } = await rig();
  await engine.start();
  await engine.maintenance();
  assert.equal((await engine.status()).backfillDone, true);
  await engine.stop();
});

test("createKnowledgeEngine requires a config", () => {
  assert.throws(() => createKnowledgeEngine({}), /config/);
});
