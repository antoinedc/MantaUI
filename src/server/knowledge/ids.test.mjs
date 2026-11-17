import { test } from "node:test";
import assert from "node:assert/strict";
import { newBatchId, newDecisionId, newNoteId, ulid } from "./ids.mjs";

test("ulid: 26 Crockford chars, time-sortable, random tail", () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
  assert.notEqual(ulid(5), ulid(5));
  assert.equal(ulid(0, () => Buffer.alloc(10)), "0".repeat(26));
});

test("id prefixes: n_ / d_ / b_", () => {
  assert.match(newNoteId(), /^n_[0-9A-Z]{26}$/);
  assert.match(newDecisionId(), /^d_[0-9A-Z]{26}$/);
  assert.match(newBatchId(), /^b_[0-9A-Z]{26}$/);
});
