// upgradeV2Reclaim.test.mjs — "reclaim disk space" (K7, spec §6) after a copy-mode V2 migration.
//
// SAFETY: every test runs on the REAL filesystem inside a temp root it created, with the home dir,
// the running-PID lookup and the open-file reader injected so they only ever point at fixture
// files. Before EVERY unlink the injected fs asserts the path is inside that root — a test (or a
// bug) that tried to delete anything else throws instead. Nothing here touches ~/.manta,
// ~/.local/share/opencode or ~/.opencode.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, existsSync, realpathSync, rmSync, readFileSync, openSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  createDefaultDeps,
  createReclaimFs,
  createUpgradeRoutes,
  createUpgradeV2,
  RECLAIM_REASONS,
  ROLLBACK_REFUSED_AFTER_RECLAIM,
} from "./upgradeV2.mjs";
import { parseLsofNames, readOpencodeMainPid, readOpenFiles } from "./upgradeV2Service.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const NEVER = () => new Promise(() => {});

/**
 * A fixture box inside a fresh temp root:
 *   data/opencode.db(+wal,+shm)   the untouched V1 history            (reclaim targets)
 *   data/opencode-v2.db(+wal,+shm) the live V2 copy                   (must survive)
 *   home/.opencode/bin/opencode-v1 the kept V1 binary                 (reclaim target)
 */
function makeFixture(opts = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reclaim-test-")));
  roots.push(root);
  const data = join(root, "data");
  const home = join(root, "home");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, ".opencode", "bin"), { recursive: true });
  const f = {
    root,
    data,
    home,
    v1: join(data, "opencode.db"),
    v1wal: join(data, "opencode.db-wal"),
    v1shm: join(data, "opencode.db-shm"),
    live: join(data, "opencode-v2.db"),
    livewal: join(data, "opencode-v2.db-wal"),
    liveshm: join(data, "opencode-v2.db-shm"),
    bin: join(home, ".opencode", "bin", "opencode-v1"),
  };
  const put = (p, n) => writeFileSync(p, Buffer.alloc(n, 1));
  put(f.v1, 1000);
  put(f.v1wal, 200);
  put(f.v1shm, 30);
  put(f.live, 5000);
  put(f.livewal, 60);
  put(f.liveshm, 7);
  put(f.bin, 4000);
  return { ...f, put, ...opts };
}

/** The reclaim fs: the real one, with a guard before every unlink and optional fault injection. */
function guardedFs(fx, { failUnlink = null, afterUnlink = null, hangAfterUnlinkOf = null } = {}) {
  const real = createReclaimFs();
  const unlinked = [];
  return {
    ...real,
    unlinked,
    unlink: async (p) => {
      assert.ok(p === fx.root || p.startsWith(fx.root + sep), `TEST GUARD: refusing to unlink outside the temp root: ${p}`);
      assert.ok(!p.includes(`${sep}..${sep}`), `TEST GUARD: path escapes: ${p}`);
      if (failUnlink?.(p)) {
        const e = new Error(`EACCES: permission denied, unlink '${p}'`);
        e.code = "EACCES";
        throw e;
      }
      await real.unlink(p);
      unlinked.push(p);
      await afterUnlink?.(p);
      if (hangAfterUnlinkOf && p === hangAfterUnlinkOf) await NEVER();
    },
  };
}

function completedState(fx, extra = {}) {
  return {
    version: 1,
    state: "completed",
    mode: "copy",
    v1Db: fx.v1,
    targetDb: fx.live,
    v1Sessions: 3,
    copyDone: true,
    steps: {},
    error: null,
    ...extra,
  };
}

/** Engine over a store. `io` overrides the injected reclaim deps (pid / open files / fs). */
async function makeBox(fx, { state = completedState(fx), io = {}, store = { data: structuredClone(state) }, deps = {} } = {}) {
  const fsOps = io.fs ?? guardedFs(fx);
  const reclaim = {
    binPath: () => fx.bin,
    runningPid: async () => 4242,
    openFiles: async () => [{ path: fx.live }, { path: fx.livewal }, { path: fx.liveshm }],
    ...io,
    fs: fsOps,
  };
  const engine = createUpgradeV2({
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    publish: () => {},
    log: () => {},
    loadState: async () => (store.data ? structuredClone(store.data) : null),
    saveState: async (s) => {
      store.data = structuredClone(s);
    },
    services: { pauseBackground: async () => {}, resumeBackground: async () => {} },
    reclaim,
    ...deps,
  });
  await engine.boot();
  return { engine, store, fs: fsOps };
}

const exists = (p) => existsSync(p);
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "timed out waiting for the condition");
};
const TOTAL = 1000 + 200 + 30 + 4000;

describe("reclaim: availability (GET) — every reason", () => {
  test("available: copy mode, completed, targets present → sums the present targets", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx);
    assert.deepEqual(await engine.reclaimStatus(), { available: true, reason: null, mode: "copy", bytes: TOTAL, state: "none" });
    for (const p of [fx.v1, fx.v1wal, fx.v1shm, fx.live, fx.bin]) assert.ok(exists(p), "GET never deletes anything");
  });

  test("a missing sidecar just isn't summed", async () => {
    const fx = makeFixture();
    rmSync(fx.v1shm);
    const { engine } = await makeBox(fx);
    assert.equal((await engine.reclaimStatus()).bytes, TOTAL - 30);
  });

  for (const st of ["idle", "running", "failed", "rolled_back"]) {
    test(`upgrade state "${st}" → only available after the upgrade finishes`, async () => {
      const fx = makeFixture();
      const { engine } = await makeBox(fx); // booted on a completed state (no upgrade run is started)
      engine._state().state = st; // a "running" upgrade can't be booted without the full upgrade deps
      const r = await engine.reclaimStatus();
      assert.equal(r.available, false);
      assert.equal(r.reason, RECLAIM_REASONS.unfinished);
      assert.equal(r.bytes, null);
      assert.equal(r.mode, null);
      assert.deepEqual(await engine.reclaim(), { ok: false, error: RECLAIM_REASONS.unfinished });
      assert.ok(exists(fx.v1) && exists(fx.bin));
    });
  }

  test("a fresh engine that has not loaded anything (state idle) → unfinished", async () => {
    const e = createUpgradeV2({ loadState: async () => null, saveState: async () => {} });
    const r = await e.reclaimStatus();
    assert.equal(r.available, false);
    assert.equal(r.reason, RECLAIM_REASONS.unfinished);
  });

  test("in-place mode → not supported yet", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { state: completedState(fx, { mode: "in-place" }) });
    const r = await engine.reclaimStatus();
    assert.equal(r.available, false);
    assert.equal(r.mode, "in-place");
    assert.match(r.reason, /migrated in place/);
  });

  test("already reclaimed → Already reclaimed", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { state: completedState(fx, { reclaim: { state: "done", targets: [], freedBytes: 1 } }) });
    const r = await engine.reclaimStatus();
    assert.deepEqual([r.available, r.reason, r.state], [false, "Already reclaimed", "done"]);
  });

  test("nothing present → Nothing to reclaim", async () => {
    const fx = makeFixture();
    for (const p of [fx.v1, fx.v1wal, fx.v1shm, fx.bin]) rmSync(p);
    const { engine } = await makeBox(fx);
    const r = await engine.reclaimStatus();
    assert.deepEqual([r.available, r.reason], [false, "Nothing to reclaim"]);
  });

  test("only the old binary present → still available (bytes = its size)", async () => {
    const fx = makeFixture();
    for (const p of [fx.v1, fx.v1wal, fx.v1shm]) rmSync(p);
    const { engine } = await makeBox(fx);
    const r = await engine.reclaimStatus();
    assert.equal(r.available, true);
    assert.equal(r.bytes, 4000);
  });

  test("the state file has no usable v1Db → refuses (fails closed)", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { state: completedState(fx, { v1Db: null }) });
    const r = await engine.reclaimStatus();
    assert.equal(r.available, false);
    assert.equal(r.reason, RECLAIM_REASONS.unexpected);
  });
});

describe("reclaim: the live DB comes from the RUNNING process; every uncertainty fails closed", () => {
  const unavailable = async (fx, io, why) => {
    const { engine } = await makeBox(fx, { io });
    const r = await engine.reclaimStatus();
    assert.equal(r.available, false, why);
    assert.equal(r.reason, RECLAIM_REASONS.live, why);
    const p = await engine.reclaim();
    assert.deepEqual(p, { ok: false, error: RECLAIM_REASONS.live }, why);
    for (const f of [fx.v1, fx.v1wal, fx.v1shm, fx.bin]) assert.ok(exists(f), `${why}: nothing deleted`);
  };

  test("PID lookup returns null (nohup: no reliable PID)", async () => {
    await unavailable(makeFixture(), { runningPid: async () => null }, "null pid");
  });
  test("PID lookup throws", async () => {
    await unavailable(makeFixture(), { runningPid: async () => { throw new Error("systemctl failed"); } }, "throwing pid");
  });
  test("PID is nonsense (0, 1, NaN, a string)", async () => {
    for (const pid of [0, 1, NaN, "4242"]) await unavailable(makeFixture(), { runningPid: async () => pid }, `pid ${pid}`);
  });
  test("open-file reader throws", async () => {
    await unavailable(makeFixture(), { openFiles: async () => { throw new Error("EACCES /proc/4242/fd"); } }, "throwing reader");
  });
  test("open-file set holds no opencode*.db", async () => {
    const fx = makeFixture();
    await unavailable(fx, { openFiles: async () => [{ path: join(fx.data, "something-else.txt") }] }, "no db");
  });
  test("open-file set holds TWO distinct opencode DBs (ambiguous)", async () => {
    const fx = makeFixture();
    await unavailable(fx, { openFiles: async () => [{ path: fx.live }, { path: fx.v1 }] }, "two dbs");
  });
  test("open-file reader returns something that is not a list", async () => {
    await unavailable(makeFixture(), { openFiles: async () => null }, "not a list");
  });
  test("the DB was deleted while open → not usable as the live DB", async () => {
    const fx = makeFixture();
    await unavailable(fx, { openFiles: async () => [{ path: `${fx.live} (deleted)` }] }, "deleted db");
  });
  test("no reclaim deps at all (engine built without them) → can't confirm", async () => {
    const fx = makeFixture();
    const engine = createUpgradeV2({
      loadState: async () => completedState(fx), saveState: async () => {}, publish: () => {}, log: () => {},
      services: { pauseBackground: async () => {}, resumeBackground: async () => {} },
    });
    await engine.boot();
    assert.equal((await engine.reclaimStatus()).reason, RECLAIM_REASONS.live);
    assert.deepEqual(await engine.reclaim(), { ok: false, error: RECLAIM_REASONS.live });
  });

  test("the running process wins over what the configuration says", async () => {
    // The state file / unit file point V1 at opencode.db and "live" at opencode-v2.db — but the
    // process that is actually running has opencode.db (V1) open as its database.
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { io: { openFiles: async () => [{ path: fx.v1 }, { path: fx.v1wal }, { path: fx.v1shm }] } });
    const r = await engine.reclaimStatus();
    assert.equal(r.available, false);
    assert.match(r.reason, /opencode\.db is the database in use/);
    assert.deepEqual((await engine.reclaim()).ok, false);
    assert.ok(exists(fx.v1) && exists(fx.v1wal) && exists(fx.bin));
  });

  test("a different process than the one configured: the identity is read from the PID the supervisor reports", async () => {
    const fx = makeFixture();
    const asked = [];
    const { engine } = await makeBox(fx, {
      io: {
        runningPid: async () => 777,
        openFiles: async (pid) => {
          asked.push(pid);
          return [{ path: fx.live }];
        },
      },
    });
    assert.equal((await engine.reclaimStatus()).available, true);
    assert.deepEqual([...new Set(asked)], [777]);
  });
});

describe("reclaim: the closed allowlist", () => {
  const refused = async (fx, state, re, io = {}) => {
    const { engine } = await makeBox(fx, { state, io });
    const r = await engine.reclaimStatus();
    assert.equal(r.available, false, "GET unavailable");
    assert.match(r.reason, re);
    const p = await engine.reclaim();
    assert.equal(p.ok, false);
    assert.match(p.error, re);
    return engine;
  };

  test("v1Db IS the live DB (same path)", async () => {
    const fx = makeFixture();
    await refused(fx, completedState(fx, { v1Db: fx.live }), /opencode-v2\.db .*(not on the list|database in use)/);
    for (const p of [fx.live, fx.livewal, fx.liveshm, fx.v1, fx.v1wal, fx.bin]) assert.ok(exists(p));
  });

  test("v1Db reaches the live DB through a symlinked parent directory", async () => {
    const fx = makeFixture();
    const link = join(fx.root, "alias");
    symlinkSync(fx.data, link);
    // name it like V1 but via the alias: alias/opencode.db is a real V1 file (fine) — so use the live one
    await refused(fx, completedState(fx, { v1Db: join(link, "opencode-v2.db") }), /opencode-v2\.db/);
    assert.ok(exists(fx.live));
  });

  test("v1Db is a HARD LINK of the live DB (same inode, allowed name, same directory)", async () => {
    const fx = makeFixture();
    rmSync(fx.v1);
    linkSync(fx.live, fx.v1); // data/opencode.db is now the same inode as the live DB
    await refused(fx, completedState(fx), /opencode\.db is the database in use/);
    assert.ok(exists(fx.live) && exists(fx.v1));
    assert.equal(readFileSync(fx.live).length, 5000);
  });

  test("a hard-linked SIDECAR of the live DB is refused by inode", async () => {
    const fx = makeFixture();
    rmSync(fx.v1wal);
    linkSync(fx.livewal, fx.v1wal);
    await refused(fx, completedState(fx), /opencode\.db-wal is the database in use/);
  });

  test("v1Db has the wrong basename", async () => {
    const fx = makeFixture();
    const odd = join(fx.data, "notes.db");
    fx.put(odd, 10);
    await refused(fx, completedState(fx, { v1Db: odd }), /notes\.db is not on the list/);
    assert.ok(exists(odd));
  });

  test("v1Db points at an unrelated file", async () => {
    const fx = makeFixture();
    const other = join(fx.root, "precious.txt");
    fx.put(other, 10);
    await refused(fx, completedState(fx, { v1Db: other }), /precious\.txt is not on the list/);
    assert.ok(exists(other));
  });

  test("V1 DB lives outside the live DB's directory", async () => {
    const fx = makeFixture();
    const elsewhere = join(fx.root, "elsewhere");
    mkdirSync(elsewhere);
    const v = join(elsewhere, "opencode.db");
    fx.put(v, 10);
    await refused(fx, completedState(fx, { v1Db: v }), /opencode\.db is not in the folder of the database in use/);
    assert.ok(exists(v));
  });

  test("v1Db is itself a symlink (to a real opencode.db)", async () => {
    const fx = makeFixture();
    const real = join(fx.root, "elsewhere-real.db");
    fx.put(real, 10);
    rmSync(fx.v1);
    symlinkSync(real, fx.v1);
    await refused(fx, completedState(fx), /opencode\.db is not a regular file/);
    assert.ok(exists(real));
  });

  test("a sidecar that is a symlink", async () => {
    const fx = makeFixture();
    const victim = join(fx.root, "victim");
    fx.put(victim, 10);
    rmSync(fx.v1wal);
    symlinkSync(victim, fx.v1wal);
    await refused(fx, completedState(fx), /opencode\.db-wal is not a regular file/);
    assert.ok(exists(victim) && exists(fx.v1));
  });

  test("the old binary is a symlink", async () => {
    const fx = makeFixture();
    const real = join(fx.root, "real-bin");
    fx.put(real, 10);
    rmSync(fx.bin);
    symlinkSync(real, fx.bin);
    await refused(fx, completedState(fx), /opencode-v1 is not a regular file/);
    assert.ok(exists(real) && exists(fx.v1));
  });

  test("v1Db is a directory", async () => {
    const fx = makeFixture();
    const dir = join(fx.data, "opencode.db.d");
    mkdirSync(dir);
    await refused(fx, completedState(fx, { v1Db: dir }), /not a regular file|not on the list/);
  });

  test("a target held open by opencode (by path) is refused", async () => {
    const fx = makeFixture();
    await refused(fx, completedState(fx), /opencode\.db-wal is open by OpenCode/, {
      openFiles: async () => [{ path: fx.live }, { path: fx.v1wal }],
    });
    assert.ok(exists(fx.v1wal) && exists(fx.v1));
  });

  test("a target held open under another NAME (same inode) is refused", async () => {
    const fx = makeFixture();
    const alias = join(fx.data, "alias-of-bin");
    linkSync(fx.bin, alias);
    await refused(fx, completedState(fx), /opencode-v1 is open by OpenCode/, {
      openFiles: async () => [{ path: fx.live }, { path: alias }],
    });
    assert.ok(exists(fx.bin));
  });

  test("an open file reported by device+inode only (deleted name) still counts", async () => {
    const fx = makeFixture();
    const st = statSync(fx.v1shm, { bigint: true });
    await refused(fx, completedState(fx), /opencode\.db-shm is open by OpenCode/, {
      openFiles: async () => [{ path: fx.live }, { path: `${join(fx.data, "gone")} (deleted)`, dev: String(st.dev), ino: String(st.ino) }],
    });
  });
});

describe("reclaim: POST — the manifest, deletion order, resume", () => {
  test("happy path: manifest is persisted BEFORE the first unlink; live files + other files survive", async () => {
    const fx = makeFixture();
    const bystander = join(fx.data, "unrelated.txt");
    fx.put(bystander, 5);
    const store = { data: null };
    let manifestBeforeFirstUnlink = null;
    const fs = guardedFs(fx, {});
    const origUnlink = fs.unlink;
    fs.unlink = async (p) => {
      if (manifestBeforeFirstUnlink === null) manifestBeforeFirstUnlink = structuredClone(store.data?.reclaim ?? null);
      return origUnlink(p);
    };
    const { engine } = await makeBox(fx, { io: { fs }, store: Object.assign(store, { data: structuredClone(completedState(fx)) }) });
    const r = await engine.reclaim();
    assert.deepEqual(r, { ok: true, freedBytes: TOTAL });
    assert.equal(manifestBeforeFirstUnlink?.state, "running");
    assert.deepEqual(manifestBeforeFirstUnlink.targets.map((t) => t.path), [fx.v1, fx.v1wal, fx.v1shm, fx.bin]);
    assert.ok(manifestBeforeFirstUnlink.targets.every((t) => t.removed === false && /^\d+$/.test(t.ino) && /^\d+$/.test(t.dev) && t.size > 0));
    for (const p of [fx.v1, fx.v1wal, fx.v1shm, fx.bin]) assert.ok(!exists(p), `${p} removed`);
    for (const p of [fx.live, fx.livewal, fx.liveshm, bystander, join(fx.home, ".opencode", "bin")]) assert.ok(exists(p), `${p} kept`);
    assert.equal(store.data.reclaim.state, "done");
    assert.equal(store.data.reclaim.freedBytes, TOTAL);
    assert.ok(store.data.reclaim.targets.every((t) => t.removed === true));
    assert.deepEqual((await engine.reclaimStatus()).state, "done");
    assert.deepEqual(await engine.reclaim(), { ok: false, error: "Already reclaimed" });
  });

  test("the manifest could not be persisted → nothing is deleted", async () => {
    const fx = makeFixture();
    const fs = guardedFs(fx);
    const { engine } = await makeBox(fx, { io: { fs }, deps: { saveState: async () => { throw new Error("disk full"); } } });
    const r = await engine.reclaim();
    assert.equal(r.ok, false);
    assert.match(r.error, /nothing was deleted/);
    assert.deepEqual(fs.unlinked, []);
    assert.ok(exists(fx.v1) && exists(fx.bin));
    assert.equal((await engine.reclaimStatus()).state, "none", "no half-recorded reclaim is left behind");
  });

  test("partial failure → failed (manifest kept), GET still available with the remaining bytes, retry finishes", async () => {
    const fx = makeFixture();
    let breakBin = true;
    const fs = guardedFs(fx, { failUnlink: (p) => breakBin && p === fx.bin });
    const { engine, store } = await makeBox(fx, { io: { fs } });
    const r1 = await engine.reclaim();
    assert.equal(r1.ok, false);
    assert.equal(r1.error, "Couldn't delete opencode-v1: permission denied");
    assert.ok(!r1.error.includes(fx.root), "the message names the file, never the path");
    assert.equal(store.data.reclaim.state, "failed");
    for (const p of [fx.v1, fx.v1wal, fx.v1shm]) assert.ok(!exists(p));
    assert.ok(exists(fx.bin));
    const st = await engine.reclaimStatus();
    assert.deepEqual([st.available, st.state, st.bytes], [true, "failed", 4000]);
    breakBin = false;
    const r2 = await engine.reclaim();
    assert.deepEqual(r2, { ok: true, freedBytes: TOTAL });
    assert.ok(!exists(fx.bin));
    assert.equal(store.data.reclaim.state, "done");
  });

  test("crash after the LAST unlink but before it was recorded → resume finalizes without deleting anything", async () => {
    const fx = makeFixture();
    const store = { data: structuredClone(completedState(fx)) };
    // The process "dies" inside the unlink of the binary (the last target), after the file is gone.
    const dying = guardedFs(fx, { hangAfterUnlinkOf: fx.bin });
    const first = await makeBox(fx, { io: { fs: dying }, store });
    void first.engine.reclaim(); // never settles — that is the crash
    await until(() => dying.unlinked.includes(fx.bin));
    assert.ok(!exists(fx.bin), "the last file is already gone");
    assert.equal(store.data.reclaim.state, "running");
    assert.equal(store.data.reclaim.targets.find((t) => t.path === fx.bin).removed, false, "…but the crash lost the record of it");

    const fs2 = guardedFs(fx);
    const second = await makeBox(fx, { io: { fs: fs2 }, store });
    const st = await second.engine.reclaimStatus();
    assert.deepEqual([st.available, st.state], [true, "failed"], "a crashed running reclaim reads as failed");
    const r = await second.engine.reclaim();
    assert.deepEqual(r, { ok: true, freedBytes: TOTAL });
    assert.deepEqual(fs2.unlinked, [], "nothing left to delete");
    assert.equal(store.data.reclaim.state, "done");
  });

  test("every entry removed but `done` never recorded → GET available, POST finalizes", async () => {
    const fx = makeFixture();
    for (const p of [fx.v1, fx.v1wal, fx.v1shm, fx.bin]) rmSync(p);
    const manifest = {
      state: "running",
      startedAt: 1,
      targets: [fx.v1, fx.v1wal, fx.v1shm, fx.bin].map((path, i) => ({ path, dev: "1", ino: String(i), size: 10 * (i + 1), removed: true })),
    };
    const { engine, store } = await makeBox(fx, { state: completedState(fx, { reclaim: manifest }) });
    const st = await engine.reclaimStatus();
    assert.deepEqual([st.available, st.state, st.bytes], [true, "failed", 0]);
    assert.deepEqual(await engine.reclaim(), { ok: true, freedBytes: 100 });
    assert.equal(store.data.reclaim.state, "done");
  });

  test("resume skips entries that are already missing, and only deletes the rest", async () => {
    const fx = makeFixture();
    const store = { data: structuredClone(completedState(fx)) };
    const fs1 = guardedFs(fx, { failUnlink: (p) => p === fx.v1shm });
    const a = await makeBox(fx, { io: { fs: fs1 }, store });
    assert.equal((await a.engine.reclaim()).ok, false);
    assert.deepEqual(fs1.unlinked, [fx.v1, fx.v1wal]);
    rmSync(fx.v1shm); // the user (or a previous run) removed it by hand
    const fs2 = guardedFs(fx);
    const b = await makeBox(fx, { io: { fs: fs2 }, store });
    assert.equal((await b.engine.reclaim()).ok, true);
    assert.deepEqual(fs2.unlinked, [fx.bin]);
  });

  test("a resumed run refuses when opencode now holds a remaining target open", async () => {
    const fx = makeFixture();
    const store = { data: structuredClone(completedState(fx)) };
    const a = await makeBox(fx, { io: { fs: guardedFs(fx, { failUnlink: (p) => p === fx.v1shm }) }, store });
    await a.engine.reclaim();
    const fs2 = guardedFs(fx);
    const b = await makeBox(fx, { io: { fs: fs2, openFiles: async () => [{ path: fx.live }, { path: fx.v1shm }] }, store });
    const r = await b.engine.reclaim();
    assert.equal(r.ok, false);
    assert.match(r.error, /opencode\.db-shm is open by OpenCode/);
    assert.deepEqual(fs2.unlinked, []);
    assert.ok(exists(fx.v1shm) && exists(fx.bin));
    assert.equal(store.data.reclaim.state, "failed");
  });

  test("a resumed run with an undeterminable live DB stops (failed) and deletes nothing", async () => {
    const fx = makeFixture();
    const store = { data: structuredClone(completedState(fx)) };
    await (await makeBox(fx, { io: { fs: guardedFs(fx, { failUnlink: (p) => p === fx.v1wal }) }, store })).engine.reclaim();
    const fs2 = guardedFs(fx);
    const b = await makeBox(fx, { io: { fs: fs2, runningPid: async () => null }, store });
    assert.deepEqual(await b.engine.reclaim(), { ok: false, error: RECLAIM_REASONS.live });
    assert.deepEqual(fs2.unlinked, []);
  });

  test("a manifest entry replaced by a DIFFERENT file (different inode) is refused", async () => {
    const fx = makeFixture();
    const store = { data: structuredClone(completedState(fx)) };
    const a = await makeBox(fx, { io: { fs: guardedFs(fx, { failUnlink: (p) => p === fx.v1shm }) }, store });
    await a.engine.reclaim(); // v1 + v1wal gone, v1shm and bin remain, manifest persisted
    // Between the runs the shm file is deleted and a brand-new file takes its name.
    rmSync(fx.v1shm);
    fx.put(fx.v1shm, 99);
    const fs2 = guardedFs(fx);
    const b = await makeBox(fx, { io: { fs: fs2 }, store });
    const r = await b.engine.reclaim();
    assert.equal(r.ok, false);
    assert.match(r.error, /opencode\.db-shm was replaced by a different file/);
    assert.deepEqual(fs2.unlinked, []);
    assert.ok(exists(fx.v1shm) && exists(fx.bin), "neither the impostor nor the later targets were touched");
    assert.equal(store.data.reclaim.state, "failed");
  });

  describe("forged manifest (the state file is as untrusted as the rest of it)", () => {
    const forged = async (fx, path, nameNote, re) => {
      const st = statSync(path, { bigint: true });
      const manifest = {
        state: "failed",
        startedAt: 1,
        targets: [{ path, dev: String(st.dev), ino: String(st.ino), size: Number(st.size), removed: false }],
      };
      const fs = guardedFs(fx);
      const { engine, store } = await makeBox(fx, { state: completedState(fx, { reclaim: manifest }), io: { fs } });
      const r = await engine.reclaim();
      assert.equal(r.ok, false, nameNote);
      assert.match(r.error, re, nameNote);
      assert.deepEqual(fs.unlinked, [], `${nameNote}: nothing unlinked`);
      assert.ok(exists(path), `${nameNote}: file survives`);
      assert.equal(store.data.reclaim.state, "failed");
    };

    test("an unrelated file with its REAL inode", async () => {
      const fx = makeFixture();
      const victim = join(fx.root, "home", "important-notes.txt");
      fx.put(victim, 12);
      await forged(fx, victim, "unrelated file", /important-notes\.txt is not on the list/);
    });

    test("the LIVE database with its real inode", async () => {
      const fx = makeFixture();
      await forged(fx, fx.live, "live db", /opencode-v2\.db is not on the list/);
    });

    test("an allowed NAME in the wrong directory", async () => {
      const fx = makeFixture();
      const other = join(fx.root, "other");
      mkdirSync(other);
      const p = join(other, "opencode.db");
      fx.put(p, 12);
      await forged(fx, p, "wrong dir", /opencode\.db is not in the folder of the database in use/);
    });

    test("the binary name at a location other than ~/.opencode/bin/opencode-v1", async () => {
      const fx = makeFixture();
      const p = join(fx.data, "opencode-v1");
      fx.put(p, 12);
      await forged(fx, p, "wrong bin", /opencode-v1 is not the preserved old OpenCode program/);
    });

    test("a symlink with an allowed name", async () => {
      const fx = makeFixture();
      const victim = join(fx.root, "victim");
      fx.put(victim, 12);
      const link = join(fx.data, "opencode.db-shm");
      rmSync(link);
      symlinkSync(victim, link);
      const st = statSync(victim, { bigint: true });
      const manifest = { state: "failed", targets: [{ path: link, dev: String(st.dev), ino: String(st.ino), size: 12, removed: false }] };
      const fs = guardedFs(fx);
      const { engine } = await makeBox(fx, { state: completedState(fx, { reclaim: manifest }), io: { fs } });
      const r = await engine.reclaim();
      assert.equal(r.ok, false);
      assert.match(r.error, /not a regular file/);
      assert.ok(exists(victim));
    });

    test("a path that is not canonical (.. traversal) is refused", async () => {
      const fx = makeFixture();
      const sneaky = `${fx.data}/../data/opencode.db`; // join() would normalise it away
      const st = statSync(fx.v1, { bigint: true });
      const manifest = { state: "failed", targets: [{ path: sneaky, dev: String(st.dev), ino: String(st.ino), size: 1, removed: false }] };
      const fs = guardedFs(fx);
      const { engine } = await makeBox(fx, { state: completedState(fx, { reclaim: manifest }), io: { fs } });
      const r = await engine.reclaim();
      assert.equal(r.ok, false);
      assert.deepEqual(fs.unlinked, []);
      assert.ok(exists(fx.v1));
    });

    test("entries that are not objects / have no path → damaged record, nothing deleted", async () => {
      const fx = makeFixture();
      for (const targets of [[null], [{ size: 1, removed: false }], [{ path: 42, removed: false }], [{ path: "relative/opencode.db", removed: false }]]) {
        const fs = guardedFs(fx);
        const { engine } = await makeBox(fx, { state: completedState(fx, { reclaim: { state: "failed", targets } }), io: { fs } });
        assert.deepEqual(await engine.reclaim(), { ok: false, error: RECLAIM_REASONS.damaged });
        assert.deepEqual(fs.unlinked, []);
      }
    });

    test("a reclaim record with no target list, or that isn't an object → damaged, never re-derived", async () => {
      const fx = makeFixture();
      for (const reclaim of [{ state: "failed" }, "garbage", 7]) {
        const fs = guardedFs(fx);
        const { engine } = await makeBox(fx, { state: completedState(fx, { reclaim }), io: { fs } });
        const st = await engine.reclaimStatus();
        assert.equal(st.available, false);
        assert.equal(st.reason, RECLAIM_REASONS.damaged);
        assert.deepEqual(await engine.reclaim(), { ok: false, error: RECLAIM_REASONS.damaged });
        assert.deepEqual(fs.unlinked, []);
      }
      assert.ok(exists(fx.v1));
    });

    test("removed:true entries are trusted only as 'nothing to do' — a forged removed flag deletes nothing", async () => {
      const fx = makeFixture();
      const fs = guardedFs(fx);
      const manifest = { state: "failed", targets: [{ path: fx.v1, dev: "1", ino: "1", size: 1, removed: true }] };
      const { engine } = await makeBox(fx, { state: completedState(fx, { reclaim: manifest }), io: { fs } });
      await engine.reclaim(); // finalizes "done" without touching anything
      assert.deepEqual(fs.unlinked, []);
      assert.ok(exists(fx.v1));
    });
  });
});

describe("reclaim: interplay with rollback / retry / the upgrade lock", () => {
  const rollbackDeps = () => {
    const calls = [];
    return {
      calls,
      opencode: { stop: async () => calls.push("stop"), configure: async () => calls.push("configure"), start: async () => calls.push("start") },
      restoreV1: async () => calls.push("restoreV1"),
      removeDb: async () => calls.push("removeDb"),
      readPreviousRelease: async () => ({ git_sha: "abc" }),
      reinstallPreviousRelease: async () => calls.push("reinstall") && {},
    };
  };

  for (const rstate of ["running", "failed", "done"]) {
    test(`rollback is refused with the reclaim in state "${rstate}" and touches nothing`, async () => {
      const fx = makeFixture();
      const rd = rollbackDeps();
      const { engine } = await makeBox(fx, {
        state: completedState(fx, { state: "failed", steps: { stop: { status: "done" } }, reclaim: { state: rstate, targets: [] } }),
        deps: rd,
      });
      assert.deepEqual(await engine.rollback(), { ok: false, error: ROLLBACK_REFUSED_AFTER_RECLAIM });
      assert.deepEqual(rd.calls, []);
      assert.equal(engine._state().state, "failed");
    });
  }

  test("rollback is refused while a reclaim is mid-flight (manifest persisted, unlink in progress)", async () => {
    const fx = makeFixture();
    const rd = rollbackDeps();
    const fs = guardedFs(fx, { hangAfterUnlinkOf: fx.v1 });
    const { engine } = await makeBox(fx, { io: { fs }, deps: rd });
    void engine.reclaim();
    await until(() => fs.unlinked.includes(fx.v1));
    assert.equal((await engine.rollback()).error, ROLLBACK_REFUSED_AFTER_RECLAIM);
    assert.deepEqual((await engine.retry()).ok, false);
    assert.equal((await engine.reclaimStatus()).state, "running");
    assert.equal((await engine.reclaimStatus()).available, false);
    assert.deepEqual(await engine.reclaim(), { ok: false, error: RECLAIM_REASONS.running }, "no second concurrent reclaim");
    assert.deepEqual(rd.calls, []);
  });

  test("rollback + retry are refused once a reclaim exists even if the upgrade state is failed", async () => {
    const fx = makeFixture();
    const rd = rollbackDeps();
    const { engine } = await makeBox(fx, { state: completedState(fx, { state: "failed", reclaim: { state: "done", targets: [] } }), deps: rd });
    assert.match((await engine.retry()).error, /Retry is no longer possible/);
    assert.deepEqual(rd.calls, []);
  });

  test("reclaim is refused while a rollback runs (shared lock) and deletes nothing", async () => {
    const fx = makeFixture();
    let release;
    const gate = new Promise((r) => (release = r));
    const fs = guardedFs(fx);
    const { engine } = await makeBox(fx, {
      state: completedState(fx, { state: "failed", steps: { stop: { status: "done" } } }),
      io: { fs },
      deps: {
        opencode: { stop: async () => gate, configure: async () => {}, start: async () => {} },
        restoreV1: async () => {},
        removeDb: async () => {},
        readPreviousRelease: async () => null,
        reinstallPreviousRelease: async () => ({}),
      },
    });
    const rolling = engine.rollback();
    const r = await engine.reclaim();
    assert.deepEqual(r, { ok: false, error: RECLAIM_REASONS.busy });
    const st = await engine.reclaimStatus();
    assert.equal(st.available, false);
    assert.deepEqual(fs.unlinked, []);
    release();
    await rolling;
    // and once the rollback is done, the upgrade is no longer "completed": still refused
    assert.equal((await engine.reclaim()).ok, false);
    assert.ok(exists(fx.v1) && exists(fx.bin));
  });

  test("reclaim is refused while the upgrade itself is failed or rolled back", async () => {
    const fx = makeFixture();
    for (const st of ["failed", "rolled_back"]) {
      const { engine } = await makeBox(fx, { state: completedState(fx, { state: st }) });
      assert.deepEqual(await engine.reclaim(), { ok: false, error: RECLAIM_REASONS.unfinished });
    }
    assert.ok(exists(fx.v1));
  });

  test("reclaim is refused for an in-place box", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { state: completedState(fx, { mode: "in-place" }) });
    const r = await engine.reclaim();
    assert.equal(r.ok, false);
    assert.match(r.error, /migrated in place/);
    assert.ok(exists(fx.v1));
  });
});

describe("reclaim: HTTP routes (GET is read-only; handler-level, injected deps)", () => {
  async function withServer(engine, fn) {
    const routes = createUpgradeRoutes(engine);
    const server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (await routes.handle(req, res, path)) return;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ passthrough: path }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(async (method, path) => {
        const res = await fetch(base + path, { method });
        return { status: res.status, body: await res.json() };
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  test("GET answers the K7 ReclaimStatus shape and deletes nothing; POST answers a K7 ReclaimResult", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx);
    await withServer(engine, async (call) => {
      const g = await call("GET", "/api/upgrade/reclaim");
      assert.equal(g.status, 200);
      assert.deepEqual(g.body, { available: true, reason: null, mode: "copy", bytes: TOTAL, state: "none" });
      for (const p of [fx.v1, fx.v1wal, fx.v1shm, fx.bin]) assert.ok(exists(p));
      const p = await call("POST", "/api/upgrade/reclaim");
      assert.deepEqual(p, { status: 200, body: { ok: true, freedBytes: TOTAL } });
      assert.deepEqual((await call("GET", "/api/upgrade/reclaim")).body, { available: false, reason: "Already reclaimed", mode: "copy", bytes: null, state: "done" });
      assert.equal((await call("POST", "/api/upgrade/rollback")).body.error, ROLLBACK_REFUSED_AFTER_RECLAIM);
      assert.equal((await call("PUT", "/api/upgrade/reclaim")).status, 404, "only GET/POST");
    });
  });

  test("a refusal is a 200 {ok:false,error}; an unexpected throw is a SAFE 500 (no raw error in the body)", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { io: { runningPid: async () => null } });
    await withServer(engine, async (call) => {
      assert.deepEqual((await call("POST", "/api/upgrade/reclaim")).body, { ok: false, error: RECLAIM_REASONS.live });
    });
    const boom = { isUpgradeMode: () => false, reclaimStatus: async () => { throw new Error("EACCES /home/secret/path"); }, reclaim: async () => { throw new Error("boom /x"); } };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await withServer(boom, async (call) => {
        for (const m of ["GET", "POST"]) {
          const r = await call(m, "/api/upgrade/reclaim");
          assert.equal(r.status, 500);
          assert.ok(!JSON.stringify(r.body).includes("secret"));
          assert.ok(!JSON.stringify(r.body).includes("/x"));
          assert.match(r.body.error, /Couldn't check/);
        }
      });
    } finally {
      console.warn = warn;
    }
  });

  test("the route stays reachable in upgrade mode (exempt prefix) but the engine refuses", async () => {
    const fx = makeFixture();
    const { engine } = await makeBox(fx, { state: completedState(fx, { state: "failed" }) });
    await withServer({ ...engine, isUpgradeMode: () => true }, async (call) => {
      const g = await call("GET", "/api/upgrade/reclaim");
      assert.equal(g.status, 200);
      assert.equal(g.body.available, false);
    });
  });
});

describe("reclaim: INTEGRATION — default deps wiring on the real filesystem (temp root, injected home / PID / open files)", () => {
  test("createDefaultDeps().reclaim drives a full reclaim; only fixture files are touched", async () => {
    const fx = makeFixture();
    const bystander = join(fx.data, "keep.txt");
    fx.put(bystander, 3);
    const real = createReclaimFs();
    const unlinked = [];
    const base = createDefaultDeps({
      mantaHome: join(fx.root, "manta"),
      publish: () => {},
      services: { pauseBackground: async () => {}, resumeBackground: async () => {} },
      home: fx.home,
      log: () => {},
      reclaimIo: {
        runningPid: async () => 31337,
        openFiles: async (pid) => {
          assert.equal(pid, 31337);
          return [{ path: fx.live }, { path: fx.livewal }, { path: fx.liveshm }];
        },
        fs: {
          ...real,
          unlink: async (p) => {
            // The test-mode guard: never unlink anything outside the temp root we created.
            assert.ok(p.startsWith(fx.root + sep), `TEST GUARD: ${p} is outside ${fx.root}`);
            unlinked.push(p);
            return real.unlink(p);
          },
        },
      },
    });
    assert.equal(base.reclaim.binPath(), fx.bin, "the binary path is derived from the injected home");
    const store = { data: structuredClone(completedState(fx)) };
    const engine = createUpgradeV2({
      ...base,
      loadState: async () => structuredClone(store.data),
      saveState: async (s) => {
        store.data = structuredClone(s);
      },
    });
    await engine.boot();
    const st = await engine.reclaimStatus();
    assert.deepEqual([st.available, st.bytes, st.mode], [true, TOTAL, "copy"]);
    assert.deepEqual(await engine.reclaim(), { ok: true, freedBytes: TOTAL });
    assert.deepEqual(unlinked.sort(), [fx.v1, fx.v1wal, fx.v1shm, fx.bin].sort());
    for (const p of [fx.live, fx.livewal, fx.liveshm, bystander]) assert.ok(exists(p));
    for (const p of [fx.v1, fx.v1wal, fx.v1shm, fx.bin]) assert.ok(!exists(p));
    assert.equal(store.data.reclaim.state, "done");
  });
});

describe("reclaim: default deps on a nohup box", () => {
  test("no supervisor → no reliable PID → the live DB can't be confirmed (nothing deleted)", async () => {
    const fx = makeFixture();
    const base = createDefaultDeps({
      mantaHome: join(fx.root, "manta"),
      publish: () => {},
      services: {},
      home: fx.home,
      log: () => {},
      opencodeService: { supervisor: "nohup" },
      reclaimIo: { fs: guardedFs(fx) },
    });
    assert.equal(await base.reclaim.runningPid(), null);
    const store = { data: structuredClone(completedState(fx)) };
    const engine = createUpgradeV2({ ...base, loadState: async () => structuredClone(store.data), saveState: async () => {} });
    await engine.boot();
    assert.equal((await engine.reclaimStatus()).reason, RECLAIM_REASONS.live);
    assert.equal((await engine.reclaim()).ok, false);
    assert.ok(exists(fx.v1) && exists(fx.bin));
  });
});

describe("running-process helpers (read-only)", () => {
  test("systemd: MainPID parse; 0/missing → null", async () => {
    const exec = (out) => async (cmd, args) => {
      assert.equal(cmd, "systemctl");
      assert.deepEqual(args, ["--user", "show", "opencode-serve", "-p", "MainPID"]);
      return { stdout: out };
    };
    assert.equal(await readOpencodeMainPid({ supervisor: "systemd", exec: exec("MainPID=4321\n") }), 4321);
    assert.equal(await readOpencodeMainPid({ supervisor: "systemd", exec: exec("MainPID=0\n") }), null);
    assert.equal(await readOpencodeMainPid({ supervisor: "systemd", exec: exec("") }), null);
  });
  test("systemd tool failure propagates (the caller treats it as 'can't confirm')", async () => {
    await assert.rejects(readOpencodeMainPid({ supervisor: "systemd", exec: async () => { throw new Error("no bus"); } }));
  });
  test("launchd: the PID line of `launchctl list <label>`; not running → null", async () => {
    const seen = [];
    const exec = (out) => async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { stdout: out };
    };
    const dict = '{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "com.mantaui.opencode";\n\t"PID" = 9876;\n\t"LastExitStatus" = 0;\n};\n';
    assert.equal(await readOpencodeMainPid({ supervisor: "launchd", exec: exec(dict) }), 9876);
    assert.deepEqual(seen[0], ["launchctl", "list", "com.mantaui.opencode"]);
    assert.equal(await readOpencodeMainPid({ supervisor: "launchd", exec: exec('{\n\t"Label" = "com.mantaui.opencode";\n};') }), null);
  });
  test("nohup (or anything else) has no reliable PID → null", async () => {
    assert.equal(await readOpencodeMainPid({ supervisor: "nohup", exec: async () => assert.fail("must not run anything") }), null);
    assert.equal(await readOpencodeMainPid({ exec: async () => assert.fail("must not run anything") }), null);
  });
  test("macOS: lsof -Fn -p <pid>, names only", async () => {
    const out = "p123\nfcwd\nn/Users/x\nf5\nn/Users/x/.local/share/opencode/opencode-v2.db\nf6\nn/Users/x/db-wal\nn->0x1234\nnpipe\n";
    assert.deepEqual(parseLsofNames(out), ["/Users/x", "/Users/x/.local/share/opencode/opencode-v2.db", "/Users/x/db-wal"]);
    let called;
    const files = await readOpenFiles(123, { platform: "darwin", exec: async (cmd, args) => ((called = [cmd, ...args]), { stdout: out }) });
    assert.deepEqual(called, ["lsof", "-Fn", "-p", "123"]);
    assert.equal(files.length, 3);
  });
  test("an unusable pid / unsupported platform throws", async () => {
    await assert.rejects(readOpenFiles(0, { platform: "linux" }));
    await assert.rejects(readOpenFiles(5, { platform: "win32" }));
  });
  test("linux: /proc/<pid>/fd is read via readlink + stat of the fd link; non-file fds are skipped", async () => {
    const ops = {
      readdir: async (p) => {
        assert.equal(p, "/proc/55/fd");
        return ["0", "3", "4", "9"];
      },
      readlink: async (p) => {
        if (p.endsWith("/0")) return "/dev/null";
        if (p.endsWith("/3")) return "/data/opencode-v2.db";
        if (p.endsWith("/4")) return "socket:[8812]";
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
      stat: async (p) => (p.endsWith("/3") ? { dev: 2049n, ino: 777n } : Promise.reject(new Error("nope"))),
    };
    assert.deepEqual(await readOpenFiles(55, { platform: "linux", fsOps: ops }), [
      { path: "/dev/null" },
      { path: "/data/opencode-v2.db", dev: "2049", ino: "777" },
    ]);
  });
  test("linux (real /proc, own pid): a file this process holds open is reported with its true identity", { skip: process.platform !== "linux" }, async () => {
    const fx = makeFixture();
    const fd = openSync(fx.live, "r");
    try {
      const files = await readOpenFiles(process.pid);
      const hit = files.find((f) => f.path === fx.live);
      assert.ok(hit, "own open fd found");
      const st = statSync(fx.live, { bigint: true });
      assert.deepEqual([hit.dev, hit.ino], [String(st.dev), String(st.ino)]);
    } finally {
      closeSync(fd);
    }
  });
});
