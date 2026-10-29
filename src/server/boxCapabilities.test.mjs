import { test } from "node:test";
import assert from "node:assert/strict";
import { BOX_CAPABILITIES, CAPABILITY_ID_PATTERN } from "./boxCapabilities.mjs";
import { isUpgradeExemptPath } from "./upgradeV2.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The master "Capability id registry" (00-master.md, D25) — a set literal copied
// from it. An id nobody registered there must not ship.
const MASTER_REGISTRY = new Set([
  "chat-cards-1", "artifacts-list-1", "models-table-1", "models-picker-1", "models-unidentified-1",
  "models-price-form-1", "ledger-view-1", "optimizer-view-1", "usage-resume-view-1", "usage-alerts-1",
  "usage-window-tone-1", "search-scope-all-1", "forge-pr-view-1", "forge-diff-view-1", "forge-inbox-view-1",
  "forge-messages-1", "cache-stale-at-1", "context-selected-model-1", "devices-view-1",
  "forge-status-secondary-1", "update-targets-view-1", "upgrade-view-1", "launchers-flags-1",
  "accounts-copy-1", "sessions-naming-1", "forge-clone-view-1", "sessions-close-1",
  "sessions-window-status-1", "transcript-view-1", "questions-plan-1", "transcript-runs-1",
]);

// What the box advertises after each WS11 sub-step. Each step APPENDS its own ids
// here (D1 appends none); with D11 the list is the WHOLE registry (asserted below).
const EXPECTED_AFTER_STEP = [
  "chat-cards-1", "artifacts-list-1",
  "models-table-1", "models-picker-1", "models-unidentified-1", "models-price-form-1", "ledger-view-1",
  "optimizer-view-1", "usage-resume-view-1", "usage-alerts-1", "usage-window-tone-1",
  "search-scope-all-1",
  "forge-pr-view-1", "forge-diff-view-1", "forge-inbox-view-1", "forge-messages-1",
  "cache-stale-at-1", "context-selected-model-1", // D2
  "devices-view-1", "forge-status-secondary-1", "update-targets-view-1", "upgrade-view-1", "launchers-flags-1", // D3
  "accounts-copy-1", // D4
  "sessions-naming-1", // D5 (naming)
  "forge-clone-view-1", // D5 (clone)
  "sessions-close-1", // D6
  "sessions-window-status-1", // D7
  "transcript-view-1", // D8–D9
  "questions-plan-1", // D10
  "transcript-runs-1", // D11
];

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

test("the advertised list equals the stage's expected list (each WS11 step appends its ids)", () => {
  assert.deepEqual([...BOX_CAPABILITIES], EXPECTED_AFTER_STEP);
});

test("the box advertises the WHOLE master registry — no id missing, none extra (WS11 wrap-up)", () => {
  assert.deepEqual([...BOX_CAPABILITIES].sort(), [...MASTER_REGISTRY].sort());
});

test("the registry literal above is the master spec's own table (a drifted copy fails here)", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../docs/superpowers/specs/2026-10-28-ios-desktop-parity/00-master.md", import.meta.url)), "utf8");
  const start = doc.indexOf("### Capability id registry (D25)");
  const end = doc.indexOf("## Shared member registry");
  assert.ok(start >= 0 && end > start, "the master registry section exists");
  const ids = new Set([...doc.slice(start, end).matchAll(/`([a-z0-9-]+-\d+)`/g)].map((m) => m[1]));
  assert.deepEqual([...ids].sort(), [...MASTER_REGISTRY].sort());
  assert.deepEqual([...ids].sort(), [...BOX_CAPABILITIES].sort());
});

test("every advertised id is in the master registry", () => {
  for (const id of BOX_CAPABILITIES) assert.ok(MASTER_REGISTRY.has(id), `${id} is not in the master registry`);
});

test("GET /api/version is upgrade-exempt and the server:version RPC is not (why clients read REST)", () => {
  assert.equal(isUpgradeExemptPath("/api/version"), true);
  assert.equal(isUpgradeExemptPath("/rpc/server:version"), false);
});
