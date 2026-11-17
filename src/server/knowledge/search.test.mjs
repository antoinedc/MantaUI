import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageReader, createPageIndex, createSearch, significantTerms } from "./search.mjs";
import { createSettings } from "./settings.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const A = "alpha-0123456789"; // the caller's project
const B = "beta-9876543210"; // share-and-read
const C = "gamma-1111111111"; // private
const D = "delta-2222222222"; // read-only

const fm = (title, body) => `---\ntitle: ${title}\nverified: 2026-11-01\nsources: [commit:abcdef1]\n---\n${body}\n`;
const PAGES = {
  "user/preferences.md": fm("Preferences", "The user prefers tabs over spaces always."),
  "commons/howto/deploy.md": fm("Deploy anywhere", "Generic deploy steps: tag the release and push."),
  [`projects/${A}/runbooks/release.md`]: fm("Release alpha", "Alpha release: tag the release then verify."),
  [`projects/${B}/runbooks/release.md`]: fm("Release beta", "Beta release: tag the release then push the tag."),
  [`projects/${C}/runbooks/release.md`]: fm("Release gamma", "Gamma private release: tag the release by hand."),
  [`projects/${D}/runbooks/release.md`]: fm("Release delta", "Delta read-only release: tag the release."),
};

// A scanner that masks `sk-…` tokens, standing in for the engine's secretlint-backed one.
const fakeScanner = { redact: async (t) => ({ text: String(t).replace(/sk-[A-Za-z0-9]{6,}/g, "[REDACTED]"), unavailable: false }) };

async function rig({ stored, mappedSessions = {}, transcripts, messages, scanner = fakeScanner } = {}) {
  const state = await memState();
  const dir = await tmpDir("knowledge-search-");
  const store = { dir, read: async (p) => PAGES[p] ?? null, listPages: async () => Object.keys(PAGES).sort() };
  const reg = [A, B, C, D].map((slug) => ({ slug, displayName: slug.split("-")[0], canonicalId: `github.com/o/${slug.split("-")[0]}` }));
  const registry = { list: async () => reg, get: async (s) => reg.find((p) => p.slug === s) ?? null };
  const cfg = { knowledge: stored ?? { projects: { [C]: { sharing: "private" }, [D]: { sharing: "read-only" } } } };
  const settings = createSettings({ config: { get: async () => cfg, update: async () => {} }, registry });
  const sessions = { ses_a: { slug: A, directory: "/a" }, ses_b: { slug: B, directory: "/b" }, ses_c: { slug: C, directory: "/c" }, ses_d: { slug: D, directory: "/d" }, ...mappedSessions };
  const sessionMap = {
    get: (id) => (sessions[id] ? { slug: sessions[id].slug, directory: sessions[id].directory } : null),
    directoriesFor: (slugs) => [...new Set(Object.values(sessions).filter((s) => slugs.includes(s.slug)).map((s) => s.directory))],
  };
  const calls = [];
  const search = createSearch({
    state,
    store,
    registry,
    sessionMap,
    settings,
    searchTranscripts: transcripts ? async (a) => (calls.push(a), transcripts(a)) : undefined,
    readMessages: messages,
    scanner,
  });
  await createPageIndex({ state, store }).rebuild();
  return { search, calls, state, sessions };
}

const refs = (r) => r.hits.map((h) => h.ref);

test("project scope: own project wiki + user wiki + commons; never another project", async () => {
  const { search } = await rig();
  const r = await search.search({ sessionID: "ses_a", query: "tag the release" });
  assert.ok(refs(r).includes(`page:projects/${A}/runbooks/release.md`));
  assert.ok(refs(r).includes("page:commons/howto/deploy.md"));
  assert.ok(!refs(r).some((x) => x.includes(B) || x.includes(C) || x.includes(D)));
  const u = await search.search({ sessionID: "ses_a", query: "tabs spaces" });
  assert.deepEqual(refs(u), ["page:user/preferences.md"]);
  assert.deepEqual(Object.keys(u.hits[0]).sort(), ["at", "project", "ref", "snippet", "source", "title"]);
  assert.equal(u.hits[0].project, "user");
});

test("scope all obeys §4.2: other share-and-read projects appear; private and read-only projects never do", async () => {
  const { search } = await rig();
  const r = await search.search({ sessionID: "ses_a", query: "tag the release", scope: "all", limit: 20 });
  const rs = refs(r);
  assert.ok(rs.includes(`page:projects/${B}/runbooks/release.md`));
  assert.ok(!rs.some((x) => x.includes(C)), "private project leaked");
  assert.ok(!rs.some((x) => x.includes(D)), "read-only project leaked");
});

test("a read-only caller reads commons and others; a private caller reads only its own project and the user wiki", async () => {
  const { search } = await rig();
  const ro = refs(await search.search({ sessionID: "ses_d", query: "tag the release", scope: "all", limit: 20 }));
  assert.ok(ro.includes("page:commons/howto/deploy.md"));
  assert.ok(ro.includes(`page:projects/${B}/runbooks/release.md`));
  const priv = refs(await search.search({ sessionID: "ses_c", query: "tag the release", scope: "all", limit: 20 }));
  assert.ok(!priv.includes("page:commons/howto/deploy.md"));
  assert.ok(!priv.some((x) => x.includes(B) || x.includes(A)));
  assert.ok(priv.includes(`page:projects/${C}/runbooks/release.md`));
  assert.ok(refs(await search.search({ sessionID: "ses_c", query: "tabs spaces", scope: "all" })).includes("page:user/preferences.md"));
});

test("an unmapped caller is private: user wiki only", async () => {
  const { search } = await rig();
  const r = await search.search({ sessionID: "ses_unknown", query: "tag the release", scope: "all", limit: 20 });
  assert.deepEqual(refs(r), []);
  assert.deepEqual(refs(await search.search({ sessionID: "ses_unknown", query: "tabs spaces" })), ["page:user/preferences.md"]);
});

test("multi-word queries fall back to any-term when no page has every word", async () => {
  const { search } = await rig();
  const r = await search.search({ sessionID: "ses_a", query: "tabs nonexistentword", sources: ["wiki"] });
  assert.deepEqual(refs(r), ["page:user/preferences.md"]);
});

test("transcripts: asks for any-term over exactly the readable projects' directories; drops hits from unmapped or unreadable sessions", async () => {
  const { search, calls } = await rig({
    transcripts: async () => ({
      truncated: true,
      hits: [
        { sessionID: "ses_a", messageID: "msg_1", snippet: "mine", at: 5, title: "My session" },
        { sessionID: "ses_b", messageID: "msg_2", snippet: "beta thing", at: 9 },
        { sessionID: "ses_c", messageID: "msg_3", snippet: "private thing", at: 8 },
        { sessionID: "ses_unmapped", messageID: "msg_4", snippet: "who knows", at: 7 },
      ],
    }),
  });
  const project = await search.search({ sessionID: "ses_a", query: "release", sources: ["sessions"] });
  assert.deepEqual(calls[0].directories, ["/a"]);
  assert.equal(calls[0].anyTerms, true);
  assert.deepEqual(refs(project), ["msg:ses_a/msg_1"]); // b is out of project scope
  assert.equal(project.truncated, true);
  const all = await search.search({ sessionID: "ses_a", query: "release", scope: "all", sources: ["sessions"] });
  assert.deepEqual(calls[1].directories.sort(), ["/a", "/b", "/d"].filter((d) => d !== "/d")); // D is read-only → not visible to others
  assert.deepEqual(refs(all), ["msg:ses_b/msg_2", "msg:ses_a/msg_1"]); // newest first; c (private) and unmapped dropped
  assert.equal(all.hits[0].source, "sessions");
  assert.equal(all.hits[0].project, B);
});

test("limit and truncated; validation errors are 400 invalid-query", async () => {
  const { search } = await rig();
  const r = await search.search({ sessionID: "ses_a", query: "release", scope: "all", limit: 1, sources: ["wiki"] });
  assert.equal(r.hits.length, 1);
  assert.equal(r.truncated, true);
  for (const bad of [{ query: "" }, { query: "x".repeat(201) }, { query: "ok", scope: "world" }, { query: "ok", sources: ["x"] }, { query: "ok", sources: [] }, { query: "ok", limit: 0 }, { query: "ok", limit: 21 }, { query: "ok", limit: 1.5 }]) {
    await assert.rejects(search.search({ sessionID: "ses_a", ...bad }), (e) => e.code === "invalid-query" && e.status === 400, JSON.stringify(bad));
  }
});

test("FTS metacharacters in the query are literal text, never syntax errors", async () => {
  const { search } = await rig();
  for (const q of ['"unbalanced', "a AND (b", "tab*", "col:umn", "NEAR(x y)"]) await search.search({ sessionID: "ses_a", query: q, sources: ["wiki"] });
});

test("page: returns title/body/verified/sources and counts the use; sharing is enforced; missing is 404", async () => {
  const { search, state } = await rig();
  const p = await search.page({ sessionID: "ses_a", ref: `page:projects/${A}/runbooks/release.md` });
  assert.equal(p.kind, "page");
  assert.equal(p.title, "Release alpha");
  assert.equal(p.verified, "2026-11-01");
  assert.deepEqual(p.sources, ["commit:abcdef1"]);
  assert.match(p.body, /Alpha release/);
  assert.equal(state.db.prepare("SELECT uses FROM page_use WHERE path = ?").get(`projects/${A}/runbooks/release.md`).uses, 1);
  await assert.rejects(search.page({ sessionID: "ses_a", ref: `page:projects/${C}/runbooks/release.md` }), (e) => e.code === "not-shared" && e.status === 403);
  await assert.rejects(search.page({ sessionID: "ses_c", ref: "page:commons/howto/deploy.md" }), (e) => e.status === 403);
  assert.equal((await search.page({ sessionID: "ses_a", ref: `page:projects/${B}/runbooks/release.md` })).kind, "page"); // B shares
  await assert.rejects(search.page({ sessionID: "ses_a", ref: "page:user/missing.md" }), (e) => e.code === "not-found" && e.status === 404);
  for (const bad of ["page:../../etc/passwd", "page:user/../x.md", "file:/etc/passwd", "url:https://x.y", "commit:abcdef1", "", undefined]) await assert.rejects(search.page({ sessionID: "ses_a", ref: bad }), (e) => e.status === 404, String(bad));
});

test("session refs: ±5 neighbourhood capped at 2000 chars; own session always readable; unmapped/private sessions are 403", async () => {
  const seen = [];
  const { search } = await rig({
    mappedSessions: { ses_own_unmapped_caller: undefined },
    messages: async (a) => (seen.push(a), [{ id: "msg_1", role: "user", text: "x".repeat(5000), at: 1 }, { id: "msg_2", role: "assistant", text: "ok", at: 2 }]),
  });
  const r = await search.page({ sessionID: "ses_a", ref: "msg:ses_b/msg_2" });
  assert.equal(r.kind, "session");
  assert.equal(r.sessionID, "ses_b");
  assert.equal(r.messages[0].text.length, 2000);
  assert.deepEqual(seen[0], { sessionID: "ses_b", messageIDs: ["msg_2"], radius: 5 });
  await assert.rejects(search.page({ sessionID: "ses_a", ref: "msg:ses_c/msg_2" }), (e) => e.code === "not-shared");
  await assert.rejects(search.page({ sessionID: "ses_a", ref: "msg:ses_nobody/msg_2" }), (e) => e.code === "not-shared");
  assert.equal((await search.page({ sessionID: "ses_c", ref: "msg:ses_c/msg_2" })).kind, "session"); // own, even though private
  assert.equal((await search.page({ sessionID: "ses_zzz", ref: "msg:ses_zzz/msg_2" })).kind, "session"); // own and unmapped
  await search.page({ sessionID: "ses_a", ref: "part:ses_b/part_abc123x0002" });
  assert.deepEqual(seen.at(-1).messageIDs, ["msg_abc123", "abc123"]);
});

test("createMessageReader: ±radius around the message, text parts only", async () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ info: { id: `msg_${i}`, role: i % 2 ? "assistant" : "user", time: { created: i } }, parts: [{ type: "text", text: `t${i}` }, { type: "tool", text: "ignored" }] }));
  const read = createMessageReader({ listMessages: async () => msgs });
  const r = await read({ sessionID: "s", messageIDs: ["nope", "msg_10"], radius: 5 });
  assert.deepEqual(r.map((m) => m.id), Array.from({ length: 11 }, (_, i) => `msg_${i + 5}`));
  assert.equal(r[5].text, "t10");
  assert.equal(r[5].role, "user");
  assert.equal(await read({ sessionID: "s", messageIDs: ["msg_99"] }), null);
});

// ---- transcript text that leaves a project is secret-redacted (review finding 3) ----

const SECRET_HIT = (id) => ({ sessionID: id, messageID: "msg_1", partID: "prt_1", snippet: "export TOKEN=sk-abcdef123456 then deploy", at: 5 });

test("search snippets from ANOTHER project are redacted; the caller's own project's are shown as is", async () => {
  const { search } = await rig({ transcripts: async () => ({ hits: [SECRET_HIT("ses_b"), SECRET_HIT("ses_a")], truncated: false }) });
  const r = await search.search({ sessionID: "ses_a", query: "deploy", scope: "all", sources: ["sessions"] });
  const byProject = Object.fromEntries(r.hits.map((h) => [h.project, h.snippet]));
  assert.equal(byProject[B], "export TOKEN=[REDACTED] then deploy");
  assert.equal(byProject[A], "export TOKEN=sk-abcdef123456 then deploy");
});

test("scanner unavailable (or absent): other projects' snippets are omitted, never shown raw; the caller's own still show", async () => {
  for (const scanner of [{ redact: async () => ({ text: "x", unavailable: true }) }, { redact: async () => { throw new Error("down"); } }, null]) {
    const { search } = await rig({ scanner, transcripts: async () => ({ hits: [SECRET_HIT("ses_b"), SECRET_HIT("ses_a")], truncated: false }) });
    const r = await search.search({ sessionID: "ses_a", query: "deploy", scope: "all", sources: ["sessions"] });
    const byProject = Object.fromEntries(r.hits.map((h) => [h.project, h.snippet]));
    assert.equal(byProject[B], "");
    assert.match(byProject[A], /sk-abcdef123456/);
  }
});

test("the page() message neighbourhood of another project's session is redacted; own session and own project are not; unavailable scanner omits", async () => {
  const messages = async ({ sessionID }) => [{ id: "msg_1", role: "user", text: `key sk-abcdef123456 in ${sessionID}`, at: 1 }];
  const { search } = await rig({ messages });
  const other = await search.page({ sessionID: "ses_a", ref: "msg:ses_b/msg_1" });
  assert.equal(other.messages[0].text, "key [REDACTED] in ses_b");
  const own = await search.page({ sessionID: "ses_a", ref: "msg:ses_a/msg_1" });
  assert.equal(own.messages[0].text, "key sk-abcdef123456 in ses_a");
  const sameProject = await rig({ messages, mappedSessions: { ses_a2: { slug: A, directory: "/a" } } });
  assert.match((await sameProject.search.page({ sessionID: "ses_a", ref: "msg:ses_a2/msg_1" })).messages[0].text, /sk-abcdef123456/);
  const down = await rig({ messages, scanner: { redact: async () => ({ text: "", unavailable: true }) } });
  const omitted = await down.search.page({ sessionID: "ses_a", ref: "msg:ses_b/msg_1" });
  assert.equal(omitted.messages[0].text, "");
  assert.equal(omitted.messages[0].id, "msg_1");
});

// ---- any-term queries drop short words and stop words ----


test("significantTerms drops terms under 3 characters and common stop words, but never empties a query", () => {
  assert.deepEqual(significantTerms(["how", "do", "we", "deploy", "the", "widget", "to", "k8s"]), ["deploy", "widget", "k8s"]);
  assert.deepEqual(significantTerms(["Is", "the", "a"]), ["Is", "the", "a"], "only filler: keep what was asked");
  assert.deepEqual(significantTerms(["(pnpm)", "and", "release."]), ["(pnpm)", "release."]);
});

test("the transcript query handed to the index has the filler removed; the wiki OR fallback ranks on the same terms", async () => {
  const { search, calls } = await rig({ transcripts: async () => ({ hits: [], truncated: false }) });
  await search.search({ sessionID: "ses_a", query: "how do we tag the release in pnpm", sources: ["sessions"] });
  assert.equal(calls[0].query, "tag release pnpm");
  assert.equal(calls[0].anyTerms, true);
  // wiki: no page has every word ("zzz" matches nothing), so the OR fallback runs on the significant terms only
  const r = await search.search({ sessionID: "ses_a", query: "the of zzzqq release", sources: ["wiki"] });
  assert.ok(refs(r).includes(`page:projects/${A}/runbooks/release.md`));
});
