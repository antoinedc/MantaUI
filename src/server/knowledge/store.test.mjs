import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKnowledgeStore, formatMessage, parseTrailers } from "./store.mjs";
import { execGitRunner, tmpDir } from "./testHelpers.mjs";

async function mk(opts = {}) {
  const dir = await tmpDir("knowledge-store-");
  const store = createKnowledgeStore({ dir, git: execGitRunner(dir), ...opts });
  await store.init();
  return { dir, store };
}

test("init creates the repo, .gitignore, tombstones and one commit; it is idempotent", async () => {
  const { dir, store } = await mk();
  assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /state\.sqlite/);
  assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /\.queue\//);
  assert.equal(JSON.parse(await readFile(join(dir, "tombstones.json"), "utf8")).version, 1);
  const before = await store.log();
  assert.equal(before.length, 1);
  assert.equal(before[0].author, "Manta curator");
  await store.init();
  assert.equal((await store.log()).length, 1);
});

test("commit writes one commit per decision with trailers and the curator author", async () => {
  const { store } = await mk();
  const r = await store.commit({ path: "projects/p-0123456789/gotchas.md", content: "# Gotchas\n", message: "Add gotchas", body: "because", trailers: { "Manta-Decision": "d_1", "Manta-Batch": "b_1" } });
  assert.equal(r.changed, true);
  const [c] = await store.log({ limit: 1 });
  assert.equal(c.subject, "Add gotchas");
  assert.equal(c.author, "Manta curator");
  assert.deepEqual(c.trailers, { "Manta-Decision": "d_1", "Manta-Batch": "b_1" });
  assert.match(c.body, /because/);
  assert.equal(await store.lastCommitFor("projects/p-0123456789/gotchas.md"), r.sha);
  const again = await store.commit({ path: "projects/p-0123456789/gotchas.md", content: "# Gotchas\n", message: "noop" });
  assert.equal(again.changed, false);
});

test("a dirty tree (hand edit) is committed as a user commit before the curator's", async () => {
  const { dir, store } = await mk();
  await store.commit({ path: "user/preferences.md", content: "one\n", message: "first" });
  await writeFile(join(dir, "user/preferences.md"), "one\nmine\n");
  assert.deepEqual(await store.dirty(), ["user/preferences.md"]);
  await store.commit({ path: "commons/howto/x.md", content: "x\n", message: "second" });
  const log = await store.log();
  assert.equal(log[0].subject, "second");
  assert.match(log[1].subject, /^User edits: user\/preferences\.md/);
  assert.equal(log[1].author, "User"); // no git identity in the sandbox → fallback
  assert.deepEqual(await store.dirty(), []);
});

test("the store-wide lock serialises appliers", async () => {
  const { store } = await mk();
  const order = [];
  await Promise.all([
    store.withLock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    }),
    store.withLock(async () => {
      order.push("b");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("secrets in content or message refuse the commit and write nothing", async () => {
  const scan = async (t) => ({ clean: !t.includes("SECRET"), hits: [], unavailable: false });
  const { dir, store } = await mk({ scan });
  await assert.rejects(store.commit({ path: "user/x.md", content: "a SECRET here", message: "m" }), (e) => e.code === "secret-detected");
  await assert.rejects(store.commit({ path: "user/x.md", content: "fine", message: "m SECRET" }), (e) => e.code === "secret-detected");
  assert.equal(await store.read("user/x.md"), null);
  assert.deepEqual(await store.dirty(), []);
  void dir;
});

test("paths cannot escape the store", async () => {
  const { store } = await mk();
  await assert.rejects(store.commit({ path: "../evil.md", content: "x", message: "m" }), (e) => e.code === "invalid-path");
  await assert.rejects(store.commit({ path: ".git/config", content: "x", message: "m" }), (e) => e.code === "invalid-path");
});

test("revert undoes a decision; a conflict with a later commit names it and leaves the tree untouched", async () => {
  const { dir, store } = await mk();
  const a = await store.commit({ path: "user/preferences.md", content: "- a\n", message: "add a" });
  const b = await store.commit({ path: "user/preferences.md", content: "- a\n- b\n", message: "add b" });
  const c = await store.commit({ path: "user/preferences.md", content: "- a\n- b changed\n", message: "change b" });
  const ok = await store.revert(c.sha, { trailers: { "Manta-Decision": "d_9" } });
  assert.equal(ok.ok, true);
  assert.equal(await readFile(join(dir, "user/preferences.md"), "utf8"), "- a\n- b\n");
  assert.match((await store.log({ limit: 1 }))[0].subject, /^Revert: change b/);
  assert.equal((await store.log({ limit: 1 }))[0].trailers["Manta-Decision"], "d_9");
  // reverting b now: its lines are untouched but a later (revert) commit exists → still clean; revert a: conflicts with b's append
  const conflict = await store.revert(a.sha);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "conflict");
  assert.ok(conflict.conflictWith.sha);
  assert.match(conflict.conflictWith.subject, /add b|Revert: change b/);
  assert.equal(await readFile(join(dir, "user/preferences.md"), "utf8"), "- a\n- b\n");
  assert.deepEqual(await store.dirty(), []);
  void b;
});

test("revert refuses unknown commits and reverting twice", async () => {
  const { store } = await mk();
  assert.equal((await store.revert("deadbeef")).reason, "unknown-commit");
  assert.equal((await store.revert("zz")).reason, "unknown-commit");
});

test("onCommit hooks fire for curator and user commits; listPages walks the areas", async () => {
  const { dir, store } = await mk();
  const seen = [];
  store.onCommit((e) => seen.push(e.by));
  await store.commit({ path: "commons/howto/a.md", content: "# a\n", message: "a" });
  await writeFile(join(dir, "user", "p.md"), "x").catch(() => {});
  assert.deepEqual(await store.listPages(), ["commons/howto/a.md"]);
  assert.deepEqual(seen, ["curator"]);
});

test("formatMessage / parseTrailers", () => {
  const m = formatMessage({ message: "Sub\nject", body: "why", trailers: { "Manta-Batch": "b_1", Skip: "" } });
  assert.equal(m, "Sub ject\n\nwhy\n\nManta-Batch: b_1");
  assert.deepEqual(parseTrailers("why\n\nManta-Batch: b_1\nManta-Decision: d_2"), { "Manta-Batch": "b_1", "Manta-Decision": "d_2" });
});
