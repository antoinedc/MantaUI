// contract.test.mjs — the seams between the knowledge server and its two clients, exercised end to end
// with the REAL engine and the REAL route/channel handlers (spec §11.2, §11.6):
//
//   • the V2 plugin's tools and briefing delivery (docs/opencode-plugins-v2/manta, transpiled and run
//     as-is) talking to `handleKnowledgeRoute` — their request shapes, the error bodies they read, the
//     200-with-`accepted:false` answer, a repeat ack;
//   • the desktop card's wire (`buildKnowledgeChannels`): flat settings + project rows + optional status
//     fields, `null` clearing an override, changes and undo shapes;
//   • the integration adapters index.mjs injects (user-authored evidence, forge access, band).
//
// No live opencode/tmux; a throwaway store dir per test.

import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpileTree } from "../../../scripts/opencode-v2/ts-loader.mjs";
import { isExemptPath } from "../auth.mjs";
import { createKnowledgeEngine } from "./engine.mjs";
import { buildKnowledgeChannels, handleKnowledgeRoute, toSettingsWire } from "./routes.mjs";
import { createBandOf, createForgeAdapters, createIsUserAuthored, createIsUserAuthoredRef, createKnowledgeRunner } from "./integration.mjs";
import { execGitRunner, makeRepo, tmpDir } from "./testHelpers.mjs";

let sqlite = true;
try {
  await import("node:sqlite");
} catch {
  sqlite = false;
}
const skip = sqlite ? false : "needs node:sqlite (Node 24)";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANTA_DIR = join(HERE, "..", "..", "..", "docs", "opencode-plugins-v2", "manta");
const stub = (code) => code.replace(/from\s+["']@opencode\/plugin["']/, `from "${pathToFileURL(join(HERE, "..", "..", "..", "scripts", "opencode-v2", "v2-plugin-stub.mjs")).href}"`);
const TOKEN = "ab12".repeat(8);
process.env.MANTA_SERVER_URL = "http://manta.test";
process.env.MANTA_BOX_TOKEN = TOKEN;

const tree = await transpileTree(MANTA_DIR, { rewrite: stub });
after(() => tree.cleanup());
// The card's own pure logic (statusLines, isOverride, changeWhere, describeUndoFailure), run on the box's real answers.
const cardTree = await transpileTree(join(HERE, "..", "..", "renderer", "settings"), { files: [join(HERE, "..", "..", "renderer", "settings", "knowledgeFormat.ts")] });
after(() => cardTree.cleanup());
const card = await import(pathToFileURL(join(cardTree.dir, "knowledgeFormat.mjs")).href);
const imp = (rel) => import(pathToFileURL(join(tree.dir, rel)).href);
const { allTools } = await imp("tools/index.mjs");
const { createBriefing } = await imp("lib/briefing.mjs");
const tool = (name) => allTools.find((t) => t.name === name);

const fakeLint = async () => ({ preset: { meta: { id: "p" } }, lintSource: async () => ({ messages: [] }) });
const started = (id) => ({ type: "session.execution.started", data: { sessionID: id } });

const engines = [];
async function rig({ sessions = {}, over = {}, repoRemote = "https://github.com/acme/widget.git" } = {}) {
  const dir = await tmpDir("knowledge-contract-");
  const repo = await makeRepo({ remote: repoRemote });
  let cfg = { knowledge: undefined };
  const notes = [];
  const clock = { t: Date.now() };
  const engine = createKnowledgeEngine({
    dir,
    git: execGitRunner(dir),
    config: { get: async () => cfg, update: async (p) => (cfg = { ...cfg, ...p }) },
    getSession: async (id) => (id in sessions ? sessions[id] : { directory: repo }),
    isCtoSession: async () => false,
    loadLint: fakeLint,
    secretValues: () => [],
    fireNotify: async (n) => notes.push(n),
    maintenanceMs: 3_600_000,
    log: () => {},
    listSessionsPage: async () => [],
    now: () => clock.t,
    ...over,
  });
  engines.push(engine);
  await engine.start();
  return { engine, dir, repo, notes, clock };
}
afterEach(async () => {
  while (engines.length) await engines.pop().stop();
});

/** A fetch that answers with the real route handler, so a client's exact request shape is what reaches it. */
function routeFetch(engine, log = []) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers });
    let out = null;
    const handled = await handleKnowledgeRoute({
      engine,
      req: { method },
      res: {},
      path: u.pathname,
      url: u,
      readJsonBody: async () => body,
      respondJson: (_res, status, b) => {
        out = { status, b };
      },
    });
    if (!handled || !out) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(out.b), { status: out.status });
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("plugin ↔ server (§11.2, §11.3)", { skip }, () => {
  test("knowledge_note: accepted, duplicate (200 accepted:false), a rejected note (400 invalid-note), an unmapped session", async () => {
    const { engine } = await rig({ sessions: { ses_unmapped: null } });
    const log = [];
    globalThis.fetch = routeFetch(engine, log);
    await engine.observeRaw(started("ses_one"));
    const note = tool("knowledge_note");
    const args = { kind: "howto", text: "Run npm test", refs: ["commit:abcdef1"] };
    assert.equal(await note.execute(args, { sessionID: "ses_one" }), "Noted.");
    assert.equal(log[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(log[0].body, { sessionID: "ses_one", kind: "howto", text: "Run npm test", refs: ["commit:abcdef1"] });
    assert.match(await note.execute(args, { sessionID: "ses_one" }), /^Not noted: Already noted\./);
    const bad = await note.execute({ ...args, refs: ["no-such-ref-shape"] }, { sessionID: "ses_one" });
    assert.match(bad, /^Not noted: the note was rejected \(/);
    assert.match(await note.execute({ ...args, text: "other" }, { sessionID: "ses_unmapped" }), /^Not noted: .*isn't part of a known project/);
  });

  test("every knowledge route answers 'disabled' (503) in the plugin's vocabulary when the switch is off", async () => {
    const { engine } = await rig();
    globalThis.fetch = routeFetch(engine);
    await engine.observeRaw(started("ses_one"));
    await engine.settingsSet({ enabled: false });
    assert.match(await tool("knowledge_note").execute({ kind: "howto", text: "x", refs: ["commit:abcdef1"] }, { sessionID: "ses_one" }), /switched off/);
    assert.match(await tool("knowledge_search").execute({ query: "x" }, { sessionID: "ses_one" }), /switched off/);
    assert.match(await tool("knowledge_read").execute({ ref: "page:user/preferences.md" }, { sessionID: "ses_one" }), /switched off/);
  });

  test("knowledge_search sends `sources` as one comma-separated param and renders hits; knowledge_read reads the ref back", async () => {
    const { engine } = await rig();
    const log = [];
    globalThis.fetch = routeFetch(engine, log);
    await engine.observeRaw(started("ses_one"));
    await engine.store.commit({ path: "user/preferences.md", content: "---\ntitle: Preferences\nverified: 2026-11-16\nsources: [commit:abcdef1]\n---\nAlways use pnpm, never npm.\n", message: "seed" });
    await engine.refreshDerived();
    const out = await tool("knowledge_search").execute({ query: "pnpm", sources: ["wiki", "sessions"], limit: 5 }, { sessionID: "ses_one" });
    assert.deepEqual(log[0].query, { sessionID: "ses_one", query: "pnpm", scope: "project", sources: "wiki,sessions", limit: "5" });
    assert.match(out, /ref: page:user\/preferences\.md/);
    const read = await tool("knowledge_read").execute({ ref: "page:user/preferences.md" }, { sessionID: "ses_one" });
    assert.match(read, /# Preferences/);
    assert.match(read, /Always use pnpm/);
    assert.match(await tool("knowledge_read").execute({ ref: "page:user/missing.md" }, { sessionID: "ses_one" }), /^Read failed: Not found/);
  });

  test("briefing: prefetch → append → ack → the same bytes; a repeat ack is fine; a stale token is a 409 the plugin tolerates", async () => {
    const { engine } = await rig();
    const log = [];
    globalThis.fetch = routeFetch(engine, log);
    await engine.observeRaw(started("ses_one"));
    const slug = engine.sessionMap.get("ses_one").slug;
    await engine.store.commit({ path: `projects/${slug}/rules.md`, content: "- Use pnpm\n", message: "rules" });
    engine.layer.rules.track({ slug, text: "Use pnpm", reason: "confirmed" });
    await engine.store.commit({ path: `projects/${slug}/overview.md`, content: "# Widget\n\n## Briefing\nA small widget service.\n", message: "overview" });
    await engine.refreshDerived();

    const b = createBriefing({
      fetch: (u, i) => globalThis.fetch(u, i),
      base: () => "http://manta.test",
      headers: (body) => ({ ...(body ? { "content-type": "application/json" } : {}), authorization: `Bearer ${TOKEN}` }),
      directory: () => undefined,
      waitMs: 2000,
    });
    const system = [{ type: "text", text: "identity" }];
    await b.onContext({ sessionID: "ses_one", system, messages: [] });
    await b.flush();
    assert.equal(system.length, 2);
    assert.match(system[1].text, /Standing rules from the user for this project:\n- Use pnpm/);
    assert.match(system[1].text, /A small widget service\./);
    assert.equal(engine.briefings.weekStats().served, 1);

    // The server hands the same bytes to a repeated request, and a repeat ack is idempotent.
    const again = await globalThis.fetch("http://manta.test/api/knowledge/briefing?sessionID=ses_one&assistantMessages=3").then((r) => r.json());
    assert.equal(again.text, system[1].text);
    const ack = await globalThis.fetch("http://manta.test/api/knowledge/briefing/ack", { method: "POST", body: JSON.stringify({ sessionID: "ses_one", token: again.token }), headers: {} });
    assert.equal(ack.status, 200);
    const stale = await globalThis.fetch("http://manta.test/api/knowledge/briefing/ack", { method: "POST", body: JSON.stringify({ sessionID: "ses_one", token: "nope" }), headers: {} });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "stale-token");
    assert.equal(engine.briefings.weekStats().served, 1);
  });

  test("the briefing route never errors for a client: a broken lookup answers {text:'', token:null}", async () => {
    const { engine } = await rig();
    globalThis.fetch = routeFetch({ ...engine, briefing: async () => { throw new Error("boom"); } });
    const r = await globalThis.fetch("http://manta.test/api/knowledge/briefing?sessionID=ses_one").then((x) => x.json());
    assert.deepEqual(r, { text: "", token: null });
  });

  test("/api/knowledge/* is behind the auth gate like every other /api route", () => {
    for (const p of ["/api/knowledge/notes", "/api/knowledge/search", "/api/knowledge/page", "/api/knowledge/briefing", "/api/knowledge/briefing/ack", "/api/knowledge/briefing/reset"]) {
      assert.equal(isExemptPath(p), false, p);
    }
  });
});

describe("desktop card ↔ server (§11.6)", { skip }, () => {
  test("settings-get is flat: defaults + one row per project with override flags, outward availability, and only the status fields it can say", async () => {
    const { engine } = await rig({ over: { hasForgeLogin: async () => true, getRepoAccess: async () => ({ canPush: true, isFork: false, defaultBranch: "main" }) } });
    const ch = buildKnowledgeChannels(engine);
    await engine.observeRaw(started("ses_one"));
    const slug = engine.sessionMap.get("ses_one").slug;
    const s = await ch["knowledge:settings-get"]();
    assert.equal(s.enabled, true);
    assert.equal(s.dailyCapUsd, 1);
    assert.equal(s.repoRules, "box-only");
    assert.equal(s.sharing, "share-and-read");
    assert.ok(!("status" in s));
    assert.equal(s.spentTodayUsd, 0);
    assert.equal(s.sessionsWithoutBriefingThisWeek, 0);
    assert.ok(!("unavailableReason" in s) && !("waitingForCapableModel" in s));
    assert.equal(s.projects.length, 1);
    assert.deepEqual(s.projects[0], { slug, displayName: "widget", canonicalId: "github.com/acme/widget", repoRules: "box-only", sharing: "share-and-read", repoRulesOverride: false, sharingOverride: false, outwardAllowed: true });

    // an override sets the flag; `null` for a key (or the project) deletes it
    const set = await ch["knowledge:settings-set"]({ patch: { projects: { [slug]: { sharing: "private", repoRules: "pull-request" } } } });
    assert.equal(set.projects[0].sharing, "private");
    assert.equal(set.projects[0].sharingOverride, true);
    assert.equal(set.projects[0].repoRulesOverride, true);
    const cleared = await ch["knowledge:settings-set"]({ patch: { projects: { [slug]: { sharing: null } } } });
    assert.equal(cleared.projects[0].sharingOverride, false);
    assert.equal(cleared.projects[0].repoRulesOverride, true);
    const gone = await ch["knowledge:settings-set"]({ patch: { projects: { [slug]: null } } });
    assert.equal(gone.projects[0].repoRulesOverride, false);
    assert.equal(gone.projects[0].repoRules, "box-only");
  });

  test("a project without a forge login says why outward modes are off; the invalid patch is a 400 the card shows", async () => {
    const { engine } = await rig();
    const ch = buildKnowledgeChannels(engine);
    await engine.observeRaw(started("ses_one"));
    const s = await ch["knowledge:settings-get"]();
    assert.equal(s.projects[0].outwardAllowed, false);
    assert.ok(s.projects[0].outwardReason.length > 0);
    await assert.rejects(ch["knowledge:settings-set"]({ patch: { projects: { [s.projects[0].slug]: { repoRules: "direct" } } } }), (e) => e.rpcStatus === 400 && /aren't available/.test(e.message));
    await assert.rejects(ch["knowledge:settings-set"]({ patch: { dailyCapUsd: -1 } }), (e) => e.rpcStatus === 400);
  });

  test("status fields come from the engine: spend, briefings missed, unavailable (no node:sqlite), waiting for a capable model", async () => {
    const { engine, clock } = await rig();
    const ch = buildKnowledgeChannels(engine);
    await engine.budget.record({ taskClass: "knowledge-capture", model: { providerID: "p", modelID: "m" }, usd: 0.25 });
    engine.briefings.noteMissed();
    engine.briefings.noteMissed();
    let s = await ch["knowledge:settings-get"]();
    assert.equal(s.spentTodayUsd, 0.25);
    assert.equal(s.sessionsWithoutBriefingThisWeek, 2);
    assert.ok(!("waitingForCapableModel" in s));

    // work blocked for > 24 h on `no-qualifying-model`, no decision evaluated since → the card says so
    const real = clock.t;
    clock.t = real - 30 * 3600 * 1000;
    engine.changesLog.add({ kind: "waiting", summary: "Rule work is waiting", reason: "No model in the deep band", data: { code: "no-qualifying-model" } });
    clock.t = real;
    s = await ch["knowledge:settings-get"]();
    assert.equal(s.waitingForCapableModel, true);
    engine.changesLog.add({ kind: "applied", summary: "Added a rule", reason: "r" });
    s = await ch["knowledge:settings-get"]();
    assert.ok(!("waitingForCapableModel" in s));

    const off = await rig({ over: { importSqlite: async () => { throw new Error("no sqlite"); } } });
    const offCh = buildKnowledgeChannels(off.engine);
    const u = await offCh["knowledge:settings-get"]();
    assert.match(u.unavailableReason, /Node 24/);
    assert.deepEqual(u.projects, []);
  });

  test("changes always carry an area string and undo reports a conflict as one readable phrase", async () => {
    const { engine } = await rig({ over: { undo: async () => ({ ok: false, reason: "A later change touched the same page.", conflictWith: { sha: "0123456789abcdef", subject: "Rewrote the release runbook" } }) } });
    const ch = buildKnowledgeChannels(engine);
    const id = engine.changesLog.add({ kind: "applied", summary: "Added how to release", reason: "Needed twice", undoable: true });
    const page = await ch["knowledge:changes"]({});
    assert.equal(page.items[0].area, "");
    assert.equal(page.items[0].undoable, true);
    assert.deepEqual(await ch["knowledge:undo"]({ id }), { ok: false, reason: "A later change touched the same page.", conflictWith: "Rewrote the release runbook (0123456)" });
    const after = await ch["knowledge:changes"]({});
    assert.match(after.items[0].error, /later change/);
    assert.deepEqual(await ch["knowledge:undo"]({ id: "c_nope" }), { ok: false, reason: "That change no longer exists." });
  });

  test("seam: an undo that worked WITH a warning reaches the card through knowledge:undo (and only then)", async () => {
    let n = 0;
    const { engine } = await rig({ over: { undo: async () => ({ ok: true, ...(n++ === 0 ? { warning: "Undone in the store, but the global file couldn't be updated (EACCES); it will be retried." } : {}) }) } });
    const ch = buildKnowledgeChannels(engine);
    const a = engine.changesLog.add({ kind: "applied", summary: "A", reason: "r", undoable: true });
    const b = engine.changesLog.add({ kind: "applied", summary: "B", reason: "r", undoable: true });
    assert.deepEqual(await ch["knowledge:undo"]({ id: a }), { ok: true, warning: "Undone in the store, but the global file couldn't be updated (EACCES); it will be retried." });
    assert.deepEqual(await ch["knowledge:undo"]({ id: b }), { ok: true });
  });

  test("the card's own logic reads the box's answers: override flags, status lines, outward note, change location, undo refusal", async () => {
    const { engine } = await rig({ over: { hasForgeLogin: async () => false, getRepoAccess: async () => null, undo: async () => ({ ok: false, reason: "A later change touched the same page.", conflictWith: { sha: "0123456789abcdef", subject: "Rewrote the release runbook" } }) } });
    const ch = buildKnowledgeChannels(engine);
    await engine.observeRaw(started("ses_one"));
    await engine.budget.record({ taskClass: "knowledge-capture", model: { providerID: "p", modelID: "m" }, usd: 0.25 });
    const slug = engine.sessionMap.get("ses_one").slug;
    await ch["knowledge:settings-set"]({ patch: { projects: { [slug]: { sharing: "private" } } } });
    const s = await ch["knowledge:settings-get"]();
    const row = s.projects[0];
    assert.equal(card.isOverride(row, "sharing", s), true);
    assert.equal(card.isOverride(row, "repoRules", s), false);
    assert.equal(card.outwardLost(row), false);
    assert.equal(row.outwardAllowed, false);
    assert.match(row.outwardReason, /No GitHub login/);
    const lines = card.statusLines(s);
    assert.deepEqual(lines.map((l) => l.id), ["spend", "briefing"]);
    assert.match(lines[0].text, /Spent \$0\.25 of the \$1\.00 daily cap today/);
    assert.match(lines[1].text, /Every session this week started with a briefing/);

    const id = engine.changesLog.add({ kind: "applied", summary: "Added how to release", reason: "r", undoable: true });
    const [item] = (await ch["knowledge:changes"]({})).items;
    assert.equal(card.changeWhere(item, s.projects), "Knowledge");
    assert.equal(card.changeWhere({ area: "project", slug }, s.projects), "Project: widget");
    const refusal = await ch["knowledge:undo"]({ id });
    assert.equal(refusal.ok, false);
    const text = card.describeUndoFailure(refusal);
    assert.match(text, /A later change touched the same page\./);
    assert.match(text, /\(Rewrote the release runbook \(0123456\)\)/);
    assert.doesNotMatch(text, /\[object Object\]/);
  });

  test("toSettingsWire passes a payload with no status through unchanged", () => {
    assert.deepEqual(toSettingsWire({ enabled: true, projects: [] }, null), { enabled: true, projects: [] });
  });
});

describe("engine wiring (index.mjs adapters)", { skip }, () => {
  test("the post-upgrade notification fires once, across restarts, and only when the feature is on", async () => {
    const a = await rig();
    assert.equal(a.notes.length, 1);
    assert.equal(a.notes[0].tag, "knowledge-upgrade");
    // a second start over the same store (a restart) does not notify again
    const notes = [];
    const again = createKnowledgeEngine({ dir: a.dir, git: execGitRunner(a.dir), config: { get: async () => ({}), update: async () => {} }, getSession: async () => null, isCtoSession: async () => false, loadLint: fakeLint, secretValues: () => [], fireNotify: async (n) => notes.push(n), maintenanceMs: 3_600_000, log: () => {}, listSessionsPage: async () => [] });
    engines.push(again);
    await again.start();
    assert.equal(notes.length, 0);
  });

  test("a session pinned from its first prompt event is the only mapping path; notes then reach the queue as derived/user per the origin record", async () => {
    const origins = new Map();
    const promptOrigins = { getRecord: (mid) => (origins.has(mid) ? { origin: origins.get(mid), sessionID: "ses_one" } : null) };
    const { engine } = await rig({ over: { isUserAuthoredRef: createIsUserAuthoredRef(promptOrigins, { readRole: async () => "user" }) } });
    await engine.observeRaw(started("ses_one"));
    const slug = engine.sessionMap.get("ses_one").slug;
    origins.set("msg_user1", "user");
    origins.set("msg_sched1", "schedule");
    await engine.enqueueNote({ sessionID: "ses_one", kind: "preference", text: "Use pnpm", refs: ["msg:ses_one/msg_user1"] });
    await engine.enqueueNote({ sessionID: "ses_one", kind: "howto", text: "Run pnpm test", refs: ["msg:ses_one/msg_sched1"] });
    const q = await engine.queue.list(slug);
    assert.deepEqual(q.map((n) => [n.text, n.derived]), [["Use pnpm", false], ["Run pnpm test", true]]);
  });

  test("createIsUserAuthoredRef: msg/part refs resolve to the message; the record must be a user origin in the ref's own session on a message opencode stores as role user", async () => {
    const recs = {
      msg_ok: { origin: "user", sessionID: "ses_a" },
      msg_asst: { origin: "user", sessionID: "ses_a" }, // a re-posted assistant id that got recorded anyway
      msg_other_session: { origin: "user", sessionID: "ses_b" },
      msg_sched: { origin: "schedule", sessionID: "ses_a" },
    };
    const roles = { "ses_a/msg_ok": "user", "ses_a/msg_asst": "assistant", "ses_a/msg_other_session": "user", "ses_a/msg_sched": "user" };
    const f = createIsUserAuthoredRef({ getRecord: (m) => recs[m] ?? null }, { readRole: async (s, m) => roles[`${s}/${m}`] ?? null });
    assert.equal(await f("msg:ses_a/msg_ok"), true);
    assert.equal(await f("msg:ses_a/msg_asst"), false, "reused assistant id stays not user-authored");
    assert.equal(await f("msg:ses_a/msg_other_session"), false, "record belongs to another session: refused");
    assert.equal(await f("msg:ses_b/msg_other_session"), false, "role lookup finds no such message there");
    assert.equal(await f("msg:ses_a/msg_sched"), false);
    assert.equal(await f("msg:ses_a/msg_other"), false);
    assert.equal(await f("commit:abcdef1"), false);
    assert.equal(await f("file:/etc/passwd"), false);
    assert.equal(await f(undefined), false);
    assert.equal(await createIsUserAuthoredRef({ getRecord: () => { throw new Error("x"); } })("msg:ses_a/msg_ok"), false);
    assert.equal(await createIsUserAuthoredRef({ getRecord: () => recs.msg_ok }, { readRole: async () => { throw new Error("down"); } })("msg:ses_a/msg_ok"), false, "an unreadable role fails closed");
  });

  test("createIsUserAuthored: user origin, and the record's session must match when the caller names one", () => {
    const f = createIsUserAuthored({ getRecord: (m) => ({ msg_1: { origin: "user", sessionID: "ses_a" }, msg_2: { origin: "unknown", sessionID: "ses_a" } })[m] ?? null });
    assert.equal(f("msg_1"), true);
    assert.equal(f("msg_1", { sessionID: "ses_a" }), true);
    assert.equal(f("msg_1", { sessionID: "ses_b" }), false);
    assert.equal(f("msg_2"), false);
    assert.equal(f("msg_3"), false);
  });

  test("createForgeAdapters: access maps ok → {canPush,isFork,defaultBranch}, every failure → null; login resolves per host", async () => {
    const seen = [];
    const a = createForgeAdapters({
      forgeRepoAccess: async (t) => (seen.push(t), t === "github.com/acme/w" ? { ok: true, canPush: true, isFork: false, defaultBranch: "main", kind: "github", host: "github.com", repoKey: t, stale: false } : { ok: false, error: "not_connected", message: "x" }),
      resolveToken: async (host) => (host === "github.com" ? { token: "t" } : null),
    });
    assert.deepEqual(await a.getRepoAccess({ kind: "github", host: "github.com", owner: "acme", repo: "w" }), { canPush: true, isFork: false, defaultBranch: "main" });
    assert.equal(await a.getRepoAccess({ kind: "gitlab", host: "gitlab.example.com", owner: "acme", repo: "w" }), null);
    assert.equal(await a.getRepoAccess({}), null);
    assert.equal(await a.hasForgeLogin("github", "github.com"), true);
    assert.equal(await a.hasForgeLogin("gitlab", "gitlab.example.com"), false);
    assert.equal(await a.hasForgeLogin("github"), true);
    assert.deepEqual(seen, ["github.com/acme/w", "gitlab.example.com/acme/w"]);
  });

  test("createKnowledgeRunner hands knowledge callers the real per-kind usage as `tokens` (+ usd), the estimate number otherwise", async () => {
    const seen = [];
    const inner = async ({ deps }) => {
      await deps.reportCost({ taskClass: "curator-notes", tokens: 5550, usage: { input: 1000, output: 200, reasoning: 50, cacheRead: 4000, cacheWrite: 300 }, usd: 0.07, estimated: false });
      await deps.reportCost({ taskClass: "curator-notes", tokens: 400, estimated: true });
      return { text: "ok" };
    };
    const run = createKnowledgeRunner({ runEphemeral: inner, oc: {}, configGet: async () => ({}) });
    await run({ taskClass: "curator-notes", deps: { reportCost: async (c) => seen.push(c) } });
    assert.deepEqual(seen[0].tokens, { input: 1000, output: 200, reasoning: 50, cacheRead: 4000, cacheWrite: 300 });
    assert.equal(seen[0].usd, 0.07);
    assert.equal(seen[1].tokens, 400);
  });

  test("createBandOf: the family's router band, else null", () => {
    const band = createBandOf((p, m) => (m === "haiku" ? { tier: "fast" } : null));
    assert.equal(band("anthropic", "haiku"), "fast");
    assert.equal(band("x", "mystery"), null);
  });
});
