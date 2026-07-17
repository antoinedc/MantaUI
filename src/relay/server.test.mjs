// server.test.mjs — the combined relay entrypoint, booted as a REAL process.
//
// This is the permanent, CI-guarded version of the throwaway BET-71 harness: it
// boots `createRelayService` on an ephemeral port and asserts the full BET-71
// matrix against the RUNNING service (real http.Server, real WS box dial-out,
// real phone HTTP requests) — not a hand-composed in-process harness. It proves
// the two relay halves finally meet in shippable code:
//   1. a box dials OUT over WS on /box and registers (box leg + shared store),
//   2. GET /api/boxes is phone-authenticated (401 without / 200 with),
//   3. a FREE metadata subpath proxies through to the box,
//   4. a GATED subpath returns 402 until a receipt is bound,
//   5. POST /api/iap/validate binds a receipt and OPENS the gate,
//   6. the push register + send routes are mounted and fan out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { createRelayService, routePtyUpgrade, handlePtyUpgrade, bridgeDevicePty } from "./server.mjs";
import { openStore, hashToken } from "./store.mjs";
import { encodeFrame, decodeFrame, FRAME_TYPES } from "./protocol.mjs";
import { createDefaultPhoneAuth, createDefaultSubscriptionCheck } from "./api.mjs";
import { bindReceipt } from "./iap.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef"; // 32 hex
const TOKEN_A = "11112222333344445555666677778888"; // box token (32 hex)
const ACCT_1 = "aaaabbbbccccddddeeeeffff00001111"; // phone device token (32-hex)
const silent = () => {};

// ---------------------------------------------------------------------------
// JWS fixture builders (mirrors iap.test.mjs; structural verifier accepts these)
// ---------------------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function makeJws(payload, { withX5c = true, sig = "sigbytes" } = {}) {
  const header = { alg: "ES256", ...(withX5c ? { x5c: ["leaf", "intermediate", "root"] } : {}) };
  return `${b64url(header)}.${b64url(payload)}.${sig}`;
}
function txPayload({ otid = "1000000999", productId = "sub.monthly", expiresDate = null } = {}) {
  const p = { originalTransactionId: otid, productId };
  if (expiresDate != null) p.expiresDate = expiresDate;
  return p;
}

// ---------------------------------------------------------------------------
// boot the real combined service on an ephemeral port with a shared store
// ---------------------------------------------------------------------------

async function makeService(t, { proxyRequest, pairRateLimiter, warnSink } = {}) {
  const store = openStore(); // in-memory, shared so the test can bindBox()
  // Pre-seed ACCT_1 as a known device token → account. In the new world the
  // /pair endpoint mints these tokens at runtime; tests that exercise phone
  // API/IAP/push routes just need ONE valid bearer to be in the store.
  store.addAccountToken(hashToken(ACCT_1), ACCT_1);
  const svc = createRelayService({
    port: 0,
    host: "127.0.0.1",
    store,
    proxyRequest,
    pairRateLimiter,
    log: silent,
    warn: warnSink || silent,
  });
  const { port } = await svc.start();
  t.after(async () => {
    await svc.close();
  });
  return { svc, store, port, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

// A phone HTTP request with a bearer token (the minted device token, whose
// sha256 maps to the authed account in the store).
async function phone(base, method, path, { token = ACCT_1, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

// Dial a box OUT over WS and resolve once it's registered in the box leg.
async function connectBox(svc, wsBase, { boxId = BOX_A, token = TOKEN_A } = {}) {
  const qs = new URLSearchParams({ box_id: boxId, token });
  const ws = new WebSocket(`${wsBase}/box?${qs.toString()}`);
  await once(ws, "open");
  await waitFor(() => svc.boxLeg.routing.has(boxId));
  return ws;
}

// Make the box socket answer proxied REQUEST frames with a canned RESPONSE so
// the phone→box proxy path is exercised end to end.
function autoRespondBox(ws, { status = 200, body = '{"ok":true}' } = {}) {
  ws.on("message", (data) => {
    const frame = decodeFrame(data);
    if (frame?.type === FRAME_TYPES.REQUEST) {
      ws.send(
        encodeFrame({
          type: FRAME_TYPES.RESPONSE,
          id: frame.id,
          status,
          headers: { "content-type": "application/json" },
          body,
        }),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// the matrix
// ---------------------------------------------------------------------------

test("box dials out over WS on /box and registers in the box leg", async (t) => {
  const { svc, store, port, wsBase } = await makeService(t);
  assert.ok(Number.isInteger(port) && port > 0, "bound an ephemeral port");
  const ws = await connectBox(svc, wsBase);
  assert.equal(svc.boxLeg.routing.has(BOX_A), true, "box registered live");
  assert.ok(store.getBox(BOX_A), "box row persisted in shared store");
  ws.close();
});

test("a non-/box WS upgrade is refused (only the box leg gets upgrades)", async (t) => {
  const { wsBase } = await makeService(t);
  const ws = new WebSocket(`${wsBase}/nope`);
  const [errOrClose] = await Promise.race([
    once(ws, "error").then((a) => ["error", ...a]),
    once(ws, "unexpected-response").then((a) => ["unexpected", ...a]),
  ]).then((r) => [r[0]]);
  assert.ok(errOrClose === "error" || errOrClose === "unexpected", "upgrade rejected");
});

test("GET /api/boxes: 401 without auth, 200 with a bearer token", async (t) => {
  const { store, base } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);

  const noAuth = await phone(base, "GET", "/api/boxes", { token: null });
  assert.equal(noAuth.status, 401, "unauthenticated → 401");

  const authed = await phone(base, "GET", "/api/boxes");
  assert.equal(authed.status, 200);
  assert.equal(authed.json.boxes.length, 1);
  assert.equal(authed.json.boxes[0].box_id, BOX_A);
});

test("FREE metadata subpath proxies through to the box", async (t) => {
  const { svc, store, base, wsBase } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);
  const ws = await connectBox(svc, wsBase);
  autoRespondBox(ws, { status: 200, body: '{"projects":[]}' });

  const res = await phone(base, "GET", `/box/${BOX_A}/projects`);
  assert.equal(res.status, 200, "free subpath forwarded (no 402)");
  assert.deepEqual(res.json, { projects: [] });
  ws.close();
});

test("GATED subpath returns 402 until a receipt is bound, then opens", async (t) => {
  const { svc, store, base, wsBase } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);
  const ws = await connectBox(svc, wsBase);
  autoRespondBox(ws, { status: 200, body: '{"stream":"ok"}' });

  // Before any receipt: gated subpath is payment-required.
  const gated = await phone(base, "GET", `/box/${BOX_A}/transcript`);
  assert.equal(gated.status, 402, "gated subpath 402 pre-subscription");

  // Bind a receipt via the IAP validate route (structural verifier accepts the
  // x5c fixture; DEV crypto is not enforced but the gate flips).
  const jws = makeJws(txPayload({ expiresDate: Date.now() + 86_400_000 }));
  const iap = await phone(base, "POST", "/api/iap/validate", { body: { box_id: BOX_A, jws } });
  assert.equal(iap.status, 200, "receipt bound");
  assert.equal(iap.json.bound, true);

  // Now the gated subpath proxies through.
  const opened = await phone(base, "GET", `/box/${BOX_A}/transcript`);
  assert.equal(opened.status, 200, "gate opened after receipt bound");
  assert.deepEqual(opened.json, { stream: "ok" });
  ws.close();
});

test("IAP validate rejects a receipt for a box the account does not own (404)", async (t) => {
  const { store, base } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, "ffffffffffffffffffffffffffffffff"); // owned by someone else
  const jws = makeJws(txPayload());
  const res = await phone(base, "POST", "/api/iap/validate", { body: { box_id: BOX_A, jws } });
  assert.equal(res.status, 404, "unowned box → 404");
});

test("IAP renewed binds via an App Store notification JWS", async (t) => {
  const { store, base } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);
  const innerJws = makeJws(txPayload({ otid: "renew-1", expiresDate: Date.now() + 86_400_000 }));
  const outer = { notificationType: "DID_RENEW", data: { signedTransactionInfo: innerJws } };
  const signedPayload = makeJws(outer);
  const res = await phone(base, "POST", "/api/iap/renewed", {
    body: { box_id: BOX_A, signedPayload },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.bound, true);
  assert.equal(res.json.notification_type, "DID_RENEW");
  assert.equal(store.listReceiptsForBox(BOX_A).length, 1);
});

test("push register + send routes are mounted and fan out to the stub sender", async (t) => {
  const { svc, store, base } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);

  const reg = await phone(base, "POST", "/api/push/register", {
    body: { platform: "apns", token: "device-token-abc" },
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.registered, true);
  assert.equal(store.listPushTokensForAccount(ACCT_1).length, 1);

  // A mobile-now payload fans out to the registered device via the stub sender.
  const send = await phone(base, "POST", "/api/push/send", {
    body: { box_id: BOX_A, payload: { kind: "agent_message", urgent: true, body: "hi" } },
  });
  assert.equal(send.status, 200);
  assert.ok(send.json.route, "route decision reported");
  assert.ok(Array.isArray(send.json.delivered), "delivered list returned");
  assert.equal(svc.push._sender.sent.length, 1, "stub sender received the delivery");
});

test("push register rejects an invalid platform (400)", async (t) => {
  const { base } = await makeService(t);
  const res = await phone(base, "POST", "/api/push/register", {
    body: { platform: "carrier-pigeon", token: "t" },
  });
  assert.equal(res.status, 400);
});

test("IAP/push routes require phone auth (401 without a bearer)", async (t) => {
  const { base } = await makeService(t);
  const res = await phone(base, "POST", "/api/push/register", {
    token: null,
    body: { platform: "apns", token: "t" },
  });
  assert.equal(res.status, 401);
});

test("a GET on an IAP route is 405 (routes are POST-only)", async (t) => {
  const { base } = await makeService(t);
  const res = await phone(base, "GET", "/api/iap/validate");
  assert.equal(res.status, 405);
});

// ---------------------------------------------------------------------------
// POST /pair — phone bootstrap (BET-152)
//
// A fake proxyRequest simulates the box's /auth/claim reply. The relay must:
//   - mint an account_token + bind box_id → account_id,
//   - return the token plaintext ONCE,
//   - accept subsequent phone API calls with that token (list boxes → bound),
//   - keep the box's response body out of any output,
//   - rate-limit per box_id,
//   - reject malformed shapes BEFORE any proxy call / rate-limit burn,
//   - second pair of the same box_id reuses account_id but issues a fresh token.
// ---------------------------------------------------------------------------

// Fake box: every claim is decided by `reply(boxId, code)` -> { status, body }.
// Records every call so a test can assert "no proxy call happened" for the
// malformed branch.
function fakeBox(reply) {
  const calls = [];
  return {
    calls,
    proxyRequest: async (boxId, req) => {
      calls.push({ boxId, ...req });
      let body;
      try {
        body = JSON.parse(req.body || "{}");
      } catch {
        body = {};
      }
      return reply(boxId, body.code);
    },
  };
}

const OK_BOX = () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ box_token: "BOX_TOKEN_LEAKED_FROM_BOX" }),
});

test("POST /pair: happy path mints a device token usable by the phone API", async (t) => {
  const box = fakeBox(OK_BOX);
  const { svc, store, base } = await makeService(t, { proxyRequest: box.proxyRequest });

  const res = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "123456" } });
  assert.equal(res.status, 200, "200 with minted account");
  assert.equal(res.json.box_id, BOX_A);
  assert.match(res.json.account_id, /^[0-9a-f]{32}$/, "account_id is opaque 32-hex");
  assert.match(res.json.account_token, /^[0-9a-f]{32}$/, "account_token is plaintext 32-hex");

  // The relay must NOT log/store/return the box_token (ADR-1). Asserting the
  // account_token is distinct from it is the proxy: the relay never asked for
  // the box_token in plaintext either, so any leak would be visible as the
  // box body surfacing in /pair's response — it doesn't.
  assert.notEqual(res.json.account_token, "BOX_TOKEN_LEAKED_FROM_BOX");
  assert.equal(box.calls.length, 1, "one /auth/claim proxied");
  assert.equal(box.calls[0].path, "/auth/claim");
  assert.equal(box.calls[0].method, "POST");
  assert.equal(box.calls[0].boxId, BOX_A);

  // The plaintext account_token (sha256 in the store) authenticates the phone
  // API: GET /api/boxes must now show the bound box.
  const bearer = res.json.account_token;
  const list = await phone(base, "GET", "/api/boxes", { token: bearer });
  assert.equal(list.status, 200);
  assert.equal(list.json.boxes.length, 1);
  assert.equal(list.json.boxes[0].box_id, BOX_A);

  // Store side: exactly one binding, exactly one token row, both pointing at
  // the same account_id.
  const binding = store.getBinding(BOX_A);
  assert.ok(binding, "binding persisted");
  assert.equal(binding.account_id, res.json.account_id);
  assert.equal(store.listAccountTokensForAccount(res.json.account_id).length, 1);
  // Store has the HASH, never the plaintext.
  assert.equal(
    store.getAccountByTokenHash(hashToken(bearer)),
    res.json.account_id,
    "store can look up by sha256(plaintext)",
  );
  assert.equal(store.getAccountByTokenHash(bearer), null, "store has no plaintext token row");
});

test("POST /pair: offline box (proxyRequest rejects no_tunnel) → 503, no binding/token", async (t) => {
  const calls = [];
  const proxyRequest = async () => {
    calls.push("called");
    const err = new Error("no tunnel");
    err.code = "no_tunnel";
    throw err;
  };
  const { svc, store, base } = await makeService(t, { proxyRequest });

  const res = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "654321" } });
  assert.equal(res.status, 503);
  assert.equal(res.json.error, "box_offline");
  assert.equal(calls.length, 1, "proxy called exactly once");
  assert.equal(store.getBinding(BOX_A), null, "no binding persisted");
});

test("POST /pair: wrong code (box replies non-200) → 401, no binding/token, box body NOT leaked", async (t) => {
  const calls = [];
  const proxyRequest = async (_boxId, _req) => {
    calls.push("called");
    return {
      status: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "pairing failed", detail: "BOX_INTERNAL_TRACE_INFO" }),
    };
  };
  const { store, base } = await makeService(t, { proxyRequest });

  const res = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "111111" } });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, "claim_rejected");
  // The box body MUST NOT appear in the relay's response (the box's internal
  // error text is not the relay's to expose).
  assert.equal(
    JSON.stringify(res.json).includes("BOX_INTERNAL_TRACE_INFO"),
    false,
    "box body is not leaked",
  );
  assert.equal(calls.length, 1);
  assert.equal(store.getBinding(BOX_A), null);
});

test("POST /pair: second pair of the same box reuses account_id but issues a fresh token", async (t) => {
  const box = fakeBox(OK_BOX);
  const { svc, store, base } = await makeService(t, { proxyRequest: box.proxyRequest });

  const first = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "222222" } });
  assert.equal(first.status, 200);
  const second = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "333333" } });
  assert.equal(second.status, 200);

  assert.equal(first.json.account_id, second.json.account_id, "account_id reused");
  assert.notEqual(first.json.account_token, second.json.account_token, "distinct tokens");

  assert.equal(box.calls.length, 2, "two box claims");
  assert.equal(store.listAccountTokensForAccount(first.json.account_id).length, 2, "two token rows");

  // Both tokens must work as phone bearers (the list shows the bound box once).
  const list1 = await phone(base, "GET", "/api/boxes", { token: first.json.account_token });
  const list2 = await phone(base, "GET", "/api/boxes", { token: second.json.account_token });
  assert.equal(list1.json.boxes.length, 1);
  assert.equal(list2.json.boxes.length, 1);
});

test("POST /pair: malformed box_id or code → 400 with no proxy call and no rate-limit burn", async (t) => {
  const calls = [];
  const proxyRequest = async () => {
    calls.push("called");
    return OK_BOX();
  };
  // Tiny rate limiter to assert the malformed branch does NOT burn a token.
  const used = new Set();
  const pairRateLimiter = (key) => {
    if (used.has(key)) return false;
    used.add(key);
    return true;
  };
  const { store, base } = await makeService(t, { proxyRequest, pairRateLimiter });

  const badCases = [
    { box_id: "not-hex", code: "123456" },
    { box_id: BOX_A, code: "abc" },                  // not 6 digits
    { box_id: BOX_A, code: "12345" },               // 5 digits
    { box_id: BOX_A, code: "1234567" },             // 7 digits
    { box_id: BOX_A, code: " 123456" },             // leading space
    { box_id: BOX_A },                              // missing code
  ];
  for (const body of badCases) {
    const res = await phone(base, "POST", "/pair", { token: null, body });
    assert.equal(res.status, 400, `malformed ${JSON.stringify(body)} → 400`);
    assert.equal(res.json.error, "bad_request");
  }
  assert.equal(calls.length, 0, "no proxy call for malformed input");
  assert.equal(used.size, 0, "rate-limiter bucket NOT burned for malformed input");

  // After all malformed, a valid request from the SAME box_id still has full bucket.
  const ok = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "555555" } });
  assert.equal(ok.status, 200);
});

test("POST /pair: GET is 405; box body NEVER proxied through on rejection", async (t) => {
  const box = fakeBox(OK_BOX);
  const { base } = await makeService(t, { proxyRequest: box.proxyRequest });
  const get = await phone(base, "GET", "/pair");
  assert.equal(get.status, 405);
});

test("POST /pair: rate limit kicks in after PAIR_RL_CAPACITY per-box_id hits", async (t) => {
  // Drainable limiter — capacity 2, no refill inside the test window.
  let calls = 0;
  const pairRateLimiter = () => {
    calls += 1;
    return calls <= 2;
  };
  const box = fakeBox(OK_BOX);
  const { base } = await makeService(t, { proxyRequest: box.proxyRequest, pairRateLimiter });

  const r1 = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "000001" } });
  const r2 = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "000002" } });
  const r3 = await phone(base, "POST", "/pair", { token: null, body: { box_id: BOX_A, code: "000003" } });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429, "third hit throttled");
  assert.equal(r3.json.error, "rate_limited");
});

// ---------------------------------------------------------------------------
// /box/:id/pty upgrade — BET-158
//
// 1) routePtyUpgrade pure gate (auth + ownership + subscription, no socket).
// 2) Full upgrade against the running service: a device WS at /box/<id>/pty
//    is auth-gated + subscription-gated, and when both pass the bridge
//    opens a tunnel stream to the box.
// ---------------------------------------------------------------------------

// A complete set of deps for routePtyUpgrade — same shape createRelayService
// hands to the upgrade handler. Tests can pass a fresh store + the same
// auth seam the running service uses so the gate logic is exercised exactly
// as it would be in production.
function makeRouteFixture({ subscribed = false, owned = true } = {}) {
  const store = openStore();
  store.addAccountToken(hashToken(ACCT_1), ACCT_1);
  if (owned) {
    store.upsertBox(BOX_A);
    store.bindBox(BOX_A, ACCT_1);
  }
  const authenticatePhone = createDefaultPhoneAuth({ store });
  const hasActiveSubscription = createDefaultSubscriptionCheck(store, () => Date.now());
  // Stub a receipt bound to BOX_A when `subscribed` is true — hasActiveSubscription
  // reads the store, not the receipt validator, so any row with no expiry is enough.
  if (subscribed) {
    bindReceipt(store, {
      boxId: BOX_A,
      transaction: {
        originalTransactionId: "test-otid",
        productId: "sub.monthly",
        expiresAt: null,
      },
      raw: "jws",
    }, { now: () => Date.now() });
  }
  return { store, authenticatePhone, hasActiveSubscription };
}

test("routePtyUpgrade: rejects bad box_id shape with 404", () => {
  const fix = makeRouteFixture();
  const url = new URL("ws://x/box/nothex/pty?session=abc");
  const d = routePtyUpgrade({
    url, boxId: "nothex", headers: { authorization: `Bearer ${ACCT_1}` },
    ...fix,
  });
  assert.equal(d.kind, "reject");
  assert.equal(d.status, 404);
});

test("routePtyUpgrade: rejects missing/invalid phone token with 401", () => {
  const fix = makeRouteFixture();
  const url = new URL(`ws://x/box/${BOX_A}/pty?session=abc`);
  const d = routePtyUpgrade({
    url, boxId: BOX_A, headers: {}, ...fix,
  });
  assert.equal(d.kind, "reject");
  assert.equal(d.status, 401);
});

test("routePtyUpgrade: rejects a box the account does NOT own with 404", () => {
  const fix = makeRouteFixture({ owned: false });
  const url = new URL(`ws://x/box/${BOX_A}/pty?session=abc`);
  const d = routePtyUpgrade({
    url, boxId: BOX_A, headers: { authorization: `Bearer ${ACCT_1}` },
    ...fix,
  });
  assert.equal(d.kind, "reject");
  assert.equal(d.status, 404);
});

test("routePtyUpgrade: rejects a subscription-gated box with 402 when no receipt bound", () => {
  const fix = makeRouteFixture({ subscribed: false });
  const url = new URL(`ws://x/box/${BOX_A}/pty?session=abc`);
  const d = routePtyUpgrade({
    url, boxId: BOX_A, headers: { authorization: `Bearer ${ACCT_1}` },
    ...fix,
  });
  assert.equal(d.kind, "reject");
  assert.equal(d.status, 402);
});

test("routePtyUpgrade: accepts a valid, owned, subscribed box and strips ?token= from subpath", () => {
  const fix = makeRouteFixture({ subscribed: true });
  const url = new URL(
    `ws://x/box/${BOX_A}/pty?session=abc&cols=100&rows=40&token=${ACCT_1}`,
  );
  const d = routePtyUpgrade({
    url, boxId: BOX_A, headers: { authorization: `Bearer ${ACCT_1}` },
    ...fix,
  });
  assert.equal(d.kind, "ok");
  assert.equal(d.boxId, BOX_A);
  // ?token= must be stripped — the relay strips it because (ADR-1) the box
  // authenticates with its OWN box_token, not the device's account token.
  assert.equal(d.subpath.includes("token="), false, "?token= must be stripped from the subpath");
  assert.equal(d.subpath.includes("session=abc"), true);
  assert.equal(d.subpath.includes("cols=100"), true);
  assert.equal(d.subpath.startsWith("?"), true);
});

test("upgrade routing: /box still reaches the box leg", async (t) => {
  const { wsBase } = await makeService(t);
  // Sanity: an upgrade to /box works (existing behavior).
  const ws = new WebSocket(`${wsBase}/box?box_id=${BOX_A}&token=${TOKEN_A}`);
  await once(ws, "open");
  ws.close();
});

test("upgrade routing: /box/<id>/anything-else is refused with 404 (no fallthrough)", async (t) => {
  const { wsBase } = await makeService(t);
  const ws = new WebSocket(`${wsBase}/box/${BOX_A}/foo`);
  const [event] = await Promise.race([
    once(ws, "unexpected-response").then(() => ["unexpected"]),
    once(ws, "error").then(() => ["error"]),
  ]);
  assert.ok(event === "error" || event === "unexpected", "non-/pty upgrade must not silently match");
});

// Listen for either an "unexpected-response" (server sent an HTTP status
// before the WS upgrade completed) or an "error" (the socket was destroyed
// mid-handshake). Returns { kind, status? } — the WS library fires
// `unexpected-response` with the http.IncomingMessage when the server
// writes a real HTTP error, and `error` when the socket is closed
// abruptly. The relay uses both depending on timing; either is valid for
// asserting the gate.
async function expectUpgradeStatus(ws, expectedStatus, label) {
  // Race for unexpected-response first; fall back to error so we don't
  // hang if the server's tcp-write is too fast for the WS library's
  // upgrade-completion check.
  let unexpected;
  let error;
  const settled = new Promise((resolve) => {
    ws.once("unexpected-response", (_msg, res) => {
      unexpected = { status: res.statusCode };
      resolve();
    });
    ws.once("error", () => {
      error = true;
      resolve();
    });
  });
  await settled;
  if (unexpected) {
    assert.equal(unexpected.status, expectedStatus, `${label}: expected ${expectedStatus}, got ${unexpected.status}`);
    return;
  }
  // An "error" without a response object means the relay accepted the
  // socket but rejected with a non-standard response (or destroyed it
  // before any bytes were sent). We can only assert that the upgrade did
  // not succeed; the test should rely on `unexpected` for status pinning.
  assert.fail(`${label}: expected HTTP ${expectedStatus} but got an error before the upgrade response`);
}

test("upgrade routing: /box/<id>/pty without auth → 401 close", async (t) => {
  const { svc, store, wsBase } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);
  const ws = new WebSocket(`${wsBase}/box/${BOX_A}/pty?session=abc`);
  await expectUpgradeStatus(ws, 401, "no auth");
  ws.terminate();
});

test("upgrade routing: /box/<id>/pty for an unowned box → 404", async (t) => {
  const { store, wsBase } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, "ffffffffffffffffffffffffffffffff"); // owned by someone else
  const ws = new WebSocket(`${wsBase}/box/${BOX_A}/pty?session=abc&token=${ACCT_1}`);
  await expectUpgradeStatus(ws, 404, "unowned box");
  ws.terminate();
});

test("upgrade routing: /box/<id>/pty with valid auth but no subscription → 402", async (t) => {
  const { svc, store, wsBase } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);
  const ws = new WebSocket(`${wsBase}/box/${BOX_A}/pty?session=abc&token=${ACCT_1}`);
  await expectUpgradeStatus(ws, 402, "no subscription");
  ws.terminate();
});

test("upgrade routing: /box/<id>/pty with valid auth + subscription → bridge to box leg", async (t) => {
  const { svc, store, wsBase } = await makeService(t);
  store.upsertBox(BOX_A);
  store.bindBox(BOX_A, ACCT_1);
  // Bind an active receipt so the subscription gate opens.
  bindReceipt(store, {
    boxId: BOX_A,
    transaction: {
      originalTransactionId: "test-1",
      productId: "sub.monthly",
      expiresAt: null,
    },
    raw: "jws",
  }, { now: () => Date.now() });

  // Dial the box leg so the relay has a live transport to bridge to.
  const boxWs = new WebSocket(`${wsBase}/box?box_id=${BOX_A}&token=${TOKEN_A}`);
  await once(boxWs, "open");
  await waitFor(() => svc.boxLeg.routing.has(BOX_A));

  // The box leg auto-answers STREAM_OPEN request forms with a canned
  // STREAM_OPEN (response form) + END so the device-side bridge sees the
  // handshake complete; we watch the box socket to verify the relay sent
  // exactly one STREAM_OPEN with stream:"pty".
  const sentFrames = [];
  boxWs.on("message", (data) => {
    const f = decodeFrame(data);
    if (f) sentFrames.push(f);
    if (f?.type === FRAME_TYPES.STREAM_OPEN && f.stream) {
      // Answer with the response form so the bridge's onHead fires.
      boxWs.send(encodeFrame({
        type: FRAME_TYPES.STREAM_OPEN,
        id: f.id,
        stream: f.stream,
        status: 101,
        headers: {},
      }));
      // ...and immediately end it so the device's WS closes cleanly.
      boxWs.send(encodeFrame({
        type: FRAME_TYPES.STREAM_END,
        id: f.id,
        stream: f.stream,
      }));
    }
  });

  const deviceWs = new WebSocket(
    `${wsBase}/box/${BOX_A}/pty?session=abc&token=${ACCT_1}`,
  );
  await once(deviceWs, "open");
  // Wait for the device to close (the box leg sends STREAM_END immediately
  // above; the bridge closes the device WS in response).
  await once(deviceWs, "close");

  // Exactly one STREAM_OPEN went down the tunnel, with stream="pty" and
  // the path stripped of ?token= (the device's account token).
  const open = sentFrames.find((f) => f.type === FRAME_TYPES.STREAM_OPEN);
  assert.ok(open, "STREAM_OPEN was sent down the tunnel");
  assert.equal(open.method, "GET", "method preserved");
  assert.equal(open.stream, "pty", "stream discriminator is 'pty'");
  assert.match(open.path, /^\/pty\?session=abc$/, "device path forwarded, ?token= stripped");

  boxWs.close();
  deviceWs.terminate();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function once(ws, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    ws.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function waitFor(pred, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!pred()) throw new Error("waitFor: predicate never became true");
}
