import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountsRouteHandler } from "./accountsRoute.mjs";

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
    const handled = await handle({ method, ...extra }, {}, new URL(pathAndQuery, "http://x"));
    return { handled, out: sent[0] };
  };
  return { call };
}
const assigner = {
  resolve: async (p, s, parent) => ({ seatId: `${p}/${s}/${parent}`, live: true }),
  refreshSeat: async (p, id) => (id === "seat-9" ? null : { seatId: id, live: false, accessToken: "TOK" }),
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
  assert.deepEqual((await call("POST", "/api/accounts/refresh", { body: { provider: "claude", seatId: "seat-2" } })).out, [200, { seatId: "seat-2", live: false, accessToken: "TOK" }]);
  assert.equal((await call("POST", "/api/accounts/refresh", { body: { provider: "claude", seatId: "seat-9" } })).out[0], 404);
  assert.equal((await call("POST", "/api/accounts/refresh", { body: { provider: "nope", seatId: "seat-2" } })).out[0], 400);
  assert.equal((await call("POST", "/api/accounts/refresh", { body: { provider: "claude" } })).out[0], 400);
  assert.equal((await call("POST", "/api/accounts/refresh", { badJson: true })).out[0], 400);
});

test("an assigner failure propagates (index.mjs turns it into the class-2 500)", async () => {
  const { call } = harness({ ...assigner, resolve: async () => { throw new Error("boom"); } });
  await assert.rejects(call("GET", "/api/accounts/resolve?provider=claude&sessionID=s"), /boom/);
});
