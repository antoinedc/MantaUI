import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import {
  createRelayApi,
  createDefaultPhoneAuth,
  createDefaultSubscriptionCheck,
  isGatedSubpath,
} from "./api.mjs";
import { createRelayServer, createDefaultVerifier } from "./index.mjs";
import { openStore, BOX_STATUS } from "./store.mjs";
import { encodeFrame, decodeFrame, FRAME_TYPES } from "./protocol.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef"; // 32 hex
const BOX_B = "fedcba9876543210fedcba9876543210";
const BOX_TOKEN_A = "aaaa2222333344445555666677778888";
const ACCT_1 = "1111111111111111aaaaaaaaaaaaaaaa"; // phone account token
const ACCT_2 = "2222222222222222bbbbbbbbbbbbbbbb";

const silent = () => {};

// A store seeded with box A bound to account 1 and box B bound to account 2.
function seededStore() {
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1000 });
  store.upsertBox(BOX_B, { status: BOX_STATUS.OFFLINE, at: 2000 });
  store.bindBox(BOX_A, ACCT_1, { at: 1000 });
  store.bindBox(BOX_B, ACCT_2, { at: 2000 });
  return store;
}

// A default proxyRequest fake that never gets called (routing/gate tests).
const noProxy = async () => {
  throw new Error("proxyRequest should not have been called");
};

// Auth that maps the two account tokens; anything else → null.
function makeAuth() {
  return createDefaultPhoneAuth({
    accountTokens: { [ACCT_1]: ACCT_1, [ACCT_2]: ACCT_2 },
    warn: silent,
  });
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function parseBody(resp) {
  return typeof resp.body === "string" && resp.body ? JSON.parse(resp.body) : null;
}

// ---------------------------------------------------------------------------
// pure: gated-path classification
// ---------------------------------------------------------------------------

test("isGatedSubpath: transcript/stream/prompt/pty are gated; metadata is free", () => {
  for (const p of ["/transcript", "/stream", "/stream/abc", "/prompt", "/pty", "/events", "/message"]) {
    assert.equal(isGatedSubpath(p), true, `${p} should be gated`);
  }
  for (const p of ["/", "/projects", "/sessions", "/sessions/x/stats", "/status"]) {
    assert.equal(isGatedSubpath(p), false, `${p} should be free`);
  }
});

// ---------------------------------------------------------------------------
// pure: default phone auth seam
// ---------------------------------------------------------------------------

test("createDefaultPhoneAuth: mapped token → accountId; unknown/malformed → null", () => {
  const auth = makeAuth();
  assert.deepEqual(auth({ headers: bearer(ACCT_1) }), { accountId: ACCT_1 });
  assert.equal(auth({ headers: bearer("deadbeefdeadbeefdeadbeefdeadbeef") }), null, "unknown token");
  assert.equal(auth({ headers: bearer("not-hex") }), null, "malformed token");
  assert.equal(auth({ headers: {} }), null, "no token");
});

test("createDefaultPhoneAuth: DEV-OPEN (no map) treats a well-formed token as the account", () => {
  const auth = createDefaultPhoneAuth({ warn: silent });
  assert.deepEqual(auth({ headers: bearer(ACCT_1) }), { accountId: ACCT_1 });
  assert.equal(auth({ headers: bearer("bad") }), null);
});

test("createDefaultPhoneAuth: falls back to ?token= query when no header", () => {
  const auth = makeAuth();
  assert.deepEqual(auth({ path: `/api/boxes?token=${ACCT_1}` }), { accountId: ACCT_1 });
});

// ---------------------------------------------------------------------------
// pure: default subscription check reads the store
// ---------------------------------------------------------------------------

test("createDefaultSubscriptionCheck: no receipt → false; active receipt → true; expired → false", () => {
  const store = seededStore();
  const now = () => 5000;
  const check = createDefaultSubscriptionCheck(store, now);

  assert.equal(check(BOX_A), false, "no receipt bound → not subscribed");

  store.upsertReceipt({ originalTransactionId: "t1", boxId: BOX_A, expiresAt: 9999 });
  assert.equal(check(BOX_A), true, "future-expiry receipt → subscribed");

  store.upsertReceipt({ originalTransactionId: "t1", boxId: BOX_A, expiresAt: 1 });
  assert.equal(check(BOX_A), false, "expired receipt → not subscribed");

  store.upsertReceipt({ originalTransactionId: "t2", boxId: BOX_A, expiresAt: null });
  assert.equal(check(BOX_A), true, "no-expiry receipt → subscribed");
  store.close();
});

// ---------------------------------------------------------------------------
// routing endpoints
// ---------------------------------------------------------------------------

test("GET /api/boxes returns only the authed account's boxes; unauthenticated → 401", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const api = createRelayApi({ store, proxyRequest: noProxy, authenticatePhone: makeAuth(), warn: silent });

  const unauth = await api.route({ method: "GET", path: "/api/boxes" });
  assert.equal(unauth.status, 401);

  const resp = await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_1) });
  assert.equal(resp.status, 200);
  const body = await parseBody(resp);
  assert.equal(body.boxes.length, 1, "only account 1's box");
  assert.equal(body.boxes[0].box_id, BOX_A);

  const resp2 = await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_2) });
  const body2 = await parseBody(resp2);
  assert.equal(body2.boxes.length, 1);
  assert.equal(body2.boxes[0].box_id, BOX_B);
});

test("GET /api/boxes/:id — unknown → 404, unowned → 404, owned → details", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const api = createRelayApi({ store, proxyRequest: noProxy, authenticatePhone: makeAuth(), warn: silent });

  // Unknown box (well-formed id, no binding).
  const unknown = "cccccccccccccccccccccccccccccccc";
  const r1 = await api.route({ method: "GET", path: `/api/boxes/${unknown}`, headers: bearer(ACCT_1) });
  assert.equal(r1.status, 404, "unknown box → 404");

  // Owned by account 2, requested by account 1 → 404 (no existence leak).
  const r2 = await api.route({ method: "GET", path: `/api/boxes/${BOX_B}`, headers: bearer(ACCT_1) });
  assert.equal(r2.status, 404, "unowned box → 404");

  // Owned → details.
  const r3 = await api.route({ method: "GET", path: `/api/boxes/${BOX_A}`, headers: bearer(ACCT_1) });
  assert.equal(r3.status, 200);
  const body = await parseBody(r3);
  assert.equal(body.box.box_id, BOX_A);
  assert.equal(body.box.status, BOX_STATUS.ONLINE);

  // Malformed box id → 404.
  const r4 = await api.route({ method: "GET", path: `/api/boxes/not-a-box`, headers: bearer(ACCT_1) });
  assert.equal(r4.status, 404, "malformed id → 404");
});

test("POST /api/boxes/:id/revoke removes the binding; subsequent list omits it", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const api = createRelayApi({ store, proxyRequest: noProxy, authenticatePhone: makeAuth(), warn: silent });

  const rev = await api.route({ method: "POST", path: `/api/boxes/${BOX_A}/revoke`, headers: bearer(ACCT_1) });
  assert.equal(rev.status, 200);
  const body = await parseBody(rev);
  assert.equal(body.revoked, true);

  // Now the list is empty for account 1.
  const list = await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_1) });
  const lb = await parseBody(list);
  assert.equal(lb.boxes.length, 0, "revoked box gone from list");

  // And the box is no longer owned → 404 on detail.
  const det = await api.route({ method: "GET", path: `/api/boxes/${BOX_A}`, headers: bearer(ACCT_1) });
  assert.equal(det.status, 404);

  // Revoke of an unowned box → 404 (can't revoke someone else's).
  const cross = await api.route({ method: "POST", path: `/api/boxes/${BOX_B}/revoke`, headers: bearer(ACCT_1) });
  assert.equal(cross.status, 404);
});

// ---------------------------------------------------------------------------
// gate seam (structure only)
// ---------------------------------------------------------------------------

test("gate seam: gated subpath with no active receipt → 402; metadata subpath → served free", async (t) => {
  const store = seededStore();
  t.after(() => store.close());

  // proxyRequest fake records what it was asked to forward and returns a canned
  // box response for the free/metadata path.
  const forwarded = [];
  const proxyRequest = async (boxId, req) => {
    forwarded.push({ boxId, ...req });
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
  };
  const api = createRelayApi({ store, proxyRequest, authenticatePhone: makeAuth(), warn: silent });

  // Gated path, no receipt bound → 402, and proxyRequest NOT called.
  const gated = await api.route({ method: "GET", path: `/box/${BOX_A}/transcript`, headers: bearer(ACCT_1) });
  assert.equal(gated.status, 402, "gated path without subscription → 402");
  assert.equal(forwarded.length, 0, "gated request not forwarded to box");

  // Metadata path → forwarded free, box response relayed back.
  const free = await api.route({ method: "GET", path: `/box/${BOX_A}/projects`, headers: bearer(ACCT_1) });
  assert.equal(free.status, 200, "metadata path served free");
  assert.equal(forwarded.length, 1, "metadata request forwarded");
  assert.equal(forwarded[0].path, "/projects", "subpath forwarded without /box/:id prefix");
  const body = await parseBody(free);
  assert.deepEqual(body, { ok: true });

  // With an active receipt bound, the gated path now forwards too.
  store.upsertReceipt({ originalTransactionId: "t1", boxId: BOX_A, expiresAt: null });
  const gatedOk = await api.route({ method: "GET", path: `/box/${BOX_A}/transcript`, headers: bearer(ACCT_1) });
  assert.equal(gatedOk.status, 200, "gated path with active receipt → forwarded");
  assert.equal(forwarded.length, 2);
});

test("proxy: unowned box on the proxy path → 404, never forwarded", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const api = createRelayApi({ store, proxyRequest: noProxy, authenticatePhone: makeAuth(), warn: silent });
  // Account 1 tries to proxy to account 2's box.
  const r = await api.route({ method: "GET", path: `/box/${BOX_B}/projects`, headers: bearer(ACCT_1) });
  assert.equal(r.status, 404);
});

test("proxy: 503 when the box has no live tunnel (proxyRequest rejects no_tunnel)", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const proxyRequest = async () => {
    const err = new Error("no tunnel");
    err.code = "no_tunnel";
    throw err;
  };
  const api = createRelayApi({ store, proxyRequest, authenticatePhone: makeAuth(), warn: silent });
  const r = await api.route({ method: "GET", path: `/box/${BOX_A}/projects`, headers: bearer(ACCT_1) });
  assert.equal(r.status, 503);
  const body = await parseBody(r);
  assert.equal(body.error, "box_offline");
});

test("proxy: box timeout → 504", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const proxyRequest = async () => {
    throw new Error("request 1 timed out after 30000ms");
  };
  const api = createRelayApi({ store, proxyRequest, authenticatePhone: makeAuth(), warn: silent });
  const r = await api.route({ method: "GET", path: `/box/${BOX_A}/projects`, headers: bearer(ACCT_1) });
  assert.equal(r.status, 504);
});

test("rate limit: exhausting the per-account bucket → 429", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  // Tiny bucket: capacity 2, no meaningful refill within the test.
  let calls = 0;
  const rateLimiter = () => {
    calls += 1;
    return calls <= 2;
  };
  const api = createRelayApi({ store, proxyRequest: noProxy, authenticatePhone: makeAuth(), rateLimiter, warn: silent });
  const a = await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_1) });
  const b = await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_1) });
  const c = await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_1) });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429, "third request throttled");
});

// ---------------------------------------------------------------------------
// end-to-end proxy over a REAL relay + REAL box socket (fake box answers)
// ---------------------------------------------------------------------------

// Wait for a ws event once, with a timeout guard.
function once(ws, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    ws.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function waitFor(pred, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!pred()) throw new Error("waitFor: predicate never became true");
}

test("end-to-end: phone metadata request is forwarded to a live box and the framed response returns", async (t) => {
  // Real relay on an ephemeral port with a store where box A is bound to acct 1.
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address();
  const relay = createRelayServer({
    wss,
    store,
    verifyBox: createDefaultVerifier({ warn: silent }),
    log: silent,
    warn: silent,
  });

  // A fake box: dial in, then answer any REQUEST frame with a canned RESPONSE
  // echoing the requested path (proves the subpath was forwarded correctly).
  const boxWs = new WebSocket(
    `ws://127.0.0.1:${port}/box?box_id=${BOX_A}&token=${BOX_TOKEN_A}`,
  );
  await once(boxWs, "open");
  boxWs.on("message", (data) => {
    const frame = decodeFrame(data);
    if (frame && frame.type === FRAME_TYPES.REQUEST) {
      boxWs.send(
        encodeFrame({
          type: FRAME_TYPES.RESPONSE,
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: frame.path, method: frame.method }),
        }),
      );
    }
  });
  await waitFor(() => relay.routing.has(BOX_A));

  t.after(async () => {
    // Close the box socket and let the relay's close-cleanup run (unregister +
    // setBoxStatus) WHILE the store is still open, then close the relay/store.
    boxWs.close();
    await waitFor(() => !relay.routing.has(BOX_A));
    await relay.close();
    await new Promise((r) => wss.close(() => r()));
  });

  const api = createRelayApi({
    store,
    proxyRequest: relay.proxyRequest,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  const resp = await api.route({
    method: "GET",
    path: `/box/${BOX_A}/projects`,
    headers: bearer(ACCT_1),
  });
  assert.equal(resp.status, 200);
  const body = JSON.parse(resp.body);
  assert.equal(body.path, "/projects", "box saw the forwarded subpath");
  assert.equal(body.method, "GET");
});

test("end-to-end: no live tunnel → proxyRequest rejects no_tunnel → 503", async (t) => {
  // Box A is bound + known to the store but NEVER dials in → no live tunnel.
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.OFFLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const relay = createRelayServer({ wss, store, log: silent, warn: silent });
  t.after(async () => {
    await relay.close();
    await new Promise((r) => wss.close(() => r()));
  });

  const api = createRelayApi({
    store,
    proxyRequest: relay.proxyRequest,
    authenticatePhone: makeAuth(),
    warn: silent,
  });
  const resp = await api.route({
    method: "GET",
    path: `/box/${BOX_A}/projects`,
    headers: bearer(ACCT_1),
  });
  assert.equal(resp.status, 503, "offline box → 503");
});
