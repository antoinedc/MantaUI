// register.test.mjs — POST /register behavior.
//
// The route is the gate to the entire gateway: it mints gateway_tokens for
// fresh boxes, refreshes them on each box boot, and creates/updates the OVH
// DNS A record that maps <box_id>.boxes.mantaui.com to the box's public IP.
//
// All dependencies are injected so these tests run hermetically:
//   load / save   — in-memory store maps (no FS)
//   fetchImpl     — fake that captures DNS calls (no OVH)
//   createDnsRecord — same fake, but we route through the production
//                     createOrUpdate wrapper so the dns.mjs signature is
//                     exercised end-to-end
//   rateLimiter   — injected for the 11th-call test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  handleRegister,
  sourceIp,
  bearerToken,
  tokenEquals,
  isValidGatewayToken,
  isHexToken,
  createRegisterRateLimiter,
  ovhSubDomainFor,
} from "./index.mjs";

const VALID_BOX_ID = "abcdef0123456789abcdef0123456789";
const OTHER_BOX_ID = "1234567890abcdef1234567890abcdef";

// A token shape: 32 lowercase hex (same family as box_id).
const makeToken = (seed) => seed.padStart(32, "0").slice(-32);

function makeFakeDns() {
  const calls = [];
  const fetchImpl = async () => ({ ok: true, status: 200, body: null });
  const createOrUpdate = async (args) => {
    calls.push({ args, op: args.existingRecordId ? "update" : "create" });
    return { recordId: calls.length * 100, action: calls[calls.length - 1].op };
  };
  return { calls, fetchImpl, createOrUpdate };
}

function makeStore(initial = {}) {
  let store = { ...initial };
  return {
    get store() { return store; },
    set store(next) { store = next; },
    persist: async (next) => { store = next; },
  };
}

test("isValidGatewayToken: 32 lowercase hex only", () => {
  assert.equal(isValidGatewayToken(makeToken("a")), true);
  assert.equal(isValidGatewayToken("UPPER".padEnd(32, "X")), false);
  assert.equal(isValidGatewayToken("abc"), false);
  assert.equal(isValidGatewayToken(null), false);
});

test("tokenEquals: same string → true", () => {
  const t = makeToken("a");
  assert.equal(tokenEquals(t, t), true);
});

test("tokenEquals: mismatch → false", () => {
  const a = makeToken("a");
  const b = makeToken("b");
  assert.equal(tokenEquals(a, b), false);
  assert.equal(tokenEquals(a, "not-the-same-length"), false);
});

test("tokenEquals: short-circuit when either is non-string", () => {
  assert.equal(tokenEquals(undefined, makeToken("a")), false);
  assert.equal(tokenEquals(makeToken("a"), null), false);
});

test("bearerToken: extracts token from Bearer header (case-insensitive)", () => {
  assert.equal(bearerToken("Bearer abcdef0123456789abcdef0123456789"), makeToken("abcdef0123456789abcdef0123456789"));
  assert.equal(bearerToken("bearer abcdef0123456789abcdef0123456789"), makeToken("abcdef0123456789abcdef0123456789"));
  assert.equal(bearerToken("  Bearer abcdef0123456789abcdef0123456789  "), makeToken("abcdef0123456789abcdef0123456789"));
});

test("bearerToken: accepts bare token (legacy), rejects empty/missing", () => {
  assert.equal(bearerToken("abcdef0123456789abcdef0123456789"), makeToken("abcdef0123456789abcdef0123456789"));
  assert.equal(bearerToken(""), null);
  assert.equal(bearerToken(null), null);
});

test("sourceIp: prefers X-Forwarded-For first value", () => {
  assert.equal(
    sourceIp({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } }),
    "1.2.3.4",
  );
});

test("sourceIp: falls back to socket.remoteAddress when no XFF", () => {
  assert.equal(sourceIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(sourceIp({ headers: {}, socket: {} }), "");
});

test("createRegisterRateLimiter: 10 calls from same IP within an hour pass", () => {
  const take = createRegisterRateLimiter();
  for (let i = 0; i < 10; i++) {
    assert.equal(take("1.2.3.4"), true, `call ${i + 1} must succeed`);
  }
});

test("createRegisterRateLimiter: 11th call from same IP within an hour → false", () => {
  const take = createRegisterRateLimiter();
  for (let i = 0; i < 10; i++) take("1.2.3.4");
  assert.equal(take("1.2.3.4"), false);
});

test("createRegisterRateLimiter: different IPs each get the full bucket", () => {
  const take = createRegisterRateLimiter();
  for (let i = 0; i < 10; i++) assert.equal(take("1.2.3.4"), true);
  // a different IP is unaffected
  assert.equal(take("5.6.7.8"), true);
});

test("createRegisterRateLimiter: window resets after windowMs elapsed", () => {
  let t = 0;
  const take = createRegisterRateLimiter({ now: () => t });
  for (let i = 0; i < 10; i++) assert.equal(take("1.2.3.4"), true);
  assert.equal(take("1.2.3.4"), false);
  t += 60 * 60 * 1000 + 1;
  assert.equal(take("1.2.3.4"), true, "window elapsed → fresh bucket");
});

// --- handleRegister -------------------------------------------------------

test("handleRegister: rejects invalid box_id (XYZ, 0xabc, wrong length, uppercase)", async () => {
  const store = makeStore();
  const dns = makeFakeDns();
  for (const bad of ["XYZ", "0xabcdef", VALID_BOX_ID.slice(0, 31), VALID_BOX_ID.toUpperCase()]) {
    const r = await handleRegister({
      body: { box_id: bad },
      ip: "1.2.3.4",
      store: store.store,
      persist: store.persist,
      rateLimiter: () => true,
      createDnsRecord: dns.createOrUpdate,
    });
    assert.equal(r.status, 400, `bad box_id "${bad}" must be rejected`);
  }
});

test("handleRegister: first call mints a 32-hex token, creates DNS, persists", async () => {
  const store = makeStore();
  const dns = makeFakeDns();
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID },
    ip: "1.2.3.4",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => true,
    createDnsRecord: dns.createOrUpdate,
  });
  assert.equal(r.status, 200);
  assert.match(r.json.host, /^abcdef.*\.boxes\.mantaui\.com$/);
  assert.match(r.json.gateway_token, /^[0-9a-f]{32}$/);
  assert.equal(dns.calls.length, 1, "DNS create must have been called exactly once");
  assert.equal(dns.calls[0].op, "create");
  assert.equal(dns.calls[0].args.boxId, VALID_BOX_ID);
  assert.equal(dns.calls[0].args.target, "1.2.3.4");
  assert.equal(dns.calls[0].args.existingRecordId, null);
  const persisted = store.store[VALID_BOX_ID];
  assert.ok(persisted);
  assert.equal(persisted.gateway_token, r.json.gateway_token);
  assert.equal(persisted.ip, "1.2.3.4");
  assert.equal(persisted.ovhRecordId, 100); // calls.length * 100
});

test("handleRegister: re-register with wrong token → 401 (no DNS update)", async () => {
  const dns = makeFakeDns();
  // Pre-seed the store.
  const store = makeStore({
    [VALID_BOX_ID]: {
      gateway_token: makeToken("good"),
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 12345,
    },
  });
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID, __bearer: makeToken("bad") },
    ip: "1.2.3.4",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => true,
    createDnsRecord: dns.createOrUpdate,
  });
  assert.equal(r.status, 401);
  assert.equal(dns.calls.length, 0, "DNS must not have been touched");
});

test("handleRegister: re-register with correct token + same IP → 200 host only (no DNS)", async () => {
  const dns = makeFakeDns();
  const store = makeStore({
    [VALID_BOX_ID]: {
      gateway_token: makeToken("good"),
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 12345,
    },
  });
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID, __bearer: makeToken("good") },
    ip: "1.2.3.4",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => true,
    createDnsRecord: dns.createOrUpdate,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.host, `${VALID_BOX_ID}.boxes.mantaui.com`);
  assert.equal(r.json.gateway_token, undefined, "no token re-issue");
  assert.equal(dns.calls.length, 0, "no DNS update when IP unchanged");
});

test("handleRegister: re-register with correct token + changed IP → updates DNS", async () => {
  const dns = makeFakeDns();
  const store = makeStore({
    [VALID_BOX_ID]: {
      gateway_token: makeToken("good"),
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 12345,
    },
  });
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID, __bearer: makeToken("good") },
    ip: "5.6.7.8",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => true,
    createDnsRecord: dns.createOrUpdate,
  });
  assert.equal(r.status, 200);
  assert.equal(dns.calls.length, 1);
  assert.equal(dns.calls[0].op, "update");
  assert.equal(dns.calls[0].args.existingRecordId, 12345);
  assert.equal(dns.calls[0].args.target, "5.6.7.8");
  assert.equal(store.store[VALID_BOX_ID].ip, "5.6.7.8");
});

test("handleRegister: rate limit 429 takes precedence over validation", async () => {
  const dns = makeFakeDns();
  const store = makeStore();
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID },
    ip: "1.2.3.4",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => false, // always reject
    createDnsRecord: dns.createOrUpdate,
  });
  assert.equal(r.status, 429);
  assert.equal(dns.calls.length, 0);
  assert.equal(store.store[VALID_BOX_ID], undefined);
});

test("handleRegister: DNS create failure on first registration → 502", async () => {
  const dns = makeFakeDns();
  const failDns = async () => { throw new Error("OVH boom"); };
  const store = makeStore();
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID },
    ip: "1.2.3.4",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => true,
    createDnsRecord: failDns,
  });
  assert.equal(r.status, 502);
  assert.equal(store.store[VALID_BOX_ID], undefined, "must NOT persist on DNS failure");
});

test("handleRegister: DNS update failure on re-register → 200 with existing host (non-fatal)", async () => {
  const failDns = async () => { throw new Error("OVH timeout"); };
  const store = makeStore({
    [VALID_BOX_ID]: {
      gateway_token: makeToken("good"),
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 12345,
    },
  });
  const r = await handleRegister({
    body: { box_id: VALID_BOX_ID, __bearer: makeToken("good") },
    ip: "5.6.7.8",
    store: store.store,
    persist: store.persist,
    rateLimiter: () => true,
    createDnsRecord: failDns,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.host, `${VALID_BOX_ID}.boxes.mantaui.com`);
});

test("ovhSubDomainFor: <box_id>.boxes", () => {
  assert.equal(ovhSubDomainFor(VALID_BOX_ID), `${VALID_BOX_ID}.boxes`);
});
