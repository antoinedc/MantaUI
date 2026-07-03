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

import { createRelayService } from "./server.mjs";
import { openStore } from "./store.mjs";
import { encodeFrame, decodeFrame, FRAME_TYPES } from "./protocol.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef"; // 32 hex
const TOKEN_A = "11112222333344445555666677778888"; // box token (32 hex)
const ACCT_1 = "aaaabbbbccccddddeeeeffff00001111"; // phone token == account (DEV-OPEN)
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

async function makeService(t) {
  const store = openStore(); // in-memory, shared so the test can bindBox()
  const svc = createRelayService({
    port: 0,
    host: "127.0.0.1",
    store,
    log: silent,
    warn: silent,
  });
  const { port } = await svc.start();
  t.after(async () => {
    await svc.close();
  });
  return { svc, store, port, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

// A phone HTTP request with a bearer token (== account id in DEV-OPEN).
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
