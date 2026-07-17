import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import {
  createRelayServer,
  createDefaultVerifier,
  parseHandshake,
  wsTransport,
  DEFAULT_RELAY_PORT,
} from "./index.mjs";
import { openStore, BOX_STATUS, hashToken } from "./store.mjs";
import { encodeFrame, decodeFrame, FRAME_TYPES } from "./protocol.mjs";

const BOX_A = "0123456789abcdef0123456789abcdef"; // 32 hex
const BOX_B = "fedcba9876543210fedcba9876543210";
const TOKEN_A = "11112222333344445555666677778888";
const TOKEN_B = "88887777666655554444333322221111";

const silent = () => {};

// ---------------------------------------------------------------------------
// pure: handshake parsing
// ---------------------------------------------------------------------------

test("parseHandshake: header forms win over query params", () => {
  const h = parseHandshake({
    url: `/box?box_id=${BOX_B}&token=${TOKEN_B}`,
    headers: { authorization: `Bearer ${TOKEN_A}`, "x-box-id": BOX_A, host: "h" },
    host: "h",
  });
  assert.equal(h.boxId, BOX_A);
  assert.equal(h.token, TOKEN_A);
  assert.equal(h.path, "/box");
});

test("parseHandshake: falls back to query params when no headers", () => {
  const h = parseHandshake({ url: `/box?box_id=${BOX_A}&token=${TOKEN_A}` });
  assert.equal(h.boxId, BOX_A);
  assert.equal(h.token, TOKEN_A);
});

test("parseHandshake: bare Authorization (no Bearer scheme) still parses", () => {
  const h = parseHandshake({ url: "/box", headers: { authorization: TOKEN_A } });
  assert.equal(h.token, TOKEN_A);
});

test("parseHandshake: missing creds → nulls; malformed url → nulls", () => {
  assert.deepEqual(parseHandshake({ url: "/box" }), {
    boxId: null,
    token: null,
    path: "/box",
  });
});

// ---------------------------------------------------------------------------
// pure: default verifier (BET-152 / ADR-4 TOFU)
// ---------------------------------------------------------------------------

test("createDefaultVerifier: throws without a store (no dev-open fallback)", () => {
  assert.throws(() => createDefaultVerifier(), /store required/);
});

test("createDefaultVerifier: first dial-out registers + accepts; same token re-accepts", () => {
  const store = openStore();
  const v = createDefaultVerifier({ store, warn: silent, log: silent });

  // First sight: row created, accepted.
  assert.equal(v({ boxId: BOX_A, token: TOKEN_A }), true);
  const cred = store.getBoxCredential(BOX_A);
  assert.ok(cred, "credential row persisted on first sight");
  assert.equal(cred.token_hash, hashToken(TOKEN_A), "stored hash is sha256(token)");

  // Re-present the same pair: still accepted, no second row, same hash.
  assert.equal(v({ boxId: BOX_A, token: TOKEN_A }), true);
  assert.equal(store.getBoxCredential(BOX_A).token_hash, hashToken(TOKEN_A));
  store.close();
});

test("createDefaultVerifier: wrong token for a known box rejects; store row untouched", () => {
  const store = openStore();
  const v = createDefaultVerifier({ store, warn: silent, log: silent });

  assert.equal(v({ boxId: BOX_A, token: TOKEN_A }), true, "register");
  const originalHash = store.getBoxCredential(BOX_A).token_hash;

  assert.equal(v({ boxId: BOX_A, token: TOKEN_B }), false, "wrong token rejected");
  assert.equal(
    store.getBoxCredential(BOX_A).token_hash,
    originalHash,
    "stored credential NOT rotated by a wrong-token attempt",
  );
  store.close();
});

test("createDefaultVerifier: malformed handshake rejects BEFORE any row is created", () => {
  const store = openStore();
  const v = createDefaultVerifier({ store, warn: silent, log: silent });

  // Malformed shapes must reject AND must not register anything.
  assert.equal(v({ boxId: "not-hex", token: TOKEN_A }), false);
  assert.equal(v({ boxId: BOX_A, token: "not-hex" }), false);
  // The valid-shape box row is untouched (none created, none modified).
  assert.equal(store.getBoxCredential(BOX_A), null, "no row created from a malformed handshake");
  store.close();
});

// ---------------------------------------------------------------------------
// pure: wsTransport adapter
// ---------------------------------------------------------------------------

test("wsTransport.send encodes frame objects and forwards strings; swallows encode errors", () => {
  const sent = [];
  const errors = [];
  const fakeWs = { send: (raw) => sent.push(raw), on() {}, close() {} };
  const t = wsTransport(fakeWs, { onError: (e) => errors.push(e) });
  t.send({ type: FRAME_TYPES.PONG, id: 1 });
  assert.equal(decodeFrame(sent[0]).type, FRAME_TYPES.PONG);
  t.send("already-a-string");
  assert.equal(sent[1], "already-a-string");
  // An invalid frame object fails encodeFrame → reported, not thrown.
  t.send({ type: "bogus" });
  assert.equal(errors.length, 1);
});

// ---------------------------------------------------------------------------
// integration: real loopback ws server, real box client sockets
// ---------------------------------------------------------------------------

// Build a relay on an ephemeral port with an in-memory store and the default
// (store-backed) verifier. Returns { relay, store, url } and registers teardown.
async function makeRelay(t, { verifyBox, store: injectedStore } = {}) {
  const store = injectedStore || openStore(); // in-memory
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address();
  const relay = createRelayServer({
    wss,
    store,
    verifyBox: verifyBox || createDefaultVerifier({ store, warn: silent, log: silent }),
    log: silent,
    warn: silent,
  });
  t.after(async () => {
    await relay.close(); // detaches listener + closes store (injected-wss path)
    await new Promise((r) => wss.close(() => r())); // we own the wss → we close it
  });
  return { relay, store, url: `ws://127.0.0.1:${port}` };
}

// Open a box client socket; resolve on open, reject on early close/error.
function connectBox(url, { boxId, token, headers } = {}) {
  const qs = new URLSearchParams();
  if (boxId) qs.set("box_id", boxId);
  if (token) qs.set("token", token);
  const full = `${url}/box?${qs.toString()}`;
  const ws = new WebSocket(full, { headers });
  return ws;
}

// Wait for a ws event once, with a timeout guard so a hung test fails loudly.
function once(ws, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    ws.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

test("authenticated box registers in RoutingTable + persists an online box row", async (t) => {
  const { relay, store, url } = await makeRelay(t);
  const ws = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws, "open");

  // Give the server 'connection' handler a tick to run acceptBox.
  await waitFor(() => relay.routing.has(BOX_A));

  assert.equal(relay.routing.has(BOX_A), true, "registered in RoutingTable");
  const box = store.getBox(BOX_A);
  assert.ok(box, "box row persisted");
  assert.equal(box.status, BOX_STATUS.ONLINE);

  ws.close();
  await once(ws, "close");
});

test("bad-token handshake is rejected: socket closed, no registration, no box row", async (t) => {
  // Pre-seed the store so BOX_A is a KNOWN box (its credential is hash(TOKEN_A))
  // — a wrong-token dial-out must be rejected AND not allowed to re-register.
  const store = openStore();
  store.setBoxCredential(BOX_A, hashToken(TOKEN_A));
  const { relay, url } = await makeRelay(t, { store });

  const ws = connectBox(url, { boxId: BOX_A, token: TOKEN_B }); // wrong token
  const [code] = await once(ws, "close");
  assert.equal(code, 4401, "closed with unauthorized app code");
  assert.equal(relay.routing.has(BOX_A), false, "never registered");
  assert.equal(store.getBox(BOX_A), null, "no box row persisted");
});

test("malformed handshake (missing box_id) is rejected without registration", async (t) => {
  const { relay, url } = await makeRelay(t);
  const ws = connectBox(url, { token: TOKEN_A }); // no box_id
  const [code] = await once(ws, "close");
  assert.equal(code, 4401);
  assert.equal(relay.routing.size, 0);
});

test("close unregisters the box + marks it offline with a fresh last_seen", async (t) => {
  const { relay, store, url } = await makeRelay(t);
  const ws = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws, "open");
  await waitFor(() => relay.routing.has(BOX_A));
  const seenWhileOnline = store.getBox(BOX_A).last_seen;

  ws.close();
  await once(ws, "close");
  await waitFor(() => !relay.routing.has(BOX_A));

  assert.equal(relay.routing.has(BOX_A), false, "unregistered on close");
  const box = store.getBox(BOX_A);
  assert.equal(box.status, BOX_STATUS.OFFLINE);
  assert.ok(box.last_seen >= seenWhileOnline, "last_seen bumped on disconnect");
});

test("relay answers a PING frame with a matching PONG", async (t) => {
  const { url } = await makeRelay(t);
  const ws = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws, "open");
  ws.send(encodeFrame({ type: FRAME_TYPES.PING, id: 7 }));
  const [data] = await once(ws, "message");
  const frame = decodeFrame(data);
  assert.equal(frame.type, FRAME_TYPES.PONG);
  assert.equal(frame.id, 7);
  ws.close();
  await once(ws, "close");
});

test("a box reconnecting evicts its stale socket (single live socket per box)", async (t) => {
  const { relay, url } = await makeRelay(t);
  const ws1 = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws1, "open");
  await waitFor(() => relay.routing.has(BOX_A));

  const ws2 = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws2, "open");
  // The re-register evicts + closes ws1's server side → ws1 receives a close.
  await once(ws1, "close");
  await waitFor(() => relay.routing.has(BOX_A));
  assert.equal(relay.routing.size, 1, "still exactly one live box");

  ws2.close();
  await once(ws2, "close");
});

test("box_id header form authenticates (non-query client)", async (t) => {
  const { relay, url } = await makeRelay(t);
  const ws = new WebSocket(`${url}/box`, {
    headers: { "x-box-id": BOX_A, authorization: `Bearer ${TOKEN_A}` },
  });
  await once(ws, "open");
  await waitFor(() => relay.routing.has(BOX_A));
  assert.equal(relay.routing.has(BOX_A), true);
  ws.close();
  await once(ws, "close");
});

test("DEFAULT_RELAY_PORT is the bui 20xxx-block port", () => {
  assert.equal(DEFAULT_RELAY_PORT, 20787);
});

// ---------------------------------------------------------------------------
// streamRequest — phone→box STREAM_* proxy (BET-156 §3, SSE/PTY plumbing)
// ---------------------------------------------------------------------------

// A fake box client that auto-replies to STREAM_OPEN (request form) with a
// canned head + DATA + END sequence. Lets us drive streamRequest end-to-end
// over a real WebSocket pair without standing up the agent.
function installAutoStreamBox(ws, { chunks = [], reason = null, status = 200, headers = {} } = {}) {
  ws.on("message", (data) => {
    const f = decodeFrame(data);
    if (!f || f.type !== FRAME_TYPES.STREAM_OPEN) return;
    if (typeof f.method !== "string") return; // ignore response-form opens (relay never sends them)
    // Send the response head, then chunks, then end (or abort).
    ws.send(encodeFrame({
      type: FRAME_TYPES.STREAM_OPEN,
      id: f.id,
      stream: f.stream,
      status,
      headers,
    }));
    for (const c of chunks) {
      ws.send(encodeFrame({
        type: FRAME_TYPES.STREAM_DATA,
        id: f.id,
        stream: f.stream,
        data: c,
      }));
    }
    if (reason != null) {
      ws.send(encodeFrame({
        type: FRAME_TYPES.STREAM_ABORT,
        id: f.id,
        stream: f.stream,
        reason,
      }));
    } else {
      ws.send(encodeFrame({
        type: FRAME_TYPES.STREAM_END,
        id: f.id,
        stream: f.stream,
      }));
    }
  });
}

test("streamRequest: relays a box-side stream OPEN→DATA×n→END in order to the caller", async (t) => {
  const { relay, url } = await makeRelay(t);
  const ws = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws, "open");
  await waitFor(() => relay.routing.has(BOX_A));
  installAutoStreamBox(ws, {
    chunks: ["data: hello\n\n", "data: world\n\n"],
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  // Drive the stream request synchronously — the callbacks fire async on the
  // inbound message path (WebSocket I/O runs on the libuv loop, not microtasks).
  const events = { head: null, data: [], end: null, abort: null };
  relay.streamRequest(BOX_A, { method: "GET", path: "/events" }, {
    onHead: (h) => { events.head = h; },
    onData: (t) => { events.data.push(t); },
    onEnd: () => { events.end = true; },
    onAbort: (r) => { events.abort = r; },
  });

  // Poll on a real timer until the full sequence has arrived. waitFor uses
  // setTimeout (libuv), which interleaves with the WS I/O — Promise.resolve()
  // alone would not yield long enough for the I/O callbacks to fire.
  await waitFor(() => events.head && events.end, { timeoutMs: 2000 });
  // A tiny extra tick to capture any straggler events (the test asserts on
  // .end / .abort not firing too).
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(events.head, "onHead fired");
  assert.equal(events.head.status, 200);
  assert.equal(events.head.headers["content-type"], "text/event-stream");
  assert.deepEqual(events.data, ["data: hello\n\n", "data: world\n\n"], "chunks preserved in order");
  assert.equal(events.end, true, "onEnd fired");
  assert.equal(events.abort, null, "no abort");

  ws.close();
  await once(ws, "close");
});

test("streamRequest: relays a box-side STREAM_ABORT as onAbort(reason)", async (t) => {
  const { relay, url } = await makeRelay(t);
  const ws = connectBox(url, { boxId: BOX_A, token: TOKEN_A });
  await once(ws, "open");
  await waitFor(() => relay.routing.has(BOX_A));
  installAutoStreamBox(ws, { chunks: ["partial "], reason: "box exploded" });

  const events = { head: null, data: [], end: null, abort: null };
  relay.streamRequest(BOX_A, { method: "GET", path: "/events" }, {
    onHead: (h) => { events.head = h; },
    onData: (t) => { events.data.push(t); },
    onEnd: () => { events.end = true; },
    onAbort: (r) => { events.abort = r; },
  });
  await waitFor(() => events.head && events.abort, { timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(events.head, "onHead fired even on abort (the head frame arrived first)");
  assert.deepEqual(events.data, ["partial "], "data frame before the abort is preserved");
  assert.equal(events.abort, "box exploded", "onAbort(reason) fired");
  assert.equal(events.end, null, "onEnd did NOT fire");

  ws.close();
  await once(ws, "close");
});

test("streamRequest: no live tunnel → onAbort fires synchronously, no wire activity", async (t) => {
  const { relay, url: _ } = await makeRelay(t);
  // Deliberately do NOT connect a box. routing.has(BOX_A) === false.
  let abortCalled = null;
  const handle = relay.streamRequest(BOX_A, { method: "GET", path: "/events" }, {
    onHead: () => { throw new Error("onHead should not fire without a tunnel"); },
    onData: () => { throw new Error("onData should not fire without a tunnel"); },
    onEnd: () => { throw new Error("onEnd should not fire without a tunnel"); },
    onAbort: (r) => { abortCalled = r; },
  });
  assert.equal(abortCalled, "no_tunnel", "synchronous onAbort('no_tunnel')");
  assert.equal(handle.streamId, -1, "no stream id assigned");
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Poll a predicate until true or timeout (the server-side 'connection' handler
// runs on a later tick than the client 'open' event).
async function waitFor(pred, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!pred()) throw new Error("waitFor: predicate never became true");
}
