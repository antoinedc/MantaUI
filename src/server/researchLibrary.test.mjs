// The research library (docs/superpowers/specs/2026-11-24-research-library.md): the store, `research_library_find` and
// `research_library_save`, scope isolation, the quote check, private → project, and the guidance every agent task gets.
// The binding, the source store and the clock are injected; the files live in a temp folder.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchLibrary, RESEARCH_GUIDANCE, withResearchGuidance, LIBRARY_MAX_ENTRIES } from "./researchLibrary.mjs";

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
      return state.caller.refused ? { refused: state.caller.refused } : { childSessionID: state.caller.child, project: state.caller.project, agent: state.caller.agent };
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
  // one domain-free line: a request the research says is likely a mistake is put to the user, not silently complied with or changed
  const askLines = lines.filter((l) => l.includes("`ask_user`"));
  assert.equal(askLines.length, 1);
  assert.match(askLines[0], /likely a mistake/);
  assert.match(askLines[0], /silently comply/);
  assert.match(askLines[0], /silently change/);
  assert.match(askLines[0], /recommendation/);
});

test("withResearchGuidance appends the block once, after the task text", () => {
  const out = withResearchGuidance("Do the thing.");
  assert.ok(out.startsWith("Do the thing.\n\n---\n"));
  assert.ok(out.endsWith(`${RESEARCH_GUIDANCE.trim()}\n`) || out.includes(RESEARCH_GUIDANCE.trim()));
  assert.equal(withResearchGuidance(out), out, "idempotent");
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
