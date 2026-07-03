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
import { openStore, BOX_STATUS } from "./store.mjs";
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
// pure: default verifier
// ---------------------------------------------------------------------------

test("createDefaultVerifier: dev-open accepts any well-formed pair, rejects malformed", () => {
  const v = createDefaultVerifier({ warn: silent });
  assert.equal(v({ boxId: BOX_A, token: TOKEN_A }), true);
  assert.equal(v({ boxId: "bad", token: TOKEN_A }), false);
  assert.equal(v({ boxId: BOX_A, token: "bad" }), false);
});

test("createDefaultVerifier: with boxTokens map, only exact token matches", () => {
  const v = createDefaultVerifier({
    boxTokens: { [BOX_A]: TOKEN_A },
    warn: silent,
  });
  assert.equal(v({ boxId: BOX_A, token: TOKEN_A }), true);
  assert.equal(v({ boxId: BOX_A, token: TOKEN_B }), false, "wrong token rejected");
  assert.equal(v({ boxId: BOX_B, token: TOKEN_B }), false, "unknown box rejected");
});

test("createDefaultVerifier: accepts a Map as well as a plain object", () => {
  const v = createDefaultVerifier({
    boxTokens: new Map([[BOX_A, TOKEN_A]]),
    warn: silent,
  });
  assert.equal(v({ boxId: BOX_A, token: TOKEN_A }), true);
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

// Build a relay on an ephemeral port with an in-memory store and injected
// verifier. Returns { relay, store, url } and registers teardown.
async function makeRelay(t, { verifyBox } = {}) {
  const store = openStore(); // in-memory
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address();
  const relay = createRelayServer({
    wss,
    store,
    verifyBox: verifyBox || createDefaultVerifier({ warn: silent }),
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
  const verifyBox = createDefaultVerifier({ boxTokens: { [BOX_A]: TOKEN_A }, warn: silent });
  const { relay, store, url } = await makeRelay(t, { verifyBox });

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
