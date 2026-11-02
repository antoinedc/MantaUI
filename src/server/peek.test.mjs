// Tests for the /api/peek file-serving route. These drive the REAL handler
// (src/server/peek.mjs, the same module index.mjs calls) with real node:fs I/O
// and a fake Writable response — no re-implemented mock. Plus the pure
// parseByteRange unit tests.
// Run via `npm run test:server` (node:test).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeFile, mkdir, rm, mkdtemp, realpath, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseByteRange } from "./range.mjs";
import { createPeekHandler, createDownloadHandler } from "./peek.mjs";
import { createHomePath } from "./homePath.mjs";

const MIME = {
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

// A throwaway "home" (and a sibling "outside" dir) so the real home-scoped
// policy runs against real files without touching the maintainer's home.
let root;
let home;
let outside;
let openInHome;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "peek-test-")));
  home = join(root, "home");
  outside = join(root, "outside");
  await mkdir(home);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret");
  ({ openInHome } = createHomePath({ homedir: () => home }));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// The real handler, wired with the real policy + fs, driven in-process.
function makeHandler() {
  return createPeekHandler({ openInHome, pipeline, MIME });
}

function makeDownloadHandler() {
  return createDownloadHandler({ openInHome, pipeline });
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

// Create a throwaway test dir inside the fake home dir.
function tempRoot(tag) {
  return join(home, `peek-${tag}-${Date.now()}`);
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
  const file = join(home, `peek-home-${ts}.txt`);
  await writeFile(file, "home file content");
  try {
    const res = await runPeek({ path: `~/peek-home-${ts}.txt` });
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

test("/api/peek rejects a path outside home with 403 + reason", async () => {
  const res = await runPeek({ path: join(outside, "secret.txt") });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body.toString()), {
    error: "path outside home directory",
    reason: "outside-home",
  });
});

test("/api/peek rejects a .. escape with 403", async () => {
  const res = await runPeek({ path: join(home, "..", "outside", "secret.txt") });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body.toString()).reason, "outside-home");
});

test("/api/peek rejects a symlink that escapes home with 403 (never serves the target)", async () => {
  await symlink(join(outside, "secret.txt"), join(home, "peek-escape-link"));
  const res = await runPeek({ path: join(home, "peek-escape-link") });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.toString().includes("secret"), false);
  assert.equal(JSON.parse(res.body.toString()).reason, "outside-home");
});

test("/api/peek serves a symlink that stays inside home", async () => {
  const dir = tempRoot("inlink");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "real.txt"), CONTENT);
  await symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
  const res = await runPeek({ path: join(dir, "alias.txt") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), CONTENT);
  assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
});

test("/api/peek returns 404 + reason for a non-existent file", async () => {
  const res = await runPeek({ path: join(home, "nonexistent-file-12345.txt") });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body.toString()), { error: "not found", reason: "missing" });
});

test("/api/peek returns 404 + reason for a directory", async () => {
  const root = tempRoot("dir");
  await mkdir(root, { recursive: true });
  try {
    const res = await runPeek({ path: root });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body.toString()), { error: "not a file", reason: "not-file" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/peek returns 403 + reason for an unreadable path", { skip: process.getuid?.() === 0 }, async () => {
  const dir = tempRoot("locked");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "f.txt"), "f");
  await chmod(dir, 0o000);
  try {
    const res = await runPeek({ path: join(dir, "f.txt") });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.body.toString()), { error: "permission denied", reason: "permission" });
  } finally {
    await chmod(dir, 0o755);
    await rm(dir, { recursive: true, force: true });
  }
});

test("/api/peek maps changed/unavailable to 503 with safe bodies (no raw error text)", async () => {
  for (const reason of ["changed", "unavailable"]) {
    const handler = createPeekHandler({
      openInHome: async () => ({ ok: false, reason }),
      pipeline,
      MIME,
    });
    const res = new FakeRes();
    await handler(request("GET"), res, peekUrl("/whatever"));
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.reason, reason);
    assert.equal(typeof body.error, "string");
    assert.ok(!/ENOENT|EACCES|\/home|\/tmp/.test(body.error));
  }
});

// ---------------------------------------------------------------------------
// /api/download — same policy, attachment headers, non-destructive
// ---------------------------------------------------------------------------

function downloadUrl(absPath) {
  return new URL("http://127.0.0.1:8787/api/download?path=" + encodeURIComponent(absPath));
}

async function runDownload(path) {
  const res = new FakeRes();
  await makeDownloadHandler()(request("GET"), res, downloadUrl(path));
  return res;
}

test("/api/download streams the file as an attachment and leaves it in place", async () => {
  const dir = tempRoot("dl");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "report.txt");
  await writeFile(file, CONTENT);
  try {
    const res = await runDownload(file);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/octet-stream");
    assert.equal(res.headers["content-length"], String(Buffer.byteLength(CONTENT)));
    assert.equal(res.headers["content-disposition"], 'attachment; filename="report.txt"');
    assert.equal(res.body.toString(), CONTENT);
    const again = await runDownload(file);
    assert.equal(again.statusCode, 200, "re-download is allowed — nothing was deleted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/api/download expands ~ and works anywhere inside home", async () => {
  const ts = Date.now();
  await writeFile(join(home, `dl-home-${ts}.txt`), "x");
  const res = await runDownload(`~/dl-home-${ts}.txt`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), "x");
});

test("/api/download refuses outside-home (also via symlink), missing, directory, empty path", async () => {
  await symlink(join(outside, "secret.txt"), join(home, "dl-escape-link"));
  const cases = [
    [join(outside, "secret.txt"), 403, "outside-home"],
    [join(home, "dl-escape-link"), 403, "outside-home"],
    [join(home, "dl-nope.txt"), 404, "missing"],
    [home, 404, "not-file"],
  ];
  for (const [path, status, reason] of cases) {
    const res = await runDownload(path);
    assert.equal(res.statusCode, status, path);
    assert.equal(JSON.parse(res.body.toString()).reason, reason, path);
    assert.equal(res.body.toString().includes("secret"), false);
  }
  const empty = await runDownload("");
  assert.equal(empty.statusCode, 400);
});
