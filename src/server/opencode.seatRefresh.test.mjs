// Per-seat Claude credential refresh (multi-account spec §3).
// The real `claude` CLI is never run: spawn is injected and "refreshes" by
// rewriting the seat's fake credentials file, which is what the CLI does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeRefreshEnv,
  refreshClaudeSeatCredentials,
  createCredentialRefreshSweep,
} from "./opencode.mjs";

const NOW = 1_800_000_000_000;
const creds = (access, expiresAt) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `r-${access}`, expiresAt, refreshTokenExpiresAt: NOW + 30 * 86_400_000 } });

async function seatDir(name, access, expiresAt) {
  const root = await mkdtemp(join(tmpdir(), "seat-refresh-"));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".credentials.json"), creds(access, expiresAt));
  return { root, dir };
}

// A fake child process: after `run()` it "exits".
function fakeSpawn(run, calls = []) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const proc = new EventEmitter();
    setImmediate(async () => {
      try {
        await run?.(opts);
      } finally {
        proc.emit("exit", 0);
      }
    });
    return proc;
  };
}

test("claudeRefreshEnv: a seat gets CLAUDE_CONFIG_DIR; the live refresh does not", () => {
  const base = { PATH: "/usr/bin", HOME: "/h" };
  assert.equal(claudeRefreshEnv(base, "linux", "/seats/seat-1").CLAUDE_CONFIG_DIR, "/seats/seat-1");
  assert.equal("CLAUDE_CONFIG_DIR" in claudeRefreshEnv(base, "linux"), false);
  assert.equal(claudeRefreshEnv(base, "linux").TERM, "dumb");
  assert.ok(claudeRefreshEnv(base, "linux").PATH.endsWith("/usr/bin"));
});

test("refreshClaudeSeatCredentials: runs claude with CLAUDE_CONFIG_DIR=<seat dir> via an argv array, and reports ok when the seat file advanced", async () => {
  const { root, dir } = await seatDir("seat-1", "old", NOW + 60_000);
  try {
    const calls = [];
    const r = await refreshClaudeSeatCredentials(
      { seatId: "seat-1", dir },
      {
        now: () => NOW,
        resolveBin: () => "/fake/claude",
        spawn: fakeSpawn(async () => writeFile(join(dir, ".credentials.json"), creds("new", NOW + 8 * 3_600_000)), calls),
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.expiresAt, NOW + 8 * 3_600_000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "/fake/claude");
    assert.deepEqual(calls[0].args, ["-p", ".", "--model", "haiku"]);
    assert.equal(calls[0].opts.env.CLAUDE_CONFIG_DIR, dir);
    assert.equal(calls[0].opts.shell, undefined, "no shell");
    assert.equal(JSON.parse(await readFile(join(dir, ".credentials.json"), "utf-8")).claudeAiOauth.accessToken, "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshClaudeSeatCredentials: a CLI that changes nothing is a failure, not a success", async () => {
  const { root, dir } = await seatDir("seat-1", "old", NOW + 60_000);
  try {
    const r = await refreshClaudeSeatCredentials(
      { seatId: "seat-1", dir },
      { now: () => NOW, resolveBin: () => "/fake/claude", spawn: fakeSpawn() },
    );
    assert.deepEqual(r, { ok: false, reason: "failed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshClaudeSeatCredentials: a seat with no credentials never spawns anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-refresh-"));
  try {
    const calls = [];
    const r = await refreshClaudeSeatCredentials(
      { seatId: "seat-1", dir: join(root, "nope") },
      { now: () => NOW, resolveBin: () => "/fake/claude", spawn: fakeSpawn(null, calls) },
    );
    assert.deepEqual(r, { ok: false, reason: "no-credentials" });
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshClaudeSeatCredentials: single-flight per seat directory", async () => {
  const { root, dir } = await seatDir("seat-1", "old", NOW + 60_000);
  try {
    const calls = [];
    const deps = {
      now: () => NOW,
      resolveBin: () => "/fake/claude",
      spawn: fakeSpawn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        await writeFile(join(dir, ".credentials.json"), creds("new", NOW + 8 * 3_600_000));
      }, calls),
    };
    const [a, b] = await Promise.all([
      refreshClaudeSeatCredentials({ seatId: "seat-1", dir }, deps),
      refreshClaudeSeatCredentials({ seatId: "seat-1", dir }, deps),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweep: live refresh is unchanged, and expiring seats are refreshed while comfortable ones are left alone", async () => {
  const soon = await seatDir("seat-1", "soon", NOW + 5 * 60_000);
  const later = await seatDir("seat-2", "later", NOW + 5 * 3_600_000);
  try {
    const liveRefreshes = [];
    const seatRefreshes = [];
    const { sweep } = createCredentialRefreshSweep({
      now: () => NOW,
      readCreds: () => ({ expiresAt: NOW + 5 * 60_000, refreshTokenExpiresAt: NOW + 1e9 }),
      refresh: async () => liveRefreshes.push("live"),
      listSeatTargets: async () => [{ seatId: "seat-1", dir: soon.dir }, { seatId: "seat-2", dir: later.dir }],
      refreshSeat: async (t) => seatRefreshes.push(t.seatId),
    });
    await sweep();
    assert.deepEqual(liveRefreshes, ["live"]);
    assert.deepEqual(seatRefreshes, ["seat-1"]);
  } finally {
    await rm(soon.root, { recursive: true, force: true });
    await rm(later.root, { recursive: true, force: true });
  }
});

test("sweep: one seat throwing does not stop the next; a broken seat store does not stop the live refresh", async () => {
  const a = await seatDir("seat-1", "a", NOW + 60_000);
  const b = await seatDir("seat-2", "b", NOW + 60_000);
  try {
    const refreshed = [];
    const { sweep } = createCredentialRefreshSweep({
      now: () => NOW,
      readCreds: () => ({ expiresAt: NOW + 60_000, refreshTokenExpiresAt: NOW + 1e9 }),
      refresh: async () => refreshed.push("live"),
      listSeatTargets: async () => [{ seatId: "seat-1", dir: a.dir }, { seatId: "seat-2", dir: b.dir }],
      refreshSeat: async (t) => {
        refreshed.push(t.seatId);
        if (t.seatId === "seat-1") throw new Error("boom");
      },
    });
    await sweep();
    assert.deepEqual(refreshed, ["live", "seat-1", "seat-2"]);

    const refreshed2 = [];
    const { sweep: sweep2 } = createCredentialRefreshSweep({
      now: () => NOW,
      readCreds: () => ({ expiresAt: NOW + 60_000, refreshTokenExpiresAt: NOW + 1e9 }),
      refresh: async () => refreshed2.push("live"),
      listSeatTargets: async () => {
        throw new Error("store down");
      },
    });
    await sweep2();
    assert.deepEqual(refreshed2, ["live"]);
  } finally {
    await rm(a.root, { recursive: true, force: true });
    await rm(b.root, { recursive: true, force: true });
  }
});

test("sweep: with no seat options it behaves exactly as before (live only)", async () => {
  const refreshed = [];
  const { sweep } = createCredentialRefreshSweep({
    now: () => NOW,
    readCreds: () => ({ expiresAt: NOW + 60_000, refreshTokenExpiresAt: NOW + 1e9 }),
    refresh: async () => refreshed.push("live"),
  });
  await sweep();
  assert.deepEqual(refreshed, ["live"]);
});
