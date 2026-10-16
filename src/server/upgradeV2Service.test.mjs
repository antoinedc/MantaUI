// upgradeV2Service.test.mjs — unit-text patching + the three-supervisor controller (fake exec/fs).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readOpencodePassword, createOpencodeService, detectSupervisor, patchUnitText, serviceEnvFor, unitEnvValue, unitExecBin } from "./upgradeV2Service.mjs";

const UNIT = `[Unit]
Description=opencode

[Service]
Type=simple
ExecStart=/home/u/.opencode/bin/opencode serve --port 4096 --hostname 127.0.0.1
Environment=PATH=/usr/bin
Environment=ANTHROPIC_CLI_VERSION=2.1.257
Restart=on-failure

[Install]
WantedBy=default.target
`;

describe("patchUnitText", () => {
  test("sets the binary, keeps its arguments", () => {
    const out = patchUnitText(UNIT, { bin: "/home/u/.opencode/bin/opencode-v1" });
    assert.equal(unitExecBin(out), "/home/u/.opencode/bin/opencode-v1");
    assert.match(out, /ExecStart=\S+ serve --port 4096 --hostname 127.0.0.1/);
  });
  test("adds, replaces and removes Environment lines inside [Service]", () => {
    let out = patchUnitText(UNIT, { env: { OPENCODE_PASSWORD: "abc", OPENCODE_DB: "/d/x.db" } });
    assert.equal(unitEnvValue(out, "OPENCODE_PASSWORD"), "abc");
    assert.equal(unitEnvValue(out, "OPENCODE_DB"), "/d/x.db");
    assert.ok(out.indexOf("OPENCODE_PASSWORD") < out.indexOf("[Install]"));
    out = patchUnitText(out, { env: { OPENCODE_PASSWORD: "def", OPENCODE_DB: null } });
    assert.equal(unitEnvValue(out, "OPENCODE_PASSWORD"), "def");
    assert.equal(unitEnvValue(out, "OPENCODE_DB"), null, "an absent DB must not be rendered as an EMPTY OPENCODE_DB (V2 would open path '')");
    assert.ok(!/OPENCODE_DB/.test(out));
    assert.equal(unitEnvValue(out, "ANTHROPIC_CLI_VERSION"), "2.1.257", "unrelated env untouched");
  });
  test("idempotent", () => {
    const once = patchUnitText(UNIT, { bin: "/b/opencode", env: { OPENCODE_PASSWORD: "abc" } });
    assert.equal(patchUnitText(once, { bin: "/b/opencode", env: { OPENCODE_PASSWORD: "abc" } }), once);
  });
  test("a value with whitespace is quoted so systemd keeps it whole", () => {
    const out = patchUnitText(UNIT, { env: { OPENCODE_DB: "/my data/x.db" } });
    assert.match(out, /^Environment="OPENCODE_DB=\/my data\/x\.db"$/m);
    assert.equal(unitEnvValue(out, "OPENCODE_DB"), "/my data/x.db");
  });
  test("text with no [Service] section is returned unchanged", () => {
    assert.equal(patchUnitText("nothing here", { bin: "/b" }), "nothing here");
  });
});

describe("serviceEnvFor", () => {
  test("V1 carries neither the V2 password nor a V2 db; V2 carries the password and the db only when given", () => {
    assert.deepEqual(serviceEnvFor("v1", { password: "p", db: "/x" }), { OPENCODE_PASSWORD: null, OPENCODE_DB: null });
    assert.deepEqual(serviceEnvFor("v2", { password: "p", db: "/x" }), { OPENCODE_PASSWORD: "p", OPENCODE_DB: "/x" });
    assert.deepEqual(serviceEnvFor("v2", { password: "p", db: null }), { OPENCODE_PASSWORD: "p", OPENCODE_DB: null });
  });
});

describe("detectSupervisor", () => {
  test("systemd when the unit exists, launchd on a Mac with the plist, otherwise nohup", () => {
    assert.equal(detectSupervisor({ platform: "linux", unitExists: true }), "systemd");
    assert.equal(detectSupervisor({ platform: "linux", unitExists: false }), "nohup");
    assert.equal(detectSupervisor({ platform: "darwin", plistExists: true }), "launchd");
    assert.equal(detectSupervisor({ platform: "darwin", plistExists: false }), "nohup");
  });
});

function fakeIO({ unit = UNIT } = {}) {
  const files = new Map([["UNIT", unit]]);
  const execs = [];
  const writes = [];
  return {
    files,
    execs,
    writes,
    opts: {
      home: "/home/u",
      exec: async (cmd, args) => {
        execs.push([cmd, ...args]);
        return { stdout: "", stderr: "" };
      },
      read: async () => files.get("UNIT"),
      write: async (p, t, mode) => {
        writes.push([p, mode]);
        files.set("UNIT", t);
      },
      exists: (p) => p.endsWith("opencode-serve.service"),
      readPassword: async () => "deadbeef",
    },
  };
}

describe("systemd controller", () => {
  test("configure(v2) pins the V2 binary + password + db + no-autoupdate, 0600, then reloads", async () => {
    const io = fakeIO();
    const svc = createOpencodeService({ platform: "linux", ...io.opts });
    assert.equal(svc.supervisor, "systemd");
    assert.equal(await svc.configure("v2", { db: "/d/opencode-v2.db" }), true);
    const text = io.files.get("UNIT");
    assert.equal(unitExecBin(text), "/home/u/.opencode/bin/opencode");
    assert.equal(unitEnvValue(text, "OPENCODE_PASSWORD"), "deadbeef");
    assert.equal(unitEnvValue(text, "OPENCODE_DB"), "/d/opencode-v2.db");
    assert.equal(unitEnvValue(text, "OPENCODE_DISABLE_AUTOUPDATE"), "true");
    assert.equal(io.writes[0][1], 0o600, "the unit carries a password");
    assert.deepEqual(io.execs.at(-1), ["systemctl", "--user", "daemon-reload"]);
    io.execs.length = 0;
    assert.equal(await svc.configure("v2", { db: "/d/opencode-v2.db" }), false, "already configured → no rewrite, no reload");
    assert.deepEqual(io.execs, []);
  });
  test("configure(v1) returns the unit to the preserved V1 binary and strips every V2-only env", async () => {
    const io = fakeIO();
    const svc = createOpencodeService({ platform: "linux", ...io.opts });
    await svc.configure("v2", { db: "/d/x.db" });
    await svc.configure("v1");
    const text = io.files.get("UNIT");
    assert.equal(unitExecBin(text), "/home/u/.opencode/bin/opencode-v1");
    for (const k of ["OPENCODE_PASSWORD", "OPENCODE_DB", "OPENCODE_DISABLE_AUTOUPDATE"]) assert.equal(unitEnvValue(text, k), null, k);
    assert.equal(unitEnvValue(text, "ANTHROPIC_CLI_VERSION"), "2.1.257");
  });
  test("start/stop use systemctl --user on opencode-serve", async () => {
    const io = fakeIO();
    const svc = createOpencodeService({ platform: "linux", ...io.opts });
    await svc.stop();
    await svc.start();
    assert.deepEqual(io.execs, [["systemctl", "--user", "stop", "opencode-serve"], ["systemctl", "--user", "restart", "opencode-serve"]]);
  });
});

describe("launchd controller", () => {
  test("edits via PlistBuddy and restarts with bootout+bootstrap (never kickstart -k — it reuses the stale definition)", async () => {
    const execs = [];
    const svc = createOpencodeService({
      platform: "darwin",
      home: "/Users/u",
      uid: 501,
      exec: async (cmd, args) => {
        execs.push([cmd, ...args]);
        if (args[1]?.startsWith("Set :EnvironmentVariables:OPENCODE_PASSWORD")) throw new Error("Does Not Exist"); // first time: Set fails → Add
        return { stdout: "", stderr: "" };
      },
      exists: (p) => p.endsWith(".plist"),
      readPassword: async () => "deadbeef",
    });
    assert.equal(svc.supervisor, "launchd");
    await svc.configure("v2", { db: "/d/x.db" });
    const cmds = execs.map((e) => e[2]);
    assert.ok(cmds.includes("Set :ProgramArguments:0 /Users/u/.opencode/bin/opencode"));
    assert.ok(cmds.includes("Add :EnvironmentVariables:OPENCODE_PASSWORD string deadbeef"));
    assert.ok(cmds.includes("Set :EnvironmentVariables:OPENCODE_DB /d/x.db") || cmds.includes("Add :EnvironmentVariables:OPENCODE_DB string /d/x.db"));
    execs.length = 0;
    await svc.start();
    assert.deepEqual(execs, [
      ["launchctl", "bootout", "gui/501/com.mantaui.opencode"],
      ["launchctl", "bootstrap", "gui/501", "/Users/u/Library/LaunchAgents/com.mantaui.opencode.plist"],
    ]);
  });
  test("configure(v1) deletes the V2-only keys that are present and reports a change; a second pass changes nothing", async () => {
    const execs = [];
    const plist = new Map([
      [":ProgramArguments:0", "/Users/u/.opencode/bin/opencode"],
      [":EnvironmentVariables:OPENCODE_PASSWORD", "deadbeef"],
      [":EnvironmentVariables:OPENCODE_DB", "/d/x.db"],
      [":EnvironmentVariables:OPENCODE_DISABLE_AUTOUPDATE", "true"],
    ]);
    const exec = async (c, a) => {
      const cmd = a[1];
      execs.push(cmd);
      const [verb, key, ...rest] = cmd.split(" ");
      if (verb === "Print") {
        if (!plist.has(key)) throw new Error("Does Not Exist");
        return { stdout: `${plist.get(key)}\n` };
      }
      if (verb === "Delete") plist.delete(key);
      if (verb === "Set" || verb === "Add") plist.set(key, verb === "Add" ? rest.slice(1).join(" ") : rest.join(" "));
      return { stdout: "" };
    };
    const svc = createOpencodeService({ platform: "darwin", home: "/Users/u", exec, exists: (p) => p.endsWith(".plist") });
    assert.equal(await svc.configure("v1"), true);
    assert.ok(execs.includes("Delete :EnvironmentVariables:OPENCODE_PASSWORD"));
    assert.ok(execs.includes("Delete :EnvironmentVariables:OPENCODE_DB"));
    assert.ok(execs.includes("Set :ProgramArguments:0 /Users/u/.opencode/bin/opencode-v1"));
    execs.length = 0;
    assert.equal(await svc.configure("v1"), false);
    assert.ok(!execs.some((e) => /^(Set|Add|Delete)/.test(e)), "idempotent: nothing written the second time");
  });
});

describe("nohup controller", () => {
  test("start spawns the chosen binary with the password/db env; V1 gets neither", async () => {
    const spawned = [];
    const svc = createOpencodeService({
      platform: "linux", home: "/home/u", exists: () => false, readPassword: async () => "deadbeef",
      spawnDetached: (bin, args, env) => spawned.push([bin, args, env]),
      killNohup: async () => spawned.push(["killed"]),
    });
    assert.equal(svc.supervisor, "nohup");
    await svc.configure("v2", { db: "/d/x.db" });
    await svc.stop();
    await svc.start();
    assert.deepEqual(spawned.slice(0, 2).map((x) => x[0]), ["killed", "killed"]);
    assert.deepEqual(spawned[2], [
      "/home/u/.opencode/bin/opencode",
      ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
      { OPENCODE_PASSWORD: "deadbeef", OPENCODE_DB: "/d/x.db", OPENCODE_DISABLE_AUTOUPDATE: "true" },
    ]);
    await svc.configure("v1");
    await svc.start();
    assert.deepEqual(spawned[3], ["killed"], "start() is a restart: whatever runs is killed first");
    assert.deepEqual(spawned[4], ["/home/u/.opencode/bin/opencode-v1", ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {}]);
  });
});

describe("readOpencodePassword (K1 reader — lazy)", () => {
  test("a password file created AFTER the first (failed) read is picked up on the next call; nothing is cached as empty", async () => {
    let content = null;
    const read = async () => {
      if (content === null) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return content;
    };
    const args = { env: {}, file: "/p/opencode-password", read };
    await assert.rejects(() => readOpencodePassword(args), /not readable.*ENOENT/);
    content = "\n";
    await assert.rejects(() => readOpencodePassword(args), /is empty/);
    content = "deadbeefdeadbeefdeadbeefdeadbeef\n"; // first boot creates it while the process is already running
    assert.equal(await readOpencodePassword(args), "deadbeefdeadbeefdeadbeefdeadbeef");
    content = "cafebabecafebabecafebabecafebabe\n"; // …and a rotation is seen too
    assert.equal(await readOpencodePassword(args), "cafebabecafebabecafebabecafebabe");
  });
  test("MANTA_OPENCODE_PASSWORD overrides the file", async () => {
    assert.equal(await readOpencodePassword({ env: { MANTA_OPENCODE_PASSWORD: " fromenv " }, read: async () => assert.fail("file must not be read") }), "fromenv");
  });
});
