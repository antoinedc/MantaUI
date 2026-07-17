import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRelayAgent,
  createBackoff,
  makeDefaultLocalFetch,
  makeDefaultLocalFetchStream,
  shouldStartRelayAgent,
  DEFAULT_RELAY_URL,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "./index.mjs";
import {
  encodeFrame,
  decodeFrame,
  FRAME_TYPES,
  createFakeTransport,
} from "../protocol.mjs";

// Reference re-implementation of src/shared/net/backoff.ts ExponentialBackoff.
// The canonical class is TypeScript compiled only into the renderer/main
// bundles; a node:test `.mjs` cannot import a `.ts` module at runtime (same
// reason protocol.mjs/index.mjs stay pure `.mjs`). So we pin the `.mjs` mirror's
// parity against this byte-for-byte transcription of the TS formula
// (`base * factor ** attempt`, capped at `max`, full-jitter = `rng()*capped`).
// If backoff.ts changes, THIS reference and the mirror must both change — the
// parity test below fails loudly otherwise.
class ExponentialBackoff {
  constructor({ base, max, factor = 2, jitter = true, rng = Math.random }) {
    this.base = base;
    this.max = max;
    this.factor = factor;
    this.jitter = jitter;
    this.rng = rng;
    this._attempt = 0;
  }
  next() {
    const computed = this.base * Math.pow(this.factor, this._attempt);
    const capped = Math.min(computed, this.max);
    this._attempt += 1;
    return this.jitter ? this.rng() * capped : capped;
  }
  reset() {
    this._attempt = 0;
  }
  attempt() {
    return this._attempt;
  }
}

const BOX_ID = "0123456789abcdef0123456789abcdef"; // 32 hex
const BOX_TOKEN = "11112222333344445555666677778888";
const AUTH = { box_id: BOX_ID, box_token: BOX_TOKEN };

const silent = () => {};

// ---------------------------------------------------------------------------
// A fake relay endpoint. Each call to `connect` records the handshake and
// returns the box-side end of a fresh in-memory transport pair; the relay side
// is exposed so a test can send frames to the client and read what it sent back.
// ---------------------------------------------------------------------------
function makeFakeRelay({ failFirst = 0 } = {}) {
  const handshakes = []; // { url, headers }
  const links = []; // { relaySide, boxSide, sent: [], recv: [] }
  let failuresLeft = failFirst;

  async function connect(url, { headers } = {}) {
    handshakes.push({ url, headers });
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("dial-out refused (fake)");
    }
    const { a: boxSide, b: relaySide } = createFakeTransport();
    // The transport contract (see relay wsTransport / the client's defaultConnect)
    // is: send() accepts an already-encoded string OR a frame object it encodes.
    // The raw fake endpoint only forwards bytes, so wrap it to honor the same
    // contract the real ws adapter provides.
    const boxTransport = {
      send(frame) {
        boxSide.send(typeof frame === "string" ? frame : encodeFrame(frame));
      },
      onMessage(cb) {
        boxSide.onMessage(cb);
      },
      onClose(cb) {
        boxSide.onClose(cb);
      },
      close() {
        boxSide.close();
      },
    };
    const link = { relaySide, boxSide, sent: [], recv: [] };
    // Record everything the client (boxTransport) sends to the relay (relaySide).
    relaySide.onMessage((raw) => link.recv.push(decodeFrame(raw)));
    links.push(link);
    return boxTransport;
  }

  return {
    connect,
    handshakes,
    links,
    lastLink: () => links[links.length - 1],
    // Push a frame FROM the relay TO the client over the newest link.
    sendToClient(frame) {
      this.lastLink().relaySide.send(encodeFrame(frame));
    },
    // Frames the client sent back to the relay over the newest link.
    clientSent() {
      return this.lastLink().recv;
    },
    // Drop the newest link (simulate the relay/tunnel closing).
    dropLink() {
      this.lastLink().relaySide.close();
    },
  };
}

// A manual clock so reconnect delays are deterministic (no real sleeps).
function makeClock() {
  let seq = 1;
  const timers = new Map(); // handle -> { fn, ms }
  return {
    setTimer(fn, ms) {
      const h = seq++;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimer(h) {
      timers.delete(h);
    },
    // Fire every currently-pending timer once (FIFO), returning their delays.
    flush() {
      const fired = [];
      for (const [h, { fn, ms }] of [...timers]) {
        timers.delete(h);
        fired.push(ms);
        fn();
      }
      return fired;
    },
    pendingCount() {
      return timers.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Test-fixture helpers (BET-155 — dedupe)
//
// makeStubAgent — the canonical agent-fixture setup used by almost every test
// below: a fake relay endpoint, a manual clock, and an agent wired to both
// with silent log/warn. The duplication-gate flagged this 8-line setup as a
// 12+ line intra-file clone repeated across many tests; folding it into a
// helper drops each test back to a 3-line setup and removes the clone.
//
// Tests that need to override a knob (`backoff`, `localFetch`, `failFirst`)
// pass it through `opts`; everything else stays identical so a reader
// scanning tests sees the SAME shape in every "agent does X" test. `failFirst`
// is a first-class key (passed to makeFakeRelay) because that's how the
// reconnect tests have always described the dial-failure contract.
//
// captureFetchHeaders — wraps `body()` with a stubbed global fetch that
// captures the `init?.headers` of every outbound call, then restores the
// real fetch in a `finally` so a thrown assertion can't leak the stub to
// sibling tests. The two makeDefaultLocalFetch tests use it; the 8-line
// stub/restore preamble was an intra-file clone of itself.
function makeStubAgent(opts = {}) {
  const { failFirst, ...agentOpts } = opts;
  const relay = makeFakeRelay(
    failFirst != null ? { failFirst } : undefined,
  );
  const clock = makeClock();
  const agent = createRelayAgent({
    auth: AUTH,
    connect: relay.connect,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: silent,
    warn: silent,
    ...agentOpts,
  });
  return { relay, clock, agent };
}

async function captureFetchHeaders(body) {
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init?.headers });
    return {
      status: 200,
      headers: new Map(),
      text: async () => "",
    };
  };
  try {
    return { seen, result: await body() };
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---------------------------------------------------------------------------
// pure: config surface + backoff parity
// ---------------------------------------------------------------------------

test("DEFAULT_RELAY_URL is the dev relay wss endpoint", () => {
  assert.equal(DEFAULT_RELAY_URL, "wss://relay.mantaui.com");
});

test("backoff mirror matches ExponentialBackoff semantics (no jitter, capped growth)", () => {
  const mirror = createBackoff({
    base: RECONNECT_BASE_MS,
    max: RECONNECT_MAX_MS,
    jitter: false,
  });
  const canonical = new ExponentialBackoff({
    base: RECONNECT_BASE_MS,
    max: RECONNECT_MAX_MS,
    jitter: false,
  });
  // Walk enough attempts to hit the cap; both must agree step-for-step.
  for (let i = 0; i < 8; i++) {
    assert.equal(
      mirror.next(),
      canonical.next(),
      `attempt ${i} delay must match ExponentialBackoff`,
    );
  }
  assert.equal(mirror.attempt(), canonical.attempt());
  mirror.reset();
  canonical.reset();
  assert.equal(mirror.next(), canonical.next(), "reset resets both to attempt 0");
});

test("backoff mirror full-jitter stays within [0, capped] and uses injected rng", () => {
  const b = createBackoff({ base: 1000, max: 30000, jitter: true, rng: () => 0.5 });
  assert.equal(b.next(), 500, "attempt 0: 0.5 * min(1000, 30000)");
  assert.equal(b.next(), 1000, "attempt 1: 0.5 * min(2000, 30000)");
});

// ---------------------------------------------------------------------------
// dial-out + authentication
// ---------------------------------------------------------------------------

test("dials out and authenticates with the box_id + box_token handshake", async () => {
  const { relay, clock, agent } = makeStubAgent();

  await agent.start();

  assert.equal(agent.isConnected(), true, "connected after start");
  assert.equal(relay.handshakes.length, 1, "dialed out exactly once");
  const { url, headers } = relay.handshakes[0];
  assert.match(url, /\/box$/, "connects to the relay /box path");
  assert.equal(headers.authorization, `Bearer ${BOX_TOKEN}`, "presents the box_token");
  assert.equal(headers["x-box-id"], BOX_ID, "presents the box_id");

  agent.stop();
  assert.equal(clock.pendingCount(), 0, "no timers left after stop");
});

test("rejects construction without a valid box identity", () => {
  assert.throws(
    () => createRelayAgent({ auth: { box_id: "bad", box_token: BOX_TOKEN } }),
    /valid.*box_id.*box_token/i,
  );
});

// ---------------------------------------------------------------------------
// reconnect with backoff (never gives up)
// ---------------------------------------------------------------------------

test("reconnects with increasing backoff on repeated dial failures and never gives up", async () => {
  // The first 3 dial attempts fail; the 4th succeeds. Backoff must be armed
  // after each failure with a strictly non-decreasing (growing) delay, and the
  // loop must never stop retrying on its own.
  // Deterministic delays: no jitter so growth is observable.
  const backoff = createBackoff({ base: 100, max: 10000, jitter: false });
  const { relay, clock, agent } = makeStubAgent({ failFirst: 3, backoff });

  await agent.start(); // attempt 1 → fails, arms a reconnect timer
  assert.equal(agent.isConnected(), false);
  assert.equal(clock.pendingCount(), 1, "a reconnect is armed after the 1st failure");

  const delays = [];
  // Fire timers until connected — each flush runs the next attempt.
  for (let i = 0; i < 5 && !agent.isConnected(); i++) {
    const fired = clock.flush();
    delays.push(...fired);
    // give the async openOnce() a microtask to settle
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.equal(agent.isConnected(), true, "eventually connects after retries");
  assert.equal(relay.handshakes.length, 4, "4 dial attempts (3 fail + 1 success)");
  // The scheduled delays for attempts 2,3,4 must be strictly increasing
  // (100, 200, 400 for base 100, factor 2, no jitter).
  assert.deepEqual(delays.slice(0, 3), [100, 200, 400], "exponential growth");

  agent.stop();
  assert.equal(clock.pendingCount(), 0, "no timers left after stop");
});

test("a drop after a successful connect triggers reconnect (tunnel resurrection)", async () => {
  const backoff = createBackoff({ base: 50, max: 1000, jitter: false });
  const { relay, clock, agent } = makeStubAgent({ backoff });

  await agent.start();
  assert.equal(agent.isConnected(), true);

  relay.dropLink(); // relay/tunnel closes → client sees onClose
  await Promise.resolve();
  assert.equal(agent.isConnected(), false, "disconnected after drop");
  assert.equal(clock.pendingCount(), 1, "reconnect armed after drop");

  clock.flush();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(agent.isConnected(), true, "reconnected after drop");
  assert.equal(relay.handshakes.length, 2, "dialed out again");

  agent.stop();
  assert.equal(clock.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// request proxy: relay→box REQUEST → local fetch → RESPONSE back over tunnel
// ---------------------------------------------------------------------------

test("proxies a relay REQUEST to the local box server and streams the RESPONSE back", async () => {
  const localCalls = [];
  const localFetch = async (req) => {
    localCalls.push(req);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects: ["p1", "p2"] }),
    };
  };
  const { relay, clock, agent } = makeStubAgent({ localFetch });

  await agent.start();

  // The relay forwards a metadata GET down the tunnel.
  relay.sendToClient({
    type: FRAME_TYPES.REQUEST,
    id: 42,
    method: "GET",
    path: "/api/projects",
  });
  // Let the async proxy (localFetch + send) settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // The local box server was called with the request details.
  assert.equal(localCalls.length, 1, "local box server called once");
  assert.equal(localCalls[0].method, "GET");
  assert.equal(localCalls[0].path, "/api/projects");

  // A correlated RESPONSE frame streamed back to the relay.
  const sent = relay.clientSent();
  const resp = sent.find((f) => f && f.type === FRAME_TYPES.RESPONSE);
  assert.ok(resp, "a RESPONSE frame was sent back");
  assert.equal(resp.id, 42, "response id echoes the request id");
  assert.equal(resp.status, 200);
  assert.deepEqual(JSON.parse(resp.body), { projects: ["p1", "p2"] });

  agent.stop();
  assert.equal(clock.pendingCount(), 0);
});

test("a failing local fetch replies with a correlated ERROR frame, not a hang", async () => {
  const localFetch = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8787");
  };
  const { relay, agent } = makeStubAgent({ localFetch });

  await agent.start();
  relay.sendToClient({
    type: FRAME_TYPES.REQUEST,
    id: 7,
    method: "GET",
    path: "/api/projects",
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const err = relay.clientSent().find((f) => f && f.type === FRAME_TYPES.ERROR);
  assert.ok(err, "an ERROR frame was sent back");
  assert.equal(err.id, 7, "error correlates the request id");
  assert.equal(err.code, "local_fetch_failed");

  agent.stop();
});

test("answers a relay PING with a correlated PONG", async () => {
  const { relay, agent } = makeStubAgent();
  await agent.start();

  relay.sendToClient({ type: FRAME_TYPES.PING, id: 99 });
  await Promise.resolve();

  const pong = relay.clientSent().find((f) => f && f.type === FRAME_TYPES.PONG);
  assert.ok(pong, "a PONG was sent");
  assert.equal(pong.id, 99, "pong echoes the ping id");

  agent.stop();
});

// ---------------------------------------------------------------------------
// clean teardown
// ---------------------------------------------------------------------------

test("stop() leaves no open sockets or timers (clean teardown)", async () => {
  const { relay, clock, agent } = makeStubAgent();
  await agent.start();
  assert.equal(agent.isConnected(), true);

  agent.stop();

  assert.equal(agent.isConnected(), false, "transport released");
  assert.equal(clock.pendingCount(), 0, "no timers pending");
  // The box-side transport's underlying state is closed → a further relay send
  // reaches nobody and the client never re-arms a reconnect after stop().
  relay.dropLink();
  await Promise.resolve();
  assert.equal(clock.pendingCount(), 0, "stop() is permanent: no reconnect after a post-stop drop");
});

test("stop() during an in-flight dial does not connect afterwards", async () => {
  // Make connect hang until we release it, then stop() before it resolves.
  let release;
  const gate = new Promise((r) => (release = r));
  let closed = false;
  const connect = async () => {
    await gate;
    return {
      send() {},
      onMessage() {},
      onClose() {},
      close() {
        closed = true;
      },
    };
  };
  const { agent, clock } = makeStubAgent({ connect });

  const startP = agent.start();
  agent.stop(); // stop while the dial is still pending
  release();
  await startP;
  await Promise.resolve();

  assert.equal(agent.isConnected(), false, "never adopts a socket opened after stop");
  assert.equal(closed, true, "the raced-open socket is closed");
  assert.equal(clock.pendingCount(), 0);
});

// ---------------------------------------------------------------------------
// shouldStartRelayAgent — ADR-1 config decision (BET-155)
// ---------------------------------------------------------------------------

test("shouldStartRelayAgent defaults to true (relay-first product default)", () => {
  assert.equal(shouldStartRelayAgent(undefined), true);
  assert.equal(shouldStartRelayAgent(null), true);
  assert.equal(shouldStartRelayAgent({}), true);
  assert.equal(shouldStartRelayAgent({ relayEnabled: undefined }), true);
});

test("shouldStartRelayAgent returns true for relayEnabled=true", () => {
  assert.equal(shouldStartRelayAgent({ relayEnabled: true }), true);
});

test("shouldStartRelayAgent returns false ONLY for relayEnabled=false (opt-out)", () => {
  assert.equal(shouldStartRelayAgent({ relayEnabled: false }), false);
});

test("shouldStartRelayAgent treats truthy non-booleans as enabled (no over-engineering)", () => {
  // The only way to opt out is the literal boolean `false`. Anything else
  // (a stray "no", 0 wrapped in JSON's quirks, a stale schema) keeps the
  // relay on — re-enabling is one config flip away, and a silent "no" would
  // be invisible to the operator.
  assert.equal(shouldStartRelayAgent({ relayEnabled: "no" }), true);
  assert.equal(shouldStartRelayAgent({ relayEnabled: 0 }), true);
  assert.equal(shouldStartRelayAgent({ relayEnabled: "" }), true);
});

// ---------------------------------------------------------------------------
// makeDefaultLocalFetch — ADR-1 auth overwrite (BET-155)
// ---------------------------------------------------------------------------

test("makeDefaultLocalFetch overwrites a foreign Authorization header with the BOX bearer", async () => {
  // A foreign (account) token presented by the device / carried in frame.headers
  // must NOT be forwarded to 127.0.0.1:8787. The box server authenticates every
  // request with its own box_token, so the agent installs that bearer no matter
  // what the inbound value was.
  const { seen } = await captureFetchHeaders(async () => {
    const localFetch = makeDefaultLocalFetch("http://127.0.0.1:8787", AUTH);
    await localFetch({
      method: "GET",
      path: "/api/projects",
      headers: { authorization: "Bearer account-token-from-device" },
      body: undefined,
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].headers.authorization,
    `Bearer ${BOX_TOKEN}`,
    "Authorization is the BOX token, not the foreign account token",
  );
});

test("makeDefaultLocalFetch is case-insensitive about the Authorization key", async () => {
  // HTTP headers are case-insensitive; "Authorization", "authorization", and
  // "AUTHORIZATION" are the same header name. A client that capitalized the
  // key differently must still lose the inbound value to the BOX bearer.
  const { seen } = await captureFetchHeaders(async () => {
    const localFetch = makeDefaultLocalFetch("http://127.0.0.1:8787", AUTH);
    for (const variant of ["Authorization", "authorization", "AUTHORIZATION", "AuThOrIzAtIoN"]) {
      await localFetch({
        method: "GET",
        path: "/x",
        headers: { [variant]: "Bearer leaked-token" },
        body: undefined,
      });
    }
  });
  assert.equal(seen.length, 4);
  for (const { headers } of seen) {
    assert.equal(
      headers.authorization,
      `Bearer ${BOX_TOKEN}`,
      "every variant must collapse to the BOX bearer (lowercase key)",
    );
    // No stale "Authorization"/"AUTHORIZATION" key with the foreign value.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "authorization" && k !== "authorization") {
        assert.fail(`foreign key "${k}" survived in outbound headers`);
      }
    }
  }
});

test("makeDefaultLocalFetch installs the BOX bearer when no Authorization was inbound", async () => {
  const { seen } = await captureFetchHeaders(async () => {
    const localFetch = makeDefaultLocalFetch("http://127.0.0.1:8787", AUTH);
    await localFetch({
      method: "GET",
      path: "/api/projects",
      headers: { "x-device-id": "phone-1", accept: "application/json" },
      body: undefined,
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${BOX_TOKEN}`);
  // Unrelated headers pass through unchanged (and keep their original case).
  assert.equal(seen[0].headers["x-device-id"], "phone-1");
  assert.equal(seen[0].headers.accept, "application/json");
});

test("makeDefaultLocalFetch preserves unrelated headers when overwriting auth", async () => {
  const { seen } = await captureFetchHeaders(async () => {
    const localFetch = makeDefaultLocalFetch("http://127.0.0.1:8787", AUTH);
    await localFetch({
      method: "GET",
      path: "/x",
      headers: {
        authorization: "Bearer stale-device-token",
        "x-request-id": "abc-123",
        "x-forwarded-for": "1.2.3.4", // explicitly NOT a thing we strip; pass-through
        accept: "*/*",
      },
      body: undefined,
    });
  });
  assert.equal(seen.length, 1);
  const h = seen[0].headers;
  assert.equal(h.authorization, `Bearer ${BOX_TOKEN}`);
  assert.equal(h["x-request-id"], "abc-123");
  assert.equal(h["x-forwarded-for"], "1.2.3.4");
  assert.equal(h.accept, "*/*");
});

test("makeDefaultLocalFetch requires a valid box_token (never accepts a missing/foreign one)", () => {
  assert.throws(() => makeDefaultLocalFetch("http://127.0.0.1:8787", null), /box_token/);
  assert.throws(() => makeDefaultLocalFetch("http://127.0.0.1:8787", undefined), /box_token/);
  assert.throws(
    () => makeDefaultLocalFetch("http://127.0.0.1:8787", { box_id: BOX_ID, box_token: "bad" }),
    /box_token/,
  );
  assert.throws(() => makeDefaultLocalFetch("http://127.0.0.1:8787", {}), /box_token/);
});

test("the agent's default localFetch is the overwriting one (ADR-1 wired by default)", async () => {
  // End-to-end: drive a real REQUEST frame through the agent and verify the
  // outbound HTTP request to 127.0.0.1:8787 carries the BOX bearer, even
  // though the inbound frame carried a foreign "Authorization" header. This
  // is the contract install.sh + the box-server's auth gate rely on.
  const { relay, agent } = makeStubAgent();
  const { seen } = await captureFetchHeaders(async () => {
    await agent.start();
    relay.sendToClient({
      type: FRAME_TYPES.REQUEST,
      id: 1,
      method: "GET",
      path: "/api/projects",
      headers: {
        authorization: "Bearer attacker-supplied-token",
        "x-device-id": "phone-1",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    agent.stop();
  });

  assert.equal(seen.length, 1, "exactly one outbound call to the local box server");
  assert.match(
    String(seen[0].url ?? ""),
    /^http:\/\/127\.0\.0\.1:8787\/api\/projects$/,
    "URL is the local box server + the relay-forwarded path",
  );
  assert.equal(
    seen[0].headers.authorization,
    `Bearer ${BOX_TOKEN}`,
    "the outbound HTTP request carries the BOX bearer, NOT the foreign token",
  );
  // Unrelated headers still pass through (case preserved).
  assert.equal(seen[0].headers["x-device-id"], "phone-1");
});

// ---------------------------------------------------------------------------
// status() — coarse live-state snapshot for /relay/status (BET-155)
// ---------------------------------------------------------------------------

test("status() is \"stopped\" before start()", () => {
  const { agent } = makeStubAgent();
  assert.equal(agent.status(), "stopped");
});

test("status() is \"connected\" after a successful start()", async () => {
  const { agent } = makeStubAgent();
  await agent.start();
  assert.equal(agent.status(), "connected");
  agent.stop();
});

test("status() is \"connecting\" after a drop while the reconnect is armed", async () => {
  const { relay, agent } = makeStubAgent();
  await agent.start();
  relay.dropLink();
  await Promise.resolve();
  assert.equal(agent.status(), "connecting", "stays 'connecting' through the backoff window");
  agent.stop();
});

test("status() is \"stopped\" after stop() and ignores later drop events", async () => {
  const { relay, agent } = makeStubAgent();
  await agent.start();
  agent.stop();
  assert.equal(agent.status(), "stopped");
  // A late drop must not flip the state — stop() is permanent.
  relay.dropLink();
  await Promise.resolve();
  assert.equal(agent.status(), "stopped");
});

test("status() is \"connecting\" between a failed dial and the next attempt", async () => {
  // failFirst=1: first dial fails, the agent arms a reconnect; before the
  // next attempt fires the agent is neither connected nor stopped.
  const { agent } = makeStubAgent({ failFirst: 1 });
  await agent.start(); // attempt 1 fails → reconnect armed
  assert.equal(agent.status(), "connecting");
  agent.stop();
});

// ---------------------------------------------------------------------------
// SSE/PTY streaming path (BET-156 §3) — STREAM_OPEN (request form) is proxied
// to a streaming local fetch; the agent forwards the response head + body as
// STREAM_OPEN (response form) + STREAM_DATA + STREAM_END, preserving chunk
// boundaries so SSE bytes arrive at the phone as they leave the box.
// ---------------------------------------------------------------------------

// A minimal Response-shaped object that exposes `body` as a web ReadableStream
// the test can pump chunks into. Mirrors what node:fetch returns for an SSE
// response. enqueue() pushes a chunk; close() ends the stream.
function makeFakeStreamResponse({ status = 200, headers = {} } = {}) {
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  // jsdom + Node 18+: ReadableStream is global on Node 18+; if missing, we
  // surface a clearer error.
  return {
    response: {
      status,
      headers: new Map(Object.entries(headers)),
      body,
    },
    enqueue(chunk) {
      controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    },
    close() {
      try { controller.close(); } catch { /* already closed */ }
    },
    error(reason) {
      try { controller.error(reason); } catch { /* already closed */ }
    },
  };
}

test("agent turns an event-stream local response into OPEN→DATA×n→END frames preserving chunk boundaries", async () => {
  // The relay sends a STREAM_OPEN (request form) down the tunnel. The agent
  // opens a streaming local fetch, gets back an SSE-style response, and
  // pumps the body chunk-by-chunk as STREAM_DATA frames preserving the
  // chunk boundaries (the relay's api side asserts res.write was called
  // once per DATA — the byte-ordering matches what the box server sent).
  const stream = makeFakeStreamResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
  const localFetchStream = async () => stream.response;

  const { relay, agent } = makeStubAgent({ localFetchStream });
  await agent.start();

  relay.sendToClient({
    type: FRAME_TYPES.STREAM_OPEN,
    id: 7,
    stream: "relay-stream-1",
    method: "GET",
    path: "/events?token=abc",
  });

  // Wait for STREAM_OPEN (response form) to be sent before pumping data.
  for (let i = 0; i < 20 && !relay.clientSent().some((f) => f && f.type === FRAME_TYPES.STREAM_OPEN && f.stream === "relay-stream-1"); i++) {
    await Promise.resolve();
  }
  // Pump three chunks in distinct boundary-preserving units.
  stream.enqueue("data: hello\n\n");
  // Let the agent read each chunk and send a STREAM_DATA frame.
  for (let i = 0; i < 20 && relay.clientSent().filter((f) => f && f.type === FRAME_TYPES.STREAM_DATA && f.stream === "relay-stream-1").length < 1; i++) {
    await Promise.resolve();
  }
  stream.enqueue("data: world\n\n");
  for (let i = 0; i < 20 && relay.clientSent().filter((f) => f && f.type === FRAME_TYPES.STREAM_DATA && f.stream === "relay-stream-1").length < 2; i++) {
    await Promise.resolve();
  }
  stream.enqueue("data: end\n\n");
  for (let i = 0; i < 20 && relay.clientSent().filter((f) => f && f.type === FRAME_TYPES.STREAM_DATA && f.stream === "relay-stream-1").length < 3; i++) {
    await Promise.resolve();
  }
  stream.close();
  // Wait for STREAM_END.
  for (let i = 0; i < 30 && !relay.clientSent().some((f) => f && f.type === FRAME_TYPES.STREAM_END && f.stream === "relay-stream-1"); i++) {
    await Promise.resolve();
  }

  const sent = relay.clientSent().filter((f) => f && f.stream === "relay-stream-1");
  // Sequence: OPEN, DATA, DATA, DATA, END — in order.
  assert.deepEqual(
    sent.map((f) => f.type),
    ["stream-open", "stream-data", "stream-data", "stream-data", "stream-end"],
    "frame sequence is OPEN→DATA×3→END",
  );
  // The response-side STREAM_OPEN carries the upstream status + headers
  // verbatim, so the relay's api side can writeHead(status, headers).
  const headFrame = sent[0];
  assert.equal(headFrame.id, 7, "response-side STREAM_OPEN echoes the request id");
  assert.equal(headFrame.stream, "relay-stream-1", "same stream id");
  assert.equal(headFrame.status, 200);
  assert.equal(headFrame.headers["content-type"], "text/event-stream");
  // Chunk boundaries: three DATA frames, each with its chunk's bytes.
  assert.deepEqual(
    sent.slice(1, -1).map((f) => f.data),
    ["data: hello\n\n", "data: world\n\n", "data: end\n\n"],
    "chunk boundaries preserved across STREAM_DATA frames",
  );

  agent.stop();
});

test("agent emits STREAM_ABORT when the streaming local fetch rejects", async () => {
  const localFetchStream = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:8787");
  };
  const { relay, agent } = makeStubAgent({ localFetchStream });
  await agent.start();

  relay.sendToClient({
    type: FRAME_TYPES.STREAM_OPEN,
    id: 9,
    stream: "relay-stream-err",
    method: "GET",
    path: "/events?token=x",
  });
  for (let i = 0; i < 30 && !relay.clientSent().some((f) => f && f.type === FRAME_TYPES.STREAM_ABORT && f.stream === "relay-stream-err"); i++) {
    await Promise.resolve();
  }

  const abort = relay.clientSent().find(
    (f) => f && f.type === FRAME_TYPES.STREAM_ABORT && f.stream === "relay-stream-err",
  );
  assert.ok(abort, "a STREAM_ABORT frame was sent back");
  assert.equal(abort.id, 9);
  assert.match(abort.reason, /ECONNREFUSED/);

  agent.stop();
});

test("agent ignores STREAM_OPEN in response form (no method) — protocol guard", async () => {
  // A response-form STREAM_OPEN arriving from the relay is a wire protocol
  // bug (the relay never sends response forms). The agent warns and drops
  // it instead of treating it as a request to open a local fetch.
  const localFetchStream = async () => {
    throw new Error("should not be called");
  };
  const { relay, agent } = makeStubAgent({ localFetchStream });
  await agent.start();

  relay.sendToClient({
    type: FRAME_TYPES.STREAM_OPEN,
    id: 11,
    stream: "ghost-stream",
    status: 200,
    headers: {},
  });
  await Promise.resolve();
  await Promise.resolve();

  const sent = relay.clientSent().filter((f) => f && f.stream === "ghost-stream");
  assert.equal(sent.length, 0, "no frames sent in response to a response-form STREAM_OPEN");

  agent.stop();
});

// ---------------------------------------------------------------------------
// makeDefaultLocalFetchStream — ADR-1 auth overwrite (mirrors localFetch test)
// ---------------------------------------------------------------------------

test("makeDefaultLocalFetchStream overwrites a foreign Authorization header with the BOX bearer", async () => {
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init?.headers });
    // The streaming path doesn't actually read body here — we just need the
    // fetch call to be exercised; the assertions are on headers + URL.
    return {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({ start(c) { c.close(); } }),
    };
  };
  try {
    const localFetchStream = makeDefaultLocalFetchStream("http://127.0.0.1:8787", AUTH);
    await localFetchStream({
      method: "GET",
      path: "/events?token=abc",
      headers: { authorization: "Bearer account-token-from-device" },
      body: undefined,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].headers.authorization,
    `Bearer ${BOX_TOKEN}`,
    "Authorization is the BOX token, not the foreign account token",
  );
});

test("makeDefaultLocalFetchStream requires a valid box_token (never accepts a missing/foreign one)", () => {
  assert.throws(() => makeDefaultLocalFetchStream("http://127.0.0.1:8787", null), /box_token/);
  assert.throws(() => makeDefaultLocalFetchStream("http://127.0.0.1:8787", undefined), /box_token/);
  assert.throws(
    () => makeDefaultLocalFetchStream("http://127.0.0.1:8787", { box_id: BOX_ID, box_token: "bad" }),
    /box_token/,
  );
});
