// researchSources.test.mjs — the box-wide research sources store (research layer spec docs/superpowers/specs/2026-11-28-research-layer.md,
// US1: AC-1.1 … AC-1.15; FR-001/002/005/011). A real temp folder stands in for ~/.manta; everything else is injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchSources, BUILTIN_SOURCES, DEFAULT_ORDER } from "./researchSources.mjs";
import { ResearchError } from "./research/transport.mjs";

const bookface = (extra = {}) => ({ id: "bookface", name: "Bookface (YC) search", description: "YC's private founder forum.", command: ["/home/dev/.yc/bin/yc", "search", "{query}"], env: { YC_TOKEN: "{secret:YC_TOKEN}" }, ...extra });
const posts = (extra = {}) => ({ id: "bookface-posts", name: "Bookface posts", description: "Posts on Bookface.", url: "https://search.example.com/api/v1/posts?q={query}", headers: { Authorization: "Bearer {secret:YC_TOKEN}" }, ...extra });
const user = (id, extra = {}) => ({ id, name: `Source ${id}`, description: `The ${id} source.`, command: ["lookup", "{query}"], ...extra });

async function fixture({ architect = { found: false }, secrets = [{ key: "YC_TOKEN", scope: "shared", value: "yc-token-value-1234" }], stripFails = 0, scanner } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "manta-research-sources-"));
  const file = join(dir, "research-sources.json");
  const w = { dir, file, architect, strips: 0, stripFails, changes: 0, hints: [], secrets, now: 1_800_000_000_000 };
  const store = createResearchSources({
    file,
    readArchitectSources: async () => w.architect,
    stripArchitectSources: async () => {
      w.strips++;
      if (w.stripFails > 0) {
        w.stripFails--;
        throw new Error("strip failed");
      }
      w.architect = { found: false };
    },
    loadSecrets: async () => {
      if (w.secrets === "throw") throw new Error("unreadable");
      return w.secrets;
    },
    onChange: async () => {
      w.changes++;
    },
    publish: (h) => w.hints.push(h),
    now: () => w.now,
    log: { warn() {} },
    ...(scanner ? { createScanner: scanner } : {}),
  });
  w.store = store;
  w.cleanup = () => rm(dir, { recursive: true, force: true });
  return w;
}
const ids = (r) => r.sources.map((s) => s.id);
const DEFAULT_IDS = ["web", "github", "packages", "stackoverflow", "hn", "reddit", "arxiv", "x"];
const stored = async (w) => JSON.parse(await readFile(w.file, "utf-8"));

test("AC-1.3: a fresh box lists the defaults in the default order, enabled, none private, no user sources", async () => {
  const w = await fixture();
  try {
    const r = await w.store.list();
    assert.deepEqual(ids(r), DEFAULT_IDS);
    assert.deepEqual(DEFAULT_ORDER, DEFAULT_IDS);
    assert.ok(r.sources.every((s) => s.builtin === true && s.enabled === true && s.private === false && s.kind === "builtin" && s.name && s.description));
    assert.deepEqual(r.notices, []);
    assert.deepEqual(BUILTIN_SOURCES.map((s) => s.id), DEFAULT_IDS);
  } finally {
    await w.cleanup();
  }
});

test("AC-1.1: the Architect's sources are imported first, private, in their original order, above the defaults; the Architect's key is stripped", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface(), posts({ private: false })] } });
  try {
    await w.store.migrate();
    const r = await w.store.list();
    assert.deepEqual(ids(r), ["bookface", "bookface-posts", ...DEFAULT_IDS]);
    const [a, b] = r.sources;
    assert.deepEqual(a.command, bookface().command);
    assert.deepEqual(a.env, { YC_TOKEN: "{secret:YC_TOKEN}" });
    assert.equal(a.enabled, true);
    assert.equal(a.addedBy, "migration");
    assert.equal(b.url, posts().url);
    assert.deepEqual(b.headers, posts().headers);
    assert.equal(w.strips, 1);
    assert.equal((await stored(w)).migration.architect, "done");
    assert.ok(w.changes >= 1, "agents are recompiled");
  } finally {
    await w.cleanup();
  }
});

test("AC-1.1b: every migrated source is forced private (even `private: false`); the user can widen it and nothing sets it back", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface({ private: false })] } });
  try {
    await w.store.migrate();
    let r = await w.store.list();
    assert.equal(r.sources[0].private, true);
    assert.ok(r.notices.some((n) => /moved from the Architect are private; make one public here if you want/i.test(n)), JSON.stringify(r.notices));
    const rows = r.sources.map((s) => (s.builtin ? { id: s.id, enabled: s.enabled } : { ...s, private: false }));
    assert.deepEqual(await w.store.save({ sources: rows }), { ok: true });
    await w.store.migrate();
    await w.store.migrate();
    r = await w.store.list();
    assert.equal(r.sources[0].private, false);
    assert.equal((await stored(w)).sources[0].private, false);
  } finally {
    await w.cleanup();
  }
});

test("AC-1.2: the migration is idempotent — nothing is imported twice, and a failed strip is retried without a second import", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface()] }, stripFails: 1 });
  try {
    await w.store.migrate();
    assert.equal((await stored(w)).migration.architect, "pending-strip");
    assert.deepEqual(ids(await w.store.list()), ["bookface", ...DEFAULT_IDS]);
    // the user renames nothing; the Architect's file still has the key
    w.architect = { found: true, raw: [bookface({ name: "Changed" })] };
    await w.store.migrate();
    assert.equal(w.strips, 2, "the strip was retried");
    assert.equal((await stored(w)).migration.architect, "done");
    const r = await w.store.list();
    assert.deepEqual(ids(r), ["bookface", ...DEFAULT_IDS]);
    assert.equal(r.sources[0].name, "Bookface (YC) search", "the import did not run again");
    w.architect = { found: true, raw: [user("another")] };
    await w.store.migrate();
    assert.equal(w.strips, 2);
    assert.deepEqual(ids(await w.store.list()), ["bookface", ...DEFAULT_IDS]);
  } finally {
    await w.cleanup();
  }
});

test("a file with no sources migrates to 'none' and strips nothing", async () => {
  const w = await fixture({ architect: { found: false } });
  try {
    await w.store.migrate();
    assert.equal((await stored(w)).migration.architect, "none");
    assert.equal(w.strips, 0);
  } finally {
    await w.cleanup();
  }
});

test("AC-1.14: ids that were valid under the OLD built-in set are parsed against it, renamed `-mine`, kept in order, private, and the result passes the new validation", async () => {
  const entries = [
    user("packages", { description: "Mine one", command: ["mypkgs", "{query}"] }),
    bookface(),
    user("stackoverflow", { description: "Mine two", command: undefined, url: "https://so.example.com/search?q={query}" }),
  ];
  const w = await fixture({ architect: { found: true, raw: entries } });
  try {
    await w.store.migrate();
    const r = await w.store.list();
    assert.deepEqual(ids(r), ["packages-mine", "bookface", "stackoverflow-mine", ...DEFAULT_IDS]);
    const [first, , third] = r.sources;
    assert.deepEqual(first.command, ["mypkgs", "{query}"]);
    assert.equal(first.description, "Mine one");
    assert.equal(third.url, "https://so.example.com/search?q={query}");
    assert.ok(r.sources.slice(0, 3).every((s) => s.private === true && s.builtin === false));
    assert.equal(r.notices.filter((n) => /packages → packages-mine/.test(n) && /stackoverflow → stackoverflow-mine/.test(n)).length, 1, "one notice naming both renames");
    // the migrated list passes the NEW validation: saving it back unchanged is accepted
    const rows = r.sources.map((s) => (s.builtin ? { id: s.id, enabled: s.enabled } : s));
    assert.deepEqual(await w.store.save({ sources: rows }), { ok: true });
  } finally {
    await w.cleanup();
  }
});

test("AC-1.14: a rename that collides is numbered deterministically (packages-mine taken in the same file → packages-mine-2, -3 …)", async () => {
  const entries = [user("packages-mine"), user("packages"), user("packages-mine-2")];
  const w = await fixture({ architect: { found: true, raw: entries } });
  try {
    await w.store.migrate();
    assert.deepEqual(ids(await w.store.list()).slice(0, 3), ["packages-mine", "packages-mine-3", "packages-mine-2"]);
  } finally {
    await w.cleanup();
  }
  const v = await fixture({ architect: { found: true, raw: [user("packages"), user("packages-mine")] } });
  try {
    await v.store.migrate();
    assert.deepEqual(ids(await v.store.list()).slice(0, 2), ["packages-mine-2", "packages-mine"]);
  } finally {
    await v.cleanup();
  }
});

test("AC-1.15: an entry that was already invalid under the old rules is skipped and named with the old validator's sentence; the others migrate", async () => {
  const entries = [bookface(), { id: "broken", name: "Broken", description: "no query", url: "https://x.example.com/search?q=none" }, user("hn"), user("fine")];
  const w = await fixture({ architect: { found: true, raw: entries } });
  try {
    await w.store.migrate();
    const r = await w.store.list();
    assert.deepEqual(ids(r).slice(0, 2), ["bookface", "fine"]);
    assert.ok(r.notices.some((n) => /source "broken": \{query\} must appear exactly once in the url/.test(n)), JSON.stringify(r.notices));
    assert.ok(r.notices.some((n) => /source "hn": "hn" is a built-in source id/.test(n)), "a legacy built-in id is still refused");
  } finally {
    await w.cleanup();
  }
});

test("a migration that can't be read leaves the state unset and writes nothing (retried at the next boot)", async () => {
  const w = await fixture();
  w.architect = { found: true, unreadable: true };
  try {
    await w.store.migrate();
    assert.equal((await readFile(w.file, "utf-8").catch(() => null)), null);
    w.architect = { found: true, raw: [bookface()] };
    await w.store.migrate();
    assert.deepEqual(ids(await w.store.list()).slice(0, 1), ["bookface"]);
  } finally {
    await w.cleanup();
  }
});

test("FR-011: a built-in missing from an existing file is added enabled at its default place", async () => {
  const w = await fixture();
  try {
    await writeFile(w.file, JSON.stringify({ version: 1, migration: { architect: "done" }, sources: [{ id: "mine", kind: "command", enabled: true, private: true, name: "Mine", description: "d", command: ["x", "{query}"] }, { id: "web", kind: "builtin", enabled: false }, { id: "github", kind: "builtin", enabled: true }, { id: "hn", kind: "builtin", enabled: true }] }));
    const r = await w.store.list();
    assert.deepEqual(ids(r), ["mine", "web", "github", "packages", "stackoverflow", "hn", "reddit", "arxiv", "x"]);
    assert.equal(r.sources.find((s) => s.id === "web").enabled, false, "what the user turned off stays off");
    assert.equal(r.sources.find((s) => s.id === "packages").enabled, true);
  } finally {
    await w.cleanup();
  }
});

test("AC-1.4: saving a new order is what list returns, and the ordered enabled rows follow it", async () => {
  const w = await fixture();
  try {
    const r = await w.store.list();
    const moved = [...r.sources.slice(1, 3), r.sources[0], ...r.sources.slice(3)].map((s) => ({ id: s.id, enabled: s.enabled }));
    assert.deepEqual(await w.store.save({ sources: moved }), { ok: true });
    assert.deepEqual(ids(await w.store.list()).slice(0, 3), ["github", "packages", "web"]);
    assert.deepEqual((await w.store.rows()).slice(0, 3).map((s) => s.id), ["github", "packages", "web"]);
    assert.ok(w.hints.some((h) => h.kind === "research.sources.updated"));
    assert.ok(w.changes >= 1, "agents are recompiled on a save");
  } finally {
    await w.cleanup();
  }
});

test("AC-1.5/1.6: turning a source off is stored; `rows()` carries the flag; web off is visible as such", async () => {
  const w = await fixture();
  try {
    const rows = (await w.store.list()).sources.map((s) => ({ id: s.id, enabled: s.id !== "web" && s.id !== "hn" }));
    assert.deepEqual(await w.store.save({ sources: rows }), { ok: true });
    const all = await w.store.rows();
    assert.equal(all.find((s) => s.id === "web").enabled, false);
    assert.equal(await w.store.webEnabled(), false);
    assert.deepEqual((await w.store.enabledRows()).map((s) => s.id), ["github", "packages", "stackoverflow", "reddit", "arxiv", "x"]);
  } finally {
    await w.cleanup();
  }
});

test("AC-1.7: a built-in has no Remove; a list missing one is refused; extra fields on a built-in row are ignored", async () => {
  const w = await fixture();
  try {
    const rows = (await w.store.list()).sources.filter((s) => s.id !== "arxiv").map((s) => ({ id: s.id, enabled: true }));
    assert.deepEqual(await w.store.save({ sources: rows }), { ok: false, error: "Built-in sources can be turned off, not removed", id: "arxiv" });
    const edited = (await w.store.list()).sources.map((s) => (s.id === "hn" ? { id: "hn", enabled: true, name: "Renamed", description: "x", private: true } : { id: s.id, enabled: true }));
    assert.deepEqual(await w.store.save({ sources: edited }), { ok: true });
    const hn = (await w.store.list()).sources.find((s) => s.id === "hn");
    assert.equal(hn.name, "Hacker News");
    assert.equal(hn.private, false);
  } finally {
    await w.cleanup();
  }
});

test("AC-1.8: a credential literal in a header or env value, an argv option or a scanner hit is refused and nothing is written", async () => {
  const w = await fixture();
  try {
    const base = (await w.store.list()).sources.map((s) => ({ id: s.id, enabled: true }));
    const bad = [
      user("a", { command: ["tool", "{query}"], env: { API_TOKEN: "abcd1234abcd1234" } }),
      user("b", { command: undefined, url: "https://x.example.com/s?q={query}", headers: { Authorization: "Bearer abcdef0123456789" } }),
      user("c", { command: ["tool", "{query}", "--token", "abc"] }),
      user("d", { command: ["tool", "{query}", "ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"] }),
    ];
    for (const src of bad) {
      const r = await w.store.save({ sources: [src, ...base] });
      assert.equal(r.ok, false, src.id);
      assert.match(r.error, /Put this value in Secrets and use \{secret:NAME\} in a header or env value/, src.id);
      assert.equal(r.id, src.id);
    }
    await assert.rejects(readFile(w.file, "utf-8"), "nothing was written");
    // a stored secret value, literal in a plain header
    const s2 = await fixture({ secrets: [{ key: "K", scope: "shared", value: "stored-secret-value-9" }] });
    try {
      const r = await s2.store.save({ sources: [user("e", { command: undefined, url: "https://x.example.com/s?q={query}", headers: { Accept: "stored-secret-value-9" } }), ...base] });
      assert.equal(r.ok, false);
      assert.ok(!JSON.stringify(r).includes("stored-secret-value-9"), "the value is never echoed");
    } finally {
      await s2.cleanup();
    }
  } finally {
    await w.cleanup();
  }
});

test("AC-1.8: an unreadable secrets store or an unavailable scanner REFUSES a save", async () => {
  const w = await fixture({ secrets: "throw" });
  try {
    const base = (await w.store.list()).sources.map((s) => ({ id: s.id, enabled: true }));
    const r = await w.store.save({ sources: [user("a"), ...base] });
    assert.equal(r.ok, false);
    assert.match(r.error, /Couldn't check the sources for credentials/);
  } finally {
    await w.cleanup();
  }
  const v = await fixture({ scanner: () => ({ scan: async () => ({ clean: false, unavailable: true, hits: [] }) }) });
  try {
    const base = (await v.store.list()).sources.map((s) => ({ id: s.id, enabled: true }));
    assert.match((await v.store.save({ sources: [user("a", { command: ["tool", "{query}", "--type", "posts"] }), ...base] })).error, /Couldn't check the sources for credentials/);
  } finally {
    await v.cleanup();
  }
});

test("AC-1.9: a reference to a secret that isn't in Secrets shows as missing (a name, never a value)", async () => {
  const w = await fixture({ secrets: [] });
  try {
    const base = (await w.store.list()).sources.map((s) => ({ id: s.id, enabled: true }));
    assert.deepEqual(await w.store.save({ sources: [bookface(), ...base] }), { ok: true });
    const row = (await w.store.list()).sources[0];
    assert.deepEqual(row.secretRefs, ["YC_TOKEN"]);
    assert.deepEqual(row.missingSecrets, ["YC_TOKEN"]);
    w.secrets = [{ key: "YC_TOKEN", scope: "shared", value: "yc-token-value-1234" }];
    assert.deepEqual((await w.store.list()).sources[0].missingSecrets, []);
    w.secrets = [{ key: "YC_TOKEN", scope: "session", value: "yc-token-value-1234" }];
    assert.deepEqual((await w.store.list()).sources[0].missingSecrets, ["YC_TOKEN"], "only a SHARED secret is resolved at run time");
  } finally {
    await w.cleanup();
  }
});

test("AC-1.12: at most 20 sources of your own; AC-1.13: a built-in id (or `skills`) is refused", async () => {
  const w = await fixture();
  try {
    const base = (await w.store.list()).sources.map((s) => ({ id: s.id, enabled: true }));
    const twenty = Array.from({ length: 20 }, (_, i) => user(`s${i}`));
    assert.deepEqual(await w.store.save({ sources: [...twenty, ...base] }), { ok: true });
    const r = await w.store.save({ sources: [...twenty, user("s20"), ...base] });
    assert.deepEqual(r, { ok: false, error: "At most 20 sources of your own" });
    for (const id of ["web", "github", "packages", "stackoverflow", "skills"]) {
      const clash = await w.store.save({ sources: [user(id), ...base] });
      assert.equal(clash.ok, false, id);
      assert.match(clash.error, /is a built-in source id/, id);
    }
    const dup = await w.store.save({ sources: [user("a"), user("a"), ...base] });
    assert.match(dup.error, /share the id "a"/);
  } finally {
    await w.cleanup();
  }
});

test("a user source keeps addedBy / addedAt across saves; a new one is added by the user", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface()] } });
  try {
    await w.store.migrate();
    w.now += 5000;
    const rows = (await w.store.list()).sources.map((s) => (s.builtin ? { id: s.id, enabled: s.enabled } : { ...s, enabled: false }));
    await w.store.save({ sources: [...rows, user("fresh")] });
    const r = await w.store.list();
    assert.equal(r.sources[0].addedBy, "migration");
    assert.equal(r.sources[0].enabled, false);
    const fresh = r.sources.find((s) => s.id === "fresh");
    assert.equal(fresh.addedBy, "user");
    assert.equal(fresh.private, true, "private defaults to true");
    assert.equal((await stored(w)).sources.find((s) => s.id === "bookface").addedAt, new Date(1_800_000_000_000).toISOString());
    assert.deepEqual(r.notices, [], "a save clears the migration notices");
  } finally {
    await w.cleanup();
  }
});

test("a wire row sent back as the page got it is accepted (the extra read-only fields are ignored)", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface(), posts()] } });
  try {
    await w.store.migrate();
    const echoed = (await w.store.list()).sources;
    assert.deepEqual(await w.store.save({ sources: echoed }), { ok: true });
    assert.deepEqual(ids(await w.store.list()), ["bookface", "bookface-posts", ...DEFAULT_IDS]);
  } finally {
    await w.cleanup();
  }
});

test("save refuses a malformed request with a sentence", async () => {
  const w = await fixture();
  try {
    for (const bad of [null, {}, { sources: "x" }, { sources: [null] }, { sources: [{ id: 5 }] }]) {
      const r = await w.store.save(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(typeof r.error, "string");
    }
  } finally {
    await w.cleanup();
  }
});

// ---- test (AC-1.10, AC-1.11) ----

test("AC-1.10/1.11: test runs the source, reports count/first result and timing, truncates a private sample to 200 characters and never logs it", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface()] } });
  const logged = [];
  try {
    await w.store.migrate();
    const secretAnswer = "S".repeat(500);
    const calls = [];
    const runTest = async (source, query) => {
      calls.push({ id: source.id, query });
      if (source.id === "bookface") return { count: 1, first: { title: "A post" }, text: secretAnswer };
      return { count: 3, first: { title: "Result one", url: "https://example.com/1" } };
    };
    const t = createResearchSources({ file: w.file, readArchitectSources: async () => ({ found: false }), stripArchitectSources: async () => {}, loadSecrets: async () => [], runTest, now: () => w.now, log: { warn: (m) => logged.push(m), info: (m) => logged.push(m), log: (m) => logged.push(m) } });
    const priv = await t.test({ id: "bookface" });
    assert.equal(priv.ok, true);
    assert.equal(priv.count, 1);
    assert.deepEqual(priv.first, { title: "A post" });
    assert.equal(priv.sample.length, 200);
    assert.deepEqual(calls[0], { id: "bookface", query: "test" });
    assert.ok(!logged.join("\n").includes("SSSS"), "a private sample is never logged");
    const web = await t.test({ id: "github", query: "pnpm" });
    assert.equal(web.ok, true);
    assert.equal(web.count, 3);
    assert.equal(web.first.title, "Result one");
    assert.equal(web.sample, undefined, "a built-in has no sample");
    assert.deepEqual(calls[1], { id: "github", query: "pnpm" });
    assert.equal(typeof priv.ms, "number");
  } finally {
    await w.cleanup();
  }
});

test("test: a failure is the sentence the search itself gives; an unknown id and an unsaved source (the add form) are handled; 60 s cap", async () => {
  const w = await fixture();
  try {
    const t = createResearchSources({
      file: w.file,
      readArchitectSources: async () => ({ found: false }),
      stripArchitectSources: async () => {},
      loadSecrets: async () => [],
      runTest: async (source) => {
        if (source.id === "slow") return new Promise(() => {});
        throw new ResearchError("The source's program isn't installed on this box");
      },
      testTimeoutMs: 30,
      log: { warn() {} },
    });
    assert.deepEqual(await t.test({ id: "github" }), { ok: false, error: "The source's program isn't installed on this box" });
    assert.deepEqual(await t.test({ id: "nope" }), { ok: false, error: 'Unknown source "nope"' });
    assert.deepEqual(await t.test({ source: user("slow") }), { ok: false, error: "The source timed out" });
    const bad = await t.test({ source: { id: "x" } });
    assert.equal(bad.ok, false);
    const unsaved = await t.test({ source: user("fresh") });
    assert.equal(unsaved.ok, false);
    assert.match(unsaved.error, /isn't installed/);
  } finally {
    await w.cleanup();
  }
});

// ---- review round 1, finding 3: a damaged or unreadable store must not turn the web (and every default) back on ----

import { mkdir, readdir } from "node:fs/promises";
const DAMAGED = /damaged/;
const UNREADABLE_RE = /couldn't be read/;

test("a CORRUPT file: the runtime reads (rows, enabledRows, webEnabled) refuse with a clear sentence instead of reading as the defaults; the page's list carries the error", async () => {
  const w = await fixture();
  try {
    for (const bad of ["{ not json", "[]", '{"sources": "x"}', "null"]) {
      await writeFile(w.file, bad);
      for (const read of [() => w.store.rows(), () => w.store.enabledRows(), () => w.store.webEnabled()]) {
        await assert.rejects(read(), (e) => DAMAGED.test(e.message) && e.name === "ResearchError", bad);
      }
      const l = await w.store.list();
      assert.deepEqual(l.sources, []);
      assert.match(l.error, DAMAGED);
      assert.equal(await readFile(w.file, "utf-8"), bad, "nothing was overwritten");
    }
    assert.deepEqual(await w.store.test({ id: "hn" }), { ok: false, error: (await w.store.list()).error });
  } finally {
    await w.cleanup();
  }
});

test("a file that can't be READ (here: a folder in its place) is the other unavailable case: refused with its own sentence, the save refuses and touches nothing", async () => {
  const w = await fixture();
  try {
    await mkdir(w.file, { recursive: true });
    await assert.rejects(w.store.rows(), (e) => UNREADABLE_RE.test(e.message));
    await assert.rejects(w.store.webEnabled(), (e) => UNREADABLE_RE.test(e.message));
    const l = await w.store.list();
    assert.match(l.error, UNREADABLE_RE);
    const r = await w.store.save({ sources: DEFAULT_IDS.map((id) => ({ id, enabled: true })) });
    assert.equal(r.ok, false);
    assert.match(r.error, UNREADABLE_RE);
    assert.deepEqual(await readdir(w.dir), ["research-sources.json"], "nothing moved, nothing written");
  } finally {
    await w.cleanup();
  }
});

test("saving over a CORRUPT file keeps the bad file aside (research-sources.json.corrupt-<time>, byte for byte) and writes the new list; the store is readable again", async () => {
  const w = await fixture();
  try {
    await writeFile(w.file, '{"sources": [ {broken');
    const r = await w.store.save({ sources: DEFAULT_IDS.map((id) => ({ id, enabled: id !== "web" })) });
    assert.deepEqual(r, { ok: true });
    const names = (await readdir(w.dir)).sort();
    assert.equal(names.length, 2, names.join());
    const aside = names.find((n) => n.startsWith("research-sources.json.corrupt-"));
    assert.ok(aside, names.join());
    assert.equal(await readFile(join(w.dir, aside), "utf-8"), '{"sources": [ {broken');
    assert.equal(await w.store.webEnabled(), false, "what the user saved now is what applies");
    assert.equal((await w.store.list()).error, undefined);
    // a second damaged file does not overwrite the first copy
    await writeFile(w.file, "also broken");
    w.now += 1000;
    await w.store.save({ sources: DEFAULT_IDS.map((id) => ({ id, enabled: true })) });
    assert.equal((await readdir(w.dir)).filter((n) => n.includes(".corrupt-")).length, 2);
  } finally {
    await w.cleanup();
  }
});

test("migrate leaves a corrupt file alone (nothing imported, nothing moved) and tries again at the next boot", async () => {
  const w = await fixture({ architect: { found: true, raw: [bookface()] } });
  try {
    await writeFile(w.file, "{ broken");
    assert.deepEqual(await w.store.migrate(), { state: null });
    assert.equal(await readFile(w.file, "utf-8"), "{ broken");
    assert.equal(w.strips, 0);
    assert.deepEqual((await readdir(w.dir)), ["research-sources.json"]);
  } finally {
    await w.cleanup();
  }
});
