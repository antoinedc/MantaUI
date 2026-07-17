import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import {
  createRelayApi,
  createDefaultPhoneAuth,
  createDefaultSubscriptionCheck,
  isGatedSubpath,
  isStreamingSubpath,
} from "./api.mjs";
import { createRelayServer, createDefaultVerifier } from "./index.mjs";
import { createBoxMeter, FREE_RL_CAPACITY } from "./metering.mjs";
import { openStore, BOX_STATUS, hashToken } from "./store.mjs";
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
// Seeded into a fresh in-memory store: device tokens map to their own account
// id (the same opaque identifier; this matches what /pair mints today).
function makeAuth(storeArg) {
  const store = storeArg || openStore();
  store.addAccountToken(hashToken(ACCT_1), ACCT_1);
  store.addAccountToken(hashToken(ACCT_2), ACCT_2);
  const auth = createDefaultPhoneAuth({ store, warn: silent });
  // expose the store so callers can use it for fixtures
  return Object.assign(auth, { _store: store });
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function parseBody(resp) {
  return typeof resp.body === "string" && resp.body ? JSON.parse(resp.body) : null;
}

// ---------------------------------------------------------------------------
// pure: streaming classification (BET-156 §3)
// ---------------------------------------------------------------------------

test("isStreamingSubpath: /events is streaming; metadata + gated-but-buffered paths are not", () => {
  for (const p of ["/events", "/events/", "/events?token=abc"]) {
    assert.equal(isStreamingSubpath(p), true, `${p} should be streaming`);
  }
  for (const p of ["/", "/projects", "/transcript", "/prompt", "/pty", "/message", "/stream"]) {
    assert.equal(isStreamingSubpath(p), false, `${p} should NOT be streaming`);
  }
});

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

test("createDefaultPhoneAuth: throws without a store (no dev-open fallback)", () => {
  assert.throws(() => createDefaultPhoneAuth(), /store required/);
});

test("createDefaultPhoneAuth: store-known token → accountId; unknown/malformed → null", () => {
  const auth = makeAuth();
  assert.deepEqual(auth({ headers: bearer(ACCT_1) }), { accountId: ACCT_1 });
  assert.deepEqual(auth({ headers: bearer(ACCT_2) }), { accountId: ACCT_2 });
  assert.equal(auth({ headers: bearer("deadbeefdeadbeefdeadbeefdeadbeef") }), null, "unknown well-formed token");
  assert.equal(auth({ headers: bearer("not-hex") }), null, "malformed token");
  assert.equal(auth({ headers: {} }), null, "no token");
  auth._store.close();
});

test("createDefaultPhoneAuth: falls back to ?token= query when no header", () => {
  const auth = makeAuth();
  assert.deepEqual(auth({ path: `/api/boxes?token=${ACCT_1}` }), { accountId: ACCT_1 });
  auth._store.close();
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
    verifyBox: createDefaultVerifier({ store, warn: silent, log: silent }),
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

// ---------------------------------------------------------------------------
// end-to-end streaming proxy over a REAL relay + REAL box socket (BET-156 §3)
// ---------------------------------------------------------------------------

// Fake box that auto-replies to STREAM_OPEN (request form) with a canned head
// + N DATA chunks + END. Mirrors the SSE shape: text/event-stream, no body
// length (the box leaves Content-Length off, but we still strip it in api.mjs
// defensively — see stripForStream).
function installAutoStreamBox(ws, { chunks = [], status = 200, headers = {}, reason = null } = {}) {
  ws.on("message", (data) => {
    const f = decodeFrame(data);
    if (!f || f.type !== FRAME_TYPES.STREAM_OPEN) return;
    if (typeof f.method !== "string") return; // ignore response-form
    ws.send(encodeFrame({ type: FRAME_TYPES.STREAM_OPEN, id: f.id, stream: f.stream, status, headers }));
    for (const c of chunks) {
      ws.send(encodeFrame({ type: FRAME_TYPES.STREAM_DATA, id: f.id, stream: f.stream, data: c }));
    }
    if (reason != null) {
      ws.send(encodeFrame({ type: FRAME_TYPES.STREAM_ABORT, id: f.id, stream: f.stream, reason }));
    } else {
      ws.send(encodeFrame({ type: FRAME_TYPES.STREAM_END, id: f.id, stream: f.stream }));
    }
  });
}

test("end-to-end: phone /events request streams OPEN→DATA×n→END to the phone's HTTP response", async (t) => {
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });
  store.upsertReceipt({ originalTransactionId: "t-events", boxId: BOX_A, expiresAt: null });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const relay = createRelayServer({ wss, store, verifyBox: createDefaultVerifier({ store, warn: silent, log: silent }), log: silent, warn: silent });

  const boxWs = new WebSocket(`ws://127.0.0.1:${wss.address().port}/box?box_id=${BOX_A}&token=${BOX_TOKEN_A}`);
  await once(boxWs, "open");
  installAutoStreamBox(boxWs, {
    chunks: ["data: hello\n\n", "data: world\n\n", "data: end\n\n"],
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  await waitFor(() => relay.routing.has(BOX_A));

  t.after(async () => {
    boxWs.close();
    await waitFor(() => !relay.routing.has(BOX_A));
    await relay.close();
    await new Promise((r) => wss.close(() => r()));
  });

  const api = createRelayApi({
    store,
    proxyRequest: relay.proxyRequest,
    streamRequest: relay.streamRequest,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  // Simulate the phone's HTTP request by capturing the events the streaming
  // sink would receive. The api's route() returns a __stream sentinel whose
  // handler drives the sink from STREAM_* frames.
  const events = [];
  const resp = await api.route(
    { method: "GET", path: `/box/${BOX_A}/events?token=foo`, headers: bearer(ACCT_1) },
    (e) => events.push(e),
  );
  assert.ok(resp.__stream, "the api returns the __stream sentinel for /events");
  // Drive the stream: this kicks off the STREAM_* request to the box leg.
  const handle = resp.handler();
  // Wait for the full sequence.
  await waitFor(() => events.some((e) => e.kind === "end"), { timeoutMs: 2000 });

  // Sequence: head → 3× data → end.
  assert.deepEqual(
    events.map((e) => e.kind),
    ["head", "data", "data", "data", "end"],
    "frame sequence is head→data×3→end",
  );
  assert.equal(events[0].status, 200);
  assert.equal(events[0].headers["content-type"], "text/event-stream");
  assert.deepEqual(
    events.slice(1, -1).map((e) => e.data),
    ["data: hello\n\n", "data: world\n\n", "data: end\n\n"],
    "chunks preserved in order",
  );
  assert.equal(handle.streamId >= 1, true);
});

test("end-to-end: phone /events request — STREAM_ABORT from the box surfaces as onAbort", async (t) => {
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });
  store.upsertReceipt({ originalTransactionId: "t-events-abort", boxId: BOX_A, expiresAt: null });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const relay = createRelayServer({ wss, store, verifyBox: createDefaultVerifier({ store, warn: silent, log: silent }), log: silent, warn: silent });

  const boxWs = new WebSocket(`ws://127.0.0.1:${wss.address().port}/box?box_id=${BOX_A}&token=${BOX_TOKEN_A}`);
  await once(boxWs, "open");
  installAutoStreamBox(boxWs, { chunks: ["partial "], reason: "box exploded" });
  await waitFor(() => relay.routing.has(BOX_A));

  t.after(async () => {
    boxWs.close();
    await waitFor(() => !relay.routing.has(BOX_A));
    await relay.close();
    await new Promise((r) => wss.close(() => r()));
  });

  const api = createRelayApi({
    store,
    proxyRequest: relay.proxyRequest,
    streamRequest: relay.streamRequest,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  const events = [];
  const resp = await api.route(
    { method: "GET", path: `/box/${BOX_A}/events`, headers: bearer(ACCT_1) },
    (e) => events.push(e),
  );
  resp.handler();
  await waitFor(() => events.some((e) => e.kind === "abort"), { timeoutMs: 2000 });

  assert.equal(events[0].kind, "head", "head fires even on abort");
  assert.equal(events[1].kind, "data");
  assert.equal(events[1].data, "partial ");
  assert.equal(events[2].kind, "abort");
  assert.equal(events[2].reason, "box exploded");
  assert.equal(events.some((e) => e.kind === "end"), false, "no onEnd on abort");
});

test("non-SSE proxied paths still use the buffered path (no behavior change)", async (t) => {
  // Even with streamRequest configured, a non-/events path goes through the
  // regular REQUEST/RESPONSE channel — proving the streaming branch is a
  // strict subpath carve-out, not a behavior change for the rest.
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const relay = createRelayServer({ wss, store, verifyBox: createDefaultVerifier({ store, warn: silent, log: silent }), log: silent, warn: silent });

  let streamUsed = false;
  const boxWs = new WebSocket(`ws://127.0.0.1:${wss.address().port}/box?box_id=${BOX_A}&token=${BOX_TOKEN_A}`);
  await once(boxWs, "open");
  boxWs.on("message", (data) => {
    const f = decodeFrame(data);
    if (!f) return;
    if (f.type === FRAME_TYPES.STREAM_OPEN) streamUsed = true;
    if (f.type === FRAME_TYPES.REQUEST) {
      boxWs.send(encodeFrame({ type: FRAME_TYPES.RESPONSE, id: f.id, status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) }));
    }
  });
  await waitFor(() => relay.routing.has(BOX_A));

  t.after(async () => {
    boxWs.close();
    await waitFor(() => !relay.routing.has(BOX_A));
    await relay.close();
    await new Promise((r) => wss.close(() => r()));
  });

  const api = createRelayApi({
    store,
    proxyRequest: relay.proxyRequest,
    streamRequest: relay.streamRequest,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  const resp = await api.route({
    method: "GET",
    path: `/box/${BOX_A}/projects`,
    headers: bearer(ACCT_1),
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.__stream, undefined, "non-SSE path is NOT a __stream sentinel");
  assert.equal(JSON.parse(resp.body).ok, true);
  await waitFor(() => !streamUsed, { timeoutMs: 1000 });
  assert.equal(streamUsed, false, "/projects did NOT trigger the streaming path");
});

// ---------------------------------------------------------------------------
// byte metering (BET-157) — meter wired into the api proxy branch + boxView
// ---------------------------------------------------------------------------

test("metering: proxied request records ingress+egress bytes for the right box_id", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  // The proxy path POSTs to /prompt (gated). Bind an active receipt so the
  // 402 gate doesn't fire before the proxy branch — metering is what we're
  // testing here.
  store.upsertReceipt({ originalTransactionId: "t-meter-prompt", boxId: BOX_A, expiresAt: null });
  const meter = createBoxMeter({ store, warn: silent });

  // The proxyRequest fake reflects the forwarded body back as JSON so the
  // response body is non-empty — exercising both ingress and egress.
  const proxyRequest = async (_boxId, fwd) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ echo: fwd.body ?? "" }),
  });
  const api = createRelayApi({
    store,
    proxyRequest,
    meter,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  // Pre-flight: BOX_A has no usage row yet.
  assert.equal(store.getUsage(BOX_A), null);

  // POST a known-size body so ingress is deterministic.
  const reqBody = '{"hello":"world"}';
  const resp = await api.route({
    method: "POST",
    path: `/box/${BOX_A}/prompt`,
    headers: { ...bearer(ACCT_1), "content-type": "application/json" },
    body: reqBody,
  });
  assert.equal(resp.status, 200);

  const usage = store.getUsage(BOX_A);
  assert.ok(usage, "BOX_A has a usage row after one proxied request");
  // ingress = body bytes (req.body is the JSON above — 17 bytes; headers are
  // NOT metered per BET-157 §2).
  assert.equal(usage.ingress, Buffer.byteLength(reqBody), "ingress = body byte length");
  // egress = body byte length of the buffered response.
  assert.equal(usage.egress, Buffer.byteLength(resp.body), "egress = response body bytes");
  assert.equal(usage.egress, Buffer.byteLength('{"echo":"{\\"hello\\":\\"world\\"}"}'));

  // Per-box isolation: BOX_B has no usage (its free bucket is still full).
  assert.equal(store.getUsage(BOX_B), null, "BOX_B was not proxied through");

  // A second request accumulates (does not overwrite).
  await api.route({
    method: "POST",
    path: `/box/${BOX_A}/prompt`,
    headers: { ...bearer(ACCT_1), "content-type": "application/json" },
    body: reqBody,
  });
  const after = store.getUsage(BOX_A);
  assert.equal(after.ingress, usage.ingress * 2, "second request doubles ingress");
  assert.equal(after.egress, usage.egress * 2, "second request doubles egress");
});

test("metering: over-cap box → 429 and proxyRequest is NOT called", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  // Freeze the clock so the token bucket never refills during the burst.
  const meter = createBoxMeter({ store, now: () => 1000, warn: silent });

  // Drain BOX_A's free bucket — every subsequent allow() returns false.
  for (let i = 0; i < FREE_RL_CAPACITY + 2; i++) {
    meter.allow(BOX_A, { paid: false });
  }

  let proxyCalls = 0;
  const proxyRequest = async () => {
    proxyCalls += 1;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };
  };
  const api = createRelayApi({
    store,
    proxyRequest,
    meter,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  // Free (metadata) subpath — same gate as gated, BET-157 §3.
  const resp = await api.route({
    method: "GET",
    path: `/box/${BOX_A}/projects`,
    headers: bearer(ACCT_1),
  });
  assert.equal(resp.status, 429, "over-cap free subpath → 429");
  assert.equal(proxyCalls, 0, "proxyRequest NOT called for over-cap request");
  const body = await parseBody(resp);
  assert.equal(body.error, "quota_exceeded");
  assert.equal(body.box_id, BOX_A);

  // The rejection must NOT have recorded usage.
  assert.equal(store.getUsage(BOX_A), null, "rejected requests leave no usage row");
});

test("metering: boxView exposes bytes_in/bytes_out from the store", async (t) => {
  const store = seededStore();
  t.after(() => store.close());
  const meter = createBoxMeter({ store, warn: silent });
  meter.record(BOX_A, { ingress: 123, egress: 456 });

  const api = createRelayApi({
    store,
    proxyRequest: noProxy,
    meter,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  // /api/boxes/:id detail — bytes_* are surfaced from the metering row.
  const detail = await api.route({
    method: "GET",
    path: `/api/boxes/${BOX_A}`,
    headers: bearer(ACCT_1),
  });
  assert.equal(detail.status, 200);
  const body = await parseBody(detail);
  assert.equal(body.box.bytes_in, 123);
  assert.equal(body.box.bytes_out, 456);

  // /api/boxes list — same fields per box (zero when no usage yet).
  const list = await api.route({
    method: "GET",
    path: "/api/boxes",
    headers: bearer(ACCT_1),
  });
  assert.equal(list.status, 200);
  const lb = await parseBody(list);
  const a = lb.boxes.find((x) => x.box_id === BOX_A);
  assert.ok(a, "BOX_A is in the list");
  assert.equal(a.bytes_in, 123);
  assert.equal(a.bytes_out, 456);

  // BOX_B was never metered — its boxView shows zeros.
  const lb2 = await parseBody(
    await api.route({ method: "GET", path: "/api/boxes", headers: bearer(ACCT_2) }),
  );
  const b = lb2.boxes.find((x) => x.box_id === BOX_B);
  assert.equal(b.bytes_in, 0);
  assert.equal(b.bytes_out, 0);
});

test("metering: streamed /events path records ingress once + per-chunk egress (chunk pump)", async (t) => {
  const store = openStore();
  store.upsertBox(BOX_A, { status: BOX_STATUS.ONLINE, at: 1 });
  store.bindBox(BOX_A, ACCT_1, { at: 1 });
  store.upsertReceipt({ originalTransactionId: "t-meter-stream", boxId: BOX_A, expiresAt: null });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const relay = createRelayServer({
    wss,
    store,
    verifyBox: createDefaultVerifier({ store, warn: silent, log: silent }),
    log: silent,
    warn: silent,
  });

  // Fake box serves three SSE chunks.
  const boxWs = new WebSocket(
    `ws://127.0.0.1:${wss.address().port}/box?box_id=${BOX_A}&token=${BOX_TOKEN_A}`,
  );
  await once(boxWs, "open");
  const chunks = ["data: a\n\n", "data: bb\n\n", "data: ccc\n\n"];
  installAutoStreamBox(boxWs, { chunks, status: 200, headers: { "content-type": "text/event-stream" } });
  await waitFor(() => relay.routing.has(BOX_A));

  t.after(async () => {
    boxWs.close();
    await waitFor(() => !relay.routing.has(BOX_A));
    await relay.close();
    await new Promise((r) => wss.close(() => r()));
  });

  const meter = createBoxMeter({ store, warn: silent });
  const api = createRelayApi({
    store,
    proxyRequest: relay.proxyRequest,
    streamRequest: relay.streamRequest,
    meter,
    authenticatePhone: makeAuth(),
    warn: silent,
  });

  // Send a request with a known body so ingress is exact (the box ignores the
  // body but metering still counts it).
  const reqBody = "hi";
  const events = [];
  const resp = await api.route(
    {
      method: "GET",
      path: `/box/${BOX_A}/events`,
      headers: { ...bearer(ACCT_1), "content-type": "text/plain" },
      body: reqBody,
    },
    (e) => events.push(e),
  );
  assert.ok(resp.__stream, "/events returns the __stream sentinel");
  // Drive the stream — the handler records ingress once at this point.
  resp.handler();
  await waitFor(() => events.some((e) => e.kind === "end"), { timeoutMs: 2000 });

  // Verify egress recorded per-chunk: each chunk's bytes show up in store.
  const expectedEgress = chunks.reduce((n, c) => n + Buffer.byteLength(c), 0);
  const usage = store.getUsage(BOX_A);
  assert.ok(usage, "BOX_A has a usage row after streamed request");
  assert.equal(usage.ingress, Buffer.byteLength(reqBody), "ingress recorded once on stream open");
  assert.equal(usage.egress, expectedEgress, "egress = sum of chunk byte lengths");
});
