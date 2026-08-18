// Tests for the /api/peek file-serving route. These drive the REAL handler
// (src/server/peek.mjs, the same module index.mjs calls) with real node:fs I/O
// and a fake Writable response — no re-implemented mock. Plus the pure
// parseByteRange unit tests.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { parseByteRange } from "./range.mjs";
import { createPeekHandler } from "./peek.mjs";

const MIME = {
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

// The real handler, wired with real fs + homedir, driven in-process.
function makeHandler() {
  return createPeekHandler({ homedir, stat, createReadStream, pipeline, MIME });
}

// A Writable response that captures status + headers + streamed bytes.
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
    return Buffer.concat(this._chunks);
  }
  _write(chunk, _enc, cb) {
    this._chunks.push(Buffer.from(chunk));
    cb();
  }
}

function request(method, range) {
  return { method, headers: range === undefined ? {} : { range } };
}

function peekUrl(absPath) {
  return new URL("http://127.0.0.1:8787/api/peek?path=" + encodeURIComponent(absPath));
}

// Drive the real handler and await the response (stream completes).
async function runPeek({ path, method = "GET", range }) {
  const res = new FakeRes();
  await makeHandler()(request(method, range), res, peekUrl(path));
  return res;
}

// Create a throwaway test dir inside the user's home dir.
function tempRoot(tag) {
  return join(homedir(), `.manta-test-peek-${tag}-${Date.now()}`);
}

// ---------------------------------------------------------------------------
// parseByteRange — pure unit tests (no HTTP, no server)
// ---------------------------------------------------------------------------

test("parseByteRange: closed range bytes=0-99", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
});

test("parseByteRange: closed range clamps end to EOF", () => {
  assert.deepEqual(parseByteRange("bytes=900-2000", 1000), { start: 900, end: 999 });
});

test("parseByteRange: open-ended range bytes=100-", () => {
  assert.deepEqual(parseByteRange("bytes=100-", 1000), { start: 100, end: 999 });
});

test("parseByteRange: suffix range bytes=-100", () => {
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
});

test("parseByteRange: suffix larger than file returns whole file", () => {
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseByteRange: start past EOF is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=1001-2000", 1000), "unsatisfiable");
});

test("parseByteRange: end before start is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=50-10", 1000), "unsatisfiable");
});

test("parseByteRange: zero-length / empty suffix range is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-", 1000), "unsatisfiable");
});

test("parseByteRange: range on empty file is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-1", 0), "unsatisfiable");
});

test("parseByteRange: absent header returns null", () => {
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange(undefined, 1000), null);
  assert.equal(parseByteRange("", 1000), null);
});

test("parseByteRange: unparseable header returns null", () => {
  assert.equal(parseByteRange("bytes", 1000), null);
  assert.equal(parseByteRange("bytes=", 1000), null);
  assert.equal(parseByteRange("items=0-10", 1000), null);
  assert.equal(parseByteRange("bytes=abc-def", 1000), null);
  assert.equal(parseByteRange("bytes=0-99 extra", 1000), null);
});

test("parseByteRange: multi-range request returns null (serve whole file)", () => {
  assert.equal(parseByteRange("bytes=0-99,300-400", 1000), null);
});

// ---------------------------------------------------------------------------
// Real handler — GET/HEAD 200/206/416 behaviour
// ---------------------------------------------------------------------------

const CONTENT = "0123456789abcdefghij"; // 20 bytes

test("/api/peek GET serves the full file with correct headers", async () => {
  const root = tempRoot("get");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(CONTENT)));
    assert.equal(res.body.toString(), CONTENT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek HEAD reports the full size with no body", async () => {
  const root = tempRoot("head");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file, method: "HEAD" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(CONTENT)));
    assert.equal(res.body.length, 0, "HEAD must not stream a body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek ranged GET returns 206 with the correct bytes and content-range", async () => {
  const root = tempRoot("ranged-get");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file, range: "bytes=5-9" });
    assert.equal(res.statusCode, 206);
    assert.equal(res.body.toString(), "56789");
    assert.equal(res.headers["content-range"], "bytes 5-9/20");
    assert.equal(res.headers["content-length"], "5");
    assert.equal(res.headers["accept-ranges"], "bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek open-ended ranged GET returns the tail", async () => {
  const root = tempRoot("ranged-open");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file, range: "bytes=15-" });
    assert.equal(res.statusCode, 206);
    assert.equal(res.body.toString(), "fghij");
    assert.equal(res.headers["content-range"], "bytes 15-19/20");
    assert.equal(res.headers["content-length"], "5");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek unsatisfiable range returns 416 with bytes */size", async () => {
  const root = tempRoot("416");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file, range: "bytes=100-200" });
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers["content-range"], "bytes */20");
    assert.equal(res.body.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek HEAD with a Range reports the slice length with no body", async () => {
  const root = tempRoot("head-range");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file, method: "HEAD", range: "bytes=5-9" });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers["content-range"], "bytes 5-9/20");
    assert.equal(res.headers["content-length"], "5");
    assert.equal(res.body.length, 0, "HEAD must not stream a body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek multi-range request degrades to a full 200", async () => {
  const root = tempRoot("multirange");
  await mkdir(root, { recursive: true });
  const file = join(root, "test.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runPeek({ path: file, range: "bytes=0-1,5-6" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString(), CONTENT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek expands ~ to the home directory", async () => {
  const ts = Date.now();
  const file = join(homedir(), `.manta-test-peek-home-${ts}.txt`);
  await writeFile(file, "home file content");
  try {
    const res = await runPeek({ path: `~/.manta-test-peek-home-${ts}.txt` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString(), "home file content");
  } finally {
    await rm(file, { force: true });
  }
});

test("/api/peek serves JSON with the correct content-type", async () => {
  const root = tempRoot("json");
  await mkdir(root, { recursive: true });
  const file = join(root, "data.json");
  await writeFile(file, '{"key":"value"}');
  try {
    const res = await runPeek({ path: file });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.body.toString(), '{"key":"value"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek rejects missing path with 400", async () => {
  const res = await runPeek({ path: "" });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body.toString()), { error: "path is required" });
});

test("/api/peek rejects path traversal with 403", async () => {
  const res = await runPeek({ path: "/etc/passwd" });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body.toString()), { error: "path outside home directory" });
});

test("/api/peek returns 404 for a non-existent file", async () => {
  const res = await runPeek({ path: join(homedir(), "nonexistent-file-12345.txt") });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body.toString()), { error: "not found" });
});

test("/api/peek returns 404 for a directory", async () => {
  const root = tempRoot("dir");
  await mkdir(root, { recursive: true });
  try {
    const res = await runPeek({ path: root });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body.toString()), { error: "not a file" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
