// server.test.mjs — full HTTP server integration tests.
//
// Spins up createGatewayServer() on an ephemeral port, drives every
// endpoint with real HTTP requests, and asserts the wire-level shape
// (status, body, headers, CORS). All I/O is injected — the store is an
// in-memory map, the DNS + APNs surfaces are fake senders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
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

async function buildServer({ store = {}, dns = makeFetchImpl(), apnsConfig = null, rateLimiter, apnsSender } = {}) {
  let liveStore = { ...store };
  const load = async () => ({ ...liveStore });
  const save = async (m) => { liveStore = { ...m }; };
  const { calls: dnsCalls, fetchImpl } = dns;
  const apnsCalls = [];
  const createDnsRecord = async (args) => {
    dnsCalls.push({ url: "createOrUpdate", init: { method: args.existingRecordId ? "PUT" : "POST" }, args });
    return { recordId: dnsCalls.length * 100, action: args.existingRecordId ? "update" : "create" };
  };
  // Default fake apnsSender: records every call and returns a 200 success.
  // Tests that need a real p8-signing path pass their own sender; tests that
  // just check auth/shape use this default (no network, no real key needed).
  const defaultApnsFake = async (req) => {
    apnsCalls.push(req);
    return { status: 200, body: null };
  };
  const svc = createGatewayServer({
    port: 0,
    load,
    save,
    fetchImpl,
    createDnsRecord,
    apnsConfig,
    // Wire the injected apnsSender (or the default fake) so the happy-path
    // /push test exercises the full handlePush → sendApns wiring end-to-end.
    // This is the seam BET-236 requires: without it, a bogus p8Path causes
    // JWT signing to throw and apnsSender is never reached, hiding any
    // wrong-function-into-wrong-slot regression.
    apnsSender: apnsSender ?? defaultApnsFake,
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

// Generate a real EC key + write it to a temp .p8 file so JWT signing
// succeeds during server-level /push tests. Callers must await cleanup().
async function makeApnsCfg() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const p8Path = join(
    tmpdir(),
    `manta-gw-server-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.p8`,
  );
  await writeFile(p8Path, pem, "utf-8");
  return {
    cfg: {
      teamId: "FSQ3HS4Z24",
      keyId: "82P7483297",
      bundleId: "com.antoinedc.mantaui",
      p8Path,
    },
    cleanup: () => rm(p8Path, { force: true }),
  };
}

// Drain an IncomingMessage into { status, headers, body } and resolve. Shared
// by postJson + getRequest so the chunk-collect boilerplate lives once.
function collectResponse(res, resolve) {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () =>
    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }),
  );
}

function postJson(port, path, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } },
      (res) => collectResponse(res, resolve),
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path }, (res) =>
      collectResponse(res, resolve),
    );
    req.on("error", reject);
    req.end();
  });
}

// A store map pre-seeded with the standard VALID_BOX_ID entry. `overrides`
// merge onto the entry (e.g. a specific gateway_token).
function seedStore(overrides = {}) {
  return {
    [VALID_BOX_ID]: {
      gateway_token: makeToken("good"),
      ip: "1.2.3.4",
      host: `${VALID_BOX_ID}.boxes.mantaui.com`,
      registeredAt: 1,
      updatedAt: 1,
      recordId: 1,
      ...overrides,
    },
  };
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
  const store = seedStore({ gateway_token: token, ip: "9.9.9.9", recordId: 1234 });
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
  const store = seedStore({ gateway_token: token, ip: "1.1.1.1", recordId: 1234 });
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
  const store = seedStore({ gateway_token: makeToken("right"), ip: "1.1.1.1" });
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

test("POST /push auth + tokens → 200 {results:[{token, ok, prune}]} and apnsSender invoked", async () => {
  // BET-236: use a real EC key so JWT signing succeeds and the injected
  // apnsSender is actually reached. Before this change, the bogus p8Path
  // ("/d") made JWT signing throw first, meaning apnsSender was never called
  // and any wrong-function-into-wrong-slot regression went undetected.
  const { cfg, cleanup } = await makeApnsCfg();
  try {
    const token = makeToken("good");
    const store = seedStore({ gateway_token: token });
    const tokA = makeHexToken("a");
    const tokB = makeHexToken("b");
    await withServer(
      { store, apnsConfig: cfg },
      async ({ port, apnsCalls }) => {
        const r = await postJson(
          port,
          "/push",
          {
            box_id: VALID_BOX_ID,
            tokens: [tokA, tokB],
            payload: { title: "T", body: "B" },
          },
          { authorization: `Bearer ${token}` },
        );
        assert.equal(r.status, 200);
        const j = JSON.parse(r.body);
        assert.equal(j.results.length, 2);
        // Both tokens should be ok:true because our fake apnsSender returns 200.
        assert.deepEqual(j.results[0], { token: tokA, ok: true, prune: false });
        assert.deepEqual(j.results[1], { token: tokB, ok: true, prune: false });

        // BET-236: assert the fake apnsSender was called with properly-shaped
        // APNs requests — not with a DNS fetch (URL string) or anything else.
        // If handlePush accidentally passes the DNS fetchImpl into sendApns,
        // the sender would receive a URL string rather than a request object,
        // and these assertions would fail.
        assert.equal(apnsCalls.length, 2, "apnsSender must be called once per token");
        for (const [i, req] of apnsCalls.entries()) {
          assert.equal(req.host, "api.push.apple.com", `call ${i}: host must be APNs`);
          assert.equal(req.method, "POST", `call ${i}: method must be POST`);
          assert.ok(
            typeof req.path === "string" && req.path.startsWith("/3/device/"),
            `call ${i}: path must be /3/device/<token>`,
          );
          assert.ok(
            typeof req.headers?.authorization === "string" &&
              req.headers.authorization.startsWith("bearer "),
            `call ${i}: authorization header must carry APNs bearer JWT`,
          );
          assert.equal(
            req.headers?.["apns-topic"],
            cfg.bundleId,
            `call ${i}: apns-topic must match bundleId`,
          );
          assert.ok(typeof req.body === "string", `call ${i}: body must be a JSON string`);
          const parsed = JSON.parse(req.body);
          assert.ok(parsed?.aps?.alert?.title === "T", `call ${i}: aps.alert.title must match payload`);
        }
        // Token routing: each call's path must reference the correct device token.
        assert.ok(apnsCalls[0].path.includes(tokA), "first call must target tokA");
        assert.ok(apnsCalls[1].path.includes(tokB), "second call must target tokB");
      },
    );
  } finally {
    await cleanup();
  }
});

test("POST /push with >20 tokens → 400 too_many_tokens", async () => {
  const token = makeToken("good");
  const store = seedStore({ gateway_token: token });
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
