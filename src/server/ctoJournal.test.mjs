// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

// src/server/ctoJournal.test.mjs
// BET-1394 — journal (§3.2) cap-50 eviction at admission, facts-style
// retention, near-duplicate admission suppression, per-entry delete. Pure
// tests over an in-memory store — no live I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOURNAL_CAP,
  validateProposal,
  validateProposalList,
  normalizeProposal,
  retentionOf,
  evictToCap,
  mergeProposals,
  createCtoJournal,
} from "./ctoJournal.mjs";

function memStore() {
  const store = { saved: null, load: async () => store.saved, save: async (d) => (store.saved = d) };
  return store;
}

test("validateProposal: requires non-empty trimmed text, optional refs", () => {
  assert.equal(validateProposal({ text: "  ok  " }), true);
  assert.equal(validateProposal({ text: "ok", refs: ["m1", "file.ts"] }), true);
  assert.equal(validateProposal({ text: "   " }), false);
  assert.equal(validateProposal({ text: 5 }), false);
  assert.equal(validateProposal({ text: "x", refs: "nope" }), false);
  assert.equal(validateProposal({ text: "x", refs: [1] }), false);
  assert.equal(validateProposal(null), false);
});

test("validateProposalList: optional, capped, per-entry valid", () => {
  assert.equal(validateProposalList(undefined), true);
  assert.equal(validateProposalList([]), true);
  assert.equal(validateProposalList([{ text: "a" }, { text: "b" }]), true);
  assert.equal(validateProposalList("nope"), false);
  // over-cap is invalid
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ text: `t${i}` }));
  assert.equal(validateProposalList(tooMany), false);
});

test("retentionOf: newer access + higher access_count ⇒ higher retention", () => {
  const t = 1_000_000;
  const fresh = { created: t, last_accessed: t, access_count: 5 };
  const stale = { created: t - 60 * 86_400_000, last_accessed: t - 60 * 86_400_000, access_count: 1 };
  assert.ok(retentionOf(fresh, { nowMs: t }) > retentionOf(stale, { nowMs: t }));
});

test("evictToCap: drops the single lowest-retention entry over the cap", () => {
  const t = 1_000_000;
  const kept = { id: "k", created: t, last_accessed: t, access_count: 10 };
  const old = { id: "o", created: t - 200 * 86_400_000, last_accessed: t - 200 * 86_400_000, access_count: 0 };
  const list = [kept, old];
  evictToCap(list, { cap: 1, nowMs: t });
  assert.deepEqual(
    list.map((e) => e.id),
    ["k"],
  );
});

test("mergeProposals: near-duplicates are suppressed, cap enforced at admission", () => {
  const nowMs = 1_000_000;
  const existing = [];
  for (let i = 0; i < JOURNAL_CAP; i++) {
    existing.push({ id: `base${i}`, text: `base entry ${i}`, created: nowMs, last_accessed: nowMs, access_count: 1 });
  }
  // Admit a fresh entry for every existing one (all distinct) → still ≤ cap
  const proposals = Array.from({ length: 10 }, (_, i) => ({ text: `new entry ${100 + i}` }));
  const merged = mergeProposals(existing, proposals, { nowMs, cap: JOURNAL_CAP });
  assert.equal(merged.length, JOURNAL_CAP, "cap never exceeded at admission");
  assert.ok(merged.some((e) => e.text === "new entry 100"), "new entries admitted");

  // Near-duplicate (case/space-folded) is suppressed, not re-added
  const again = mergeProposals(merged, [{ text: "  NEW entry 100  " }], { nowMs, cap: JOURNAL_CAP });
  assert.equal(again.length, JOURNAL_CAP);
  assert.equal(again.filter((e) => e.text === "new entry 100").length, 1);
});

test("createCtoJournal: add, list, delete round-trips through the store", async () => {
  const store = memStore();
  const journal = createCtoJournal({ store, now: () => 1_000_000 });
  const added = await journal.addProposals([{ text: "first" }, { text: "second", refs: ["m1"] }]);
  assert.equal(added.added, 2);
  let all = await journal.list();
  assert.equal(all.length, 2);
  assert.ok(store.saved && store.saved.entries.length === 2, "persisted");

  const dup = await journal.addProposals([{ text: "FIRST" }]);
  assert.equal(dup.added, 0, "near-duplicate suppressed");
  all = await journal.list();
  assert.equal(all.length, 2);

  await journal.removeById(all[0].id);
  all = await journal.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].text, "second");
});

test("createCtoJournal: cap enforced across batched admissions", async () => {
  const store = memStore();
  const now = () => 1_000_000;
  const journal = createCtoJournal({ store, now, cap: 5 });
  const many = Array.from({ length: 20 }, (_, i) => ({ text: `batch ${i}`, created: now(), last_accessed: now() }));
  await journal.addProposals(many);
  const all = await journal.list();
  assert.equal(all.length, 5);
});

test("createCtoJournal: reads never throw on a missing/corrupt store", async () => {
  const bad = { load: async () => { throw new Error("missing"); }, save: async () => { throw new Error("write failed"); } };
  const journal = createCtoJournal({ store: bad });
  assert.deepEqual(await journal.list(), []);
  // In-memory admission still works; the failing persist is swallowed.
  const added = await journal.addProposals([{ text: "x" }]);
  assert.equal(typeof added, "object");
  assert.equal((await journal.list()).length, 1);
});
