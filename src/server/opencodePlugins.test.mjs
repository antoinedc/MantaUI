import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_RESTART_MAX_UPTIME_MS,
  defaultPluginPaths,
  parseOpencodeUptimeMs,
  readOpencodeUptimeMs,
  runStartupPluginSync,
  shouldRestartOpencodeForPlugins,
  syncOpencodePlugins,
} from "./opencodePlugins.mjs";

const quiet = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(["log", a.join(" ")]), warn: (...a) => lines.push(["warn", a.join(" ")]) };
};

test("shouldRestartOpencodeForPlugins: only a change + an opencode that JUST started", () => {
  const MIN = 60_000;
  assert.equal(shouldRestartOpencodeForPlugins({ changed: true, opencodeUptimeMs: 10_000 }), true);
  assert.equal(shouldRestartOpencodeForPlugins({ changed: true, opencodeUptimeMs: 3 * MIN - 1 }), true);
  assert.equal(shouldRestartOpencodeForPlugins({ changed: true, opencodeUptimeMs: 3 * MIN }), false);
  assert.equal(PLUGIN_RESTART_MAX_UPTIME_MS, 3 * MIN);
  assert.equal(shouldRestartOpencodeForPlugins({ changed: false, opencodeUptimeMs: 1000 }), false);
  for (const bad of [null, undefined, NaN, -5, Infinity, "10"]) {
    assert.equal(shouldRestartOpencodeForPlugins({ changed: true, opencodeUptimeMs: bad }), false, `unknown uptime ${bad} never restarts`);
  }
});

test("parseOpencodeUptimeMs: monotonic enter time vs /proc/uptime; 0 / garbage / future → null", () => {
  assert.equal(parseOpencodeUptimeMs({ showOutput: "ActiveEnterTimestampMonotonic=9000000000\n", procUptime: "10000.50 40000.1\n" }), 1_000_500);
  assert.equal(parseOpencodeUptimeMs({ showOutput: "ActiveEnterTimestampMonotonic=0\n", procUptime: "100 1" }), null, "never active");
  assert.equal(parseOpencodeUptimeMs({ showOutput: "", procUptime: "100 1" }), null);
  assert.equal(parseOpencodeUptimeMs({ showOutput: "ActiveEnterTimestampMonotonic=5\n", procUptime: "garbage" }), null);
  assert.equal(parseOpencodeUptimeMs({ showOutput: "ActiveEnterTimestampMonotonic=900000000000\n", procUptime: "10 1" }), null, "enter time after now");
});

test("readOpencodeUptimeMs: any failure (no systemctl, macOS, unreadable /proc) → null", async () => {
  assert.equal(await readOpencodeUptimeMs({ exec: async () => { throw new Error("ENOENT"); }, readProc: async () => "1 1" }), null);
  assert.equal(await readOpencodeUptimeMs({ exec: async () => "ActiveEnterTimestampMonotonic=1000000\n", readProc: async () => { throw new Error("no /proc"); } }), null);
  assert.equal(await readOpencodeUptimeMs({ exec: async () => "ActiveEnterTimestampMonotonic=1000000\n", readProc: async () => "61.0 1" }), 60_000);
});

test("runStartupPluginSync: changed + just-started opencode → restart; changed + long-running → no restart, says so; unchanged → silent", async () => {
  const result = (over) => async () => ({ changed: true, installed: 2, updated: 2, removed: 0, warnings: [], ...over });
  let restarts = 0;
  const restart = async () => { restarts++; return { ok: true }; };

  let log = quiet();
  await runStartupPluginSync({ paths: {}, sync: result(), readUptime: async () => 20_000, restart, log });
  assert.equal(restarts, 1);
  assert.match(log.lines.map((l) => l[1]).join("\n"), /restarted opencode/);

  log = quiet();
  await runStartupPluginSync({ paths: {}, sync: result(), readUptime: async () => 3_600_000, restart, log });
  assert.equal(restarts, 1, "a long-running opencode is left alone");
  assert.match(log.lines.map((l) => l[1]).join("\n"), /takes effect on next opencode restart/);

  log = quiet();
  await runStartupPluginSync({ paths: {}, sync: result(), readUptime: async () => null, restart, log });
  assert.equal(restarts, 1, "unknown uptime never restarts");

  log = quiet();
  await runStartupPluginSync({ paths: {}, sync: result({ changed: false, updated: 0 }), readUptime: async () => { assert.fail("not asked when nothing changed"); }, restart, log });
  assert.deepEqual(log.lines, []);
  assert.equal(restarts, 1);
});

test("runStartupPluginSync: warnings are logged with [plugins]; a failing restart or sync never throws", async () => {
  let log = quiet();
  await runStartupPluginSync({ paths: {}, sync: async () => ({ changed: false, installed: 0, updated: 0, removed: 0, warnings: ["cannot create /x"] }), log });
  assert.deepEqual(log.lines, [["warn", "[plugins] cannot create /x"]]);

  log = quiet();
  await runStartupPluginSync({ paths: {}, sync: async () => ({ changed: true, installed: 1, updated: 1, removed: 0, warnings: [] }), readUptime: async () => 1000, restart: async () => ({ ok: false, error: "boom" }), log });
  assert.ok(log.lines.some((l) => l[0] === "warn" && /restart failed: boom/.test(l[1])));

  log = quiet();
  assert.equal(await runStartupPluginSync({ paths: {}, sync: async () => { throw new Error("kaboom"); }, log }), null);
  assert.ok(log.lines.some((l) => l[0] === "warn" && /startup sync failed/.test(l.join(" "))));
});

test("defaultPluginPaths: source is the repo's docs/opencode-plugins; dest honours OPENCODE_CONFIG_DIR; manifest is the state file the shell uses", () => {
  const prev = process.env.OPENCODE_CONFIG_DIR;
  const prevState = process.env.MANTA_STATE_HOME;
  try {
    process.env.OPENCODE_CONFIG_DIR = "/tmp/some-cfg";
    process.env.MANTA_STATE_HOME = "/tmp/some-state";
    const p = defaultPluginPaths();
    assert.ok(p.srcDir.endsWith("/docs/opencode-plugins"));
    assert.ok(existsSync(p.srcDir), "the shipped plugin dir exists in this checkout");
    assert.ok(readdirSync(p.srcDir).includes("manta-accounts.ts"));
    assert.equal(p.destDir, "/tmp/some-cfg/plugins");
    assert.equal(p.manifestPath, "/tmp/some-state/.manta/opencode-plugins.manifest");
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = prev;
    if (prevState === undefined) delete process.env.MANTA_STATE_HOME; else process.env.MANTA_STATE_HOME = prevState;
  }
});

test("syncOpencodePlugins: an unwritable destination and a missing source are warnings, never throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "plugins-js-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "manta-accounts.ts"), "A");
    wf(join(root, "cfg"), "a FILE where the config dir should be");
    const r = await syncOpencodePlugins({ srcDir: join(root, "src"), destDir: join(root, "cfg", "plugins"), manifestPath: join(root, "m") });
    assert.equal(r.changed, false);
    assert.match(r.warnings[0], /cannot create/);
    const r2 = await syncOpencodePlugins({ srcDir: join(root, "nope"), destDir: join(root, "d"), manifestPath: join(root, "m") });
    assert.equal(r2.changed, false);
    assert.match(r2.warnings[0], /source not found/);
    assert.equal(existsSync(join(root, "m")), false);
    assert.equal(readFileSync(join(root, "src", "manta-accounts.ts"), "utf8"), "A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index.mjs wires the startup sync (it is never imported by tests, so the suite cannot touch a real config dir)", () => {
  const src = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ runStartupPluginSync \} from "\.\/opencodePlugins\.mjs"/);
  assert.match(src, /void runStartupPluginSync\(\)/);
});
