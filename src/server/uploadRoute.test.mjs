// Tests for the POST /api/upload route (BET-1460).
//
// These drive the REAL handler (src/server/uploadRoute.mjs — the same module
// index.mjs wires) against a real temp dir; the failure paths inject a
// rejecting mkdir / pipeline. No re-implemented route mock.
//
// Contract pinned:
//   - 400 "bad session" on a missing/invalid session query
//   - 400 "missing X-Filename" on an unusable filename header
//   - 200 { path } on success, with the filename sanitized (no separators)
//   - failure: 500 whose body is ONLY the safe human message — raw
//     fs/stream error text (absolute paths, errno output) never reaches the
//     client body — and the underlying error carried on console.warn.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BATCH_RE,
  SESSION_RE,
  createUploadHandler,
  safeBasename,
} from "./uploadRoute.mjs";
import { UPLOAD_SAFE_500_MESSAGE } from "./safeApiError.mjs";

class FakeRes {
  constructor() {
    this.statusCode = null;
    this.headers = null;
    this.body = "";
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(chunk) {
    this.body = typeof chunk === "string" ? chunk : String(chunk ?? "");
  }
}

function makeReq(body, headers = {}) {
  const req = Readable.from([Buffer.from(body ?? "")]);
  req.headers = headers;
  return req;
}

function makeUrl(session) {
  return new URL(`http://x/api/upload${session ? `?session=${encodeURIComponent(session)}` : ""}`);
}

test("the session/filename regexes are pinned (path-traversal guards)", () => {
  assert.equal(SESSION_RE.source, "^[A-Za-z0-9._-]+$");
  assert.equal(BATCH_RE.source, "^[0-9]{6,20}$");
});

test("safeBasename strips separators and control chars", () => {
  // Dots are not separators — "../etc/passwd" collapses to a flat name whose
  // only risk (join()ing upward) is neutralized by the SESSION_RE-guarded
  // session and the BATCH_RE-guarded batch around it. Pinned as-is.
  assert.equal(safeBasename("../etc/passwd"), ".._etc_passwd");
  assert.equal(safeBasename("a/b\\c:d*e?f\"g<h>i|j\u0000k"), "a_b_c_d_e_f_g_h_i_j_k");
  assert.equal(safeBasename("."), "file");
  assert.equal(safeBasename(""), "file");
  assert.equal(safeBasename("x".repeat(300)), "x".repeat(200));
});

test("400 bad session on a missing/invalid session query", async () => {
  const handler = createUploadHandler({ uploadRoot: "/tmp/unused" });
  for (const session of [null, "bad session!", "../escape"]) {
    const res = new FakeRes();
    await handler(makeReq("", { "x-filename": "a.txt" }), res, makeUrl(session));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body), { error: "bad session" });
  }
});

test("400 missing X-Filename on an unusable filename header", async () => {
  const handler = createUploadHandler({ uploadRoot: "/tmp/unused" });
  const res = new FakeRes();
  await handler(makeReq("bytes", {}), res, makeUrl("sess1"));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "missing X-Filename" });
});

test("success stores the bytes under <root>/<session>/<batch>/<name> and returns 200 { path }", async () => {
  const root = await mkdtemp(join(tmpdir(), "manta-upload-test-"));
  try {
    const handler = createUploadHandler({ uploadRoot: root });
    const res = new FakeRes();
    await handler(
      makeReq("FILEBYTES", { "x-filename": "report.pdf", "x-batch-id": "123456" }),
      res,
      makeUrl("better-ui"),
    );
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.deepEqual(parsed, { path: join(root, "better-ui", "123456", "report.pdf") });
    assert.equal(await readFile(parsed.path, "utf8"), "FILEBYTES");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mkdir failure returns 500 with ONLY the safe literal — raw error goes to console.warn", async () => {
  const warnSpy = mock.method(console, "warn");
  const rawError = new Error(
    "EACCES: permission denied, mkdir '/home/dev/.manta-uploads/better-ui'",
  );
  try {
    const handler = createUploadHandler({
      uploadRoot: "/tmp/unused",
      mkdirImpl: async () => {
        throw rawError;
      },
    });
    const res = new FakeRes();
    await handler(
      makeReq("bytes", { "x-filename": "a.txt" }),
      res,
      makeUrl("sess"),
    );
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers["content-type"], "application/json");
    // The exact BET-1460 safe body — pinned literally.
    assert.deepEqual(JSON.parse(res.body), { error: UPLOAD_SAFE_500_MESSAGE });
    assert.ok(!res.body.includes("EACCES"), "raw errno leaked into the 500 body");
    assert.ok(!res.body.includes(".manta-uploads"), "raw path leaked into the 500 body");
    assert.ok(
      warnSpy.mock.calls.some(
        (c) =>
          c.arguments[0] === "[api/upload] 500 → safe body:" &&
          c.arguments[1] === rawError.message,
      ),
      "expected console.warn('[api/upload] 500 → safe body:', <underlying message>)",
    );
  } finally {
    warnSpy.mock.restore();
  }
});

test("stream failure returns the same 500 contract", async () => {
  const handler = createUploadHandler({
    uploadRoot: "/tmp/unused",
    pipelineImpl: async () => {
      throw new Error("stream blew up mid-pipe");
    },
  });
  const res = new FakeRes();
  await handler(makeReq("bytes", { "x-filename": "a.txt" }), res, makeUrl("sess"));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { error: UPLOAD_SAFE_500_MESSAGE });
  assert.ok(!res.body.includes("mid-pipe"), "raw stream error leaked into the body");
});
