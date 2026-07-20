// server.test.mjs — full HTTP server integration tests.
//
// Spins up createGatewayServer() on an ephemeral port, drives every
// endpoint with real HTTP requests, and asserts the wire-level shape
// (status, body, headers, CORS). All I/O is injected — the store is an
// in-memory map, the DNS + APNs surfaces are fake senders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createGatewayServer, createRegisterRateLimiter } from "./index.mjs";

const VALID_BOX_ID = "abcdef0123456789abcdef0123456789";
const makeToken = (seed) => seed.padStart(32, "0").slice(-32);
const makeHexToken = (seed) => seed.padStart(64, "0").slice(-64);

// Helpers ------------------------------------------------------------------

function makeFetchImpl() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/refresh")) return { ok: true, status: 200, body: null };
    // record POST → return a synthetic id
    return { ok: true, status: 200, body: calls.length * 100 };
  };
  return { calls, fetchImpl };
}

async function buildServer({ store = {}, dns = makeFetchImpl(), apnsConfig = null, rateLimiter } = {}) {
  let liveStore = { ...store };
  const load = async () => ({ ...liveStore });
  const save = async (m) => { liveStore = { ...m }; };
  const { calls: dnsCalls, fetchImpl } = dns;
  const apnsCalls = [];
  const createDnsRecord = async (args) => {
    dnsCalls.push({ url: "createOrUpdate", init: { method: args.existingRecordId ? "PUT" : "POST" }, args });
    return { recordId: dnsCalls.length * 100, action: args.existingRecordId ? "update" : "create" };
  };
  const svc = createGatewayServer({
    port: 0,
    load,
    save,
    fetchImpl,
    createDnsRecord,
    apnsConfig,
    rateLimiter: rateLimiter ?? createRegisterRateLimiter(),
    log: () => {},
    warn: () => {},
  });
  const { host, port } = await svc.start();
  return {
    svc,
    host,
    port,
    dnsCalls,
    // A LIVE reference to the test's in-memory store — callers must read
    // `ctx.liveStore` at the moment they need the current value (don't
    // destructure — the snapshot would go stale once `save` updates it).
    get liveStore() { return liveStore; },
    apnsCalls,
  };
}

function postJson(port, path, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(opts, fn) {
  const ctx = await buildServer(opts);
  try {
    await fn(ctx);
  } finally {
    await ctx.svc.stop();
  }
}

// Tests --------------------------------------------------------------------

test("GET /healthz → 200 {ok:true}, no auth", async () => {
  await withServer({}, async ({ port }) => {
    const r = await getRequest(port, "/healthz");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    assert.match(r.headers["content-type"], /text\/plain/);
  });
});

test("unknown path → 404", async () => {
  await withServer({}, async ({ port }) => {
    const r = await getRequest(port, "/nope");
    assert.equal(r.status, 404);
  });
});

test("wrong method → 404", async () => {
  await withServer({}, async ({ port }) => {
    const r = await getRequest(port, "/register"); // GET on a POST route
    assert.equal(r.status, 404);
  });
});

test("POST /register (first time) → 200 {host, gateway_token} + DNS create", async () => {
  await withServer({}, async (ctx) => {
    const { port, dnsCalls } = ctx;
    const r = await postJson(
      port,
      "/register",
      { box_id: VALID_BOX_ID },
      { "x-forwarded-for": "9.9.9.9" },
    );
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.host, `${VALID_BOX_ID}.boxes.mantaui.com`);
    assert.match(j.gateway_token, /^[0-9a-f]{32}$/);
    assert.equal(dnsCalls.length, 1);
    assert.equal(dnsCalls[0].args.boxId, VALID_BOX_ID);
    assert.equal(dnsCalls[0].args.target, "9.9.9.9");
    assert.ok(ctx.liveStore[VALID_BOX_ID]);
    assert.equal(ctx.liveStore[VALID_BOX_ID].ip, "9.9.9.9");
  });
});

test("POST /register with invalid body → 400", async () => {
  await withServer({}, async ({ port }) => {
    const r = await postJson(port, "/register", { box_id: "XYZ" }, { "x-forwarded-for": "1.1.1.1" });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, "invalid_box_id");
  });
});

test("POST /register (re-register) with valid bearer + same IP → 200 host, no DNS", async () => {
  const token = makeToken("seed");
  const store = {
    [VALID_BOX_ID]: {
      gateway_token: token,
      ip: "9.9.9.9",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 1234,
    },
  };
  await withServer({ store }, async ({ port, dnsCalls }) => {
    const r = await postJson(
      port,
      "/register",
      { box_id: VALID_BOX_ID, __bearer: token }, // __bearer is unused over the wire; the Authorization header is what counts
      { authorization: `Bearer ${token}`, "x-forwarded-for": "9.9.9.9" },
    );
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).host, `${VALID_BOX_ID}.boxes.mantaui.com`);
    assert.equal(dnsCalls.length, 0);
  });
});

test("POST /register (re-register) with valid bearer + changed IP → DNS update", async () => {
  const token = makeToken("seed");
  const store = {
    [VALID_BOX_ID]: {
      gateway_token: token,
      ip: "1.1.1.1",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 1234,
    },
  };
  await withServer({ store }, async (ctx) => {
    const { port, dnsCalls } = ctx;
    const r = await postJson(
      port,
      "/register",
      { box_id: VALID_BOX_ID },
      { authorization: `Bearer ${token}`, "x-forwarded-for": "9.9.9.9" },
    );
    assert.equal(r.status, 200);
    assert.equal(dnsCalls.length, 1);
    assert.equal(dnsCalls[0].args.existingRecordId, 1234);
    assert.equal(dnsCalls[0].args.target, "9.9.9.9");
    assert.equal(ctx.liveStore[VALID_BOX_ID].ip, "9.9.9.9");
  });
});

test("POST /register with wrong bearer → 401", async () => {
  const store = {
    [VALID_BOX_ID]: {
      gateway_token: makeToken("right"),
      ip: "1.1.1.1",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 1,
    },
  };
  await withServer({ store }, async ({ port, dnsCalls }) => {
    const r = await postJson(
      port,
      "/register",
      { box_id: VALID_BOX_ID },
      { authorization: `Bearer ${makeToken("wrong")}`, "x-forwarded-for": "1.1.1.1" },
    );
    assert.equal(r.status, 401);
    assert.equal(dnsCalls.length, 0);
  });
});

test("POST /register rate limit → 429 on the 11th call from same IP", async () => {
  let count = 0;
  const rateLimiter = () => {
    count += 1;
    return count <= 10;
  };
  await withServer({ rateLimiter }, async (ctx) => {
    const { port, dnsCalls } = ctx;
    for (let i = 0; i < 10; i++) {
      // Use a UNIQUE box_id per call so each is a first-registration (no
      // bearer required). The limiter is the only gate we want to exercise.
      const bid = i.toString(16).padStart(32, "0");
      const r = await postJson(
        port,
        "/register",
        { box_id: bid },
        { "x-forwarded-for": "1.2.3.4" },
      );
      assert.equal(r.status, 200, `call ${i + 1} should succeed`);
    }
    const r = await postJson(
      port,
      "/register",
      { box_id: "f".repeat(32) },
      { "x-forwarded-for": "1.2.3.4" },
    );
    assert.equal(r.status, 429);
    // DNS was called 10 times (one per successful registration), not 11.
    assert.equal(dnsCalls.length, 10);
  });
});

test("POST /push without auth → 401", async () => {
  await withServer({ apnsConfig: { teamId: "t", keyId: "k", p8Path: "/d", bundleId: "b" } }, async ({ port }) => {
    const r = await postJson(
      port,
      "/push",
      { box_id: VALID_BOX_ID, tokens: [makeHexToken("a")], payload: { title: "T", body: "B" } },
    );
    assert.equal(r.status, 401);
  });
});

test("POST /push auth + tokens → 200 {results:[{token, ok, prune}]}", async () => {
  const token = makeToken("good");
  const store = {
    [VALID_BOX_ID]: {
      gateway_token: token,
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 1,
    },
  };
  await withServer(
    { store, apnsConfig: { teamId: "t", keyId: "k", p8Path: "/d", bundleId: "b" } },
    async ({ port }) => {
      const r = await postJson(
        port,
        "/push",
        {
          box_id: VALID_BOX_ID,
          tokens: [makeHexToken("a"), makeHexToken("b")],
          payload: { title: "T", body: "B" },
        },
        { authorization: `Bearer ${token}` },
      );
      // Note: this test passes a bogus p8Path ("/d") to apnsConfig, so the
      // APNs JWT signing fails on every send. Each token therefore resolves
      // to { ok: false, prune: false } from sendApns (the catch path). What
      // we care about here is that the AUTH + shape are correct: 200 with
      // one result per token. The proper APNs round-trip (200 + 410 prune)
      // is covered in src/gateway/apns.test.mjs.
      assert.equal(r.status, 200);
      const j = JSON.parse(r.body);
      assert.equal(j.results.length, 2);
      assert.equal(typeof j.results[0].ok, "boolean");
      assert.equal(typeof j.results[0].prune, "boolean");
      assert.equal(typeof j.results[1].ok, "boolean");
      assert.equal(typeof j.results[1].prune, "boolean");
    },
  );
});

test("POST /push with >20 tokens → 400 too_many_tokens", async () => {
  const token = makeToken("good");
  const store = {
    [VALID_BOX_ID]: {
      gateway_token: token,
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      ovhRecordId: 1,
    },
  };
  await withServer(
    { store, apnsConfig: { teamId: "t", keyId: "k", p8Path: "/d", bundleId: "b" } },
    async ({ port }) => {
      const tokens = Array.from({ length: 21 }, (_, i) => makeHexToken(i.toString()));
      const r = await postJson(
        port,
        "/push",
        { box_id: VALID_BOX_ID, tokens, payload: { title: "T", body: "B" } },
        { authorization: `Bearer ${token}` },
      );
      assert.equal(r.status, 400);
      assert.match(JSON.parse(r.body).error, /too_many_tokens/);
    },
  );
});

test("OPTIONS /register → 204 + CORS headers (preflight)", async () => {
  await withServer({}, async ({ port }) => {
    const r = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "OPTIONS", path: "/register" }, (res) => {
        resolve({ status: res.statusCode, headers: res.headers });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], "*");
    assert.match(r.headers["access-control-allow-methods"], /POST/);
  });
});

test("POST /register with malformed JSON → 400 invalid_json", async () => {
  await withServer({}, async ({ port }) => {
    const r = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: "/register", headers: { "content-type": "application/json", "content-length": 5 } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") }));
        },
      );
      req.on("error", reject);
      req.write("not-j");
      req.end();
    });
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, "invalid_json");
  });
});
