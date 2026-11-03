// The per-request seat attribution log (seat-placement spec §5.5): a line per
// change of (session, seat, model) plus a heartbeat, a bounded fail-open queue
// with a gap marker, serialised append + rotation, and a reader that skips a
// torn last line. Real files in a temp dir; nothing touches ~/.manta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { appendFile, chmod, mkdir, rename, rm as fsRm, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_MS, createSeatAttribution, parseAttributionLines, readAttribution } from "./seatAttribution.mjs";

const quiet = { warn() {}, log() {} };
const MIN = 60_000;

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "seat-attr-"));
  try {
    await fn(join(dir, "seat-attribution"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function clock(start = 1_000_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

const req = (over = {}) => ({ provider: "claude", session: "s1", root: "s1", seat: "seat-1", model: "claude-opus-5-5", reason: "kept", ...over });

test("a line per change of (session, seat, model), none for a repeat, a heartbeat every 10 minutes", async () => {
  await withDir(async (dir) => {
    const c = clock();
    const log = createSeatAttribution({ dir, now: c.now, log: quiet });
    log.record(req({ reason: "assigned" }));
    log.record(req());
    c.tick(9 * MIN);
    log.record(req());
    c.tick(MIN);
    log.record(req()); // heartbeat
    c.tick(MIN);
    log.record(req()); // inside the new window again
    c.tick(MIN);
    log.record(req({ model: "claude-fable-5" })); // model changed
    c.tick(MIN);
    log.record(req({ model: "claude-fable-5", seat: "seat-2", reason: "moved:load" })); // seat changed
    await log.flush();
    const lines = await readAttribution({ dir, provider: "claude" });
    assert.deepEqual(lines.map((l) => [l.seat, l.model, l.reason]), [
      ["seat-1", "claude-opus-5-5", "assigned"],
      ["seat-1", "claude-opus-5-5", "kept"],
      ["seat-1", "claude-fable-5", "kept"],
      ["seat-2", "claude-fable-5", "moved:load"],
    ]);
    assert.equal(lines[1].t - lines[0].t, 10 * MIN);
    assert.equal(HEARTBEAT_MS, 10 * MIN);
    assert.deepEqual(Object.keys(lines[0]), ["t", "session", "root", "seat", "model", "reason"]);
  });
});

test("A→B→A inside 10 minutes is three lines", async () => {
  await withDir(async (dir) => {
    const c = clock();
    const log = createSeatAttribution({ dir, now: c.now, log: quiet });
    log.record(req({ seat: "seat-1" }));
    c.tick(MIN);
    log.record(req({ seat: "seat-2", reason: "moved:load" }));
    c.tick(MIN);
    log.record(req({ seat: "seat-1", reason: "moved:exhausted" }));
    await log.flush();
    assert.deepEqual((await readAttribution({ dir, provider: "claude" })).map((l) => l.seat), ["seat-1", "seat-2", "seat-1"]);
  });
});

test("a child session is recorded as itself with its root; sessions are tracked independently; providers get their own files", async () => {
  await withDir(async (dir) => {
    const c = clock();
    const log = createSeatAttribution({ dir, now: c.now, log: quiet });
    log.record(req({ session: "root", root: "root" }));
    log.record(req({ session: "child", root: "root" }));
    log.record(req({ provider: "codex", session: "root", root: "root", seat: "seat-9" }));
    log.record({ provider: "claude", session: "none", root: "none", seat: null, model: null, reason: "none" });
    await log.flush();
    const claude = await readAttribution({ dir, provider: "claude" });
    assert.deepEqual(claude.map((l) => [l.session, l.root, l.seat]), [["root", "root", "seat-1"], ["child", "root", "seat-1"], ["none", "none", null]]);
    assert.deepEqual((await readAttribution({ dir, provider: "codex" })).map((l) => l.seat), ["seat-9"]);
    assert.deepEqual((await readdir(dir)).sort(), ["claude.jsonl", "codex.jsonl"]);
  });
});

test("files are 0600 in a 0700 directory; a bad provider or session is ignored, never thrown", async () => {
  await withDir(async (dir) => {
    const log = createSeatAttribution({ dir, log: quiet });
    log.record(req());
    log.record(req({ provider: "../evil" }));
    log.record(req({ session: "" }));
    log.record(null);
    log.record(undefined);
    await log.flush();
    assert.deepEqual(await readdir(dir), ["claude.jsonl"]);
    assert.equal((await stat(join(dir, "claude.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });
});

test("fail-open: a failing disk never throws or rejects, warns at most once a minute, and the log recovers", async () => {
  await withDir(async (dir) => {
    const c = clock();
    const warns = [];
    let broken = true;
    const fs = {
      mkdir,
      chmod,
      stat: fsStat,
      rename,
      rm: fsRm,
      appendFile: async (...a) => {
        if (broken) throw new Error("EIO");
        return appendFile(...a);
      },
    };
    const log = createSeatAttribution({ dir, now: c.now, log: { warn: (...a) => warns.push(a) }, fs });
    log.record(req({ session: "a" }));
    await log.flush();
    log.record(req({ session: "b" }));
    await log.flush();
    assert.equal(warns.length, 1, "one warning inside the minute");
    c.tick(2 * MIN);
    log.record(req({ session: "c" }));
    await log.flush();
    assert.equal(warns.length, 2);
    assert.equal(log.stats().failed >= 3, true);
    broken = false;
    log.record(req({ session: "d" }));
    await log.flush();
    assert.deepEqual((await readAttribution({ dir, provider: "claude" })).map((l) => l.session), ["d"]);
    // a throwing logger or a hostile argument getter cannot break `record` either
    const hostile = createSeatAttribution({ dir, log: { warn() { throw new Error("logger broke"); } }, fs: { ...fs, appendFile: async () => { throw new Error("x"); } } });
    hostile.record({ get provider() { throw new Error("getter"); } });
    hostile.record(req());
    await assert.doesNotReject(hostile.flush());
  });
});

test("the queue is bounded: overflow drops the oldest, counts it, resets the dedupe state and writes a gap marker ahead of what survived", async () => {
  await withDir(async (dir) => {
    const c = clock();
    const log = createSeatAttribution({ dir, now: c.now, log: quiet, queueMax: 3 });
    for (const session of ["s1", "s2", "s3", "s4", "s5"]) {
      log.record(req({ session }));
      c.tick(1000);
    }
    assert.equal(log.stats().queued, 3);
    assert.equal(log.stats().dropped, 2);
    await log.flush();
    const lines = await readAttribution({ dir, provider: "claude" });
    assert.deepEqual(lines.map((l) => l.session ?? `gap:${l.dropped}`), ["gap:2", "s3", "s4", "s5"]);
    assert.equal(lines[0].reason, "gap");
    assert.equal(lines[0].t, lines[1].t, "the gap sits right before what survived");
    // dedupe was reset: an unchanged session is written again instead of being assumed covered
    log.record(req({ session: "s3" }));
    await log.flush();
    assert.equal((await readAttribution({ dir, provider: "claude" })).filter((l) => l.session === "s3").length, 2);
    assert.equal(log.stats().dropped, 2, "no new drops");
  });
});

test("a gap with nothing left for the provider is still written; one provider's drops do not mark another's file", async () => {
  await withDir(async (dir) => {
    const log = createSeatAttribution({ dir, log: quiet, queueMax: 1 });
    log.record(req({ provider: "codex", session: "x" }));
    log.record(req({ provider: "claude", session: "y" }));
    await log.flush();
    assert.deepEqual((await readAttribution({ dir, provider: "codex" })).map((l) => [l.reason, l.dropped]), [["gap", 1]]);
    assert.deepEqual((await readAttribution({ dir, provider: "claude" })).map((l) => l.session), ["y"]);
  });
});

test("append and rotation are serialised: no two file operations overlap, nothing is lost or torn, old files shift up", async () => {
  await withDir(async (dir) => {
    const c = clock();
    let active = 0;
    let maxActive = 0;
    const slow = (fn) => async (...a) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await fn(...a);
      } finally {
        active--;
      }
    };
    const fs = { mkdir: slow(mkdir), chmod: slow(chmod), stat: slow(fsStat), rename: slow(rename), rm: slow(fsRm), appendFile: slow(appendFile) };
    const log = createSeatAttribution({ dir, now: c.now, log: quiet, maxBytes: 400, keep: 10, fs });
    for (let i = 0; i < 40; i++) {
      log.record(req({ session: `s${i}` }));
      c.tick(10);
      if (i % 7 === 0) await new Promise((r) => setTimeout(r, 3)); // let some drains interleave with new records
    }
    await log.flush();
    assert.equal(maxActive, 1);
    const files = (await readdir(dir)).sort();
    assert.ok(files.length > 2, `rotated: ${files.join(",")}`);
    assert.ok(files.includes("claude.jsonl") && files.includes("claude.jsonl.1"));
    const lines = await readAttribution({ dir, provider: "claude", keep: 10 });
    assert.deepEqual(lines.map((l) => l.session), Array.from({ length: 40 }, (_, i) => `s${i}`), "every line, once, oldest first");
  });
});

test("rotation keeps `keep` files in all and drops the oldest", async () => {
  await withDir(async (dir) => {
    const log = createSeatAttribution({ dir, log: quiet, maxBytes: 250, keep: 3 });
    for (let i = 0; i < 30; i++) {
      log.record(req({ session: `s${i}` }));
      await log.flush();
    }
    assert.deepEqual((await readdir(dir)).sort(), ["claude.jsonl", "claude.jsonl.1", "claude.jsonl.2"]);
    const sessions = (await readAttribution({ dir, provider: "claude", keep: 3 })).map((l) => l.session);
    assert.equal(sessions.at(-1), "s29");
    assert.ok(sessions.length < 30 && sessions.length > 3);
  });
});

test("a torn last line (a crash mid-append) is skipped by the reader; the rest is returned", async () => {
  await withDir(async (dir) => {
    const log = createSeatAttribution({ dir, log: quiet });
    log.record(req({ session: "a" }));
    log.record(req({ session: "b" }));
    await log.flush();
    const file = join(dir, "claude.jsonl");
    await writeFile(file, (await readFile(file, "utf-8")) + '{"t":123,"session":"torn","se');
    assert.deepEqual((await readAttribution({ dir, provider: "claude" })).map((l) => l.session), ["a", "b"]);
    assert.deepEqual(parseAttributionLines('{"a":1}\n\nnot json\n[1]\n"str"\n{"b":2}\n{"c":'), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(await readAttribution({ dir, provider: "nobody" }), [], "a missing log reads as empty");
  });
});
