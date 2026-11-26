// The research library (docs/superpowers/specs/2026-11-24-research-library.md): the store, `research_library_find` and
// `research_library_save`, scope isolation, the quote check, private → project, and the guidance every agent task gets.
// The binding, the source store and the clock are injected; the files live in a temp folder.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchLibrary, RESEARCH_GUIDANCE, withResearchGuidance, LIBRARY_MAX_ENTRIES, independentSources, THIN_SOURCE_MIN } from "./researchLibrary.mjs";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-24T12:00:00Z");

const call = (extra = {}) => ({ sessionID: "ses_a", messageID: "msg_1", callID: "call_1", ...extra });

async function fixture({ caller = { child: "ses_a", project: "proj-1", agent: "seo" }, sources = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), "research-lib-test-"));
  const state = { caller, clock: T0, binds: [], sources: { ...sources } };
  const lib = createResearchLibrary({
    root: join(base, "research-library"),
    bind: async (b, tool) => {
      state.binds.push({ tool, b });
      return state.caller.refused ? { refused: state.caller.refused } : { childSessionID: state.caller.child, project: state.caller.project, agent: state.caller.agent, rootJobId: state.caller.rootJobId };
    },
    getSource: async (child, id) => state.sources[`${child}:${id}`] ?? null,
    now: () => state.clock,
    log: { warn() {} },
  });
  return {
    lib,
    state,
    file: join(base, "research-library", "library.json"),
    stored: async () => JSON.parse(await readFile(join(base, "research-library", "library.json"), "utf-8")),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

const SRC = { id: "src_0000000000000001", url: "https://a.example/page", finalUrl: "https://a.example/final", title: "T", private: false, text: "Pricing pages that show the price early    convert better in most tests." };

const save = (f, extra = {}) =>
  f.lib.save(
    call({
      topic: "Pricing page layout",
      summary: "Show the price early.",
      findings: [{ claim: "Early price helps", sourceId: SRC.id, quote: "show the price early convert better" }],
      shelfLifeDays: 90,
      shelfLifeWhy: "Layout practice shifts slowly; no change log found.",
      shelfLifeVerified: true,
      scope: "global",
      ...extra,
    }),
  );

test("save then find: the entry is stored with its dates and the finding's link comes from the stored source; find shows age and fresh", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const r = await save(f, { findings: [{ claim: "Early price helps", sourceId: SRC.id, quote: "price early convert better", date: "2026-10-01" }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.scope, "global");
    const { entries } = await f.stored();
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.topic, "Pricing page layout");
    assert.equal(e.scope, "global");
    assert.equal(e.checkedBy, "seo");
    assert.equal(e.createdAt, T0);
    assert.equal(e.checkedAt, T0);
    assert.deepEqual(e.findings[0], { claim: "Early price helps", sourceId: SRC.id, url: "https://a.example/final", quote: "price early convert better", date: "2026-10-01", private: false });
    f.state.clock = T0 + 10 * DAY;
    const found = await f.lib.find(call({ query: "pricing pages" }));
    assert.equal(found.ok, true);
    assert.equal(found.entries.length, 1);
    assert.equal(found.entries[0].ageDays, 10);
    assert.equal(found.entries[0].status, "fresh");
    assert.equal(found.entries[0].shelfLifeDays, 90);
    assert.match(found.entries[0].shelfLifeWhy, /Layout practice/);
    assert.equal(found.entries[0].findings[0].url, "https://a.example/final");
    assert.deepEqual(f.state.binds.map((x) => x.tool), ["research_library_save", "research_library_find"]);
  } finally {
    await f.cleanup();
  }
});

test("an entry past its shelf life is shown as stale, with its age", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await save(f, { shelfLifeDays: 7, shelfLifeWhy: "Platform rules change monthly." });
    f.state.clock = T0 + 8 * DAY;
    const found = await f.lib.find(call({ query: "pricing" }));
    assert.equal(found.entries[0].status, "stale");
    assert.equal(found.entries[0].ageDays, 8);
    f.state.clock = T0 + 7 * DAY;
    assert.equal((await f.lib.find(call({ query: "pricing" }))).entries[0].status, "fresh");
  } finally {
    await f.cleanup();
  }
});

test("find matches on topic, summary and claims, ranks the topic first, and returns nothing for unrelated words or an empty query", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await save(f, { topic: "Checkout form fields", summary: "Fewer fields.", findings: [{ claim: "Fewer fields raise completion", sourceId: SRC.id, quote: "show the price early" }] });
    await save(f, { topic: "Pricing page layout", summary: "Checkout wording matters little." });
    const hit = await f.lib.find(call({ query: "checkout" }));
    assert.equal(hit.entries[0].topic, "Checkout form fields", "the topic match outranks a summary mention");
    assert.equal(hit.entries.length, 2);
    assert.deepEqual((await f.lib.find(call({ query: "kubernetes operators" }))).entries, []);
    const empty = await f.lib.find(call({ query: "  " }));
    assert.equal(empty.ok, false);
    assert.match(empty.error, /query/i);
  } finally {
    await f.cleanup();
  }
});

test("scope isolation: a project entry is found only inside that project; a global one by everyone; the same topic in two scopes is two entries", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await save(f, { scope: "project", topic: "Site audit", summary: "Our site is slow." });
    await save(f, { scope: "global", topic: "Site audit", summary: "General audit method." });
    assert.equal((await f.stored()).entries.length, 2);
    const mine = await f.lib.find(call({ query: "site audit" }));
    assert.deepEqual(mine.entries.map((e) => e.scope).sort(), ["global", "project"]);
    f.state.caller = { child: "ses_b", project: "proj-2", agent: "conversion-cro" };
    const other = await f.lib.find(call({ sessionID: "ses_b", query: "site audit" }));
    assert.deepEqual(other.entries.map((e) => e.scope), ["global"]);
    assert.equal(other.entries[0].summary, "General audit method.");
    // saving the same topic as project 2 does not touch project 1's entry
    f.state.sources["ses_b:" + SRC.id] = SRC;
    await save(f, { scope: "project", topic: "Site audit", summary: "Their site is fine." });
    const { entries } = await f.stored();
    assert.equal(entries.length, 3);
    assert.equal(entries.filter((e) => e.scope !== "global" && e.scope.project === "proj-1")[0].summary, "Our site is slow.");
  } finally {
    await f.cleanup();
  }
});

test("a quote must occur in the stored text of a source fetched in THIS task (whitespace may differ, case may not); nothing is saved on a refusal", async () => {
  const f = await fixture({ sources: { [`ses_other:${SRC.id}`]: SRC, [`ses_a:src_0000000000000002`]: { ...SRC, id: "src_0000000000000002", text: "Totally different text about something else entirely." } } });
  try {
    const notMine = await save(f); // SRC.id exists only in another session
    assert.equal(notMine.ok, false);
    assert.match(notMine.error, /wasn't fetched in this task/);
    const wrong = await save(f, { findings: [{ claim: "x", sourceId: "src_0000000000000002", quote: "price early convert better" }] });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /doesn't occur in source src_0000000000000002/);
    f.state.sources[`ses_a:${SRC.id}`] = SRC;
    const caseDiff = await save(f, { findings: [{ claim: "x", sourceId: SRC.id, quote: "Show The Price Early convert better" }] });
    assert.equal(caseDiff.ok, false);
    const ok = await save(f, { findings: [{ claim: "x", sourceId: SRC.id, quote: "price early convert better" }] });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const spaced = await save(f, { topic: "Other", findings: [{ claim: "y", sourceId: SRC.id, quote: "price early    convert better in most" }] });
    assert.equal(spaced.ok, true, "runs of whitespace compare equal");
    assert.equal((await f.stored()).entries.length, 2, "the refused saves stored nothing");
    const noSource = await save(f, { topic: "Third", findings: [{ claim: "y", quote: "price early convert better" }] });
    assert.equal(noSource.ok, false, "a quote needs a source");
  } finally {
    await f.cleanup();
  }
});

test("a finding from a private source forces project scope and keeps no quote and no link; it is shown only inside the project", async () => {
  const priv = { ...SRC, id: "src_00000000000000aa", private: true, url: null, finalUrl: null };
  const f = await fixture({ sources: { [`ses_a:${priv.id}`]: priv } });
  try {
    const r = await save(f, { scope: "global", findings: [{ claim: "Members say price first", sourceId: priv.id, quote: "price early convert better" }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.scope, "project");
    assert.equal(r.forcedProject, true);
    const [e] = (await f.stored()).entries;
    assert.deepEqual(e.scope, { project: "proj-1" });
    assert.deepEqual(e.findings[0], { claim: "Members say price first", sourceId: priv.id, url: null, quote: null, date: "2026-11-24", private: true });
    f.state.caller = { child: "ses_b", project: "proj-2", agent: "seo" };
    assert.deepEqual((await f.lib.find(call({ sessionID: "ses_b", query: "pricing" }))).entries, []);
  } finally {
    await f.cleanup();
  }
});

test("saving the same topic and scope replaces the entry and records what it supersedes; `keep` carries earlier findings over unchanged", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const first = await save(f, { findings: [{ claim: "A", sourceId: SRC.id, quote: "price early convert better", date: "2026-01-02" }, { claim: "B" }] });
    f.state.clock = T0 + 100 * DAY;
    const second = await save(f, { topic: "  pricing PAGE   layout ", summary: "Updated.", findings: [{ claim: "C (new)" }], keep: [0] });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.replaced, true);
    const { entries } = await f.stored();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].supersedes, first.id);
    assert.notEqual(entries[0].id, first.id);
    assert.equal(entries[0].summary, "Updated.");
    assert.equal(entries[0].checkedAt, T0 + 100 * DAY);
    assert.deepEqual(entries[0].findings.map((x) => x.claim), ["A", "C (new)"]);
    assert.equal(entries[0].findings[0].date, "2026-01-02", "a kept finding keeps its own date");
    const bad = await save(f, { findings: [{ claim: "D" }], keep: [5] });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /keep/);
  } finally {
    await f.cleanup();
  }
});

test("a new topic needs a shelf life: whole days with a reason; unverified means 30 days whatever was asked", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    for (const bad of [{ shelfLifeDays: 0 }, { shelfLifeDays: 1.5 }, { shelfLifeDays: 4000 }, { shelfLifeDays: "90" }, { shelfLifeWhy: "  " }, { shelfLifeVerified: "yes" }]) {
      const r = await save(f, bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    const u = await save(f, { shelfLifeDays: 365, shelfLifeVerified: false, shelfLifeWhy: "Couldn't find a change log." });
    assert.equal(u.ok, true);
    assert.equal(u.shelfLifeDays, 30);
    const [e] = (await f.stored()).entries;
    assert.equal(e.shelfLifeDays, 30);
    assert.equal(e.shelfLifeVerified, false);
    const found = await f.lib.find(call({ query: "pricing" }));
    assert.equal(found.entries[0].shelfLifeVerified, false);
  } finally {
    await f.cleanup();
  }
});

test("other shape checks: topic, summary, findings, scope and dates are validated", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    for (const bad of [{ topic: "ab" }, { topic: "x".repeat(121) }, { summary: "" }, { findings: [] }, { findings: "nope" }, { findings: [{ claim: "" }] }, { findings: [{ claim: "ok", date: "yesterday" }] }, { scope: "everywhere" }, { findings: Array.from({ length: 21 }, (_, i) => ({ claim: `c${i}` })) }]) {
      const r = await save(f, bad);
      assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal((await save(f, { findings: [{ claim: "A fine claim without a source" }] })).ok, true);
    assert.equal((await f.stored()).entries[0].findings[0].url, null);
  } finally {
    await f.cleanup();
  }
});

test("a refused binding answers its sentence and reads and writes nothing", async () => {
  const f = await fixture({ caller: { refused: "Only a task from Manta can use this tool" }, sources: {} });
  try {
    assert.deepEqual(await save(f), { ok: false, error: "Only a task from Manta can use this tool" });
    assert.deepEqual(await f.lib.find(call({ query: "pricing" })), { ok: false, error: "Only a task from Manta can use this tool" });
    await assert.rejects(readFile(f.file), /ENOENT/);
  } finally {
    await f.cleanup();
  }
});

test(`the library keeps at most ${LIBRARY_MAX_ENTRIES} entries, the newest checked ones`, async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const entries = Array.from({ length: LIBRARY_MAX_ENTRIES }, (_, i) => ({
      id: `rl_${i}`, topic: `topic number ${i}`, scope: "global", summary: "s", findings: [], shelfLifeDays: 30, shelfLifeWhy: "w", shelfLifeVerified: true, createdAt: T0 - (i + 1) * 1000, checkedAt: T0 - (i + 1) * 1000, checkedBy: "seo",
    }));
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(f.file, ".."), { recursive: true });
    await writeFile(f.file, JSON.stringify({ version: 1, entries }));
    const r = await save(f, { topic: "brand new topic" });
    assert.equal(r.ok, true);
    const after = (await f.stored()).entries;
    assert.equal(after.length, LIBRARY_MAX_ENTRIES);
    assert.ok(after.some((e) => e.topic === "brand new topic"));
    assert.ok(!after.some((e) => e.id === `rl_${LIBRARY_MAX_ENTRIES - 1}`), "the oldest went");
  } finally {
    await f.cleanup();
  }
});

test("concurrent saves of different topics both land (one writer)", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const rs = await Promise.all([save(f, { topic: "Topic one" }), save(f, { topic: "Topic two" }), save(f, { topic: "Topic three" })]);
    assert.ok(rs.every((r) => r.ok));
    assert.equal((await f.stored()).entries.length, 3);
  } finally {
    await f.cleanup();
  }
});

test("a damaged library file is not overwritten blindly: save refuses, find answers nothing found is NOT claimed", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(f.file, ".."), { recursive: true });
    await writeFile(f.file, "{ not json");
    const r = await save(f);
    assert.equal(r.ok, false);
    assert.match(r.error, /library/i);
    assert.equal(await readFile(f.file, "utf-8"), "{ not json", "the damaged file is left as it was");
    const found = await f.lib.find(call({ query: "pricing" }));
    assert.equal(found.ok, false);
  } finally {
    await f.cleanup();
  }
});

// ---- independent sources: the evidence bar of an entry ----

const f_ = (url, extra = {}) => ({ claim: "c", sourceId: url ? `src_${url.length}` : null, url, quote: null, date: "2026-11-24", private: false, ...extra });

test("independentSources counts one source per registrable domain: subdomains and paths of one site are one", () => {
  const r = independentSources([f_("https://docs.anthropic.com/a"), f_("https://www.anthropic.com/b"), f_("https://anthropic.com/c"), f_("https://example.co.uk/x"), f_("https://blog.example.co.uk/y"), f_("https://other.org/z")]);
  assert.equal(r.sourceCount, 3);
  assert.equal(THIN_SOURCE_MIN, 3);
});

test("independentSources tells apart authors on shared hosts: github owners, user sites on github.io", () => {
  const r = independentSources([f_("https://github.com/alice/one"), f_("https://github.com/alice/two"), f_("https://github.com/bob/one"), f_("https://carol.github.io/post"), f_("https://dave.github.io/post")]);
  assert.equal(r.sourceCount, 4, "alice once, bob, carol, dave");
});

test("independentSources: a private source counts once per source, findings with no source count for nothing, and an unreadable url does not throw", () => {
  const r = independentSources([
    f_(null, { sourceId: "src_p1", private: true }),
    f_(null, { sourceId: "src_p1", private: true }),
    f_(null, { sourceId: "src_p2", private: true }),
    f_(null),
    f_("not a url"),
    f_("https://a.example/x"),
  ]);
  assert.equal(r.sourceCount, 3);
});

test("independentSources flags thin: fewer than 3 sources, or one source carrying more than half the findings (exactly half is fine)", () => {
  assert.equal(independentSources([f_("https://a.example/1"), f_("https://b.example/1")]).thin, true, "two sources");
  assert.equal(independentSources([f_("https://a.example/1"), f_("https://b.example/1"), f_("https://c.example/1")]).thin, false, "three sources, one each");
  const dominant = independentSources([f_("https://a.example/1"), f_("https://a.example/2"), f_("https://a.example/3"), f_("https://a.example/4"), f_("https://b.example/1"), f_("https://c.example/1")]);
  assert.equal(dominant.sourceCount, 3);
  assert.equal(dominant.thin, true, "4 of 6 findings from one source");
  assert.equal(dominant.dominant, true);
  const half = independentSources([f_("https://a.example/1"), f_("https://a.example/2"), f_("https://b.example/1"), f_("https://c.example/1")]);
  assert.equal(half.thin, false, "2 of 4 is exactly half");
  assert.equal(independentSources([]).thin, true);
  assert.equal(independentSources([]).sourceCount, 0);
  // findings without a source still count in the total: 3 sourced findings out of 7 do not make 3 sources "carry" the entry
  assert.equal(independentSources([f_("https://a.example/1"), f_("https://a.example/2"), f_("https://a.example/3"), f_("https://a.example/4"), f_("https://b.example/1"), f_("https://c.example/1"), f_(null)]).thin, true);
});

const srcAt = (n, url, text = "Pricing pages that show the price early convert better in most tests.", extra = {}) => ({ id: `src_000000000000000${n}`, url, finalUrl: url, title: "T", private: false, text, ...extra });
const withSources = (list, child = "ses_a") => Object.fromEntries(list.map((s) => [`${child}:${s.id}`, s]));
const findingFrom = (s, claim) => ({ claim, sourceId: s.id, quote: "price early convert better" });

test("save stores sourceCount and thin; a thin entry is still saved (two documents of one site = one source)", async () => {
  const s1 = srcAt(1, "https://docs.example.com/a");
  const s2 = srcAt(2, "https://www.example.com/b");
  const f = await fixture({ sources: withSources([s1, s2]) });
  try {
    const r = await save(f, { findings: [findingFrom(s1, "A"), findingFrom(s2, "B"), { claim: "C" }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sourceCount, 1);
    assert.equal(r.thin, true);
    const [e] = (await f.stored()).entries;
    assert.equal(e.sourceCount, 1);
    assert.equal(e.thin, true);
    assert.equal(e.findings.length, 3, "nothing was rejected");
  } finally {
    await f.cleanup();
  }
});

test("save: three independent sources, none dominant, is not thin", async () => {
  const list = [srcAt(1, "https://a.example/x"), srcAt(2, "https://b.example/x"), srcAt(3, "https://c.example/x")];
  const f = await fixture({ sources: withSources(list) });
  try {
    const r = await save(f, { findings: list.map((s, i) => findingFrom(s, `claim ${i}`)) });
    assert.equal(r.sourceCount, 3);
    assert.equal(r.thin, false);
    assert.equal((await f.stored()).entries[0].thin, false);
  } finally {
    await f.cleanup();
  }
});

test("save: private-source findings count as sources and the entry stays in project scope", async () => {
  const pub = srcAt(1, "https://a.example/x");
  const p1 = srcAt(2, null, undefined, { private: true });
  const p2 = srcAt(3, null, undefined, { private: true });
  const f = await fixture({ sources: withSources([pub, p1, p2]) });
  try {
    const r = await save(f, { scope: "global", findings: [findingFrom(pub, "A"), findingFrom(p1, "B"), findingFrom(p2, "C")] });
    assert.equal(r.sourceCount, 3);
    assert.equal(r.thin, false);
    assert.equal(r.scope, "project");
    assert.equal(r.forcedProject, true);
  } finally {
    await f.cleanup();
  }
});

test("find carries the source count and thin flag; a thin entry says why, a fully sourced one does not", async () => {
  const list = [srcAt(1, "https://a.example/x"), srcAt(2, "https://b.example/x"), srcAt(3, "https://c.example/x")];
  const f = await fixture({ sources: withSources(list) });
  try {
    await save(f, { topic: "Thin topic", findings: [findingFrom(list[0], "A"), findingFrom(list[1], "B")] });
    await save(f, { topic: "Solid topic", findings: list.map((s, i) => findingFrom(s, `c${i}`)) });
    const thin = (await f.lib.find(call({ query: "thin topic" }))).entries.find((e) => e.topic === "Thin topic");
    assert.equal(thin.sourceCount, 2);
    assert.equal(thin.thin, true);
    assert.equal(thin.status, "fresh", "freshness is reported as before; the plugin never shows it alone");
    const solid = (await f.lib.find(call({ query: "solid topic" }))).entries.find((e) => e.topic === "Solid topic");
    assert.equal(solid.sourceCount, 3);
    assert.equal(solid.thin, false);
  } finally {
    await f.cleanup();
  }
});

test("an entry saved before the count existed gets it computed on read from its findings' urls, and the file is not rewritten", async () => {
  const f = await fixture();
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(f.file, ".."), { recursive: true });
    const old = {
      id: "rl_old", topic: "Old topic", scope: "global", summary: "s", shelfLifeDays: 120, shelfLifeWhy: "w", shelfLifeVerified: true, createdAt: T0, checkedAt: T0, checkedBy: "architect",
      findings: [f_("https://docs.anthropic.com/a"), f_("https://www.anthropic.com/b"), f_("https://anthropic.com/c"), f_("https://anthropic.com/d"), f_("https://anthropic.com/e")],
    };
    const text = JSON.stringify({ version: 1, entries: [old] });
    await writeFile(f.file, text);
    const [e] = (await f.lib.find(call({ query: "old topic" }))).entries;
    assert.equal(e.sourceCount, 1);
    assert.equal(e.thin, true);
    assert.equal(await readFile(f.file, "utf-8"), text);
  } finally {
    await f.cleanup();
  }
});

test("a refresh with keep recomputes the count and the flag from kept and new findings together", async () => {
  const list = [srcAt(1, "https://a.example/x"), srcAt(2, "https://b.example/x"), srcAt(3, "https://c.example/x")];
  const f = await fixture({ sources: withSources(list) });
  try {
    const first = await save(f, { findings: [findingFrom(list[0], "A"), findingFrom(list[1], "B")] });
    assert.equal(first.thin, true);
    const second = await save(f, { summary: "Improved.", findings: [findingFrom(list[2], "C")], keep: [0, 1] });
    assert.equal(second.replaced, true);
    assert.equal(second.sourceCount, 3);
    assert.equal(second.thin, false);
    const [e] = (await f.stored()).entries;
    assert.equal(e.sourceCount, 3);
    assert.equal(e.thin, false);
  } finally {
    await f.cleanup();
  }
});

// ---- one organisation is one source: the alias table and the optional publisher ----

test("independentSources: the domains of one organisation are one source (the built-in alias table), and its GitHub owner too", () => {
  const r = independentSources([f_("https://www.anthropic.com/engineering/a"), f_("https://docs.claude.com/b"), f_("https://claude.com/blog/c"), f_("https://github.com/anthropics/skills"), f_("https://other.org/z")]);
  assert.equal(r.sourceCount, 2, "anthropic.com, claude.com and the anthropics GitHub owner are one; other.org is the other");
  const two = independentSources([f_("https://openai.com/a"), f_("https://platform.openai.com/b"), f_("https://www.anthropic.com/c")]);
  assert.equal(two.sourceCount, 2, "two vendors stay two");
  // an unrelated GitHub owner is still its own source
  assert.equal(independentSources([f_("https://github.com/anthropics/skills"), f_("https://github.com/alice/skills")]).sourceCount, 2);
});

test("independentSources: a finding's publisher merges sources that share it (and only merges); the same name as an alias org agrees with it", () => {
  const merged = independentSources([f_("https://a.example/1", { publisher: "Acme Corp" }), f_("https://b.example/1", { publisher: "acme  corp." }), f_("https://c.example/1")]);
  assert.equal(merged.sourceCount, 2, "a.example and b.example are one publisher");
  // a publisher label can never split one site into two sources
  const same = independentSources([f_("https://a.example/1", { publisher: "One" }), f_("https://a.example/2", { publisher: "Two" })]);
  assert.equal(same.sourceCount, 1);
  const org = independentSources([f_("https://www.anthropic.com/a"), f_("https://news.example/b", { publisher: "Anthropic" })]);
  assert.equal(org.sourceCount, 1, "the label 'Anthropic' is the anthropic.com source");
  // a publisher on a finding with no link still stands for a source of its own
  assert.equal(independentSources([f_(null, { publisher: "Acme Corp" }), f_("https://a.example/1")]).sourceCount, 2);
});

test("save stores a finding's publisher and refuses a malformed one; find returns it", async () => {
  const s1 = srcAt(1, "https://a.example/x");
  const f = await fixture({ sources: withSources([s1]) });
  try {
    const bad = await save(f, { findings: [{ ...findingFrom(s1, "A"), publisher: 7 }] });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /publisher/i);
    const long = await save(f, { findings: [{ ...findingFrom(s1, "A"), publisher: "x".repeat(81) }] });
    assert.equal(long.ok, false);
    const ok = await save(f, { findings: [{ ...findingFrom(s1, "A"), publisher: "  Acme Corp " }] });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal((await f.stored()).entries[0].findings[0].publisher, "Acme Corp");
    assert.equal((await f.lib.find(call({ query: "pricing" }))).entries[0].findings[0].publisher, "Acme Corp");
  } finally {
    await f.cleanup();
  }
});

test("save: anthropic.com and claude.com pages are one source in the stored count (the live case: '3' that was really 2)", async () => {
  const list = [srcAt(1, "https://www.anthropic.com/a"), srcAt(2, "https://docs.claude.com/b"), srcAt(3, "https://openai.com/c")];
  const f = await fixture({ sources: withSources(list) });
  try {
    const r = await save(f, { findings: list.map((s, i) => findingFrom(s, `claim ${i}`)) });
    assert.equal(r.sourceCount, 2);
    assert.equal(r.thin, true);
  } finally {
    await f.cleanup();
  }
});

// ---- duplicate findings ----

test("save: a refresh that keeps findings and adds the same claims again stores each once, preferring the copy with a link and a quote", async () => {
  const s1 = srcAt(1, "https://a.example/x");
  const s2 = srcAt(2, "https://b.example/x");
  const f = await fixture({ sources: withSources([s1, s2]) });
  try {
    await save(f, { findings: [findingFrom(s1, "Early price helps"), findingFrom(s2, "Trust badges help")] });
    // the copies come back with no link, differently spaced and cased, next to the kept ones
    const r = await save(f, { findings: [{ claim: "early  price HELPS." }, { claim: "Trust badges help" }, { claim: "A brand new claim" }], keep: [0, 1] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.findings, 3);
    const [e] = (await f.stored()).entries;
    assert.deepEqual(e.findings.map((x) => x.claim), ["Early price helps", "Trust badges help", "A brand new claim"]);
    assert.equal(e.findings[0].url, "https://a.example/x");
    assert.ok(e.findings[0].quote, "the kept copy with the quote won");
  } finally {
    await f.cleanup();
  }
});

test("save: when the later copy has the link and the earlier one has none, the later copy is the one stored; two sources with one claim stay two", async () => {
  const s1 = srcAt(1, "https://a.example/x");
  const s2 = srcAt(2, "https://b.example/x");
  const s3 = srcAt(3, "https://c.example/x");
  const f = await fixture({ sources: withSources([s1, s2, s3]) });
  try {
    const r = await save(f, { findings: [{ claim: "Early price helps" }, findingFrom(s1, "early price helps"), findingFrom(s2, "Early price helps"), findingFrom(s3, "Other")] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const [e] = (await f.stored()).entries;
    assert.equal(e.findings.length, 3, "the link-less copy merged into one of the linked ones; the two linked sources stay");
    assert.deepEqual(e.findings.map((x) => x.url), ["https://a.example/x", "https://b.example/x", "https://c.example/x"]);
  } finally {
    await f.cleanup();
  }
});

// ---- project facts ----

const fact = (claim) => ({ claim, sourceId: null, url: null, quote: null, date: "2026-11-24", private: false });

test("independentSources: in a project entry, findings with no source are project facts; all of them → no source count and not thin", () => {
  const r = independentSources([fact("The pricing page is in app/pricing.tsx"), fact("The CTA says Get started")], { projectScope: true });
  assert.equal(r.projectFacts, true);
  assert.equal(r.sourceCount, 0);
  assert.equal(r.thin, false);
  // the same findings in a global entry are unsourced claims, as before
  const g = independentSources([fact("a"), fact("b")]);
  assert.equal(g.projectFacts, false);
  assert.equal(g.thin, true);
});

test("independentSources: a mixed project entry counts only its outside sources — facts never make it thin or dominant, and never rescue it", () => {
  const facts = [fact("f1"), fact("f2"), fact("f3"), fact("f4"), fact("f5")];
  const three = independentSources([...facts, f_("https://a.example/1"), f_("https://b.example/1"), f_("https://c.example/1")], { projectScope: true });
  assert.equal(three.projectFacts, false);
  assert.equal(three.sourceCount, 3);
  assert.equal(three.thin, false, "5 facts do not make 3 sources 'dominant'");
  const two = independentSources([...facts, f_("https://a.example/1"), f_("https://b.example/1")], { projectScope: true });
  assert.equal(two.sourceCount, 2);
  assert.equal(two.thin, true, "facts do not count as a source");
  const dominant = independentSources([...facts, f_("https://a.example/1"), f_("https://a.example/2"), f_("https://a.example/3"), f_("https://b.example/1"), f_("https://c.example/1")], { projectScope: true });
  assert.equal(dominant.thin, true, "3 of 5 outside findings come from one source");
});

test("save and find: a project entry of repo observations is 'project facts', not thin; the same findings in a global entry stay thin; an old stored thin flag is not trusted", async () => {
  const f = await fixture();
  try {
    const r = await save(f, { topic: "Pricing page in this repo", scope: "project", findings: [{ claim: "The CTA text lives in app/pricing.tsx" }, { claim: "The header uses the same Get started text" }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.projectFacts, true);
    assert.equal(r.thin, false);
    const g = await save(f, { topic: "Unsourced global claims", scope: "global", findings: [{ claim: "a" }, { claim: "b" }] });
    assert.equal(g.projectFacts, false);
    assert.equal(g.thin, true);
    const stored = await f.stored();
    // simulate an entry the earlier version wrote: it stored thin:true for the same facts
    stored.entries.find((e) => e.topic === "Pricing page in this repo").thin = true;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(f.file, JSON.stringify(stored));
    const [e] = (await f.lib.find(call({ query: "pricing page in this repo" }))).entries;
    assert.equal(e.projectFacts, true);
    assert.equal(e.thin, false);
    assert.equal(e.sourceCount, 0);
  } finally {
    await f.cleanup();
  }
});

// ---- the guidance every agent task gets ----

test("the guidance is short, names the tools and the skip rules, and mentions no particular domain", () => {
  const lines = RESEARCH_GUIDANCE.trim().split("\n");
  assert.ok(lines.length <= 15, `${lines.length} lines`);
  for (const t of ["research_library_find", "research_library_save", "research_search", "research_fetch"]) assert.ok(RESEARCH_GUIDANCE.includes(t), t);
  assert.match(RESEARCH_GUIDANCE, /fresh/i);
  assert.match(RESEARCH_GUIDANCE, /current state/i);
  assert.match(RESEARCH_GUIDANCE, /fresh research/i);
  assert.match(RESEARCH_GUIDANCE, /contradict/i);
  assert.match(RESEARCH_GUIDANCE, /shelf life/i);
  assert.match(RESEARCH_GUIDANCE, /30 days/);
  assert.match(RESEARCH_GUIDANCE, /age/i);
  assert.doesNotMatch(RESEARCH_GUIDANCE, /\b(seo|cro|conversion|pricing|marketing|ads?)\b/i);
  // one domain-free line: a request the research says is likely a mistake is put to the user with the standard question tool
  const askLines = lines.filter((l) => l.includes("question tool"));
  assert.equal(askLines.length, 1);
  assert.match(askLines[0], /likely a mistake/);
  assert.match(askLines[0], /silently comply/);
  assert.match(askLines[0], /silently change/);
  assert.match(askLines[0], /ask the user with the question tool, with your recommendation and what you found/);
  assert.ok(!RESEARCH_GUIDANCE.includes("ask_user"));
});

test("the guidance has one generic line on thin entries: a lead; add independent sources, look for contrary evidence, save with keep", () => {
  const thinLines = RESEARCH_GUIDANCE.split("\n").filter((l) => /thin entry/i.test(l));
  assert.equal(thinLines.length, 1);
  assert.match(thinLines[0], /A thin entry is a lead/);
  assert.match(thinLines[0], /independent sources/);
  assert.match(thinLines[0], /contrary evidence/);
  assert.match(thinLines[0], /`keep`/);
});

test("withResearchGuidance appends the block once, after the task text", () => {
  const out = withResearchGuidance("Do the thing.");
  assert.ok(out.startsWith("Do the thing.\n\n---\n"));
  assert.ok(out.endsWith(`${RESEARCH_GUIDANCE.trim()}\n`) || out.includes(RESEARCH_GUIDANCE.trim()));
  assert.equal(withResearchGuidance(out), out, "idempotent");
});

// ---- lookup: the server-side read the Architect's fit check is checked against ----

test("lookup resolves each reference by entry id or by exact topic (case and spacing ignored), in the caller's scope, with age, status and source count", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const saved = await save(f, { topic: "Pricing page layout", shelfLifeDays: 7, shelfLifeWhy: "Moves fast." });
    await save(f, { scope: "project", topic: "Our own pricing", summary: "Observed." });
    f.state.clock = T0 + 3 * DAY;
    const got = await f.lib.lookup({ project: "proj-1", refs: [saved.id, "  pricing PAGE   layout ", "Our own pricing", "No such topic", "rl_nope"] });
    assert.deepEqual(got.map((g) => g.ref), [saved.id, "  pricing PAGE   layout ", "Our own pricing", "No such topic", "rl_nope"]);
    assert.equal(got[0].entry.id, saved.id);
    assert.equal(got[1].entry.id, saved.id, "an exact topic finds it too");
    assert.equal(got[0].entry.ageDays, 3);
    assert.equal(got[0].entry.status, "fresh");
    assert.equal(got[0].entry.sourceCount, 1);
    assert.equal(got[0].entry.thin, true);
    assert.equal(got[2].entry.scope, "project");
    assert.equal(got[3].entry, null);
    assert.equal(got[4].entry, null);
    f.state.clock = T0 + 8 * DAY;
    assert.equal((await f.lib.lookup({ project: "proj-1", refs: [saved.id] }))[0].entry.status, "stale");
    // another project never sees a project entry
    const other = await f.lib.lookup({ project: "proj-2", refs: ["Our own pricing", saved.id] });
    assert.equal(other[0].entry, null);
    assert.equal(other[1].entry.id, saved.id);
  } finally {
    await f.cleanup();
  }
});

test("lookup: the same topic in two scopes resolves to the most recently checked entry visible to the project; an unreadable library throws", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await save(f, { scope: "global", topic: "Site audit", summary: "General." });
    f.state.clock = T0 + DAY;
    await save(f, { scope: "project", topic: "Site audit", summary: "Ours." });
    assert.equal((await f.lib.lookup({ project: "proj-1", refs: ["Site audit"] }))[0].entry.summary, "Ours.");
    assert.equal((await f.lib.lookup({ project: "proj-2", refs: ["Site audit"] }))[0].entry.summary, "General.");
    await writeFile(f.file, "{ not json");
    await assert.rejects(f.lib.lookup({ project: "proj-1", refs: ["Site audit"] }), /couldn't be read/);
  } finally {
    await f.cleanup();
  }
});

// ---- the Architect's templates ----

import { fileURLToPath } from "node:url";
const TEMPLATES = fileURLToPath(new URL("./agentTemplates/architect", import.meta.url));

test("the Architect saves its build research into the library, and the authoring skill leaves research guidance to the server", async () => {
  const main = await readFile(join(TEMPLATES, "agent.md"), "utf-8");
  assert.ok(main.trimEnd().split("\n").length <= 150, "the main file stays within 150 lines");
  assert.match(main, /research_library_find/);
  assert.match(main, /research_library_save/);
  const research = await readFile(join(TEMPLATES, "skills", "research", "SKILL.md"), "utf-8");
  assert.match(research, /## The research library/);
  assert.match(research, /research_library_save/);
  assert.match(research, /shelf life/i);
  assert.match(research, /fetch again|re-?fetch/i, "a library entry is a lead: quotes for a proposal come from pages fetched in this task");
  const authoring = await readFile(join(TEMPLATES, "skills", "authoring", "SKILL.md"), "utf-8");
  assert.match(authoring, /research section/i);
  assert.match(authoring, /every\s+agent's task prompt/i);
});

// ---- what each task relied on (agent screens §6.5) ----

const ROOT = "job_root_1";
const usedFile = (f) => join(f.file, "..", "used", `${ROOT}.json`);
const readUsed = async (f) => JSON.parse(await readFile(usedFile(f), "utf-8"));

test("used: find and save record the entry ids per task root (find: the top 5 returned; save: the saved one), once each", async () => {
  const f = await fixture({ caller: { child: "ses_a", project: "proj-1", agent: "seo", rootJobId: ROOT }, sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    const saved = await save(f);
    assert.equal(saved.ok, true);
    await f.lib.find(call({ query: "pricing pages" }));
    await f.lib.find(call({ query: "pricing pages" })); // the same entry twice is recorded once
    const used = await readUsed(f);
    assert.deepEqual(used.ids, [{ id: saved.id, topic: "Pricing page layout" }]);
    assert.deepEqual(await f.lib.usedBy(ROOT), [{ id: saved.id, topic: "Pricing page layout" }]);
  } finally {
    await f.cleanup();
  }
});

test("used: a task with no root is not recorded; an unknown root reads as empty; an unsafe root is never a path", async () => {
  const f = await fixture({ sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await save(f);
    await f.lib.find(call({ query: "pricing" }));
    assert.deepEqual(await f.lib.usedBy(ROOT), []);
    assert.deepEqual(await f.lib.usedBy("../../etc/passwd"), []);
    f.state.caller.rootJobId = "../escape";
    await f.lib.find(call({ query: "pricing" }));
    await assert.rejects(readFile(join(f.file, "..", "used", "..", "escape.json"), "utf-8"));
  } finally {
    await f.cleanup();
  }
});

test("used: a task's list is capped at 50 ids, the newest kept", async () => {
  const f = await fixture({ caller: { child: "ses_a", project: "proj-1", agent: "seo", rootJobId: ROOT } });
  try {
    for (let i = 0; i < 55; i++) {
      const r = await f.lib.save(call({ topic: `Topic number ${i}`, summary: "s", findings: [{ claim: "a fact" }], shelfLifeDays: 30, shelfLifeWhy: "why", shelfLifeVerified: false, scope: "project" }));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    const ids = (await readUsed(f)).ids;
    assert.equal(ids.length, 50);
    assert.equal(ids.at(-1).topic, "Topic number 54");
    assert.equal(ids[0].topic, "Topic number 5");
  } finally {
    await f.cleanup();
  }
});

test("used: a failure to record never fails the tool call", async () => {
  const f = await fixture({ caller: { child: "ses_a", project: "proj-1", agent: "seo", rootJobId: ROOT }, sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await mkdir(join(f.file, "..", "used"), { recursive: true });
    await mkdir(usedFile(f)); // a folder where the file should be: the write fails
    const r = await save(f);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await f.lib.find(call({ query: "pricing" }))).entries.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("used: the sweep drops records older than 30 days and keeps the rest", async () => {
  const f = await fixture({ caller: { child: "ses_a", project: "proj-1", agent: "seo", rootJobId: ROOT }, sources: { [`ses_a:${SRC.id}`]: SRC } });
  try {
    await save(f);
    f.state.caller.rootJobId = "job_root_2";
    f.state.clock = T0 + 20 * DAY;
    await save(f, { topic: "Another topic" });
    f.state.clock = T0 + 31 * DAY;
    assert.equal(await f.lib.sweepUsed(), 1);
    assert.deepEqual(await f.lib.usedBy(ROOT), []);
    assert.equal((await f.lib.usedBy("job_root_2")).length, 1);
  } finally {
    await f.cleanup();
  }
});
