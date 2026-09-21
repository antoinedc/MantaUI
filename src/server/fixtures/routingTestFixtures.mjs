// fixtures/routingTestFixtures.mjs — shared routing-test fixtures (BET-1535
// S3 review Block 3: the strict duplication gate flagged the provider-model
// factory + RoutingServices builder repeated across delegate.test.mjs and
// ctoSessions.test.mjs).
//
// WHY IT EXISTS: tests NEVER construct router candidates or a RoutingServices
// context by hand — they build them from these two factories so a shape drift
// (a renamed field, a new required reader) fails identically in every suite
// instead of being re-derived (and re-drifted) per file.
//
// Pure test infrastructure: no production imports besides the model normaliser
// seam, no network, no state.

import { strict as assert } from "node:assert/strict";
import { _normalizeProviderModel } from "../opencode.mjs";
import { familyKey } from "../../shared/modelGuide.mjs";

// A raw provider-model payload in the shape opencode's `/provider` emits.
export function rawProviderModel(over = {}) {
  return {
    id: "m",
    status: "active",
    limit: { context: 32000, output: 16000 },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3 } },
    capabilities: { toolcall: true, input: ["text", "image", "pdf"] },
    ...over,
  };
}

// Turn a raw payload into the canonical OpencodeModel the router actually
// sees, asserting the fixture still normalises (drift check).
export function normalize(providerID, modelId, raw) {
  const m = _normalizeProviderModel(providerID, modelId, raw);
  assert.ok(m, "candidate must normalise (fixture drift check)");
  return m;
}

// A minimal-but-honest RoutingServices context: exact-match catalogue
// identity, family-seeded quality, per-endpoint declarations. `extra` overlays
// per-test knobs (health, accounts, ...).
export function routingServicesFor(list, extra = {}) {
  const declared = {};
  for (const m of list ?? []) {
    if (!m || typeof m !== "object") continue;
    declared[`${m.providerID}/${m.id}`] = { catalogId: m.id, price: {}, caches: true };
  }
  return {
    catalogMatcher: { lookupModel: (id) => ({ id }), matchModel: (id) => ({ kind: "exact", candidates: [{ id }] }) },
    catalogEntryFor: (c) => ({ family: familyKey(c?.id) ?? undefined }),
    qualityField: {},
    declared,
    accounts: {},
    health: {},
    telemetry: {},
    ...extra,
  };
}
