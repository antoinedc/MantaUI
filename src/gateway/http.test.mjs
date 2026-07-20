// http.test.mjs — unit tests for the moved readBody / MAX_BODY_BYTES helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MAX_BODY_BYTES, readBody, sendJson, sendText, corsHeaders } from "./http.mjs";

class FakeReq extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }
  destroy() {
    this.destroyed = true;
  }
}

test("MAX_BODY_BYTES is 256 KiB (matches the relay's body cap)", () => {
  assert.equal(MAX_BODY_BYTES, 256 * 1024);
});

test("readBody: collects chunks into a UTF-8 string", async () => {
  const req = new FakeReq();
  const p = new Promise((resolve, reject) => {
    readBody(req, (err, body) => (err ? reject(err) : resolve(body)));
  });
  req.emit("data", Buffer.from("hello "));
  req.emit("data", Buffer.from("world"));
  req.emit("end");
  const body = await p;
  assert.equal(body, "hello world");
});

test("readBody: empty body → empty string (not undefined)", async () => {
  const req = new FakeReq();
  const p = new Promise((resolve, reject) => {
    readBody(req, (err, body) => (err ? reject(err) : resolve(body)));
  });
  req.emit("end");
  assert.equal(await p, "");
});

test("readBody: too large → err.code === 'too_large' + req.destroyed", async () => {
  const req = new FakeReq();
  const p = new Promise((resolve, reject) => {
    readBody(req, (err, body) => (err ? resolve(err) : resolve(body)));
  });
  // First chunk under cap, second pushes past it.
  req.emit("data", Buffer.alloc(MAX_BODY_BYTES - 10));
  req.emit("data", Buffer.alloc(100));
  const err = await p;
  assert.ok(err instanceof Error);
  assert.equal(err.code, "too_large");
  assert.equal(req.destroyed, true);
});

test("readBody: read error → err.code === 'read' (no body)", async () => {
  const req = new FakeReq();
  const p = new Promise((resolve, reject) => {
    readBody(req, (err, body) => (err ? resolve(err) : resolve(body)));
  });
  req.emit("error");
  const err = await p;
  assert.ok(err instanceof Error);
  assert.equal(err.code, "read");
});

test("readBody: callback fires exactly once even after multiple events", async () => {
  const req = new FakeReq();
  let calls = 0;
  const p = new Promise((resolve, reject) => {
    readBody(req, (err, body) => {
      calls++;
      err ? reject(err) : resolve(body);
    });
  });
  req.emit("data", Buffer.from("a"));
  req.emit("end");
  req.emit("data", Buffer.from("ignored")); // must not deliver
  assert.equal(await p, "a");
  assert.equal(calls, 1);
});

test("corsHeaders: shape used by both sendJson and sendText", () => {
  const h = corsHeaders();
  assert.equal(h["Access-Control-Allow-Origin"], "*");
  assert.match(h["Access-Control-Allow-Methods"], /POST/);
  assert.match(h["Access-Control-Allow-Headers"], /authorization/);
});

test("sendJson: writes a JSON response with CORS + content-type", () => {
  let written = null;
  const res = {
    writeHead(status, headers) { written = { status, headers }; },
    end(body) { written.body = body; },
  };
  sendJson(res, 201, { ok: true, n: 7 });
  assert.equal(written.status, 201);
  assert.equal(written.headers["content-type"], "application/json");
  assert.equal(written.headers["Access-Control-Allow-Origin"], "*");
  assert.deepEqual(JSON.parse(written.body), { ok: true, n: 7 });
});

test("sendText: writes a text/plain response with CORS", () => {
  let written = null;
  const res = {
    writeHead(status, headers) { written = { status, headers }; },
    end(body) { written.body = body; },
  };
  sendText(res, 200, "hi");
  assert.equal(written.status, 200);
  assert.equal(written.headers["content-type"], "text/plain");
  assert.equal(written.body, "hi");
});
