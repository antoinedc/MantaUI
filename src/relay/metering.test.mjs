import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBoxMeter,
  messageBytes,
  bodyBytes,
  FREE_RL_CAPACITY,
  PAID_RL_CAPACITY,
} from "./metering.mjs";
import { openStore, BOX_STATUS } from "./store.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef";
const BOX_B = "fedcba9876543210fedcba9876543210";
const silent = () => {};

function seededStore() {
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.upsertBox(BOX_B, { status: BOX_STATUS.ONLINE, at: 1 });
  return store;
}

// ---------------------------------------------------------------------------
// byte sizing (pure)
// ---------------------------------------------------------------------------

test("bodyBytes: string / Buffer / Uint8Array / JSON / null", () => {
  assert.equal(bodyBytes(null), 0);
  assert.equal(bodyBytes("hello"), 5);
  assert.equal(bodyBytes(Buffer.from("héllo")), 6); // é = 2 bytes utf8
  assert.equal(bodyBytes(new Uint8Array([1, 2, 3])), 3);
  assert.equal(bodyBytes({ a: 1 }), Buffer.byteLength(JSON.stringify({ a: 1 })));
});

test("messageBytes: counts method + path + headers + body", () => {
  const bytes = messageBytes({
    method: "POST",
    path: "/prompt",
    headers: { "content-type": "application/json" },
    body: "hello world",
  });
  const expected =
    Buffer.byteLength("POST") +
    Buffer.byteLength("/prompt") +
    Buffer.byteLength("content-type") +
    Buffer.byteLength("application/json") +
    Buffer.byteLength("hello world");
  assert.equal(bytes, expected);
  assert.equal(messageBytes(null), 0);
  assert.equal(messageBytes({}), 0);
});

// ---------------------------------------------------------------------------
// byte counters accumulate per box on a simulated round-trip
// ---------------------------------------------------------------------------

test("meterProxy accumulates ingress+egress per box across a round-trip", (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const meter = createBoxMeter({ store, warn: silent });

  const req = { method: "GET", path: "/projects", headers: {}, body: undefined };
  const resp = { status: 200, headers: { "content-type": "application/json" }, body: '{"projects":[]}' };

  const r1 = meter.meterProxy(BOX_A, req, resp, { paid: true });
  assert.ok(r1.ingress > 0);
  assert.ok(r1.egress > 0);
  assert.equal(r1.total.ingress, r1.ingress);
  assert.equal(r1.total.egress, r1.egress);

  // A second round-trip accumulates (does not overwrite).
  const r2 = meter.meterProxy(BOX_A, req, resp, { paid: true });
  assert.equal(r2.total.ingress, r1.ingress * 2);
  assert.equal(r2.total.egress, r1.egress * 2);

  // Per-box isolation: BOX_B has its own counters.
  meter.meterProxy(BOX_B, req, resp, { paid: true });
  assert.equal(meter.usage(BOX_B).ingress, r1.ingress);
  assert.equal(meter.usage(BOX_A).ingress, r1.ingress * 2);
});

test("record + usage + resetUsage round-trip", (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const meter = createBoxMeter({ store, warn: silent });

  meter.record(BOX_A, { ingress: 100, egress: 250 });
  assert.deepEqual(
    { i: meter.usage(BOX_A).ingress, e: meter.usage(BOX_A).egress },
    { i: 100, e: 250 },
  );
  meter.record(BOX_A, { ingress: 5 });
  assert.equal(meter.usage(BOX_A).ingress, 105);
  assert.equal(meter.usage(BOX_A).egress, 250);

  store.resetUsage(BOX_A, { at: 999 });
  assert.equal(meter.usage(BOX_A).ingress, 0);
  assert.equal(meter.usage(BOX_A).egress, 0);
});

// ---------------------------------------------------------------------------
// per-box rate limiter: over-cap blocks; free vs paid caps honored
// ---------------------------------------------------------------------------

test("allow: free tier blocks over-cap; paid tier allows more", (t) => {
  const store = seededStore();
  t.after(() => store.close());
  // Freeze time so the token bucket never refills during the burst.
  const meter = createBoxMeter({ store, now: () => 1000, warn: silent });

  // Free tier: capacity FREE_RL_CAPACITY requests, then blocked.
  let allowedFree = 0;
  for (let i = 0; i < FREE_RL_CAPACITY + 5; i++) {
    if (meter.allow(BOX_A, { paid: false })) allowedFree++;
  }
  assert.equal(allowedFree, FREE_RL_CAPACITY, "free burst capped at FREE_RL_CAPACITY");
  assert.equal(meter.allow(BOX_A, { paid: false }), false, "over free cap → blocked");

  // Paid tier on a DIFFERENT box: allows up to PAID_RL_CAPACITY.
  let allowedPaid = 0;
  for (let i = 0; i < PAID_RL_CAPACITY + 5; i++) {
    if (meter.allow(BOX_B, { paid: true })) allowedPaid++;
  }
  assert.equal(allowedPaid, PAID_RL_CAPACITY, "paid burst capped at PAID_RL_CAPACITY");
  assert.ok(PAID_RL_CAPACITY > FREE_RL_CAPACITY, "paid cap exceeds free cap");
});

test("allow: per-box isolation — one box exhausting its bucket doesn't block another", (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const meter = createBoxMeter({ store, now: () => 1000, warn: silent });

  // Drain BOX_A's free bucket.
  for (let i = 0; i < FREE_RL_CAPACITY + 2; i++) meter.allow(BOX_A, { paid: false });
  assert.equal(meter.allow(BOX_A, { paid: false }), false, "BOX_A exhausted");
  // BOX_B still has its full bucket.
  assert.equal(meter.allow(BOX_B, { paid: false }), true, "BOX_B unaffected");
});

test("meterProxy returns a rate verdict alongside byte totals", (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const meter = createBoxMeter({ store, now: () => 1000, warn: silent });
  const req = { method: "GET", path: "/x", headers: {} };

  // Exhaust the free bucket via meterProxy; verdict flips to false.
  let lastAllowed = true;
  for (let i = 0; i < FREE_RL_CAPACITY + 2; i++) {
    lastAllowed = meter.meterProxy(BOX_A, req, null, { paid: false }).allowed;
  }
  assert.equal(lastAllowed, false, "over-cap meterProxy call is not allowed");
  // But bytes were still recorded for every call (metering ≠ gating).
  assert.ok(meter.usage(BOX_A).ingress > 0);
});

test("createBoxMeter requires a store", () => {
  assert.throws(() => createBoxMeter({}), /store required/);
});
