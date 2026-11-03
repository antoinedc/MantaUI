// CHANGELOG.md parsing + the `server:changelog` channel. Fixtures and injected
// I/O only — nothing here reads the real ~/.manta/auth.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangelog, createChangelogLoader, CHANGELOG_PATH, loadChangelog } from "./changelog.mjs";
import { buildHandlers, dispatch } from "./rpc.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

const FIXTURE = `# Changelog

Intro with **Box** (server) and **Desktop**.

## 1.3.0 — Box + Desktop — 2026-11-03

<!-- highlights
headline: Routines are here
items:
  - title: Routines
    icon: repeat
    text: Recurring work in a fresh session each run.
    action: routines
  - title: Cheaper handoffs
    icon: arrow-left-right
    text: Written by a cheap model.
    action: settings:models
-->

Ships: Box \`server-v1.3.0\`, Desktop \`mac-v1.3.0\` / \`win-v1.3.0\`, Website
\`web-v1.3.0\`. iOS unchanged.

### Routines
- **Scheduled work.** Does things.

### Fixes
- Fixed a thing.

## 1.2.0 — Server + Desktop · iOS 1.2.0 — 2026-11-01

Ships: Server \`server-v1.2.0\`.

### Fixes
- **A fix.** It works.

## Unreleased

- not a release

## 1.0.0 — 2026-10-23

First release.
`;

test("parses entries newest first, skipping headings without a version", () => {
  const { entries, warnings } = parseChangelog(FIXTURE);
  assert.deepEqual(warnings, []);
  assert.deepEqual(entries.map((e) => e.version), ["1.3.0", "1.2.0", "1.0.0"]);
  assert.deepEqual(entries.map((e) => e.date), ["2026-11-03", "2026-11-01", "2026-10-23"]);
});

test("components are lowercase, box → server, one per label, version numbers dropped", () => {
  const { entries } = parseChangelog(FIXTURE);
  assert.deepEqual(entries[0].components, ["server", "desktop"]);
  assert.deepEqual(entries[1].components, ["server", "desktop", "ios"]);
  assert.deepEqual(entries[2].components, []);
});

test("highlights are read from the comment; the comment and the Ships paragraph are not in the markdown", () => {
  const [e] = parseChangelog(FIXTURE).entries;
  assert.equal(e.headline, "Routines are here");
  assert.deepEqual(e.highlights, [
    { title: "Routines", text: "Recurring work in a fresh session each run.", icon: "repeat", action: "routines" },
    { title: "Cheaper handoffs", text: "Written by a cheap model.", icon: "arrow-left-right", action: "settings:models" },
  ]);
  assert.ok(!e.markdown.includes("<!--"));
  assert.ok(!e.markdown.includes("Ships:"));
  assert.ok(!e.markdown.includes("web-v1.3.0"), "the whole multi-line Ships paragraph goes");
  assert.equal(e.markdown, "### Routines\n- **Scheduled work.** Does things.\n\n### Fixes\n- Fixed a thing.");
});

test("an entry without a block has no headline and no highlights", () => {
  const e = parseChangelog(FIXTURE).entries[1];
  assert.equal(e.headline, null);
  assert.deepEqual(e.highlights, []);
  assert.equal(e.markdown, "### Fixes\n- **A fix.** It works.");
});

test("the fingerprint is the sha256 of the entry's raw section and changes when the section does", () => {
  const { entries } = parseChangelog(FIXTURE);
  const raw = FIXTURE.slice(FIXTURE.indexOf("## 1.2.0"), FIXTURE.indexOf("## Unreleased")).trimEnd();
  assert.equal(entries[1].fingerprint, sha(raw));
  const edited = parseChangelog(FIXTURE.replace("It works.", "It works well.")).entries;
  assert.notEqual(edited[1].fingerprint, entries[1].fingerprint);
  assert.equal(edited[0].fingerprint, entries[0].fingerprint, "other entries are unaffected");
});

test("at most 10 entries", () => {
  const text = Array.from({ length: 14 }, (_, i) => `## 2.0.${13 - i} — Server — 2026-01-01\n\n- x\n`).join("\n");
  const { entries } = parseChangelog(text);
  assert.equal(entries.length, 10);
  assert.equal(entries[0].version, "2.0.13");
});

const withBlock = (block) => `## 1.0.1 — Server — 2026-01-01\n\n<!-- highlights\n${block}\n-->\n\nbody\n`;

test("a bad-YAML block is ignored with a warning and the entry keeps its notes", () => {
  const { entries, warnings } = parseChangelog(withBlock("headline: [unclosed\nitems: {"));
  assert.equal(entries[0].headline, null);
  assert.deepEqual(entries[0].highlights, []);
  assert.equal(entries[0].markdown, "body");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1\.0\.1: highlights block ignored — not valid YAML/);
});

test("wrong-shape blocks are ignored: no items, not a mapping, missing title/text, bad headline", () => {
  for (const block of ["headline: x", "- a\n- b", "items: []", "items:\n  - title: only title", "items:\n  - 5", "headline: 3\nitems:\n  - {title: a, text: b}"]) {
    const { entries, warnings } = parseChangelog(withBlock(block));
    assert.deepEqual(entries[0].highlights, [], block);
    assert.equal(entries[0].headline, null, block);
    assert.equal(warnings.length, 1, block);
  }
});

test("more than 3 items → whole block ignored", () => {
  const item = (n) => `  - {title: T${n}, text: x}`;
  const { entries, warnings } = parseChangelog(withBlock(`headline: H\nitems:\n${[1, 2, 3, 4].map(item).join("\n")}`));
  assert.deepEqual(entries[0].highlights, []);
  assert.equal(entries[0].headline, null);
  assert.match(warnings[0], /at most 3 items/);
  const three = parseChangelog(withBlock(`items:\n${[1, 2, 3].map(item).join("\n")}`));
  assert.equal(three.entries[0].highlights.length, 3);
  assert.deepEqual(three.warnings, []);
});

test("unknown icon → sparkles with a warning; missing icon → sparkles silently", () => {
  const { entries, warnings } = parseChangelog(withBlock("items:\n  - {title: A, text: a, icon: rocket}\n  - {title: B, text: b}"));
  assert.deepEqual(entries[0].highlights.map((h) => h.icon), ["sparkles", "sparkles"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown icon "rocket"/);
});

test("invalid action (including settings:cto) → null with a warning; the item stays", () => {
  const block = [
    "items:",
    "  - {title: A, text: a, action: 'settings:cto'}",
    "  - {title: B, text: b, action: 'settings:nope'}",
    "  - {title: C, text: c, action: 'open-the-door'}",
    "  - {title: D, text: d, action: 'settings:voice'}",
    "  - {title: E, text: e}",
  ].join("\n");
  // 5 items is over the cap, so check the action rules across two parses
  const first = parseChangelog(withBlock(block.split("\n").slice(0, 4).join("\n")));
  assert.deepEqual(first.entries[0].highlights.map((h) => h.action), [null, null, null]);
  assert.equal(first.warnings.length, 3);
  assert.ok(first.warnings.some((w) => w.includes("settings:cto")));
  const second = parseChangelog(withBlock("items:\n  - {title: D, text: d, action: 'settings:voice'}\n  - {title: E, text: e}"));
  assert.deepEqual(second.entries[0].highlights.map((h) => h.action), ["settings:voice", null]);
  assert.deepEqual(second.warnings, []);
});

test("`log` receives every warning", () => {
  const seen = [];
  const { warnings } = parseChangelog(withBlock("items: []"), { log: (m) => seen.push(m) });
  assert.deepEqual(seen, warnings);
  assert.equal(seen.length, 1);
});

test("a heading-like line inside a code fence does not split the entry", () => {
  const text = "## 1.0.1 — Server — 2026-01-01\n\n```md\n## 9.9.9 — fake\n```\n\nafter\n";
  const { entries } = parseChangelog(text);
  assert.deepEqual(entries.map((e) => e.version), ["1.0.1"]);
  assert.ok(entries[0].markdown.includes("## 9.9.9"));
});

test("the repository CHANGELOG.md parses cleanly", () => {
  const { entries, warnings } = parseChangelog(readFileSync(CHANGELOG_PATH, "utf8"));
  assert.deepEqual(warnings, []);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.match(e.version, /^\d+\.\d+\.\d+/);
    assert.match(e.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!e.markdown.includes("Ships:"));
    assert.ok(!e.components.includes("box"));
  }
});

// ---- loader ---------------------------------------------------------------

async function tmpFile(contents) {
  const dir = await mkdtemp(join(tmpdir(), "manta-changelog-"));
  const path = join(dir, "CHANGELOG.md");
  await writeFile(path, contents);
  return { dir, path };
}

test("loader: reads, caches by mtime, and re-reads when the file changes", async () => {
  const { dir, path } = await tmpFile("## 1.0.0 — Server — 2026-01-01\n\none\n");
  try {
    let reads = 0;
    const load = createChangelogLoader({
      path,
      log: () => {},
      readFileImpl: async (...a) => (reads++, (await import("node:fs/promises")).readFile(...a)),
    });
    const a = await load();
    const b = await load();
    assert.equal(reads, 1);
    assert.equal(a, b);
    assert.equal(a.entries[0].markdown, "one");

    await writeFile(path, "## 1.0.0 — Server — 2026-01-01\n\ntwo\n");
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    const c = await load();
    assert.equal(reads, 2);
    assert.equal(c.entries[0].markdown, "two");
    assert.notEqual(c.entries[0].fingerprint, a.entries[0].fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loader: a missing file is unavailable, logged, and recovers when the file appears", async () => {
  const { dir, path } = await tmpFile("x");
  try {
    const logs = [];
    const missing = join(dir, "nope.md");
    const load = createChangelogLoader({ path: missing, log: (m) => logs.push(m) });
    assert.deepEqual(await load(), { entries: [], unavailable: true });
    assert.equal(logs.length, 1);
    const ok = createChangelogLoader({ path, log: () => {} });
    assert.deepEqual(await ok(), { entries: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loader: a read or parse failure is unavailable, never a throw", async () => {
  const load = createChangelogLoader({
    path: "/x",
    log: () => {},
    statImpl: async () => ({ mtimeMs: 1, size: 1 }),
    readFileImpl: async () => {
      throw new Error("EACCES");
    },
  });
  assert.deepEqual(await load(), { entries: [], unavailable: true });
});

test("the default path is the repo's CHANGELOG.md regardless of the process cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "manta-changelog-cwd-"));
  const before = process.cwd();
  try {
    process.chdir(dir);
    const r = await loadChangelog();
    assert.ok(!r.unavailable);
    assert.ok(r.entries.length > 0);
  } finally {
    process.chdir(before);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- server:changelog -----------------------------------------------------

const stubDeps = (extra) => ({
  tmux: { listProjects: async () => [] },
  pty: {},
  bus: {},
  syncState: {
    refreshNow: async () => {},
    applyConfig: () => {},
    snapshot: () => ({ projects: [] }),
    payloadSince: (_s, g) => ({ gen: g, seq: 0, changed: {} }),
    everSucceeded: () => true,
  },
  local: { configGet: async () => ({ projects: [] }) },
  push: { addApnsToken: async () => ({ ok: true, count: 0 }) },
  ...extra,
});

const BOX_ID = "a".repeat(32);

test("server:changelog returns the injected entries and the serverId from the injected auth loader", async () => {
  const entries = parseChangelog(FIXTURE).entries;
  const handlers = buildHandlers(stubDeps({ loadChangelog: async () => ({ entries }), loadBoxAuth: () => ({ box_id: BOX_ID }) }));
  assert.deepEqual(await dispatch(handlers, "server:changelog", []), { serverId: BOX_ID, entries });
});

test("server:changelog: no identity → serverId null; unavailable file → entries [] + unavailable", async () => {
  const handlers = buildHandlers(
    stubDeps({ loadChangelog: async () => ({ entries: [], unavailable: true }), loadBoxAuth: () => null }),
  );
  assert.deepEqual(await dispatch(handlers, "server:changelog", []), { serverId: null, entries: [], unavailable: true });
});

test("server:changelog: a throwing auth loader still answers, with serverId null", async () => {
  const handlers = buildHandlers(
    stubDeps({
      loadChangelog: async () => ({ entries: [] }),
      loadBoxAuth: () => {
        throw new Error("boom");
      },
    }),
  );
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await dispatch(handlers, "server:changelog", []), { serverId: null, entries: [] });
  } finally {
    console.warn = origWarn;
  }
});
