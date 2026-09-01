// Tests for the BET-1460 class-1 safe-500 writer (safeApiError.mjs).
//
// Every class-1 route's 500 body is written through respondSafe500 — these
// tests pin the contract itself:
//   - status 500 + application/json
//   - the body carries ONLY the safe human literal (pinned exactly, so a
//     wording change is a review-visible event)
//   - the underlying error text NEVER reaches the body
//   - the underlying error IS carried on console.warn with an `[api/<route>]`
//     tag (server-side diagnosis for log shipping)
//   - non-Error throws (strings) don't crash the writer
//
// Run via `npm run test:server` (node:test; in-memory, touches no state).

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import {
  CTO_SAFE_500_MESSAGE,
  UPLOAD_SAFE_500_MESSAGE,
  respondSafe500,
} from "./safeApiError.mjs";

class FakeRes extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this._chunks = [];
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  get body() {
    return Buffer.concat(this._chunks).toString("utf8");
  }
  _write(chunk, _enc, cb) {
    this._chunks.push(Buffer.from(chunk));
    cb();
  }
}

// Distinctive "internal" error text — if any fragment of it leaks into the
// body, a consumer's raw rendering would leak box internals to the user.
const INTERNAL_MESSAGE =
  "EACCES: permission denied, open '/home/dev/.manta-outbox/secret-name.bin'";

test("respondSafe500 writes 500 + application/json with EXACTLY the safe literal", () => {
  const res = new FakeRes();
  respondSafe500(res, "cto/verdict", CTO_SAFE_500_MESSAGE, new Error(INTERNAL_MESSAGE));
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.body), { error: CTO_SAFE_500_MESSAGE });
});

test("the underlying error text never reaches the response body", () => {
  const res = new FakeRes();
  respondSafe500(res, "upload", UPLOAD_SAFE_500_MESSAGE, new Error(INTERNAL_MESSAGE));
  assert.ok(!res.body.includes("EACCES"), "raw errno leaked into the 500 body");
  assert.ok(!res.body.includes(".manta-outbox"), "raw path leaked into the 500 body");
  assert.ok(!res.body.includes("secret-name"), "raw filename leaked into the 500 body");
});

test("the safe literals are pinned literally (wording drift is review-visible)", () => {
  assert.equal(UPLOAD_SAFE_500_MESSAGE, "Couldn't save the upload on the box.");
  assert.equal(CTO_SAFE_500_MESSAGE, "The box's assistant service hit an unexpected error.");
});

test("the underlying error goes to console.warn tagged with the route", () => {
  const warnSpy = mock.method(console, "warn");
  try {
    const err = new Error(INTERNAL_MESSAGE);
    const res = new FakeRes();
    respondSafe500(res, "cto/ledger", CTO_SAFE_500_MESSAGE, err);
    assert.ok(
      warnSpy.mock.calls.some(
        (c) =>
          c.arguments[0] === "[api/cto/ledger] 500 → safe body:" &&
          c.arguments[1] === INTERNAL_MESSAGE,
      ),
      "expected console.warn('[api/cto/ledger] 500 → safe body:', <underlying message>)",
    );
  } finally {
    warnSpy.mock.restore();
  }
});

test("a thrown non-Error (string) is handled — warned, never leaked", () => {
  const warnSpy = mock.method(console, "warn");
  try {
    const res = new FakeRes();
    respondSafe500(res, "upload", UPLOAD_SAFE_500_MESSAGE, "kaboom");
    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), { error: UPLOAD_SAFE_500_MESSAGE });
    assert.ok(
      warnSpy.mock.calls.some(
        (c) =>
          c.arguments[0] === "[api/upload] 500 → safe body:" && c.arguments[1] === "kaboom",
      ),
    );
  } finally {
    warnSpy.mock.restore();
  }
});
