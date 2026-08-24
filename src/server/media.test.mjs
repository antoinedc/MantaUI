// Tests for media.mjs pure logic + injected I/O — no live fs, HTTP, or crypto
// randomness beyond the handle generator. Run via `npm run test:server`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readImageSize,
  guessMime,
  resolvePathWithinHome,
  createPendingMediaStore,
  saveMedia,
  beginMedia,
  showMedia,
  sweepPendingMedia,
  createMediaSweep,
  dispatch,
} from "./media.mjs";

// ---------------------------------------------------------------------------
// Header builders — hand-crafted valid headers for the four supported formats
// ---------------------------------------------------------------------------

function pngHdr(width, height) {
  const b = Buffer.alloc(24);
  b.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gifHdr(width, height) {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function jpegHdr(width, height) {
  const b = Buffer.alloc(11);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xc0; // SOF0
  b.writeUInt16BE(8, 4); // segment length
  b[6] = 8; // precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

function webpLossyHdr(width, height) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(26, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt32LE(10, 16);
  b[20] = 0x9d;
  b[21] = 0x01;
  b[22] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

// ---------------------------------------------------------------------------
// readImageSize
// ---------------------------------------------------------------------------

test("readImageSize: valid PNG/JPEG/GIF/WebP headers → correct dimensions", () => {
  assert.deepEqual(readImageSize(pngHdr(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(readImageSize(jpegHdr(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(readImageSize(gifHdr(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(readImageSize(webpLossyHdr(1024, 768)), { width: 1024, height: 768 });
});

test("readImageSize: unknown bytes → null", () => {
  assert.equal(readImageSize(Buffer.from("totally not an image", "latin1")), null);
  assert.equal(readImageSize(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c])), null);
});

test("readImageSize: truncated input → null, never a throw", () => {
  assert.equal(readImageSize(Buffer.alloc(0)), null);
  assert.equal(readImageSize(Buffer.alloc(3)), null);
  // PNG signature but no IHDR body.
  assert.equal(readImageSize(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")), null);
  // GIF signature but no screen descriptor.
  assert.equal(readImageSize(Buffer.from("GIF89a", "latin1")), null);
  // JPEG with SOI only.
  assert.equal(readImageSize(Buffer.from([0xff, 0xd8, 0xff])), null);
  // WebP lossy with start code but truncated dims.
  assert.equal(readImageSize(webpLossyHdr(100, 100).subarray(0, 25)), null);
});

test("readImageSize: non-buffer input → null", () => {
  assert.equal(readImageSize("not a buffer"), null);
  assert.equal(readImageSize(null), null);
  assert.equal(readImageSize(undefined), null);
});

// ---------------------------------------------------------------------------
// guessMime
// ---------------------------------------------------------------------------

test("guessMime maps known extensions and falls back to octet-stream", () => {
  assert.equal(guessMime("photo.png"), "image/png");
  assert.equal(guessMime("clip.MP4"), "video/mp4");
  assert.equal(guessMime("a.webm"), "video/webm");
  assert.equal(guessMime("unknown.xyz"), "application/octet-stream");
  assert.equal(guessMime(""), "application/octet-stream");
});

// ---------------------------------------------------------------------------
// resolvePathWithinHome (the /api/peek home-only rule)
// ---------------------------------------------------------------------------

const HOME = "/home/alice";

test("resolvePathWithinHome: accepts a path inside home", () => {
  assert.equal(resolvePathWithinHome("/home/alice/img.png", HOME), "/home/alice/img.png");
  assert.equal(resolvePathWithinHome("/home/alice/dir/img.png", HOME), "/home/alice/dir/img.png");
});

test("resolvePathWithinHome: accepts a leading ~ (lone and prefixed)", () => {
  assert.equal(resolvePathWithinHome("~/img.png", HOME), "/home/alice/img.png");
  assert.equal(resolvePathWithinHome("~", HOME), "/home/alice/");
});

test("resolvePathWithinHome: rejects a path outside home", () => {
  assert.equal(resolvePathWithinHome("/etc/passwd", HOME), null);
  assert.equal(resolvePathWithinHome("/home/alicex/stuff", HOME), null);
  assert.equal(resolvePathWithinHome("/", HOME), null);
});

test("resolvePathWithinHome: rejects empty / non-string input", () => {
  assert.equal(resolvePathWithinHome("", HOME), null);
  assert.equal(resolvePathWithinHome(null, HOME), null);
  assert.equal(resolvePathWithinHome(undefined, HOME), null);
});

// ---------------------------------------------------------------------------
// saveMedia
// ---------------------------------------------------------------------------

function saveHarness({ file = jpegHdr(200, 100) } = {}) {
  const pushed = [];
  const writes = [];
  const deps = {
    readFile: async () => file,
    writeFile: async (p, buf) => writes.push([p, buf]),
    rm: async () => {},
    mkdtemp: async () => "/tmp/fake-media-dir",
    tmpdir: () => "/tmp",
    pushArtifact: async (path, sid, opts) => {
      pushed.push({ path, sid, opts });
      return { ok: true, row: { path: `/home/alice/.manta-outbox/${sid}/img.jpeg`, name: "img.jpeg", size: file.length } };
    },
  };
  return { pushed, writes, deps };
}

test("saveMedia: accepts data (base64) and returns measured metadata", async () => {
  const { pushed, writes, deps } = saveHarness({ file: pngHdr(300, 200) });
  const r = await saveMedia(
    { data: pngHdr(300, 200).toString("base64"), filename: "gen.png", sessionID: "s1", messageID: "m1" },
    deps,
  );
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.equal(r.width, 300);
  assert.equal(r.height, 200);
  assert.equal(writes.length, 1); // decoded blob staged to temp
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].sid, "s1");
  assert.deepEqual(pushed[0].opts, { messageID: "m1", media: true });
});

test("saveMedia: accepts sourcePath (existing file) as-is", async () => {
  const { pushed, deps } = saveHarness({ file: gifHdr(50, 25) });
  const r = await saveMedia({ sourcePath: "/home/alice/gif.gif", sessionID: "s2" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/gif");
  assert.equal(r.width, 50);
  assert.equal(r.height, 25);
  assert.equal(pushed[0].path, "/home/alice/gif.gif");
});

test("saveMedia: unmeasurable data returns null dimensions (video), not an error", async () => {
  const { deps } = saveHarness({ file: Buffer.from("plain videobytes", "latin1") });
  const r = await saveMedia({ data: Buffer.from("plain videobytes", "latin1").toString("base64"), filename: "clip.mp4", sessionID: "s3" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "video/mp4");
  assert.equal(r.width, null);
  assert.equal(r.height, null);
});

test("saveMedia: rejects when both data AND sourcePath are given", async () => {
  const { deps } = saveHarness();
  const r = await saveMedia({ data: "abc", sourcePath: "/x", sessionID: "s" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /not both/);
});

test("saveMedia: rejects when neither data nor sourcePath is given", async () => {
  const { deps } = saveHarness();
  const r = await saveMedia({ sessionID: "s" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /data.*sourcePath.*is required/);
});

test("saveMedia: requires sessionID", async () => {
  const { deps } = saveHarness();
  const r = await saveMedia({ data: "aGVsbG8=" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /sessionID is required/);
});

// ---------------------------------------------------------------------------
// showMedia — path validation + publish
// ---------------------------------------------------------------------------

function showHarness({ home = "/home/alice", file = jpegHdr(120, 80) } = {}) {
  const published = [];
  const pending = createPendingMediaStore();
  const deps = {
    home,
    readFile: async () => file,
    pending,
    publish: (payload) => published.push(payload),
  };
  return { published, pending, deps };
}

test("showMedia: rejects a path outside home", async () => {
  const { published, deps } = showHarness();
  const r = await showMedia({ path: "/etc/passwd", sessionID: "s" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /inside the user's home/);
  assert.equal(published.length, 0);
});

test("showMedia: accepts a path inside home and measures it", async () => {
  const { published, deps } = showHarness();
  const r = await showMedia({ path: "/home/alice/img.jpeg", sessionID: "s" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.width, 120);
  assert.equal(r.height, 80);
  assert.equal(published[0].action, "show");
  assert.equal(published[0].width, 120);
  assert.equal(published[0].height, 80);
});

test("showMedia: accepts a leading ~", async () => {
  const { published, deps } = showHarness();
  const r = await showMedia({ path: "~/img.jpeg", sessionID: "s" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/home/alice/img.jpeg");
  assert.equal(r.width, 120);
  assert.equal(published[0].path, "/home/alice/img.jpeg");
});

test("showMedia: with no handle still publishes a show payload", async () => {
  const { published, pending, deps } = showHarness();
  const r = await showMedia({ path: "/home/alice/img.jpeg", sessionID: "s" }, deps);
  assert.equal(r.ok, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].action, "show");
  assert.equal(published[0].handle, null);
  assert.equal(pending.size(), 0); // nothing to clear, no throw
});

// ---------------------------------------------------------------------------
// beginMedia → showMedia with handle clears the pending entry
// ---------------------------------------------------------------------------

test("beginMedia → showMedia with handle clears the pending entry", async () => {
  const pending = createPendingMediaStore();
  const published = [];
  const deps = { pending, publish: (p) => published.push(p) };
  const begin = await beginMedia({ kind: "image", width: 800, height: 600, title: "hero", sessionID: "s", messageID: "m" }, deps);
  assert.equal(begin.ok, true);
  assert.match(begin.handle, /^[0-9a-f]{32}$/);
  assert.equal(pending.size(), 1);

  const seen = published.filter((p) => p.action === "begin");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].handle, begin.handle);
  assert.equal(seen[0].action, "begin");
  assert.equal(seen[0].kind, "image");
  assert.equal(seen[0].width, 800);
  assert.equal(seen[0].title, "hero");

  const showDeps = { pending, publish: (p) => published.push(p), home: "/home/alice", readFile: async () => pngHdr(800, 600) };
  const show = await showMedia({ path: "/home/alice/img.png", handle: begin.handle, sessionID: "s" }, showDeps);
  assert.equal(show.ok, true);
  assert.equal(pending.size(), 0); // cleared
  const shows = published.filter((p) => p.action === "show");
  assert.equal(shows.length, 1);
  assert.equal(shows[0].handle, begin.handle);
});

test("beginMedia: rejects a non image/video kind", async () => {
  const pending = createPendingMediaStore();
  const r = await beginMedia({ kind: "audio", sessionID: "s" }, { pending });
  assert.equal(r.ok, false);
  assert.match(r.error, /image.*video/);
  assert.equal(pending.size(), 0);
});

// ---------------------------------------------------------------------------
// sweepPendingMedia / createMediaSweep — 10-minute orphan rule
// ---------------------------------------------------------------------------

test("sweepPendingMedia: returns only entries older than 10 minutes", () => {
  // Pin the clock. This used to call Date.now() once per entry and again for
  // the sweep, so a millisecond ticking over between the "border" entry and
  // the sweep made that entry strictly older than 10 minutes and swept it —
  // a real, rare red on an unrelated PR. The boundary is exactly what this
  // test asserts, so it has to be measured against a single instant.
  const now = Date.now();
  const pending = createPendingMediaStore();
  const age = (ms) => ({ createdAt: ms, sessionID: "s" });
  pending.set("old", age(now - 11 * 60 * 1000));
  pending.set("border", age(now - 10 * 60 * 1000));
  pending.set("fresh", age(now - 1000));

  const expired = sweepPendingMedia(now, pending);
  assert.deepEqual([...expired].sort(), ["old"]);
});

test("createMediaSweep: publishes fail for orphans and clears them", () => {
  const pending = createPendingMediaStore();
  const published = [];
  let fakeNow = Date.now();
  const sweep = createMediaSweep({
    pending,
    publish: (p) => published.push(p),
    now: () => fakeNow,
    intervalMs: 1000,
  });
  const handle = "a".repeat(32);
  pending.set(handle, { createdAt: fakeNow - 11 * 60 * 1000, sessionID: "s", messageID: "m" });

  sweep.sweep();
  assert.equal(published.length, 1);
  assert.equal(published[0].action, "fail");
  assert.equal(published[0].handle, handle);
  assert.equal(published[0].sessionID, "s");
  assert.equal(pending.size(), 0);

  // Fresh entry survives a sweep.
  pending.set("fresh", { createdAt: fakeNow, sessionID: "s" });
  sweep.sweep();
  assert.equal(pending.get("fresh") !== undefined, true);
});

// ---------------------------------------------------------------------------
// dispatch — one switch, unknown action rejected by name
// ---------------------------------------------------------------------------

test("dispatch: rejects an unknown action by name", async () => {
  const r = await dispatch("explode", {}, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown action "explode"/);
  assert.match(r.error, /save, begin, show/);
});

test("dispatch: routes the three known actions", async () => {
  const pending = createPendingMediaStore();
  const published = [];
  const deps = {
    pending,
    publish: (p) => published.push(p),
    home: "/home/alice",
    readFile: async () => pngHdr(10, 10),
    writeFile: async () => {},
    rm: async () => {},
    mkdtemp: async () => "/tmp/fd",
    pushArtifact: async (p, sid) => ({ ok: true, row: { path: p, name: "x.png", size: 1 } }),
  };
  const begin = await dispatch("begin", { kind: "image", sessionID: "s" }, deps);
  assert.equal(begin.ok, true);
  const show = await dispatch("show", { path: "/home/alice/x.png", handle: begin.handle, sessionID: "s" }, deps);
  assert.equal(show.ok, true);
  const save = await dispatch("save", { data: pngHdr(10, 10).toString("base64"), filename: "x.png", sessionID: "s" }, deps);
  assert.equal(save.ok, true);

  const actions = published.map((p) => p.action);
  assert.deepEqual(actions, ["begin", "show"]);
});
