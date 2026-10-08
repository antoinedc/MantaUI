import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountsRouteHandler, isDirectLoopbackRequest } from "./accountsRoute.mjs";

function harness(seatAssigner) {
  const sent = [];
  const handle = createAccountsRouteHandler({
    seatAssigner,
    readJson: async (req) => {
      if (req.badJson) throw new Error("bad json");
      return req.body;
    },
    respondJson: (_res, status, body) => sent.push([status, body]),
  });
  const call = async (method, pathAndQuery, extra = {}) => {
    sent.length = 0;
    const handled = await handle({ method, socket: { remoteAddress: "127.0.0.1" }, headers: {}, ...extra }, {}, new URL(pathAndQuery, "http://x"));
    return { handled, out: sent[0] };
  };
  return { call };
}
const assigner = {
  resolve: async (p, s, parent) => ({ seatId: `${p}/${s}/${parent}`, live: true }),
  refreshSeat: async (p, id) => (id === "seat-9" ? null : { seatId: id, live: false, provider: p, credentialFile: "/f" }),
};

test("a path that is not ours is left alone", async () => {
  const { call } = harness(assigner);
  assert.deepEqual(await call("GET", "/api/other"), { handled: false, out: undefined });
});

test("resolve: passes provider / sessionID / parentSessionID through", async () => {
  const { call } = harness(assigner);
  const r = await call("GET", "/api/accounts/resolve?provider=codex&sessionID=ses_1&parentSessionID=ses_0");
  assert.deepEqual(r.out, [200, { seatId: "codex/ses_1/ses_0", live: true }]);
  assert.deepEqual((await call("GET", "/api/accounts/resolve?provider=claude&sessionID=s")).out[1].seatId, "claude/s/null");
});

test("resolve: 400 on a bad provider, a missing or oversized session id", async () => {
  const { call } = harness(assigner);
  for (const q of ["provider=kimi&sessionID=s", "provider=claude", "provider=claude&sessionID=" + "x".repeat(201), "provider=claude&sessionID=s&parentSessionID=" + "x".repeat(201)]) {
    assert.deepEqual((await call("GET", `/api/accounts/resolve?${q}`)).out, [400, { error: "invalid" }]);
  }
});

test("wrong method → 405", async () => {
  const { call } = harness(assigner);
  assert.equal((await call("POST", "/api/accounts/resolve")).out[0], 405);
  assert.equal((await call("GET", "/api/accounts/refresh")).out[0], 405);
});

test("refresh: same shape as resolve; 404 for an unknown seat; 400 for bad input or unparseable JSON", async () => {
  const { call } = harness(assigner);
  assert.deepEqual((await call("POST", "/api/accounts/refresh", { body: { provider: "claude", seatId: "seat-2" } })).out, [200, { seatId: "seat-2", live: false, provider: "claude", credentialFile: "/f" }]);
  assert.equal((await call("POST", "/api/accounts/refresh", { body: { provider: "claude", seatId: "seat-9" } })).out[0], 404);
  assert.equal((await call("POST", "/api/accounts/refresh", { body: { provider: "nope", seatId: "seat-2" } })).out[0], 400);
  assert.equal((await call("POST", "/api/accounts/refresh", { body: { provider: "claude" } })).out[0], 400);
  assert.equal((await call("POST", "/api/accounts/refresh", { badJson: true })).out[0], 400);
});

test("an assigner failure propagates (index.mjs turns it into the class-2 500)", async () => {
  const { call } = harness({ ...assigner, resolve: async () => { throw new Error("boom"); } });
  await assert.rejects(call("GET", "/api/accounts/resolve?provider=claude&sessionID=s"), /boom/);
});

// ---- the direct-loopback gate -----------------------------------------------

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test("isDirectLoopbackRequest: loopback socket with no proxy header is the only yes", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isDirectLoopbackRequest(req(a)), true, a);
  assert.equal(isDirectLoopbackRequest(req("127.0.0.1", { "user-agent": "bun", authorization: "Bearer x", "content-type": "application/json" })), true);
});

test("isDirectLoopbackRequest: any non-loopback socket is a no", () => {
  for (const a of ["10.0.0.5", "192.168.1.9", "100.64.0.1", "203.0.113.9", "::ffff:10.0.0.5", "fe80::1", "", undefined, null]) {
    assert.equal(isDirectLoopbackRequest(req(a)), false, String(a));
  }
  assert.equal(isDirectLoopbackRequest({}), false);
  assert.equal(isDirectLoopbackRequest(null), false);
});

test("isDirectLoopbackRequest: a loopback socket carrying ANY proxy header (Caddy / cloudflared) is a no", () => {
  for (const h of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "cf-connecting-ip", "cdn-loop"]) {
    assert.equal(isDirectLoopbackRequest(req("127.0.0.1", { [h]: "203.0.113.9" })), false, h);
  }
});

test("both routes answer 403 to a proxied or non-loopback caller, BEFORE doing any work", async () => {
  let touched = 0;
  const { call } = harness({ resolve: async () => touched++, refreshSeat: async () => touched++ });
  for (const extra of [{ headers: { "x-forwarded-for": "203.0.113.9" } }, { socket: { remoteAddress: "10.1.2.3" } }, { headers: { "cf-connecting-ip": "1.2.3.4" } }]) {
    assert.deepEqual((await call("GET", "/api/accounts/resolve?provider=claude&sessionID=s", extra)).out, [403, { error: "forbidden" }]);
    assert.deepEqual((await call("POST", "/api/accounts/refresh", { ...extra, body: { provider: "claude", seatId: "seat-2" } })).out, [403, { error: "forbidden" }]);
  }
  assert.equal(touched, 0);
});

test("a path that is not ours is still left alone for a proxied caller (the gate is per-route)", async () => {
  const { call } = harness(assigner);
  assert.equal((await call("GET", "/api/other", { headers: { "x-forwarded-for": "1.2.3.4" } })).handled, false);
});
