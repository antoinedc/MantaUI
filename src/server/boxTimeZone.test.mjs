// boxTimeZone.test.mjs — validation + the reconciler. Every I/O seam is injected (incl. setProcessTz,
// the clock and the active-session read): the suite runs on a live box and TZ is process-wide.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createBoxTimeZone, isValidTimeZone, readRunningOpencodeTz, restartOpencodeService } from "./boxTimeZone.mjs";
import { createOpencodeService } from "./upgradeV2Service.mjs";

describe("isValidTimeZone", () => {
  test("accepts real IANA zones", () => {
    for (const tz of ["Europe/Paris", "America/Argentina/Buenos_Aires", "UTC", "Etc/GMT+5"]) assert.equal(isValidTimeZone(tz), true, tz);
  });
  test("rejects empty, unknown, injection-shaped, oversized and non-string values", () => {
    for (const tz of ["", "Foo/Bar", "Europe/Paris\nX=1", "a b", '"x"', "A".repeat(65), "Europe/Paris=1"]) assert.equal(isValidTimeZone(tz), false, JSON.stringify(tz));
    for (const tz of [undefined, null, 5, {}, ["UTC"]]) assert.equal(isValidTimeZone(tz), false, String(tz));
  });
});

/** A fully faked world. `idle` controls the active-session read: array, or an Error to throw. */
function world({ stored = null, supervisor = "systemd", defTz = null, runningTz = null, active = [] } = {}) {
  const w = {
    clock: 1_000_000,
    stored,
    processTz: [],
    def: defTz,
    running: runningTz,
    active,
    writes: [],
    restarts: 0,
    restartResult: { ok: true },
    saves: [],
    logs: [],
    activeReads: 0,
  };
  w.service = {
    supervisor,
    readEnv: async () => w.def,
    setEnv: async (env) => {
      w.writes.push(env);
      w.def = env.TZ;
      return true;
    },
  };
  w.make = (extra = {}) =>
    createBoxTimeZone({
      loadStored: async () => w.stored,
      saveStored: async (tz) => {
        w.saves.push(tz);
        w.stored = tz;
      },
      setProcessTz: (tz) => w.processTz.push(tz),
      service: w.service,
      readRunningTz: async () => w.running,
      listActiveSessionIds: async () => {
        w.activeReads += 1;
        if (w.active instanceof Error) throw w.active;
        return w.active;
      },
      restart: async () => {
        w.restarts += 1;
        if (w.restartResult.ok) w.running = w.def;
        return w.restartResult;
      },
      now: () => w.clock,
      log: (l) => w.logs.push(l),
      ...extra,
    });
  return w;
}
const tick = (w, ms) => (w.clock += ms);
const settle = () => new Promise((r) => setImmediate(r));

describe("boxTimeZone reconciler", () => {
  test("same tz as already stored + defined + running → no write, no restart, no save", async () => {
    const w = world({ stored: "Europe/Paris", defTz: "Europe/Paris", runningTz: "Europe/Paris" });
    const btz = w.make();
    await btz.start();
    await btz.reconcile();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.deepEqual(w.writes, []);
    assert.equal(w.restarts, 0);
    assert.deepEqual(w.saves, []);
    assert.deepEqual(w.processTz, ["Europe/Paris"], "applied to this process once, from the stored value");
    btz.stop();
  });

  test("a new tz: persisted once, process TZ set, definition written, restart performed once idle", async () => {
    const w = world();
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.deepEqual(w.saves, ["Europe/Paris"]);
    assert.deepEqual(w.processTz, ["Europe/Paris"]);
    assert.deepEqual(w.writes, [{ TZ: "Europe/Paris" }]);
    assert.equal(w.restarts, 1, "idle box: restarted");
    assert.equal(btz.snapshot().restartOwed, false);
    btz.noteReported("Europe/Paris");
    await settle();
    assert.equal(w.saves.length, 1, "never rewritten for the same value");
    btz.stop();
  });

  test("restart is deferred while sessions are active, then performed once idle (poke)", async () => {
    const w = world({ active: ["ses_a"] });
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.deepEqual(w.writes, [{ TZ: "Europe/Paris" }], "the inert definition write happens immediately");
    assert.equal(w.restarts, 0);
    assert.equal(btz.snapshot().restartOwed, true);
    assert.ok(w.logs.some((l) => /deferred: 1 session/.test(l)));
    w.active = [];
    btz.poke();
    await settle();
    assert.equal(w.restarts, 1);
    btz.stop();
  });

  test("an active-session read that throws means UNKNOWN → deferred, never restarted", async () => {
    const w = world({ active: new Error("opencode down") });
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.equal(w.restarts, 0);
    assert.ok(w.logs.some((l) => /active-session read failed/.test(l)));
    w.active = [];
    await btz.reconcile();
    assert.equal(w.restarts, 1);
    btz.stop();
  });

  test("the owed flag survives a failed restart, and the 10-minute gap applies to the retry", async () => {
    const w = world();
    w.restartResult = { ok: false, error: "systemctl exploded" };
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.equal(w.restarts, 1);
    assert.equal(btz.snapshot().restartOwed, true);
    tick(w, 5 * 60_000);
    await btz.reconcile();
    assert.equal(w.restarts, 1, "inside the 10-minute window: no retry");
    tick(w, 6 * 60_000);
    w.restartResult = { ok: true };
    await btz.reconcile();
    assert.equal(w.restarts, 2);
    assert.equal(btz.snapshot().restartOwed, false);
    btz.stop();
  });

  test("a second zone inside the restart window updates the definition but waits for the window", async () => {
    const w = world();
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.equal(w.restarts, 1);
    tick(w, 61_000); // past the write bound, inside the restart window
    btz.noteReported("Asia/Tokyo");
    await settle();
    assert.deepEqual(w.writes.map((x) => x.TZ), ["Europe/Paris", "Asia/Tokyo"]);
    assert.equal(w.restarts, 1, "restart waits");
    tick(w, 10 * 60_000);
    await btz.reconcile();
    assert.equal(w.restarts, 2);
    btz.stop();
  });

  test("the definition is written at most once per 60s; the latest value lands at the next opportunity", async () => {
    const w = world({ active: ["busy"] });
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    tick(w, 10_000);
    btz.noteReported("Asia/Tokyo");
    await settle();
    assert.deepEqual(w.writes.map((x) => x.TZ), ["Europe/Paris"], "second write bounded");
    tick(w, 60_000);
    await btz.reconcile();
    assert.deepEqual(w.writes.map((x) => x.TZ), ["Europe/Paris", "Asia/Tokyo"]);
    btz.stop();
  });

  test("idle is re-checked immediately before the restart (work that started while earlier reads were in flight)", async () => {
    const w = world();
    const btz = w.make({
      // The running-TZ probe is the last thing before the idle check; a turn starts during it.
      readRunningTz: async () => {
        w.active = ["ses_started_meanwhile"];
        return "";
      },
    });
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.equal(w.restarts, 0);
    btz.stop();
  });

  test("the unit lost its TZ after a re-install → re-applied", async () => {
    const w = world({ stored: "Europe/Paris", defTz: "Europe/Paris", runningTz: "Europe/Paris" });
    const btz = w.make();
    await btz.start();
    await btz.reconcile();
    assert.equal(w.writes.length, 0);
    w.def = null; // install.sh re-rendered the unit from its template
    w.running = ""; // …and restarted opencode without TZ
    tick(w, 61_000);
    await btz.reconcile();
    assert.deepEqual(w.writes, [{ TZ: "Europe/Paris" }]);
    assert.equal(w.restarts, 1);
    btz.stop();
  });

  test("boot: definition already matches but the RUNNING opencode lacks it → restart owed and performed", async () => {
    const w = world({ stored: "Europe/Paris", defTz: "Europe/Paris", runningTz: "" });
    const btz = w.make();
    await btz.start();
    await btz.reconcile();
    assert.equal(w.writes.length, 0);
    assert.equal(w.restarts, 1);
    btz.stop();
  });

  test("boot: running TZ unreadable (launchd) and this process wrote nothing → not owed", async () => {
    const w = world({ supervisor: "launchd", stored: "Europe/Paris", defTz: "Europe/Paris", runningTz: null });
    const btz = w.make();
    await btz.start();
    await btz.reconcile();
    assert.equal(w.restarts, 0);
    btz.stop();
  });

  test("nohup: process TZ still follows, the service is never touched, no throw, logged once", async () => {
    const w = world({ supervisor: "nohup" });
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    await btz.reconcile();
    await btz.reconcile();
    assert.deepEqual(w.processTz, ["Europe/Paris"]);
    assert.deepEqual(w.writes, []);
    assert.equal(w.restarts, 0);
    assert.equal(w.logs.filter((l) => /no service definition/.test(l)).length, 1);
    btz.stop();
  });

  test("an invalid tz is ignored (logged once per value) and nothing is written anywhere", async () => {
    const w = world();
    const btz = w.make();
    await btz.start();
    for (const bad of ["Foo/Bar", "Foo/Bar", "Europe/Paris\nX=1", "a b", 42]) btz.noteReported(bad);
    await settle();
    assert.deepEqual(w.processTz, []);
    assert.deepEqual(w.saves, []);
    assert.deepEqual(w.writes, []);
    assert.equal(w.logs.filter((l) => /ignoring invalid/.test(l)).length, 4);
    btz.stop();
  });

  test("an invalid STORED value is not adopted", async () => {
    const w = world({ stored: "Not/AZone" });
    const btz = w.make();
    await btz.start();
    assert.deepEqual(w.processTz, []);
    assert.equal(btz.snapshot().desired, null);
    btz.stop();
  });

  test("noteReported(undefined/null/empty) is a no-op", async () => {
    const w = world();
    const btz = w.make();
    await btz.start();
    for (const v of [undefined, null, ""]) btz.noteReported(v);
    await settle();
    assert.deepEqual(w.saves, []);
    assert.deepEqual(w.writes, []);
    assert.equal(w.logs.length, 0);
    btz.stop();
  });

  test("a definition write that fails keeps the restart owed and never restarts", async () => {
    const w = world();
    w.service.setEnv = async () => {
      throw new Error("plist has no :EnvironmentVariables");
    };
    const btz = w.make();
    await btz.start();
    btz.noteReported("Europe/Paris");
    await settle();
    assert.equal(w.restarts, 0);
    assert.equal(btz.snapshot().restartOwed, true);
    assert.ok(w.logs.some((l) => /failed/.test(l)));
    btz.stop();
  });

  test("start() applies the stored zone to the process BEFORE it resolves (the schedule poller starts right after)", async () => {
    const w = world({ stored: "Europe/Paris", defTz: "Europe/Paris", runningTz: "Europe/Paris" });
    const btz = w.make();
    await btz.start();
    assert.deepEqual(w.processTz, ["Europe/Paris"]);
    btz.stop();
  });

  test("the check timer is registered and unref'd; stop() clears it", async () => {
    const w = world();
    const calls = [];
    const btz = w.make({
      checkEveryMs: 60_000,
      setIntervalFn: (fn, ms) => {
        calls.push(["set", ms]);
        return { unref: () => calls.push(["unref"]) };
      },
      clearIntervalFn: () => calls.push(["clear"]),
    });
    await btz.start();
    btz.stop();
    assert.deepEqual(calls, [["set", 60_000], ["unref"], ["clear"]]);
  });
});

describe("readRunningOpencodeTz", () => {
  const env = (s) => ({ supervisor: "systemd", readPid: async () => 4242, read: async (p) => (assert.equal(p, "/proc/4242/environ"), s) });
  test("reads TZ out of the NUL-separated environment; absent → empty string", async () => {
    assert.equal(await readRunningOpencodeTz(env("PATH=/bin\0TZ=Europe/Paris\0HOME=/h\0")), "Europe/Paris");
    assert.equal(await readRunningOpencodeTz(env("PATH=/bin\0TZDATA=x\0")), "");
  });
  test("unknown (null) when there is no pid, the read fails, or the supervisor can't tell", async () => {
    assert.equal(await readRunningOpencodeTz({ supervisor: "systemd", readPid: async () => null }), null);
    assert.equal(await readRunningOpencodeTz({ supervisor: "systemd", readPid: async () => 1, read: async () => { throw new Error("EACCES"); } }), null);
    assert.equal(await readRunningOpencodeTz({ supervisor: "launchd", readPid: async () => assert.fail("must not look") }), null);
  });
});

describe("restartOpencodeService", () => {
  test("systemd → the shared restart; launchd → bootout+bootstrap (never kickstart) and opens the cache grace window", async () => {
    let sysd = 0;
    const out = await restartOpencodeService({ service: { supervisor: "systemd" }, restartSystemd: async () => (sysd++, { ok: true }), invalidate: () => assert.fail("restartOpencode owns it") });
    assert.deepEqual([out, sysd], [{ ok: true }, 1]);

    const execs = [];
    const invalidated = [];
    const service = createOpencodeService({
      platform: "darwin",
      home: "/Users/u",
      uid: 501,
      exec: async (cmd, args) => (execs.push([cmd, ...args]), { stdout: "", stderr: "" }),
      exists: (p) => p.endsWith(".plist"),
    });
    const r = await restartOpencodeService({ service, restartSystemd: () => assert.fail("not systemd"), invalidate: (o) => invalidated.push(o) });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(execs, [
      ["launchctl", "bootout", "gui/501/com.mantaui.opencode"],
      ["launchctl", "bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/com.mantaui.opencode.plist"],
    ]);
    assert.deepEqual(invalidated, [{ restarted: true }]);
  });
  test("a launchd bootstrap failure is reported, not thrown", async () => {
    const service = createOpencodeService({
      platform: "darwin",
      home: "/Users/u",
      exec: async (cmd, args) => {
        if (args[0] === "bootstrap") throw new Error("Bootstrap failed: 5");
        return { stdout: "", stderr: "" };
      },
      exists: (p) => p.endsWith(".plist"),
    });
    const r = await restartOpencodeService({ service, restartSystemd: async () => ({ ok: true }), invalidate: () => assert.fail("must not claim a restart") });
    assert.equal(r.ok, false);
    assert.match(r.error, /Bootstrap failed/);
  });
});
