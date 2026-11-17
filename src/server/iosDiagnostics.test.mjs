import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readdir, readFile, stat, writeFile, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIosDiagnosticsHandler, sweepDiagnostics, validateDiagnostic, fileKind, utcStamp, MAX_BODY_BYTES, RETENTION } from "./iosDiagnostics.mjs";

let root;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "ios-diag-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function serve(deps) {
  const h = createIosDiagnosticsHandler(deps);
  const server = http.createServer((req, res) => void h.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = (body, headers = {}) =>
    new Promise((resolve, reject) => {
      const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port: server.address().port, method: "POST", path: "/api/diagnostics/ios", headers: { "content-type": "application/json", ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; } })() }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  return { h, post, close: () => new Promise((r) => server.close(r)) };
}

const BODY = { kind: "hang", appVersion: "1.3.0", build: "99", osVersion: "27.0.1", device: "iPhone18,1", source: "mxdiagnostic", payload: { callStackTree: { x: 1 } } };

test("a valid diagnostic is stored raw, atomically, dir 0700 / file 0600, with the C3 name shape", async () => {
  const dir = join(root, "ok");
  const s = await serve({ dir, now: () => Date.UTC(2026, 10, 17, 9, 30, 45), randomHex: () => "a1b2c3" });
  try {
    const r = await s.post(BODY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, id: "20261117T093045Z-hang-a1b2c3.json" });
    assert.deepEqual(JSON.parse(await readFile(join(dir, r.json.id), "utf8")), BODY);
    assert.equal((await stat(join(dir, r.json.id))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".tmp-")), [], "no temp file is left behind");
  } finally {
    await s.close();
  }
});

test("invalid JSON, a non-object body, or a missing kind is a 400; an unknown kind is stored as `other`", async () => {
  const dir = join(root, "bad");
  const s = await serve({ dir });
  try {
    assert.equal((await s.post("{nope")).status, 400);
    assert.equal((await s.post("[]")).status, 400);
    assert.equal((await s.post("null")).status, 400);
    assert.equal((await s.post({ appVersion: "1" })).status, 400);
    assert.equal((await s.post({ kind: "" })).status, 400);
    assert.equal((await s.post({ kind: 7 })).status, 400);
    const r = await s.post({ kind: "../../etc/passwd", payload: {} });
    assert.equal(r.status, 200);
    assert.match(r.json.id, /^\d{8}T\d{6}Z-other-[0-9a-f]{6}\.json$/, "a hostile kind never reaches the file name");
    assert.equal(JSON.parse(await readFile(join(dir, r.json.id), "utf8")).kind, "../../etc/passwd", "the body keeps what was sent");
    assert.equal((await readdir(dir)).length, 1, "rejected bodies write nothing");
  } finally {
    await s.close();
  }
});

test("a body over 2 MiB is a 413 {error:'too large'}, by header and by streamed size, and writes nothing", async () => {
  const dir = join(root, "big");
  const s = await serve({ dir });
  try {
    const big = JSON.stringify({ kind: "crash", payload: "x".repeat(MAX_BODY_BYTES + 10) });
    const r = await s.post(big);
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { error: "too large" });
    // Just under the limit is accepted.
    const ok = await s.post({ kind: "crash", payload: "y".repeat(MAX_BODY_BYTES - 1024) });
    assert.equal(ok.status, 200);
    assert.equal((await readdir(dir)).length, 1);
  } finally {
    await s.close();
  }
});

test("a chunked body with no content-length is capped while it streams", async () => {
  const dir = join(root, "lie");
  const h = createIosDiagnosticsHandler({ dir });
  const server = http.createServer((req, res) => void h.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/", headers: { "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", (e) => (e.code === "ECONNRESET" ? resolve(413) : reject(e)));
      req.write(Buffer.alloc(MAX_BODY_BYTES + 1, 0x20));
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("pure helpers: validateDiagnostic, fileKind, utcStamp", () => {
  assert.equal(validateDiagnostic({ kind: "crash" }).ok, true);
  assert.equal(validateDiagnostic({}).ok, false);
  assert.equal(fileKind("memoryException"), "memoryException");
  assert.equal(fileKind("whatever"), "other");
  assert.equal(utcStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678))), "20260102T030405Z");
});

async function seed(dir, names, { size = 10, ageMs = 0, now = Date.now() } = {}) {
  await mkdir(dir, { recursive: true });
  for (const [i, n] of names.entries()) {
    const p = join(dir, n);
    await writeFile(p, "x".repeat(size));
    const t = (now - ageMs + i * 1000) / 1000;
    await utimes(p, t, t);
  }
}

test("retention: files older than 30 days go; then the oldest beyond 500 files; then the oldest beyond 50 MiB", async () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const dir = join(root, "ret-age");
  await seed(dir, ["old-1.json", "old-2.json"], { ageMs: 31 * day, now });
  await seed(dir, ["new-1.json", "new-2.json"], { ageMs: 1 * day, now });
  assert.equal((await sweepDiagnostics({ dir, now: () => now })).removed, 2);
  assert.deepEqual((await readdir(dir)).sort(), ["new-1.json", "new-2.json"]);

  const many = join(root, "ret-count");
  const names = Array.from({ length: RETENTION.maxFiles + 3 }, (_, i) => `f${String(i).padStart(4, "0")}.json`);
  await seed(many, names, { ageMs: 60_000, now });
  assert.equal((await sweepDiagnostics({ dir: many, now: () => now })).removed, 3);
  const left = (await readdir(many)).sort();
  assert.equal(left.length, RETENTION.maxFiles);
  assert.equal(left[0], "f0003.json", "the three oldest were dropped");

  const fat = join(root, "ret-size");
  await seed(fat, ["a.json", "b.json", "c.json"], { size: 20 * 1024 * 1024, ageMs: 60_000, now });
  assert.equal((await sweepDiagnostics({ dir: fat, now: () => now })).removed, 1);
  assert.deepEqual((await readdir(fat)).sort(), ["b.json", "c.json"], "60 MiB > 50 MiB: the oldest goes");
});

test("retention: a missing directory is fine, non-diagnostic files are left alone, a stale temp file is removed", async () => {
  const now = Date.now();
  assert.deepEqual(await sweepDiagnostics({ dir: join(root, "nope"), now: () => now }), { removed: 0 });
  const dir = join(root, "ret-misc");
  await seed(dir, ["notes.txt", "x.json.tmp-1-2-3"], { ageMs: 2 * 60 * 60 * 1000, now });
  await seed(dir, ["fresh.json.tmp-1-2-4"], { ageMs: 1000, now });
  await sweepDiagnostics({ dir, now: () => now });
  assert.deepEqual((await readdir(dir)).sort(), ["fresh.json.tmp-1-2-4", "notes.txt"]);
});

test("every accepted write sweeps: the directory never exceeds the file cap", async () => {
  const dir = join(root, "write-sweep");
  const s = await serve({ dir, retention: { ...RETENTION, maxFiles: 3 } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.post({ ...BODY, n: i })).status, 200);
    assert.equal((await readdir(dir)).length, 3);
  } finally {
    await s.close();
  }
});
