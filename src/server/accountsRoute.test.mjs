import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountsRouteHandler, isDirectLoopbackRequest } from "./accountsRoute.mjs";

function harness(seatAssigner, extraDeps = {}) {
  const sent = [];
  const handle = createAccountsRouteHandler({
    seatAssigner,
    ...extraDeps,
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

// ---- POST /api/accounts/limit ------------------------------------------------

function limitAssigner({ children = {}, moved = true, order = [] } = {}) {
  return {
    order,
    _store: () => ({ children }),
    markLimited: (p, s) => (order.push(["mark", p, s]), "seat-1"),
    reconsider: async (p, s) => (order.push(["reconsider", p, s]), moved ? { moved: true, from: "seat-1", to: "seat-2" } : { moved: false }),
    resolve: async (p, s, parent) => (order.push(["resolve", p, s, parent]), { seatId: moved ? "seat-2" : "seat-1", live: false, provider: p, credentialFile: "/f" }),
  };
}
const limitBody = (over = {}) => ({ body: { provider: "claude", sessionID: "ses_1", ...over } });

test("limit: marks the seat, kicks the refresh, reconsiders, then answers resolve + moved:true", async () => {
  const a = limitAssigner();
  const refreshed = [];
  const { call } = harness(a, { refreshUsageInBackground: (p) => (a.order.push(["refresh", p]), refreshed.push(p)) });
  const r = await call("POST", "/api/accounts/limit", limitBody({ parentSessionID: "ses_0" }));
  assert.deepEqual(r.out, [200, { seatId: "seat-2", live: false, provider: "claude", credentialFile: "/f", moved: true }]);
  assert.deepEqual(a.order, [["mark", "claude", "ses_0"], ["refresh", "claude"], ["reconsider", "claude", "ses_0"], ["resolve", "claude", "ses_1", "ses_0"]]);
  assert.deepEqual(refreshed, ["claude"]);
});

test("limit: moved is false when nothing moved", async () => {
  const { call } = harness(limitAssigner({ moved: false }));
  const r = await call("POST", "/api/accounts/limit", limitBody());
  assert.deepEqual(r.out, [200, { seatId: "seat-1", live: false, provider: "claude", credentialFile: "/f", moved: false }]);
});

test("limit: a linked child is resolved to its conversation root; an unlinked one with a parent uses the parent (and the parent's root)", async () => {
  const linked = limitAssigner({ children: { kid: { root: "root" } } });
  await harness(linked).call("POST", "/api/accounts/limit", limitBody({ sessionID: "kid" }));
  assert.deepEqual(linked.order.slice(0, 2), [["mark", "claude", "root"], ["reconsider", "claude", "root"]]);

  const viaParent = limitAssigner({ children: { mid: { root: "root" } } });
  await harness(viaParent).call("POST", "/api/accounts/limit", limitBody({ sessionID: "newkid", parentSessionID: "mid" }));
  assert.deepEqual(viaParent.order.slice(0, 2), [["mark", "claude", "root"], ["reconsider", "claude", "root"]]);

  const own = limitAssigner();
  await harness(own).call("POST", "/api/accounts/limit", limitBody({ sessionID: "solo" }));
  assert.deepEqual(own.order[0], ["mark", "claude", "solo"]);
});

test("limit: the usage refresh is NOT awaited (a never-settling refresh still answers)", async () => {
  const { call } = harness(limitAssigner(), { refreshUsageInBackground: () => new Promise(() => {}) });
  const r = await Promise.race([call("POST", "/api/accounts/limit", limitBody()), new Promise((res) => setTimeout(() => res("timeout"), 500))]);
  assert.notEqual(r, "timeout");
  assert.equal(r.out[0], 200);
});

test("limit: a refresh that throws synchronously does not fail the switch", async () => {
  const { call } = harness(limitAssigner(), { refreshUsageInBackground: () => { throw new Error("nope"); } });
  assert.equal((await call("POST", "/api/accounts/limit", limitBody())).out[0], 200);
});

test("limit: 400 on a bad provider, missing / oversized / non-string ids, unparseable JSON", async () => {
  const a = limitAssigner();
  const { call } = harness(a);
  for (const b of [
    { provider: "kimi", sessionID: "s" },
    { sessionID: "s" },
    { provider: "claude" },
    { provider: "claude", sessionID: "" },
    { provider: "claude", sessionID: 7 },
    { provider: "claude", sessionID: "x".repeat(201) },
    { provider: "claude", sessionID: "s", parentSessionID: "x".repeat(201) },
    { provider: "claude", sessionID: "s", parentSessionID: 5 },
  ]) {
    assert.deepEqual((await call("POST", "/api/accounts/limit", { body: b })).out, [400, { error: "invalid" }], JSON.stringify(b).slice(0, 60));
  }
  assert.equal((await call("POST", "/api/accounts/limit", { badJson: true })).out[0], 400);
  assert.deepEqual(a.order, [], "no work on invalid input");
});

test("limit: a null / empty parentSessionID is the same as none", async () => {
  for (const parentSessionID of [null, ""]) {
    const a = limitAssigner();
    assert.equal((await harness(a).call("POST", "/api/accounts/limit", limitBody({ parentSessionID }))).out[0], 200);
    assert.deepEqual(a.order[0], ["mark", "claude", "ses_1"]);
    assert.deepEqual(a.order.at(-1), ["resolve", "claude", "ses_1", null]);
  }
});

test("limit: GET → 405; proxied / non-loopback → 403 before any work", async () => {
  const a = limitAssigner();
  const { call } = harness(a);
  assert.equal((await call("GET", "/api/accounts/limit")).out[0], 405);
  for (const extra of [{ headers: { "x-forwarded-for": "203.0.113.9" } }, { socket: { remoteAddress: "10.1.2.3" } }]) {
    assert.deepEqual((await call("POST", "/api/accounts/limit", { ...extra, ...limitBody() })).out, [403, { error: "forbidden" }]);
  }
  assert.deepEqual(a.order, []);
});

test("limit: works against a store-less assigner fake (no _store)", async () => {
  const { _store, ...bare } = limitAssigner();
  assert.equal((await harness(bare).call("POST", "/api/accounts/limit", limitBody())).out[0], 200);
});

test("limit: an assigner failure propagates (index.mjs turns it into the class-2 500)", async () => {
  const { call } = harness({ ...limitAssigner(), reconsider: async () => { throw new Error("boom"); } });
  await assert.rejects(call("POST", "/api/accounts/limit", limitBody()), /boom/);
});
