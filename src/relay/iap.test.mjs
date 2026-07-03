import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJws,
  decodeJwsPayload,
  extractTransaction,
  extractNotificationTransaction,
  createStructuralJwsVerifier,
  createReceiptValidator,
  bindReceipt,
} from "./iap.mjs";
import { openStore, BOX_STATUS } from "./store.mjs";
import { createDefaultSubscriptionCheck } from "./api.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef";
const ACCT_1 = "1111111111111111aaaaaaaaaaaaaaaa";
const silent = () => {};

// ---------------------------------------------------------------------------
// JWS fixture builders (base64url header.payload.signature)
// ---------------------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// A well-formed JWS with an x5c chain in the header. `withX5c=false` omits the
// chain (structural verifier should reject).
function makeJws(payload, { withX5c = true, sig = "sigbytes" } = {}) {
  const header = { alg: "ES256", ...(withX5c ? { x5c: ["leafcert", "intermediate", "root"] } : {}) };
  return `${b64url(header)}.${b64url(payload)}.${sig}`;
}

// A StoreKit2-style transaction payload.
function txPayload({ otid = "1000000999", productId = "sub.monthly", expiresDate = null } = {}) {
  const p = { originalTransactionId: otid, productId };
  if (expiresDate != null) p.expiresDate = expiresDate;
  return p;
}

// An App Store Server Notification v2 outer payload wrapping an inner tx JWS.
function makeNotificationJws({ innerTx, notificationType = "DID_RENEW", ...opts } = {}) {
  const innerJws = makeJws(innerTx, opts);
  const outer = { notificationType, data: { signedTransactionInfo: innerJws } };
  return makeJws(outer, opts);
}

// ---------------------------------------------------------------------------
// parseJws / decode
// ---------------------------------------------------------------------------

test("parseJws: valid three-part JWS decodes header + payload; junk → null", () => {
  const jws = makeJws(txPayload());
  const parsed = parseJws(jws);
  assert.ok(parsed);
  assert.equal(parsed.header.alg, "ES256");
  assert.ok(Array.isArray(parsed.header.x5c));
  assert.equal(parsed.payload.originalTransactionId, "1000000999");

  assert.equal(parseJws("not-a-jws"), null);
  assert.equal(parseJws("only.two"), null);
  assert.equal(parseJws(""), null);
  assert.equal(parseJws(null), null);
  // non-JSON segment → null
  assert.equal(parseJws("aGVsbG8.d29ybGQ.sig"), null);
});

test("decodeJwsPayload returns the payload object", () => {
  const jws = makeJws(txPayload({ otid: "abc" }));
  assert.equal(decodeJwsPayload(jws).originalTransactionId, "abc");
});

// ---------------------------------------------------------------------------
// extractTransaction
// ---------------------------------------------------------------------------

test("extractTransaction: normalizes Apple fields; missing otid → null", () => {
  assert.deepEqual(
    extractTransaction({ originalTransactionId: "x", productId: "p", expiresDate: 123 }),
    { originalTransactionId: "x", productId: "p", expiresAt: 123 },
  );
  // snake_case fallback + null expiry
  assert.deepEqual(
    extractTransaction({ original_transaction_id: "y", product_id: "q" }),
    { originalTransactionId: "y", productId: "q", expiresAt: null },
  );
  assert.equal(extractTransaction({ productId: "p" }), null, "no otid → null");
  assert.equal(extractTransaction(null), null);
});

test("extractNotificationTransaction reaches the inner transaction", () => {
  const jws = makeNotificationJws({ innerTx: txPayload({ otid: "inner-123" }) });
  const tx = extractNotificationTransaction(jws);
  assert.equal(tx.originalTransactionId, "inner-123");
});

// ---------------------------------------------------------------------------
// structural verifier
// ---------------------------------------------------------------------------

test("createStructuralJwsVerifier: x5c present → ok (verified:false); no x5c → reject", () => {
  const verify = createStructuralJwsVerifier({ warn: silent });
  const good = verify(makeJws(txPayload()));
  assert.equal(good.ok, true);
  assert.equal(good.verified, false, "structural-only, crypto deferred");

  const noX5c = verify(makeJws(txPayload(), { withX5c: false }));
  assert.equal(noX5c.ok, false);
  assert.equal(noX5c.reason, "missing_x5c");

  const malformed = verify("garbage");
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "malformed_jws");
});

// ---------------------------------------------------------------------------
// validator: valid / expired / malformed / injectable verifier
// ---------------------------------------------------------------------------

test("validate: valid receipt → ok with transaction; verified:false under structural default", () => {
  const validator = createReceiptValidator({ now: () => 1000, warn: silent });
  const res = validator.validate(makeJws(txPayload({ otid: "t-1", expiresDate: 9999 })));
  assert.equal(res.ok, true);
  assert.equal(res.transaction.originalTransactionId, "t-1");
  assert.equal(res.transaction.expiresAt, 9999);
  assert.equal(res.verified, false);
});

test("validate: expired receipt rejected", () => {
  const validator = createReceiptValidator({ now: () => 5000, warn: silent });
  const res = validator.validate(makeJws(txPayload({ expiresDate: 1000 })));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "expired");
});

test("validate: malformed JWS rejected", () => {
  const validator = createReceiptValidator({ warn: silent });
  assert.equal(validator.validate("not-a-jws").ok, false);
  assert.equal(validator.validate(makeJws(txPayload(), { withX5c: false })).ok, false);
});

test("validate: injectable crypto verifier is honored (verified:true)", () => {
  let seen = null;
  const verifyJws = (jws) => {
    seen = jws;
    return { ok: true, verified: true };
  };
  const validator = createReceiptValidator({ verifyJws, now: () => 0, warn: silent });
  const jws = makeJws(txPayload({ otid: "verified-tx" }));
  const res = validator.validate(jws);
  assert.equal(res.ok, true);
  assert.equal(res.verified, true, "injected verifier enforces crypto");
  assert.equal(seen, jws, "verifier was called with the JWS");

  // A verifier that rejects → validate rejects.
  const rejecting = createReceiptValidator({ verifyJws: () => ({ ok: false, reason: "bad_chain" }), warn: silent });
  assert.equal(rejecting.validate(jws).reason, "bad_chain");
});

test("validateNotification: renewal notification → inner transaction extracted", () => {
  const validator = createReceiptValidator({ now: () => 0, warn: silent });
  const jws = makeNotificationJws({
    innerTx: txPayload({ otid: "renew-tx", expiresDate: 99999 }),
    notificationType: "DID_RENEW",
  });
  const res = validator.validateNotification(jws);
  assert.equal(res.ok, true);
  assert.equal(res.transaction.originalTransactionId, "renew-tx");
  assert.equal(res.notificationType, "DID_RENEW");
});

// ---------------------------------------------------------------------------
// bind → opens the Stage-4 gate (402 → pass) for that box
// ---------------------------------------------------------------------------

test("bindReceipt binds a validated transaction and opens the Stage-4 subscription gate", (t) => {
  const store = openStore();
  t.after(() => store.close());
  const now = () => 1000;
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1000 });
  store.bindBox(BOX_A, ACCT_1, { at: 1000 });

  // Before binding: gate is CLOSED (no receipt → 402).
  const gate = createDefaultSubscriptionCheck(store, now);
  assert.equal(gate(BOX_A), false, "no receipt → gate closed");

  // Validate + bind a valid receipt.
  const validator = createReceiptValidator({ now, warn: silent });
  const jws = makeJws(txPayload({ otid: "paid-tx", expiresDate: 999999 }));
  const res = validator.validate(jws);
  assert.equal(res.ok, true);
  bindReceipt(store, { boxId: BOX_A, transaction: res.transaction, raw: jws }, { now });

  // After binding: gate is OPEN for THIS box.
  assert.equal(gate(BOX_A), true, "valid bound receipt → gate open");

  // The receipt row is queryable by original_transaction_id.
  const row = store.getReceipt("paid-tx");
  assert.equal(row.box_id, BOX_A);
  assert.equal(row.expires_at, 999999);
});

test("bindReceipt: expired bound receipt keeps the gate closed", (t) => {
  const store = openStore();
  t.after(() => store.close());
  const now = () => 100000;
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });

  // An expired transaction never validates, so it can't be bound via the
  // validator — but even a directly-stored expired receipt leaves the gate shut.
  bindReceipt(
    store,
    { boxId: BOX_A, transaction: { originalTransactionId: "old", productId: null, expiresAt: 50 } },
    { now },
  );
  const gate = createDefaultSubscriptionCheck(store, now);
  assert.equal(gate(BOX_A), false, "expired receipt → gate stays closed");
});

test("bindReceipt: requires store + originalTransactionId", () => {
  assert.throws(() => bindReceipt(null, {}), /store required/);
  const store = openStore();
  assert.throws(() => bindReceipt(store, { boxId: BOX_A, transaction: {} }), /originalTransactionId required/);
  store.close();
});
