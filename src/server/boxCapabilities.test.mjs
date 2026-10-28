import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_CAPABILITIES, CAPABILITY_ID_PATTERN } from "./boxCapabilities.mjs";

test("the capability list is frozen and carries chat-cards-1", () => {
  assert.ok(Object.isFrozen(BOX_CAPABILITIES));
  assert.ok(BOX_CAPABILITIES.includes("chat-cards-1"));
});

test("artifacts-list-1 is advertised (WS07 M-07-S2)", () => {
  assert.ok(BOX_CAPABILITIES.includes("artifacts-list-1"));
});

test("no duplicate ids; every id is kebab-name-N", () => {
  assert.equal(new Set(BOX_CAPABILITIES).size, BOX_CAPABILITIES.length);
  for (const id of BOX_CAPABILITIES) assert.match(id, CAPABILITY_ID_PATTERN, id);
});

test("the id pattern rejects malformed ids", () => {
  for (const bad of ["chat-cards", "Chat-cards-1", "chat_cards-1", "-1", "chat-cards-x"]) {
    assert.doesNotMatch(bad, CAPABILITY_ID_PATTERN, bad);
  }
});

test("WS09 ids are advertised", () => {
  for (const id of [
    "models-table-1", "models-picker-1", "models-unidentified-1", "models-price-form-1", "ledger-view-1",
    "optimizer-view-1", "usage-resume-view-1", "usage-alerts-1", "usage-window-tone-1",
  ]) assert.ok(BOX_CAPABILITIES.includes(id), id);
});

test("WS06 search id is advertised", () => {
  assert.ok(BOX_CAPABILITIES.includes("search-scope-all-1"));
});

test("WS05 forge ids are advertised", () => {
  for (const id of ["forge-pr-view-1", "forge-diff-view-1", "forge-inbox-view-1", "forge-messages-1"]) {
    assert.ok(BOX_CAPABILITIES.includes(id), id);
  }
});
