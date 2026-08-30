// Tests for the /api/projects route (BET-1458 — characterization coverage for
// the BET-1454 stderr-leak fix). These drive the REAL handler
// (src/server/projectsRoute.mjs, the same module index.mjs calls) with an
// injected tmux listing — no re-implemented route mock.
//
// Contract pinned:
//   - success: 200 + the raw projects JSON, byte-for-byte as tmux reported it
//   - failure: 500 whose body is ONLY the safe human message — raw tmux
//     stderr never reaches the client body — and the underlying error is
//     carried on the server-side console.warn for log shipping (Axiom).
//
// Run via `npm run test:server` (node:test, MANTA_STATE_HOME sandbox set by
// the runner — this test is in-memory and touches no state files).

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { createProjectsHandler } from "./projectsRoute.mjs";

// A Writable response that captures status + headers + streamed bytes
// (same harness shape peek.test.mjs uses).
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

// The tmux stderr shape the BET-1454 fix guards against — what
// `tmux list-sessions` emits on a dead/fresh box, as carried in the thrown
// error's message. Distinctive enough that any leak into the body is caught.
const RAW_TMUX_STDERR =
  "no server running on /tmp/tmux-1000/default";
const LISTING_ERROR = new Error(`Command failed: tmux list-sessions — ${RAW_TMUX_STDERR}`);

function makeHandler(listProjects) {
  return createProjectsHandler({ listProjects });
}

test("GET /api/projects success path returns 200 + the listing JSON", async () => {
  const projects = [
    { name: "better-ui", attached: false, windows: 2 },
    { name: "scratch", attached: true, windows: 1 },
  ];
  const handler = makeHandler(async () => projects);
  const res = new FakeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.body), projects);
});

test("GET /api/projects failure returns 500 with ONLY the safe human message", async () => {
  const handler = makeHandler(async () => {
    throw LISTING_ERROR;
  });
  const res = new FakeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers["content-type"], "application/json");
  const parsed = JSON.parse(res.body);
  // The exact BET-1454 safe body — pinned literally so a wording change is a
  // review-visible event, not a silent drift.
  assert.deepEqual(parsed, { error: "Couldn't reach tmux on the box." });
  // Raw tmux stderr must never reach the client-facing body.
  assert.ok(!res.body.includes(RAW_TMUX_STDERR), "raw tmux stderr leaked into the 500 body");
  assert.ok(!res.body.includes("tmux list-sessions"), "tmux command line leaked into the 500 body");
});

test("GET /api/projects failure logs the underlying error on console.warn", async () => {
  const warnSpy = mock.method(console, "warn");
  try {
    const handler = makeHandler(async () => {
      throw LISTING_ERROR;
    });
    const res = new FakeRes();
    await handler({ method: "GET" }, res);
    // Body sanity first — the warn assertion only means something on the
    // failure path this test pins.
    assert.equal(res.statusCode, 500);
    assert.ok(
      warnSpy.mock.calls.some(
        (c) =>
          c.arguments[0] === "[api/projects] tmux listing failed:" &&
          c.arguments[1] === LISTING_ERROR.message,
      ),
      "expected console.warn('[api/projects] tmux listing failed:', <underlying message>)",
    );
  } finally {
    warnSpy.mock.restore();
  }
});
