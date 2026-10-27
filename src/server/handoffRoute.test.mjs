import { test } from "node:test";
import assert from "node:assert/strict";
import { HandoffError } from "./handoff/engine.mjs";
import { createHandoffHandler, HANDOFF_SAFE_500_MESSAGE } from "./handoffRoute.mjs";

const ID = "hof_abcdefghij0123456789";
function res() {
  const r = { status: 0, headers: {}, body: undefined, writeHead(s, h) { r.status = s; r.headers = h ?? {}; }, end(b) { r.body = b === undefined ? undefined : JSON.parse(b); } };
  return r;
}
const call = async (handler, method, url, body, readFail) => {
  const rs = res();
  const handled = await handler({ method }, rs, new URL(`http://x${url}`));
  return { handled, rs };
};
function engineStub(over = {}) {
  const calls = [];
  const rec = { id: ID, state: "ready" };
  return {
    calls,
    create: async (i) => (calls.push(["create", i]), rec),
    list: async (i) => (calls.push(["list", i]), { records: [rec], links: { branches: [] }, chain: { predecessors: [] } }),
    get: (id) => (calls.push(["get", id]), id === ID ? rec : null),
    start: async (id, i) => (calls.push(["start", id, i]), rec),
    retry: async (id) => (calls.push(["retry", id]), rec),
    dismiss: async (id) => (calls.push(["dismiss", id]), { ...rec, state: "dismissed" }),
    setMode: async (sid, mode) => (calls.push(["setMode", sid, mode]), mode),
    draftConsumed: async (id, rev) => void calls.push(["draftConsumed", id, rev]),
    ...over,
  };
}
const mk = (engine, body = {}) => createHandoffHandler({ engine, readJson: async () => body });

test("paths outside /api/handoff are not handled", async () => {
  const { handled } = await call(mk(engineStub()), "GET", "/api/other");
  assert.equal(handled, false);
});

test("POST /api/handoff → 200 {handoff}, passing only the contract fields", async () => {
  const e = engineStub();
  const { handled, rs } = await call(mk(e, { sessionId: "ses_a", trigger: "agent", action: "handoff", goal: "g", body: "b", extra: "x" }), "POST", "/api/handoff");
  assert.equal(handled, true);
  assert.equal(rs.status, 200);
  assert.deepEqual(rs.body, { handoff: { id: ID, state: "ready" } });
  assert.deepEqual(e.calls[0], ["create", { sessionId: "ses_a", trigger: "agent", action: "handoff", goal: "g", body: "b" }]);
});

test("GET /api/handoff?sessionId= → records/links", async () => {
  const e = engineStub();
  const { rs } = await call(mk(e), "GET", "/api/handoff?sessionId=ses_a");
  assert.equal(rs.status, 200);
  assert.deepEqual(e.calls[0], ["list", { sessionId: "ses_a" }]);
});

test("GET /api/handoff/:id → 200, and 404 expired for a missing or malformed id", async () => {
  const e = engineStub();
  assert.equal((await call(mk(e), "GET", `/api/handoff/${ID}`)).rs.status, 200);
  const gone = await call(mk(e), "GET", "/api/handoff/hof_zzzzzzzzzzzzzzzzzzzz");
  assert.equal(gone.rs.status, 404);
  assert.equal(gone.rs.body.error, "expired");
  assert.equal((await call(mk(e), "GET", "/api/handoff/hof_short")).rs.status, 404);
  assert.equal((await call(mk(e), "GET", "/api/handoff/%2e%2e%2fsecrets")).rs.status, 404);
});

test("POST start / retry / draft-consumed", async () => {
  const e = engineStub();
  const s = await call(mk(e, { how: "clear", disposition: "send", text: "t" }), "POST", `/api/handoff/${ID}/start`);
  assert.equal(s.rs.status, 200);
  assert.deepEqual(e.calls.at(-1), ["start", ID, { how: "clear", disposition: "send", text: "t" }]);
  assert.equal((await call(mk(e), "POST", `/api/handoff/${ID}/retry`)).rs.status, 200);
  const d = await call(mk(e, { draftRevision: 3 }), "POST", `/api/handoff/${ID}/draft-consumed`);
  assert.equal(d.rs.status, 204);
  assert.deepEqual(e.calls.at(-1), ["draftConsumed", ID, 3]);
});

test("POST dismiss → 200 {handoff}; POST /api/handoff/mode → 200 {mode} (GET is a 405, a bad mode a 400)", async () => {
  const e = engineStub();
  const d = await call(mk(e), "POST", `/api/handoff/${ID}/dismiss`);
  assert.equal(d.rs.status, 200);
  assert.deepEqual(d.rs.body, { handoff: { id: ID, state: "dismissed" } });
  assert.deepEqual(e.calls.at(-1), ["dismiss", ID]);
  const m = await call(mk(e, { sessionId: "ses_a", mode: "off", extra: 1 }), "POST", "/api/handoff/mode");
  assert.equal(m.rs.status, 200);
  assert.deepEqual(m.rs.body, { mode: "off" });
  assert.deepEqual(e.calls.at(-1), ["setMode", "ses_a", "off"]);
  assert.equal((await call(mk(e), "GET", "/api/handoff/mode")).rs.status, 405);
  const bad = engineStub({ setMode: async () => { throw new HandoffError("invalid", "mode must be auto, suggest or off"); } });
  assert.equal((await call(mk(bad, { sessionId: "s", mode: "x" }), "POST", "/api/handoff/mode")).rs.status, 400);
});

test("HandoffError codes map to their statuses with {error, message} and the record on 409", async () => {
  const cases = [
    ["already_started", 409, true],
    ["busy", 409, true],
    ["not_ready", 422, true],
    ["dismissed", 409, false],
    ["no_window", 422, false],
    ["invalid", 400, false],
    ["expired", 404, false],
  ];
  for (const [code, status, withRecord] of cases) {
    const e = engineStub({ start: async () => { throw new HandoffError(code, `msg ${code}`, withRecord ? { handoff: { id: ID } } : {}); } });
    const { rs } = await call(mk(e, { how: "clear", disposition: "send" }), "POST", `/api/handoff/${ID}/start`);
    assert.equal(rs.status, status, code);
    assert.equal(rs.body.error, code);
    assert.equal(rs.body.message, `msg ${code}`);
    assert.equal(rs.body.handoff?.id, withRecord ? ID : undefined);
  }
});

test("an unexpected error is a class-1 safe 500: a literal in the body, never the underlying message", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const e = engineStub({ create: async () => { throw new Error("ENOENT: /home/dev/.manta/handoffs.json"); } });
    const { rs } = await call(mk(e, { sessionId: "s", trigger: "user" }), "POST", "/api/handoff");
    assert.equal(rs.status, 500);
    assert.deepEqual(rs.body, { error: HANDOFF_SAFE_500_MESSAGE });
  } finally {
    console.warn = warn;
  }
});

test("an unreadable JSON body is a 400, not a 500", async () => {
  const h = createHandoffHandler({ engine: engineStub(), readJson: async () => { throw new Error("bad json"); } });
  const { rs } = await call(h, "POST", "/api/handoff");
  assert.equal(rs.status, 400);
  assert.equal(rs.body.error, "invalid");
});

test("wrong methods are 405", async () => {
  assert.equal((await call(mk(engineStub()), "DELETE", "/api/handoff")).rs.status, 405);
  assert.equal((await call(mk(engineStub()), "GET", `/api/handoff/${ID}/start`)).rs.status, 405);
});
