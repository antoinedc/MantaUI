// upgradeV2.test.mjs — the V1 → V2 upgrade state machine, with every I/O injected.
// Covers: preflight disk failure, copy vs in-place, the full K3 timeline, crash +
// resume at EVERY step, retry, rollback, the upgrade-mode path gate, K3 payload shape.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createUpgradeRoutes,
  runSelfUpdateTo,
  COPY_MODE_FACTOR,
  IN_PLACE_FACTOR,
  STEP_IDS,
  computeOverall,
  createUpgradeV2,
  decideMode,
  isUpgradeExemptPath,
} from "./upgradeV2.mjs";
import { V2_PLUGIN_IDS } from "./upgradeV2Prepare.mjs";

const GB = 1024 ** 3;
const NEVER = () => new Promise(() => {});

/** A fully faked box. `opts.crashOn` names a fake that never returns (the process "dies" there). */
function makeBox(opts = {}) {
  const store = opts.store ?? { data: null };
  const calls = [];
  const events = [];
  let clock = 1_000_000;
  const o = {
    dbBytes: 10 * GB,
    freeBytes: 25 * GB,
    v1Sessions: 29,
    v2Sessions: 29,
    migrateScript: [
      { status: "required" },
      { status: "running", progress: { label: "Clearing old events" } },
      { status: "running", progress: { label: "Migrating sessions", numerator: 5, denominator: 29 } },
      { status: "running", progress: { label: "Migrating sessions", numerator: 20, denominator: 29 } },
      { status: "completed" },
    ],
    pluginIds: [...V2_PLUGIN_IDS],
    claudeLogin: false,
    turns: [0],
    prepare: { migrationNeeded: true, passwordCreated: false },
    previous: { git_sha: "abc1234", version: "0.9.0", at: "2026-10-16T00:00:00Z" },
    ...opts,
  };
  const hook = (name) => (o.crashOn === name ? NEVER() : undefined);
  const rec = (name, ...args) => calls.push([name, ...args]);
  let migrateIdx = 0;
  let pluginIdx = 0;
  const turnQueue = [...o.turns];

  const deps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 1000,
    turnPollMs: 2000,
    stopWaitMs: 60_000,
    startTimeoutMs: 10_000,
    requiredStallMs: 5_000,
    publish: (e) => events.push(JSON.parse(JSON.stringify(e))),
    log: () => {},
    loadState: async () => (store.data ? structuredClone(store.data) : null),
    saveState: async (s) => {
      store.data = structuredClone(s);
    },
    v1DbPath: () => "/data/opencode/opencode.db",
    prepare: async () => {
      rec("prepare");
      return o.prepare;
    },
    migrateLegacyWhitelists: async () => {
      rec("migrateWhitelists");
      if (o.whitelistThrows) throw new Error("boom");
      return o.whitelistResult ?? { ok: true, migrated: [] };
    },
    retireV1: async () => rec("retireV1"),
    restoreV1: async () => rec("restoreV1"),
    opencode: {
      stop: async () => {
        rec("opencode.stop");
        return hook("opencode.stop");
      },
      configure: async (variant, args) => rec("opencode.configure", variant, args?.db ?? null),
      start: async () => {
        rec("opencode.start");
        return hook("opencode.start");
      },
    },
    services: {
      pauseBackground: async () => rec("pause"),
      resumeBackground: async () => rec("resume"),
      runningTurns: async () => (turnQueue.length > 1 ? turnQueue.shift() : turnQueue[0]),
    },
    dbSizeBytes: async () => o.dbBytes,
    freeBytes: async () => {
      rec("freeBytes");
      return hook("freeBytes") ?? o.freeBytes;
    },
    fileExists: async () => false,
    removeDb: async (p) => rec("removeDb", p),
    renameFile: async (a, b) => rec("rename", a, b),
    copyDb: async ({ src, dest, onProgress }) => {
      rec("copyDb", src, dest);
      onProgress(1, 4);
      onProgress(3, 4);
      return hook("copyDb");
    },
    countSessions: async (db, which) => (which === "v1" ? o.v1Sessions : o.v2Sessions),
    hasClaudeLogin: async () => o.claudeLogin,
    v2: {
      migrationStatus: async () => {
        rec("v2.migrationStatus");
        const h = hook("v2.migrationStatus");
        if (h) return h;
        const r = o.migrateScript[Math.min(migrateIdx, o.migrateScript.length - 1)];
        migrateIdx += 1;
        if (r instanceof Error) throw r;
        return r;
      },
      pluginIds: async () => {
        const h = hook("v2.pluginIds");
        if (h) return h;
        if (o.pluginIdsScript) return o.pluginIdsScript[Math.min(pluginIdx++, o.pluginIdsScript.length - 1)];
        return o.pluginIds;
      },
      tinyTurn: async () => {
        rec("tinyTurn");
        return o.tinyTurn ?? { ok: true };
      },
    },
    readPreviousRelease: async () => {
      rec("readPrevious");
      return o.previous;
    },
    reinstallPreviousRelease: async (prev) => {
      rec("reinstall", prev.git_sha, prev.version ?? null);
      return o.reinstallResult ?? {};
    },
  };
  return { deps, store, calls, events, o, names: () => calls.map((c) => c[0]), resetMigrate: () => (migrateIdx = 0) };
}

async function runToIdle(machine) {
  await machine.whenIdle();
}

describe("path gate", () => {
  test("exempt paths answer during an upgrade; everything else is gated", () => {
    for (const p of ["/auth/status", "/auth/claim", "/api/version", "/api/upgrade", "/api/upgrade/retry", "/api/upgrade/rollback", "/events", "/push/focus"]) {
      assert.equal(isUpgradeExemptPath(p), true, p);
    }
    for (const p of ["/rpc/tmux:list", "/api/schedule", "/api/upload", "/pty", "/api/versionx", "/api/upgrades", "/authx", "/hook/abc", "/eventsx"]) {
      assert.equal(isUpgradeExemptPath(p), false, p);
    }
  });
});

describe("decideMode", () => {
  test("copy needs 2.4x, in-place 1.4x, below that refuse (needBytes = the in-place need) — boundaries inclusive", () => {
    const db = 100;
    assert.equal(decideMode({ dbBytes: db, freeBytes: 240 }).mode, "copy");
    assert.equal(decideMode({ dbBytes: db, freeBytes: 239 }).mode, "in-place");
    assert.equal(decideMode({ dbBytes: db, freeBytes: 140 }).mode, "in-place");
    const refused = decideMode({ dbBytes: db, freeBytes: 139 });
    assert.equal(refused.mode, null);
    assert.equal(refused.needBytes, 140);
    assert.equal(COPY_MODE_FACTOR, 2.4);
    assert.equal(IN_PLACE_FACTOR, 1.4);
    // the measured growth (13.9→32.5 MB copy = 2.34x, 1.34x in place) fits under the thresholds
    assert.ok(32.5 / 13.9 < COPY_MODE_FACTOR && 1.34 < IN_PLACE_FACTOR);
  });
});

describe("K3 payload", () => {
  test("idle shape: exact keys, six pending steps in order, no error", async () => {
    const box = makeBox();
    const m = createUpgradeV2(box.deps);
    const s = m.status();
    assert.deepEqual(Object.keys(s).sort(), ["error", "etaSeconds", "overall", "state", "steps"]);
    assert.equal(s.state, "idle");
    assert.equal(s.overall, 0);
    assert.equal(s.etaSeconds, null);
    assert.equal(s.error, null);
    assert.deepEqual(s.steps.map((x) => x.id), ["preflight", "stop", "copy", "migrate", "verify", "cutover"]);
    for (const st of s.steps) {
      assert.deepEqual(Object.keys(st).sort(), ["id", "label", "progress", "status"]);
      assert.equal(st.status, "pending");
      assert.equal(st.progress, null);
      assert.equal(typeof st.label, "string");
    }
  });
});

describe("preflight", () => {
  test("not enough disk: fails retryable with needBytes/haveBytes, nothing was stopped", async () => {
    const box = makeBox({ dbBytes: 32 * GB, freeBytes: 3 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    const s = m.status();
    assert.equal(s.state, "failed");
    assert.equal(s.error.step, "preflight");
    assert.equal(s.error.retryable, true);
    assert.equal(s.error.haveBytes, 3 * GB);
    assert.equal(s.error.needBytes, Math.ceil(32 * GB * 1.4));
    assert.match(s.error.message, /free disk space/);
    assert.equal(s.steps[0].status, "failed");
    assert.ok(s.steps[0].error);
    assert.ok(!box.names().includes("opencode.stop"), "preflight must not stop anything");
    assert.ok(!box.names().includes("pause"));
    assert.equal(m.isUpgradeMode(), false, "a failed upgrade is not upgrade mode");
  });

  test("retry after space is freed re-runs preflight and completes", async () => {
    const box = makeBox({ dbBytes: 10 * GB, freeBytes: 2 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    box.o.freeBytes = 30 * GB;
    assert.deepEqual(await m.retry(), { ok: true });
    assert.equal(m.status().state, "running");
    await runToIdle(m);
    assert.equal(m.status().state, "completed");
    assert.equal(m.status().error, null);
  });
});

describe("copy vs in-place", () => {
  test(">= 2.4x free → copy mode: copies to opencode-v2.db, V2 started on that DB", async () => {
    const box = makeBox({ dbBytes: 10 * GB, freeBytes: 25 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "completed");
    const copy = box.calls.find((c) => c[0] === "copyDb");
    assert.deepEqual(copy, ["copyDb", "/data/opencode/opencode.db", "/data/opencode/opencode-v2.db.partial"]);
    assert.deepEqual(box.calls.find((c) => c[0] === "rename"), ["rename", "/data/opencode/opencode-v2.db.partial", "/data/opencode/opencode-v2.db"]);
    const cfg = box.calls.filter((c) => c[0] === "opencode.configure");
    assert.ok(cfg.length >= 2 && cfg.every((c) => c[1] === "v2" && c[2] === "/data/opencode/opencode-v2.db"));
    assert.equal(m._state().mode, "copy");
  });

  test("only 1.4x–2.4x free → in-place: no copy, V2 started with no OPENCODE_DB", async () => {
    const box = makeBox({ dbBytes: 10 * GB, freeBytes: 15 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "completed");
    assert.ok(!box.names().includes("copyDb"));
    const cfg = box.calls.filter((c) => c[0] === "opencode.configure");
    assert.ok(cfg.every((c) => c[1] === "v2" && c[2] === null));
    const copyStep = m.status().steps.find((s) => s.id === "copy");
    assert.equal(copyStep.status, "done");
    assert.equal(copyStep.progress, null);
    assert.equal(m._state().mode, "in-place");
  });
});

describe("full run", () => {
  test("K3 timeline: steps in order, real migration progress surfaces, overall rises 0→1, ETA while migrating", async () => {
    const box = makeBox();
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    const s = m.status();
    assert.equal(s.state, "completed");
    assert.equal(s.overall, 1);
    assert.ok(s.steps.every((x) => x.status === "done"));

    const overalls = box.events.map((e) => e.payload.overall);
    for (let i = 1; i < overalls.length; i++) assert.ok(overalls[i] >= overalls[i - 1], `overall regressed at ${i}: ${overalls}`);
    assert.ok(box.events.every((e) => e.kind === "upgrade"));

    const migrating = box.events.map((e) => e.payload).filter((p) => p.steps.find((x) => x.id === "migrate").status === "running");
    const labels = migrating.map((p) => p.steps.find((x) => x.id === "migrate").progress?.label);
    assert.ok(labels.includes("Clearing old events"));
    const counted = migrating.map((p) => p.steps.find((x) => x.id === "migrate").progress).filter((p) => p?.numerator !== undefined);
    assert.deepEqual(counted.map((p) => [p.numerator, p.denominator]).slice(0, 2), [[5, 29], [20, 29]]);
    assert.ok(migrating.some((p) => typeof p.etaSeconds === "number"), "ETA appears once a rate is measured");
    assert.equal(box.events.at(-1).payload.state, "completed");

    // ordering of the side effects
    const n = box.names();
    assert.ok(n.indexOf("freeBytes") < n.indexOf("pause"));
    assert.ok(n.indexOf("opencode.stop") < n.indexOf("retireV1"));
    assert.ok(n.indexOf("retireV1") < n.indexOf("copyDb"));
    assert.ok(n.indexOf("copyDb") < n.indexOf("opencode.start"));
    assert.equal(n.at(-1), "resume");
    assert.equal(m.isUpgradeMode(), false);
  });

  test("upgrade mode is on exactly while running", async () => {
    const box = makeBox();
    const m = createUpgradeV2(box.deps);
    assert.equal(m.isUpgradeMode(), false);
    await m.boot();
    assert.equal(m.isUpgradeMode(), true);
    await runToIdle(m);
    assert.equal(m.isUpgradeMode(), false);
  });

  test("stop waits for running turns, then stops anyway after the grace period", async () => {
    const box = makeBox({ turns: [2, 1, 0] });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "completed");

    const stuck = makeBox({ turns: [3] });
    const m2 = createUpgradeV2(stuck.deps);
    await m2.boot();
    await runToIdle(m2);
    assert.equal(m2.status().state, "completed");
    assert.ok(stuck.names().includes("opencode.stop"), "turns that outlive the 60s grace end with the stop");
  });

  test("no migration needed (fresh V2 box) → boot does nothing", async () => {
    const box = makeBox({ prepare: { migrationNeeded: false, passwordCreated: false } });
    const m = createUpgradeV2(box.deps);
    assert.deepEqual(await m.boot(), { action: "none" });
    assert.equal(m.status().state, "idle");
    assert.equal(m.isUpgradeMode(), false);
    assert.ok(!box.names().includes("pause"));
  });

  test("a completed upgrade is never re-run on a later boot", async () => {
    const box = makeBox();
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    const box2 = makeBox({ store: box.store });
    const m2 = createUpgradeV2(box2.deps);
    assert.deepEqual(await m2.boot(), { action: "none" });
    assert.equal(m2.status().state, "completed");
    assert.equal(box2.calls.length, 0);
  });

  test("password minted at first boot: no manta-server restart is owed (every reader is lazy) and the run completes", async () => {
    const box = makeBox({ prepare: { migrationNeeded: true, passwordCreated: true } });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "completed");
    assert.ok(!box.names().includes("restartServer"));
    assert.equal("restartServer" in box.deps.services, false);
  });

  test("the release to roll back to is captured when the upgrade STARTS (a later self-update overwrites previous-release.json)", async () => {
    const box = makeBox({ pluginIds: [] });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    assert.equal(box.store.data.previousRelease.git_sha, "abc1234");
    box.o.previous = { git_sha: "ffffff0", version: "9.9.9" }; // the file changed afterwards
    box.calls.length = 0;
    await m.rollback();
    assert.deepEqual(box.calls.find((c) => c[0] === "reinstall"), ["reinstall", "abc1234", "0.9.0"]);
  });
});

describe("crash and resume at every step", () => {
  // A crash = the process dies while a step is mid-flight: the in-flight promise is abandoned and a
  // NEW machine boots from whatever was persisted.
  const cases = [
    ["preflight", "freeBytes", { dbBytes: 10 * GB, freeBytes: 25 * GB }],
    ["stop", "opencode.stop", {}],
    ["copy", "copyDb", {}],
    ["migrate", "v2.migrationStatus", {}],
    ["verify", "v2.pluginIds", {}],
    ["cutover", "opencode.start", { _secondStartOnly: true }],
  ];
  for (const [step, crashOn, extra] of cases) {
    test(`crash during ${step} → next boot resumes and finishes; earlier steps are not redone`, async () => {
      const store = { data: null };
      const first = makeBox({ store, crashOn: extra._secondStartOnly ? undefined : crashOn, ...extra });
      if (extra._secondStartOnly) {
        // cutover is the SECOND opencode.start of a run: crash on that one.
        let starts = 0;
        const realStart = first.deps.opencode.start;
        first.deps.opencode.start = async () => {
          await realStart();
          starts += 1;
          if (starts === 2) return NEVER();
        };
      }
      const m1 = createUpgradeV2(first.deps);
      await m1.boot();
      // let it run until it is wedged inside the step
      for (let i = 0; i < 200 && store.data?.steps?.[step]?.status !== "running"; i++) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(store.data.state, "running");
      assert.equal(store.data.steps[step].status, "running", `${step} was in flight when the process died`);
      const doneBefore = STEP_IDS.filter((id) => store.data.steps[id].status === "done");

      const second = makeBox({ store, ...extra, crashOn: undefined });
      const m2 = createUpgradeV2(second.deps);
      assert.deepEqual(await m2.boot(), { action: "resume" });
      assert.equal(m2.isUpgradeMode(), true, "resumed upgrade is in upgrade mode immediately");
      assert.equal(second.names()[0], "pause", "a resumed run re-pauses the pollers the fresh process just started");
      await runToIdle(m2);
      assert.equal(m2.status().state, "completed", JSON.stringify(m2.status().error));
      assert.equal(m2.status().overall, 1);
      assert.ok(!second.names().includes("prepare"), "resume does not re-prepare");
      if (doneBefore.includes("preflight")) assert.ok(!second.names().includes("freeBytes"), "preflight was not redone");
      if (doneBefore.includes("stop")) assert.ok(!second.names().includes("opencode.stop"), "stop was not redone");
      if (doneBefore.includes("copy")) assert.ok(!second.names().includes("copyDb"), "copy was not redone");
      if (step === "copy") assert.ok(second.names().includes("copyDb"), "an interrupted copy is redone from scratch");
    });
  }
});

describe("failure, retry", () => {
  test("verify finds a missing plugin → failed + retryable; fixing it and retrying completes without redoing the migration", async () => {
    const box = makeBox({ pluginIds: ["manta"] });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    let s = m.status();
    assert.equal(s.state, "failed");
    assert.equal(s.error.step, "verify");
    assert.equal(s.error.retryable, true);
    assert.match(s.error.message, /manta\.claude-max/);
    assert.equal(s.steps.find((x) => x.id === "migrate").status, "done");
    assert.equal(s.steps.find((x) => x.id === "verify").status, "failed");
    const startsBefore = box.calls.filter((c) => c[0] === "opencode.start").length;

    box.o.pluginIds = [...V2_PLUGIN_IDS];
    assert.deepEqual(await m.retry(), { ok: true });
    await runToIdle(m);
    s = m.status();
    assert.equal(s.state, "completed");
    // verify + cutover ran; migrate did not start V2 again (cutover restarts it once)
    assert.equal(box.calls.filter((c) => c[0] === "opencode.start").length, startsBefore + 1);
  });

  test("cutover migrates legacy whitelists once, after V2 is up", async () => {
    const box = makeBox({ whitelistResult: { ok: true, migrated: ["openrouter"] } });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "completed");
    const names = box.names();
    assert.equal(names.filter((n) => n === "migrateWhitelists").length, 1);
    assert.ok(names.lastIndexOf("opencode.start") < names.indexOf("migrateWhitelists"), "runs after the switch-over start");
    assert.ok(names.indexOf("migrateWhitelists") < names.lastIndexOf("resume"), "before background work resumes");
  });

  for (const [label, o] of [
    ["returns ok:false", { whitelistResult: { ok: false, migrated: [], error: "config locked" } }],
    ["throws", { whitelistThrows: true }],
  ]) {
    test(`a whitelist migration that ${label} is logged and never fails the cutover step`, async () => {
      const box = makeBox(o);
      const logs = [];
      const m = createUpgradeV2({ ...box.deps, log: (l) => logs.push(l) });
      await m.boot();
      await runToIdle(m);
      const s = m.status();
      assert.equal(s.state, "completed");
      assert.equal(s.steps.find((x) => x.id === "cutover").status, "done");
      assert.ok(logs.some((l) => /whitelist migration .*\(ignored\)/.test(l)), logs.join("\n"));
    });
  }

  test("a failed earlier step never reaches the whitelist migration", async () => {
    const box = makeBox({ dbBytes: 10 * GB, freeBytes: 1 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    assert.ok(!box.names().includes("migrateWhitelists"));
  });

  test("plugins load lazily: an empty first listing is polled until they appear — no false failure", async () => {
    const box = makeBox({ pluginIdsScript: [[], ["manta"], [...V2_PLUGIN_IDS]] });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "completed", JSON.stringify(m.status().error));
  });

  test("V2 reports a migration error → failed at migrate; retry restarts V2 and resumes", async () => {
    const box = makeBox({
      migrateScript: [
        { status: "running", progress: { label: "Migrating sessions", numerator: 3, denominator: 29 } },
        { status: "error", error: { message: "disk full" } },
      ],
    });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    assert.equal(m.status().error.step, "migrate");
    assert.match(m.status().error.message, /disk full/);
    assert.equal(m.status().error.retryable, true);

    box.o.migrateScript = [{ status: "completed" }];
    box.resetMigrate();
    await m.retry();
    await runToIdle(m);
    assert.equal(m.status().state, "completed");
    assert.equal(box.calls.filter((c) => c[0] === "opencode.start").length, 3, "migrate start, retried migrate start, cutover start");
  });

  test("V2 never answers → migrate fails 'did not come up'", async () => {
    const box = makeBox({ migrateScript: [new Error("ECONNREFUSED")] });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    assert.match(m.status().error.message, /did not come up/);
  });

  test("V1 session count above V2's → non-retryable mismatch", async () => {
    const box = makeBox({ v1Sessions: 30, v2Sessions: 29 });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    assert.equal(m.status().error.step, "verify");
    assert.equal(m.status().error.retryable, false);
    assert.match(m.status().error.message, /30 before, 29 after/);
  });

  test("a failed test turn fails verify; with no Claude login the turn is skipped silently", async () => {
    const withLogin = makeBox({ claudeLogin: true, tinyTurn: { ok: false, error: "401" } });
    const m = createUpgradeV2(withLogin.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    assert.match(m.status().error.message, /test turn failed: 401/);

    const noLogin = makeBox({ claudeLogin: false });
    const m2 = createUpgradeV2(noLogin.deps);
    await m2.boot();
    await runToIdle(m2);
    assert.equal(m2.status().state, "completed");
    assert.ok(!noLogin.names().includes("tinyTurn"));
  });

  test("retry / rollback refuse when there is nothing failed", async () => {
    const box = makeBox();
    const m = createUpgradeV2(box.deps);
    assert.equal((await m.retry()).ok, false);
    assert.equal((await m.rollback()).ok, false);
    await m.boot();
    assert.equal((await m.retry()).ok, false, "already running");
    assert.equal((await m.rollback()).ok, false, "already running");
    await runToIdle(m);
    assert.equal((await m.retry()).ok, false, "completed");
    assert.equal((await m.rollback()).ok, false, "completed upgrades are not rolled back");
  });
});

describe("rollback", () => {
  async function failedAtVerify(extra = {}) {
    const box = makeBox({ pluginIds: [], ...extra });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    assert.equal(m.status().state, "failed");
    box.calls.length = 0;
    return { box, m };
  }

  test("copy mode: V2 stopped, the copy removed, V1 assets + service restored, previous release re-installed", async () => {
    const { box, m } = await failedAtVerify();
    assert.deepEqual(await m.rollback(), { ok: true });
    assert.deepEqual(box.names(), [
      "opencode.stop", "removeDb", "removeDb", "restoreV1", "opencode.configure", "opencode.start", "resume", "reinstall",
    ]);
    assert.deepEqual(box.calls.at(-1), ["reinstall", "abc1234", "0.9.0"], "self-update --to gets the recorded sha + version");
    assert.deepEqual(box.calls.filter((c) => c[0] === "removeDb").map((c) => c[1]), [
      "/data/opencode/opencode-v2.db.partial", "/data/opencode/opencode-v2.db",
    ]);
    assert.deepEqual(box.calls.find((c) => c[0] === "opencode.configure"), ["opencode.configure", "v1", null]);
    const s = m.status();
    assert.equal(s.state, "rolled_back");
    assert.equal(s.error, null);
    assert.ok(s.steps.every((x) => x.status === "pending"));
    assert.equal(m.isUpgradeMode(), false);
    // persisted BEFORE the reinstall (which restarts manta-server and kills this process)
    assert.equal(box.store.data.state, "rolled_back");
  });

  test("failed at the disk preflight: V1 was never touched, so rollback only re-installs the previous release", async () => {
    const box = makeBox({ dbBytes: 10 * GB, freeBytes: 1 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await runToIdle(m);
    box.calls.length = 0;
    assert.deepEqual(await m.rollback(), { ok: true });
    assert.deepEqual(box.names(), ["resume", "reinstall"]);
    assert.equal(m.status().state, "rolled_back");
  });

  test("in-place mode: nothing to delete — V1 tables are intact", async () => {
    const { box, m } = await failedAtVerify({ dbBytes: 10 * GB, freeBytes: 15 * GB });
    await m.rollback();
    assert.ok(!box.names().includes("removeDb"));
    assert.ok(box.names().includes("restoreV1"));
    assert.equal(m.status().state, "rolled_back");
  });

  test("previous-release.json missing → still rolled back to V1 (service, assets, DB), with the reason surfaced and no reinstall attempted", async () => {
    const { box, m } = await failedAtVerify({ previous: null });
    assert.deepEqual(await m.rollback(), { ok: true });
    const s = m.status();
    assert.equal(s.state, "rolled_back");
    assert.equal(s.error.step, "rollback");
    assert.match(s.error.message, /previous-release\.json is missing/);
    assert.ok(box.names().includes("restoreV1") && box.names().includes("opencode.start"));
    assert.ok(!box.names().includes("reinstall"));
    assert.equal(box.store.data.state, "rolled_back");
  });

  test("the re-install itself failing (host lacks the build…) → V1 is back, the failure reason is surfaced", async () => {
    const { m } = await failedAtVerify({ reinstallResult: { skipped: "self-update.sh --to abc1234 failed (exit 1): release host no longer has commit abc1234" } });
    assert.deepEqual(await m.rollback(), { ok: true });
    assert.equal(m.status().state, "rolled_back");
    assert.match(m.status().error.message, /release host no longer has commit/);
  });

  test("a rolled-back box is not auto-upgraded again on the next boot", async () => {
    const { box, m } = await failedAtVerify();
    await m.rollback();
    const box2 = makeBox({ store: box.store });
    const m2 = createUpgradeV2(box2.deps);
    assert.deepEqual(await m2.boot(), { action: "none" });
    assert.equal(m2.status().state, "rolled_back");
  });

  test("a failure inside rollback is reported, not swallowed", async () => {
    const { box, m } = await failedAtVerify();
    box.deps.restoreV1 = async () => {
      throw new Error("disk exploded");
    };
    const r = await m.rollback();
    assert.equal(r.ok, false);
    assert.match(r.error, /disk exploded/);
    assert.equal(m.status().state, "failed", "still failed — the user can retry the rollback");
  });
});

describe("computeOverall", () => {
  test("in-place mode ignores the copy step's weight", () => {
    const mk = (status) => ({ status, progress: null });
    const steps = { preflight: mk("done"), stop: mk("done"), copy: mk("pending"), migrate: mk("pending"), verify: mk("pending"), cutover: mk("pending") };
    const copyMode = computeOverall(steps, "copy");
    const inPlace = computeOverall(steps, "in-place");
    assert.ok(inPlace > copyMode);
  });
});

describe("HTTP surface (real server): upgrade-mode 503 gate + K3 routes", () => {
  async function withServer(engine, fn) {
    const routes = createUpgradeRoutes(engine);
    const server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (await routes.handle(req, res, path)) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ passthrough: path }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(async (method, path) => {
        const res = await fetch(base + path, { method });
        return { status: res.status, body: await res.json(), headers: res.headers };
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  test("while running: gated routes 503 with {error,upgrade:true}; exempt routes pass; /api/upgrade answers", async () => {
    const box = makeBox({ crashOn: "opencode.stop" }); // wedge in `stop` so it stays running
    const m = createUpgradeV2(box.deps);
    await m.boot();
    for (let i = 0; i < 100 && m._state().steps.stop.status !== "running"; i++) await new Promise((r) => setImmediate(r));
    assert.equal(m.isUpgradeMode(), true);
    await withServer(m, async (call) => {
      for (const [method, p] of [["POST", "/rpc/tmux:list"], ["GET", "/api/schedule"], ["POST", "/api/upload"], ["POST", "/hook/abc"]]) {
        const r = await call(method, p);
        assert.equal(r.status, 503, p);
        assert.deepEqual(r.body, { error: "box upgrading", upgrade: true });
      }
      for (const p of ["/api/version", "/events", "/push/focus", "/auth/status"]) {
        const r = await call(p === "/push/focus" ? "POST" : "GET", p);
        assert.equal(r.status, 200, p);
        assert.deepEqual(r.body, { passthrough: p });
      }
      const st = await call("GET", "/api/upgrade");
      assert.equal(st.status, 200);
      assert.equal(st.body.state, "running");
      assert.equal(st.body.steps.length, 6);
      const r1 = await call("POST", "/api/upgrade/retry");
      assert.deepEqual(r1.body.ok, false, "retry refused while running");
    });
  });

  test("failed: no gate, /api/upgrade shows the error, retry + rollback answer {ok}", async () => {
    const box = makeBox({ dbBytes: 10 * GB, freeBytes: 1 * GB });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    await m.whenIdle();
    await withServer(m, async (call) => {
      assert.equal((await call("POST", "/rpc/x")).status, 200, "not upgrade mode any more");
      const st = await call("GET", "/api/upgrade");
      assert.equal(st.body.state, "failed");
      assert.equal(st.body.error.needBytes, Math.ceil(10 * GB * 1.4));
      assert.equal(st.body.error.haveBytes, 1 * GB);
      assert.deepEqual((await call("POST", "/api/upgrade/rollback")).body, { ok: true });
      assert.equal((await call("GET", "/api/upgrade")).body.state, "rolled_back");
      assert.equal((await call("POST", "/api/upgrade/retry")).body.ok, false);
    });
  });
});

describe("runSelfUpdateTo (the real re-install call)", () => {
  const fakeChild = (exitCode) => {
    const handlers = {};
    return {
      on: (ev, fn) => ((handlers[ev] = fn), undefined),
      unref: () => {},
      fire: () => handlers.exit?.(exitCode),
    };
  };
  const run = (opts) =>
    runSelfUpdateTo({ script: "/s/self-update.sh", logPath: "/l", exists: () => true, readLog: () => "\u001b[32m✓\u001b[0m a\n\u001b[31m✗ self-update: release host no longer has commit abc1234 (manta-0.9.0.txt is now commit c0ffee)\u001b[0m\n", ...opts });

  test("passes --to <sha> and --version, and only when a version is recorded", async () => {
    for (const [version, want] of [["0.9.0", ["/s/self-update.sh", "--to", "abc1234", "--version", "0.9.0"]], [undefined, ["/s/self-update.sh", "--to", "abc1234"]]]) {
      let seen;
      const c = fakeChild(0);
      const p = run({ sha: "abc1234", version, spawnFn: (cmd, args) => ((seen = [cmd, args]), c) });
      c.fire();
      assert.deepEqual(await p, {});
      assert.deepEqual(seen, ["bash", want]);
    }
  });
  test("an early non-zero exit is a failure carrying the script's last log line (ANSI stripped)", async () => {
    const c = fakeChild(1);
    const p = run({ sha: "abc1234", spawnFn: () => c });
    c.fire();
    const r = await p;
    assert.match(r.skipped, /^self-update\.sh --to abc1234 failed \(exit 1\): ✗ self-update: release host no longer has commit/);
    assert.ok(!r.skipped.includes("\u001b"));
  });
  test("still running after the watch window = it reached the server restart = success", async () => {
    const c = fakeChild(0);
    assert.deepEqual(await run({ sha: "abc1234", spawnFn: () => c, watchMs: 5 }), {});
  });
  test("a missing script or a spawn that throws is reported, never thrown", async () => {
    assert.match((await runSelfUpdateTo({ script: "/nope/self-update.sh", sha: "abc1234" })).skipped, /self-update\.sh is missing/);
    const r = await run({ sha: "abc1234", spawnFn: () => { throw new Error("EPERM"); } });
    assert.match(r.skipped, /could not start self-update\.sh: EPERM/);
  });
});

describe("WebSocket gate in upgrade mode", () => {
  // The real wiring shape from index.mjs: an http server whose `upgrade` handler asks the gate first.
  async function wsServer(engine) {
    const routes = createUpgradeRoutes(engine);
    const wss = new WebSocketServer({ noServer: true });
    const server = createServer((_, res) => res.end("x"));
    server.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url, "http://x").pathname;
      if (routes.refuseWebSocket(socket, path)) return;
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(`hello ${path}`));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { port: server.address().port, close: () => new Promise((r) => { wss.close(); server.close(r); server.closeAllConnections?.(); }) };
  }
  const attempt = (port, path) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ refused: true, status: res.statusCode, body: JSON.parse(body), retryAfter: res.headers["retry-after"] }));
      });
      ws.on("message", (m) => { resolve({ refused: false, message: String(m) }); ws.close(); });
      ws.on("error", () => {});
    });

  test("while running: /pty and /call are refused with HTTP 503 {error,upgrade:true} before the handshake; /events is allowed", async () => {
    const box = makeBox({ crashOn: "opencode.stop" });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    for (let i = 0; i < 100 && m._state().steps.stop.status !== "running"; i++) await new Promise((r) => setImmediate(r));
    assert.equal(m.isUpgradeMode(), true);
    const srv = await wsServer(m);
    try {
      for (const p of ["/pty?session=a", "/call", "/anything-else"]) {
        const r = await attempt(srv.port, p);
        assert.equal(r.refused, true, p);
        assert.equal(r.status, 503, p);
        assert.deepEqual(r.body, { error: "box upgrading", upgrade: true });
        assert.equal(r.retryAfter, "5");
      }
      const ev = await attempt(srv.port, "/events");
      assert.deepEqual(ev, { refused: false, message: "hello /events" });
    } finally {
      await srv.close();
    }
  });

  test("when not upgrading, /pty and /call connect normally", async () => {
    const box = makeBox({ prepare: { migrationNeeded: false, passwordCreated: false } });
    const m = createUpgradeV2(box.deps);
    await m.boot();
    const srv = await wsServer(m);
    try {
      assert.deepEqual(await attempt(srv.port, "/pty"), { refused: false, message: "hello /pty" });
      assert.deepEqual(await attempt(srv.port, "/call"), { refused: false, message: "hello /call" });
    } finally {
      await srv.close();
    }
  });

  test("index.mjs asks the gate in its real upgrade handler, after auth and before routing", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.mjs"), "utf8");
    const h = src.slice(src.indexOf("const handleUpgrade = "));
    assert.ok(h.indexOf("authEngine.authorize") < h.indexOf("upgradeRoutes.refuseWebSocket(socket, url.pathname)"));
    assert.ok(h.indexOf("upgradeRoutes.refuseWebSocket") < h.indexOf('url.pathname === "/events"'));
    assert.ok(h.indexOf("upgradeRoutes.refuseWebSocket") < h.indexOf('url.pathname === "/pty"'));
    assert.ok(h.indexOf("upgradeRoutes.refuseWebSocket") < h.indexOf('url.pathname === "/call"'));
  });
});
