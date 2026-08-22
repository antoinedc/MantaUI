// Tests for src/server/accountReaders.mjs (BET-1239). All fetch I/O is injected
// — never the network, never opencode's real auth store. Exercises the loader
// (validate-on-load, invalid reported by name and excluded) and the reader
// factory (same interface shape as a code adapter, fetch → readDescriptor,
// non-2xx → the shared httpError shape which the usage poller quarantines so a
// 500 leaves the provider with NO account state).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readerFromDescriptor, loadAccountReaders } from "./accountReaders.mjs";
import { createUsagePoller } from "./usage.mjs";
import { validateDescriptor, readDescriptor } from "../shared/accountDescriptor.mjs";

const DESCRIPTOR = {
  id: "samplecredits",
  providerIDs: ["samplecredits"],
  url: "https://example.com/credits",
  auth: "bearer",
  balance: { path: "account.balance", units: "dollars", sign: "positive-is-credit" },
};

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

test("a descriptor-backed reader satisfies the same interface shape as a code adapter", () => {
  const reader = readerFromDescriptor(DESCRIPTOR);
  assert.equal(reader.id, "samplecredits");
  assert.deepEqual(reader.providerIDs, ["samplecredits"]);
  assert.equal(typeof reader.detect, "function");
  assert.equal(typeof reader.fetch, "function");
});

test("reader.fetch maps a fetched payload through readDescriptor (balance + exhausted)", async () => {
  const reader = readerFromDescriptor(DESCRIPTOR);
  const out = await reader.fetch({
    readKey: async () => "the-key",
    fetchImpl: async () => fakeResponse(200, { account: { balance: -2 } }),
    now: () => 1000,
  });
  assert.equal(out.provider, "samplecredits");
  assert.equal(out.balance, -2);
  assert.equal(out.exhausted, true);
});

test("a 500 leaves the provider with no account state and does not throw (poller)", async () => {
  // detect forced true so the 500 path is what's exercised (the real detect()
  // reads opencode's auth store, which the sandbox has no entry for).
  const reader = { ...readerFromDescriptor(DESCRIPTOR), detect: async () => true };
  const poller = createUsagePoller({
    adapters: [reader],
    fetchImpl: async () => fakeResponse(500, {}),
    now: () => 1000,
  });
  await poller.tick(); // must not throw
  assert.equal(poller.snapshots.length, 0);
});

test("reader.fetch reuses the shared httpError shape for a non-2xx", async () => {
  const reader = readerFromDescriptor(DESCRIPTOR);
  await assert.rejects(
    () =>
      reader.fetch({
        readKey: async () => "k",
        fetchImpl: async () => fakeResponse(500, {}),
      }),
    (err) => err.status === 500 && /HTTP 500/.test(err.message),
  );
});

test("shipped openrouter descriptor reads the live /api/v1/credits payload (BET-1239 regression)", () => {
  // The real OpenRouter endpoint returns { data: { total_credits, total_usage } }
  // — NOT a top-level `credits` field. The shipped descriptor must resolve the
  // balance at data.total_credits AND map the credit pool as a window so an
  // overdrawn account (total_usage > total_credits, as captured live) trips
  // `exhausted` instead of showing a healthy positive balance.
  const dir = dirname(fileURLToPath(import.meta.url));
  const raw = JSON.parse(readFileSync(join(dir, "accountDescriptors", "openrouter.json"), "utf-8"));
  const v = validateDescriptor(raw);
  assert.equal(v.valid, true);
  if (!v.valid) return;

  // Live capture 2026-08-20 with a real key: usage 20.0717 > credits 20.
  // balance = total_credits − total_usage = −0.0717 (overdrawn), and it is the
  // REMAINING balance that routes, not the granted total.
  const overdrawn = { data: { total_credits: 20, total_usage: 20.071752339 } };
  const snap = readDescriptor(v.descriptor, overdrawn, 0);
  assert.equal(snap.kind, "credit");
  assert.ok(Math.abs(snap.balance - (20 - 20.071752339)) < 1e-9, `expected remaining balance -0.07, got ${snap.balance}`);
  assert.equal(snap.exhausted, true);
  assert.equal(snap.windows[0].pct, 100);

  const healthy = { data: { total_credits: 20, total_usage: 5 } };
  const healthySnap = readDescriptor(v.descriptor, healthy, 0);
  assert.equal(healthySnap.balance, 15);
  assert.equal(healthySnap.exhausted, undefined);
  assert.equal(healthySnap.windows[0].pct, 25);
});

test("an invalid descriptor is reported by name and excluded; valid ones load", () => {
  const logs = [];
  const readers = loadAccountReaders({
    dir: "DIR",
    readDir: () => ["good.json", "bad.json", "notes.txt"],
    readJson: (p) => {
      if (p.includes("good.json")) return { ...DESCRIPTOR, id: "good", providerIDs: ["good"] };
      if (p.includes("bad.json")) {
        return { id: "baddesc", providerIDs: ["baddesc"], url: "x", auth: "bearer", oops: 1 };
      }
      throw new Error("boom");
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(readers.map((r) => r.id), ["good"]);
  assert.ok(logs.some((m) => m.includes("baddesc")), "invalid descriptor logged by name");
});
