// draft.test.mjs — the box-buffered draft review store (BET-793, spec §3.4①).
// No live network, no real filesystem: every store op takes injected load/save
// backed by an in-memory array. Covers add/edit/delete round-trips, the
// head-SHA staleness rule (kept, never deleted), clear-on-success semantics,
// and the one-draft-per-PR isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getDraft,
  putComment,
  deleteComment,
  setVerdict,
  markDraftStale,
  clearDraft,
  normalizeAnchor,
  findDraft,
} from "./draft.mjs";

const REPO = "host/acme/widget";

// An in-memory stand-in for the durable JSON store: load/save deep-copy so a
// mutation inside an op is only visible after save (emulating persistence).
function memStore(seed = []) {
  let store = JSON.parse(JSON.stringify(seed));
  const events = [];
  return {
    async load() {
      return JSON.parse(JSON.stringify(store));
    },
    async save(d) {
      store = JSON.parse(JSON.stringify(d));
    },
    current() {
      return JSON.parse(JSON.stringify(store));
    },
    publish() {
      events.push(1);
    },
  };
}

test("add / edit / delete a draft comment round-trips", async () => {
  const m = memStore();
  const add = await putComment(REPO, 1, "sha1", { path: "a.ts", line: 3, side: "new", body: "hello" }, m);
  assert.equal(add.ok, true);
  assert.equal(add.draft.comments.length, 1);
  const id = add.draft.comments[0].id;
  assert.equal(id.length > 0, true, "a fresh comment gets an id");

  // Edit by id — replaces body, does not append.
  const edit = await putComment(REPO, 1, "sha1", { id, path: "a.ts", line: 3, side: "new", body: "edited" }, m);
  assert.equal(edit.ok, true);
  assert.equal(edit.draft.comments.length, 1, "edit does not add a second comment");
  assert.equal(edit.draft.comments[0].body, "edited");

  // Persisted across a reload.
  assert.equal((await getDraft(REPO, 1, m)).comments[0].body, "edited");

  // Delete by id.
  const del = await deleteComment(REPO, 1, id, m);
  assert.equal(del.ok, true);
  assert.equal(del.draft.comments.length, 0);
  assert.equal((await getDraft(REPO, 1, m)).comments.length, 0);
});

test("an empty body is rejected and never stored", async () => {
  const m = memStore();
  const r = await putComment(REPO, 1, "sha1", { path: "a.ts", line: 3, side: "new", body: "   " }, m);
  assert.equal(r.ok, false);
  assert.equal(r.error, "comment body is required");
  assert.equal((await getDraft(REPO, 1, m)), null);
});

test("normalizeAnchor rejects an invalid or missing anchor", () => {
  assert.deepEqual(normalizeAnchor({ path: "a", line: 3, side: "new" }), { path: "a", line: 3, side: "new" });
  assert.deepEqual(normalizeAnchor({ path: "a", line: 3, side: "new", startLine: 1 }), {
    path: "a", line: 3, side: "new", startLine: 1,
  });
  assert.equal(normalizeAnchor({ path: "", line: 3, side: "new" }), null, "empty path rejected");
  assert.equal(normalizeAnchor({ path: "a", line: 0, side: "new" }), null, "line 0 rejected");
  assert.equal(normalizeAnchor({ path: "a", line: 3, side: "middle" }), null, "unknown side rejected");
  assert.equal(normalizeAnchor(null), null);
});

test("two drafts for different PRs do not collide", async () => {
  const m = memStore();
  await putComment(REPO, 1, "sha", { path: "a.ts", line: 1, side: "new", body: "one" }, m);
  await putComment(REPO, 2, "sha", { path: "b.ts", line: 2, side: "new", body: "two" }, m);
  await putComment("host/other/repo", 1, "sha", { path: "c.ts", line: 3, side: "new", body: "other-repo" }, m);

  const d1 = await getDraft(REPO, 1, m);
  const d2 = await getDraft(REPO, 2, m);
  const other = await getDraft("host/other/repo", 1, m);
  assert.equal(d1.comments.length, 1);
  assert.equal(d1.comments[0].body, "one");
  assert.equal(d2.comments[0].body, "two");
  assert.equal(other.comments[0].body, "other-repo");
  assert.equal(m.current().length, 3, "three distinct drafts stored");
});

test("head-SHA change marks stale and does NOT delete (the invalidation rule)", async () => {
  const m = memStore();
  await putComment(REPO, 1, "oldsha", { path: "a.ts", line: 3, side: "new", body: "precious" }, m);
  assert.equal((await getDraft(REPO, 1, m)).headSha, "oldsha");

  // The PR moved on: markDraftStale keeps content, flips the flag.
  const stale = await markDraftStale(REPO, 1, m);
  assert.equal(stale.stale, true, "draft is flagged stale");
  assert.equal(stale.comments.length, 1, "the typed comment is kept");
  assert.equal(stale.comments[0].body, "precious");

  const after = await getDraft(REPO, 1, m);
  assert.equal(after.stale, true);
  assert.equal(after.comments[0].body, "precious", "nothing is lost on head movement");

  // Idempotent: re-marking does not double-publish or mutate further.
  const again = await markDraftStale(REPO, 1, m);
  assert.equal(again.comments.length, 1);
});

test("setVerdict persists the shared verdict subset and rejects an unknown one", async () => {
  const m = memStore();
  const r = await setVerdict(REPO, 1, "sha1", { verdict: "approve" }, m);
  assert.equal(r.ok, true);
  assert.equal(r.draft.verdict, "approve");

  const bad = await setVerdict(REPO, 1, "sha1", { verdict: "banana" }, m);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.includes("invalid verdict"), true);

  // Clearing with null resets.
  const clear = await setVerdict(REPO, 1, "sha1", { verdict: null }, m);
  assert.equal(clear.draft.verdict, null);
});

test("clearDraft removes the draft — the success-only submit step", async () => {
  const m = memStore();
  await putComment(REPO, 1, "sha1", { path: "a.ts", line: 1, side: "new", body: "x" }, m);
  assert.equal((await getDraft(REPO, 1, m)).comments.length, 1);
  const r = await clearDraft(REPO, 1, m);
  assert.equal(r.ok, true);
  assert.equal(await getDraft(REPO, 1, m), null);
  // clearDraft on a non-existent draft is a harmless no-op.
  const noop = await clearDraft(REPO, 999, m);
  assert.equal(noop.ok, true);
});

test("findDraft matches the canonical key and is a pure lookup", () => {
  const draft = { key: `${REPO}#5`, repoKey: REPO, number: 5 };
  assert.equal(findDraft([draft], REPO, 5), draft);
  assert.equal(findDraft([draft], REPO, 6), null);
  assert.equal(findDraft([], REPO, 5), null);
});
