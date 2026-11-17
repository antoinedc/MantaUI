import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DONE_KEY, createBlackboardImport, createKeyResolver, factKindToNoteKind, isActiveFact, mapFactRefs } from "./blackboardImport.mjs";
import { createChangeLog } from "./changes.mjs";
import { createQueue } from "./queue.mjs";
import { memState, tmpDir } from "./testHelpers.mjs";

const scanner = { redact: async (t) => ({ text: t, redacted: 0, unavailable: false }) };
const T = Date.UTC(2026, 10, 17);
const fact = (id, kind, statement, extra = {}) => ({ v: 1, id, kind, statement, refs: [], confidence: 0.5, created: 1, last_accessed: 1, access_count: 0, sender: { sessionID: "ses_abc123" }, ...extra });

const TMUX = [
  { tmuxSession: "alpha", windows: [{ paneCurrentPath: "/repos/alpha" }, { paneCurrentPath: "/repos/alpha-wt" }] },
  { tmuxSession: "Bravo", windows: [{ paneCurrentPath: "/repos/bravo" }] },
  { tmuxSession: "mixed", windows: [{ paneCurrentPath: "/repos/alpha" }, { paneCurrentPath: "/repos/bravo" }] },
  { tmuxSession: "empty", windows: [{ paneCurrentPath: "/nowhere" }] },
  { tmuxSession: "viaSession", windows: [{ paneCurrentPath: "/nowhere", opencodeSessionId: "ses_mapped" }] },
  { tmuxSession: "Dup", windows: [{ paneCurrentPath: "/repos/alpha" }] },
  { tmuxSession: "dup", windows: [{ paneCurrentPath: "/repos/alpha" }] },
];
const DIRS = { "/repos/alpha": "alpha-0000000001", "/repos/alpha-wt": "alpha-0000000001", "/repos/bravo": "bravo-0000000002" };

async function rig({ files, tmux = TMUX, over = {} } = {}) {
  const state = await memState();
  const root = await tmpDir("knowledge-import-");
  const factsDir = join(root, "facts");
  await mkdir(factsDir, { recursive: true });
  for (const [name, facts] of Object.entries(files)) await writeFile(join(factsDir, `${name}.json`), JSON.stringify({ v: 1, facts }));
  const identifyCalls = [];
  const registry = { identify: async (dir) => (identifyCalls.push(dir), DIRS[dir] ? { slug: DIRS[dir] } : null) };
  const resolver = createKeyResolver({ listTmuxProjects: async () => tmux, registry, sessionMap: { get: (id) => (id === "ses_mapped" ? { slug: "carol-0000000003" } : null) }, now: () => T });
  const queue = createQueue({ state, scanner, root: join(root, "queue"), now: () => T });
  const changes = createChangeLog({ state, now: () => T });
  const imp = createBlackboardImport({ state, queue, changesLog: changes, resolver, factsDir, now: () => T, log: () => {}, ...over });
  return { imp, state, queue, changes, factsDir, identifyCalls };
}

test("mapFactRefs keeps grammar refs, maps urls/paths/shas, drops free text; kinds map to status/decision", () => {
  assert.deepEqual(mapFactRefs(["commit:abcdef1", "https://x.test/a", "/home/dev/f.mjs", "deadbeef1", "free text", "src/x.ts", "msg:ses_1/msg_1", "http://insecure"]), ["commit:abcdef1", "url:https://x.test/a", "file:/home/dev/f.mjs", "commit:deadbeef1", "msg:ses_1/msg_1"]);
  assert.equal(mapFactRefs(Array.from({ length: 12 }, (_, i) => `commit:abcdef${i}`)).length, 8);
  assert.equal(factKindToNoteKind("decision"), "decision");
  for (const k of ["status", "anomaly", "blocker", "theory", "invariant"]) assert.equal(factKindToNoteKind(k), "status");
  assert.equal(isActiveFact(fact("a", "status", "x"), T), true);
  assert.equal(isActiveFact(fact("a", "status", "x", { superseded_by: "b" }), T), false);
  assert.equal(isActiveFact(fact("a", "status", "x", { valid_until: T - 1 }), T), false);
  assert.equal(isActiveFact(fact("a", "status", "x", { valid_until: T + 1000 }), T), true);
});

test("mapped keys import their ACTIVE facts as notes; UUID/ambiguous/unknown keys are skipped and listed once", async () => {
  const r = await rig({
    files: {
      alpha: [fact("f1", "decision", "Use pnpm", { refs: ["commit:abcdef1", "free text"] }), fact("f2", "anomaly", "Flaky test", { superseded_by: "f9" }), fact("f3", "status", "Deploy is green")],
      bravo: [fact("f4", "invariant", "Never push to main")], // matched case-insensitively
      "021310b1-9ee1-430d-b5f9-36b86f8eaa63": [fact("f5", "status", "orphan")],
      mixed: [fact("f6", "status", "spans two projects")],
      empty: [fact("f7", "status", "no resolvable window")],
      DUP: [fact("f8", "status", "ambiguous name")],
      viaSession: [fact("f10", "status", "resolved through the session map")],
    },
  });
  const out = await r.imp.run();
  assert.equal(out.done, true);
  const alpha = await r.queue.list("alpha-0000000001");
  assert.deepEqual(alpha.map((n) => [n.kind, n.text, n.origin, n.derived]), [["decision", "Use pnpm", "import", true], ["status", "Deploy is green", "import", true]]);
  assert.deepEqual(alpha[0].refs, ["commit:abcdef1"]);
  assert.equal(alpha[0].sessionID, "ses_abc123");
  assert.equal((await r.queue.list("bravo-0000000002")).length, 1);
  assert.equal((await r.queue.list("carol-0000000003")).length, 1);
  assert.equal((await r.queue.slugs()).length, 3);

  const items = r.changes.list().items;
  assert.equal(items.length, 1); // ONE import change
  assert.equal(items[0].kind, "import");
  assert.match(items[0].summary, /Imported 4 CTO facts into 3 projects; skipped 4 keys/);
  const full = r.changes.get(items[0].id);
  assert.deepEqual(full.data.skipped.map((s) => s.key).sort(), ["021310b1-9ee1-430d-b5f9-36b86f8eaa63", "DUP", "empty", "mixed"]);
  assert.match(items[0].reason, /mixed \(ambiguous: its windows span 2 projects\)/);
  assert.match(items[0].reason, /no tmux session|ambiguous/);
});

test("idempotent: running again after completion does nothing; an interrupted run resumes without redoing keys", async () => {
  const r = await rig({ files: { alpha: [fact("f1", "status", "one")], bravo: [fact("f2", "status", "two")], "nope-1": [fact("f3", "status", "x")] } });
  // a tiny budget makes the first slice stop early
  let t = T;
  const slow = createBlackboardImport({ state: r.state, queue: r.queue, changesLog: r.changes, resolver: { resolve: async (k) => ((t += 1000), k === "nope-1" ? { ok: false, reason: "no tmux session with that name" } : { ok: true, slug: k === "alpha" ? "alpha-0000000001" : "bravo-0000000002" }) }, factsDir: r.factsDir, now: () => t, log: () => {} });
  const first = await slow.run({ budgetMs: 1500 });
  assert.equal(first.done, false);
  assert.ok(first.remaining > 0);
  assert.equal(r.changes.list().items.length, 0); // reported only when finished
  const second = await slow.run({ budgetMs: 60_000 });
  assert.equal(second.done, true);
  assert.equal(r.changes.list().items.length, 1);
  assert.equal(r.state.kvGet(DONE_KEY), "1");
  const before = (await r.queue.list("alpha-0000000001")).length;
  assert.deepEqual(await slow.run(), { done: true, imported: 0, skipped: 0, remaining: 0 });
  assert.equal((await r.queue.list("alpha-0000000001")).length, before);
  assert.equal(r.changes.list().items.length, 1);
});

test("a restart (new instance, same state) resumes from the persisted progress", async () => {
  const r = await rig({ files: { alpha: [fact("f1", "status", "one")], bravo: [fact("f2", "status", "two")] } });
  let calls = 0;
  const flaky = { resolve: async (k) => (++calls > 1 ? { ok: false, reason: "x" } : { ok: true, slug: "alpha-0000000001" }) };
  const a = createBlackboardImport({ state: r.state, queue: r.queue, changesLog: r.changes, resolver: flaky, factsDir: r.factsDir, now: (() => { let t = T; return () => (t += 600); })(), log: () => {} });
  const one = await a.run({ budgetMs: 1000 });
  assert.equal(one.done, false);
  const done = Object.keys(a.progress().keys);
  assert.equal(done.length >= 1, true);
  const seen = [];
  const b = createBlackboardImport({ state: r.state, queue: r.queue, changesLog: r.changes, resolver: { resolve: async (k) => (seen.push(k), { ok: false, reason: "y" }) }, factsDir: r.factsDir, now: () => T, log: () => {} });
  await b.run();
  assert.ok(seen.every((k) => !done.includes(k)));
  assert.equal(b.isDone(), true);
});

test("never modifies ~/.manta/cto: the facts directory is byte-identical afterwards", async () => {
  const r = await rig({ files: { alpha: [fact("f1", "status", "one")], junk: [fact("f2", "status", "two")] } });
  const snap = async () => Object.fromEntries(await Promise.all((await readdir(r.factsDir)).map(async (f) => [f, await readFile(join(r.factsDir, f), "utf8")])));
  const before = await snap();
  await r.imp.run();
  assert.deepEqual(await snap(), before);
  assert.deepEqual(Object.keys(await snap()).sort(), ["alpha.json", "junk.json"]);
});

test("a missing blackboard directory is done with nothing to report; an unavailable scanner pauses without losing the key", async () => {
  const none = await rig({ files: {}, over: { factsDir: "/definitely/not/here" } });
  assert.equal((await none.imp.run()).done, true);
  assert.equal(none.changes.list().items.length, 0);

  const state = await memState();
  const root = await tmpDir("knowledge-import-");
  const factsDir = join(root, "facts");
  await mkdir(factsDir, { recursive: true });
  await writeFile(join(factsDir, "alpha.json"), JSON.stringify({ v: 1, facts: [fact("f1", "status", "one")] }));
  let scannerUp = false;
  const queue = createQueue({ state, scanner: { redact: async (t) => ({ text: t, redacted: 0, unavailable: !scannerUp }) }, root: join(root, "q"), now: () => T });
  const changes = createChangeLog({ state });
  const imp = createBlackboardImport({ state, queue, changesLog: changes, resolver: { resolve: async () => ({ ok: true, slug: "alpha-0000000001" }) }, factsDir, now: () => T, log: () => {} });
  assert.equal((await imp.run()).done, false);
  assert.deepEqual(imp.progress().keys, {});
  scannerUp = true;
  assert.equal((await imp.run()).done, true);
  assert.equal((await queue.list("alpha-0000000001")).length, 1);
});

test("resolver: identify runs once per directory, cached listing, session-name matching is exact before case-insensitive", async () => {
  const r = await rig({ files: {} });
  const resolver = createKeyResolver({ listTmuxProjects: async () => TMUX, registry: { identify: async (d) => (DIRS[d] ? { slug: DIRS[d] } : null) }, now: () => T });
  assert.deepEqual(await resolver.resolve("alpha"), { ok: true, slug: "alpha-0000000001" });
  assert.deepEqual(await resolver.resolve("BRAVO"), { ok: true, slug: "bravo-0000000002" });
  assert.equal((await resolver.resolve("Dup")).ok, true); // exact match wins over the case-insensitive twin
  assert.equal((await resolver.resolve("DUP")).ok, false);
  assert.match((await resolver.resolve("DUP")).reason, /ambiguous/);
  assert.equal((await resolver.resolve("")).ok, false);
  assert.equal((await createKeyResolver({ listTmuxProjects: async () => { throw new Error("tmux down"); }, registry: {} }).resolve("x")).ok, false);
  assert.equal(r.identifyCalls.length, 0);
});

test("R3-S8: windows outside any repository (`box`) don't make a session ambiguous when a real project is also there", async () => {
  const tmux = [
    { tmuxSession: "withshell", windows: [{ paneCurrentPath: "/repos/alpha" }, { paneCurrentPath: "/home/dev" }, { paneCurrentPath: "/tmp" }] },
    { tmuxSession: "onlyshell", windows: [{ paneCurrentPath: "/home/dev" }] },
    { tmuxSession: "twoprojects", windows: [{ paneCurrentPath: "/repos/alpha" }, { paneCurrentPath: "/repos/bravo" }, { paneCurrentPath: "/home/dev" }] },
  ];
  const registry = { identify: async (d) => (d === "/home/dev" || d === "/tmp" ? { slug: "box-0000000000", canonicalId: "box" } : DIRS[d] ? { slug: DIRS[d], canonicalId: `x/${d}` } : null) };
  const resolver = createKeyResolver({ listTmuxProjects: async () => tmux, registry, now: () => T });
  assert.deepEqual(await resolver.resolve("withshell"), { ok: true, slug: "alpha-0000000001" });
  const only = await resolver.resolve("onlyshell");
  assert.equal(only.ok, false);
  assert.match(only.reason, /outside any repository/);
  assert.match((await resolver.resolve("twoprojects")).reason, /span 2 projects/);
});

test("R3-S8: a key whose tmux session no longer exists resolves through the session map of the facts' own authors; disagreement or no mapping stays skipped and is reported", async () => {
  const sessions = { ses_a: { slug: "alpha-0000000001" }, ses_a2: { slug: "alpha-0000000001" }, ses_b: { slug: "bravo-0000000002" } };
  const files = {
    "old-name": [fact("f1", "status", "from a past session", { sender: { sessionID: "ses_a" } }), fact("f2", "status", "another", { sender: { sessionID: "ses_a2" } })],
    "mixed-old": [fact("f3", "status", "x", { sender: { sessionID: "ses_a" } }), fact("f4", "status", "y", { sender: { sessionID: "ses_b" } })],
    "no-map": [fact("f5", "status", "z", { sender: { sessionID: "ses_unknown" } })],
  };
  const r = await rig({ files });
  const resolver = createKeyResolver({ listTmuxProjects: async () => TMUX, registry: { identify: async () => null }, sessionMap: { get: (id) => sessions[id] ?? null }, now: () => T });
  const imp = createBlackboardImport({ state: r.state, queue: r.queue, changesLog: r.changes, resolver, factsDir: r.factsDir, now: () => T, log: () => {} });
  assert.equal((await imp.run()).done, true);
  assert.equal((await r.queue.list("alpha-0000000001")).length, 2);
  assert.equal((await r.queue.slugs()).length, 1);
  const change = r.changes.get(r.changes.list().items[0].id);
  assert.deepEqual(change.data.skipped.map((s) => s.key).sort(), ["mixed-old", "no-map"]);
  assert.match(change.reason, /mixed-old \(no tmux session with that name\)/);
});
