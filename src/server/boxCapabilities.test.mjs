import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_CAPABILITIES, CAPABILITY_ID_PATTERN } from "./boxCapabilities.mjs";

test("the capability list is frozen and carries chat-cards-1", () => {
  assert.ok(Object.isFrozen(BOX_CAPABILITIES));
  assert.ok(BOX_CAPABILITIES.includes("chat-cards-1"));
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
