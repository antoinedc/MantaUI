// upgradeV2Prepare.test.mjs — password file, pinned-binary install (+ integrity), V2 plugins,
// V1 retirement/restore, config merge, and the end-to-end prepare decision. Real fs in temp dirs.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  V1_PLUGIN_FILES,
  V1_TOOL_FILES,
  V2_PLUGINS,
  computeMigrationNeeded,
  ensurePasswordFile,
  installPinnedBinary,
  installV2Plugins,
  mergeV2Config,
  migrationStatePath,
  newPassword,
  parseMajor,
  prepareOpencodeV2,
  restoreV1Assets,
  retireV1Assets,
} from "./upgradeV2Prepare.mjs";
import { unitEnvValue, unitExecBin } from "./upgradeV2Service.mjs";

let root;
let prevState;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "manta-prep-"));
  prevState = process.env.MANTA_STATE_HOME;
  process.env.MANTA_STATE_HOME = join(root, "state");
  mkdirSync(join(root, "state"), { recursive: true });
});
afterEach(() => {
  if (prevState === undefined) delete process.env.MANTA_STATE_HOME;
  else process.env.MANTA_STATE_HOME = prevState;
  rmSync(root, { recursive: true, force: true });
});

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const mode = (p) => statSync(p).mode & 0o777;

describe("password file", () => {
  test("32 hex chars, mode 0600, created once and never rotated", async () => {
    const file = join(root, "pw", "opencode-password");
    const a = await ensurePasswordFile({ file });
    assert.equal(a.created, true);
    const first = readFileSync(file, "utf8");
    assert.match(first, /^[0-9a-f]{32}\n$/);
    assert.equal(mode(file), 0o600);
    const b = await ensurePasswordFile({ file });
    assert.equal(b.created, false);
    assert.equal(readFileSync(file, "utf8"), first);
  });
  test("a too-open file is tightened; an empty one is replaced", async () => {
    const file = join(root, "opencode-password");
    writeFileSync(file, "cafebabe\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    await ensurePasswordFile({ file });
    assert.equal(mode(file), 0o600);
    assert.equal(readFileSync(file, "utf8"), "cafebabe\n");
    writeFileSync(file, "\n");
    const r = await ensurePasswordFile({ file });
    assert.equal(r.created, true);
    assert.match(readFileSync(file, "utf8"), /^[0-9a-f]{32}\n$/);
  });
  test("newPassword is 32 hex", () => assert.match(newPassword(), /^[0-9a-f]{32}$/));
});

describe("parseMajor", () => {
  test("reads the first x.y.z", () => {
    assert.equal(parseMajor("1.18.34"), 1);
    assert.equal(parseMajor("opencode 2.0.30\n"), 2);
    assert.equal(parseMajor(""), null);
    assert.equal(parseMajor("garbage"), null);
  });
});

describe("pinned binary", () => {
  function vendor(content = "V2-BINARY", wrongSha = false) {
    const src = join(root, "vendor", "opencode", "opencode");
    mkdirSync(join(root, "vendor", "opencode"), { recursive: true });
    writeFileSync(src, content);
    writeFileSync(`${src}.sha256`, `${wrongSha ? "0".repeat(64) : sha(content)}  opencode\n`);
    return src;
  }
  test("installs executable, atomically, and is idempotent", async () => {
    const src = vendor();
    const destDir = join(root, "home", ".opencode", "bin");
    const a = await installPinnedBinary({ src, destDir });
    assert.equal(a.changed, true);
    assert.equal(readFileSync(join(destDir, "opencode"), "utf8"), "V2-BINARY");
    assert.equal(mode(join(destDir, "opencode")), 0o755);
    const b = await installPinnedBinary({ src, destDir });
    assert.equal(b.changed, false);
    assert.deepEqual(readdirSync(destDir), ["opencode"], "no .new leftovers");
  });
  test("integrity mismatch refuses to install and leaves the existing binary alone", async () => {
    const destDir = join(root, "bin");
    mkdirSync(destDir);
    writeFileSync(join(destDir, "opencode"), "OLD");
    const src = vendor("V2-BINARY", true);
    await assert.rejects(() => installPinnedBinary({ src, destDir }), /integrity/);
    assert.equal(readFileSync(join(destDir, "opencode"), "utf8"), "OLD");
  });
  test("a binary with no sha256 sidecar is refused", async () => {
    const src = vendor();
    rmSync(`${src}.sha256`);
    await assert.rejects(() => installPinnedBinary({ src, destDir: join(root, "bin") }), /sha256/);
  });
  test("no vendored binary → reports missing, touches nothing", async () => {
    const r = await installPinnedBinary({ src: join(root, "nope"), destDir: join(root, "bin") });
    assert.equal(r.missing, true);
    assert.equal(existsSync(join(root, "bin")), false);
  });
});

describe("V2 plugins", () => {
  function plugins() {
    const src = join(root, "docs", "opencode-plugins-v2");
    for (const name of V2_PLUGINS) {
      mkdirSync(join(src, name, "lib"), { recursive: true });
      writeFileSync(join(src, name, "index.ts"), `export default "${name}"`);
      writeFileSync(join(src, name, "lib", "a.ts"), "export {}");
      writeFileSync(join(src, name, "lib", "a.test.ts"), "import vitest");
    }
    mkdirSync(join(src, "manta", "node_modules", "x"), { recursive: true });
    writeFileSync(join(src, "manta", "node_modules", "x", "i.js"), "");
    return src;
  }
  test("copies the three plugin dirs, skipping tests + node_modules; second run is a no-op; a change is detected", async () => {
    const srcDir = plugins();
    const configDir = join(root, "cfg");
    const manifest = join(root, "state", ".manta", "m");
    const a = await installV2Plugins({ srcDir, configDir, manifest });
    assert.equal(a.changed, true);
    assert.deepEqual(a.installed, [...V2_PLUGINS]);
    for (const n of V2_PLUGINS) assert.ok(existsSync(join(configDir, "plugins", n, "index.ts")));
    assert.ok(!existsSync(join(configDir, "plugins", "manta", "lib", "a.test.ts")));
    assert.ok(!existsSync(join(configDir, "plugins", "manta", "node_modules")));
    const b = await installV2Plugins({ srcDir, configDir, manifest });
    assert.equal(b.changed, false);
    writeFileSync(join(srcDir, "manta", "index.ts"), "export default 'changed'");
    const c = await installV2Plugins({ srcDir, configDir, manifest });
    assert.equal(c.changed, true);
    assert.equal(readFileSync(join(configDir, "plugins", "manta", "index.ts"), "utf8"), "export default 'changed'");
    assert.deepEqual(readdirSync(join(configDir, "plugins")).sort(), [...V2_PLUGINS].sort(), "no .new leftovers");
  });
});

describe("mergeV2Config", () => {
  test("drops every opencode-claude-auth variant, keeps other plugins, adds the V2 rules", () => {
    const r = mergeV2Config(JSON.stringify({ plugin: ["opencode-claude-auth@latest", "other@1", "opencode-claude-auth-bui@1.5.4-bui.1"], theme: "x" }));
    const cfg = JSON.parse(r.text);
    assert.deepEqual(cfg.plugin, ["other@1"]);
    assert.equal(cfg.theme, "x");
    assert.equal(cfg.permission.external_directory, "ask");
    assert.deepEqual(cfg.instructions, ["CLAUDE.md"]);
  });
  test("the plugin key goes away when only claude-auth was in it", () => {
    const cfg = JSON.parse(mergeV2Config('{"plugin":["opencode-claude-auth@latest"]}').text);
    assert.equal("plugin" in cfg, false);
  });
  test("comments survive and the merge is idempotent", () => {
    const input = `{
  // my theme
  "theme": "dark",
  "plugin": ["opencode-claude-auth@latest"], // seeded
}
`;
    const a = mergeV2Config(input);
    assert.match(a.text, /\/\/ my theme/);
    assert.match(a.text, /\/\/ seeded/);
    const b = mergeV2Config(a.text);
    assert.equal(b.changed, false);
    assert.equal(b.text, a.text);
  });
  test("the user's own permission / instructions are respected", () => {
    const a = JSON.parse(mergeV2Config('{"permission":{"external_directory":"allow","bash":"ask"},"instructions":["docs/x.md","CLAUDE.md"]}').text);
    assert.equal(a.permission.external_directory, "allow");
    assert.deepEqual(a.instructions, ["docs/x.md", "CLAUDE.md"]);
    const b = JSON.parse(mergeV2Config('{"permission":"allow","instructions":["docs/x.md"]}').text);
    assert.equal(b.permission, "allow");
    assert.deepEqual(b.instructions, ["docs/x.md", "CLAUDE.md"]);
  });
  test("empty input → a fresh config; garbage is reported corrupt and left alone", () => {
    assert.equal(JSON.parse(mergeV2Config("").text).permission.external_directory, "ask");
    const bad = mergeV2Config("{ not json");
    assert.equal(bad.corrupt, true);
    assert.equal(bad.changed, false);
    assert.equal(bad.text, "{ not json");
  });
});

describe("computeMigrationNeeded", () => {
  const base = { dbExists: true, state: null, installedMajor: null, v1BinaryKept: false };
  test("table", () => {
    assert.equal(computeMigrationNeeded({ ...base, dbExists: false, installedMajor: 1 }), false, "no DB: nothing to migrate");
    assert.equal(computeMigrationNeeded({ ...base, installedMajor: 1 }), true, "V1 binary + DB");
    assert.equal(computeMigrationNeeded({ ...base, v1BinaryKept: true }), true, "V1 binary preserved + DB (re-run after a crash)");
    assert.equal(computeMigrationNeeded({ ...base, installedMajor: 2 }), false, "a V2 box's own DB is not a V1 DB");
    assert.equal(computeMigrationNeeded({ ...base }), false, "no evidence it was ever V1");
    for (const s of ["idle", "running", "failed"]) assert.equal(computeMigrationNeeded({ ...base, installedMajor: 2, state: { state: s } }), true, s);
    for (const s of ["completed", "rolled_back"]) assert.equal(computeMigrationNeeded({ ...base, installedMajor: 1, state: { state: s } }), false, s);
  });
});

describe("retire / restore V1 assets", () => {
  function v1Config() {
    const cfg = join(root, "cfg");
    mkdirSync(join(cfg, "tools"), { recursive: true });
    mkdirSync(join(cfg, "plugins"), { recursive: true });
    writeFileSync(join(cfg, "opencode.jsonc"), '{"plugin":["opencode-claude-auth@latest"],"theme":"x"}');
    for (const t of V1_TOOL_FILES) writeFileSync(join(cfg, "tools", t), `// ${t}`);
    for (const p of V1_PLUGIN_FILES) writeFileSync(join(cfg, "plugins", p), `// ${p}`);
    writeFileSync(join(cfg, "tools", "my-own-tool.ts"), "// mine");
    writeFileSync(join(cfg, "plugins", "my-own-plugin.ts"), "// mine");
    return cfg;
  }
  test("removes exactly Manta's V1 files (backed up), never the user's own, and updates the config", async () => {
    const cfg = v1Config();
    const backupDir = join(root, "bak");
    const r = await retireV1Assets({ configDir: cfg, backupDir });
    assert.equal(r.removed.length, V1_TOOL_FILES.length + V1_PLUGIN_FILES.length);
    assert.deepEqual(readdirSync(join(cfg, "tools")), ["my-own-tool.ts"]);
    assert.deepEqual(readdirSync(join(cfg, "plugins")), ["my-own-plugin.ts"]);
    const after = JSON.parse(readFileSync(join(cfg, "opencode.jsonc"), "utf8"));
    assert.equal("plugin" in after, false);
    assert.equal(after.theme, "x");
    // idempotent
    const again = await retireV1Assets({ configDir: cfg, backupDir });
    assert.deepEqual(again.removed, []);
    assert.equal(again.configChanged, false);
  });
  test("restore puts everything back byte for byte (the first backup wins, a re-run never overwrites it)", async () => {
    const cfg = v1Config();
    const original = readFileSync(join(cfg, "opencode.jsonc"), "utf8");
    const backupDir = join(root, "bak");
    await retireV1Assets({ configDir: cfg, backupDir });
    await retireV1Assets({ configDir: cfg, backupDir }); // second run sees the MERGED config — must not clobber the backup
    const r = await restoreV1Assets({ configDir: cfg, backupDir });
    assert.equal(readFileSync(join(cfg, "opencode.jsonc"), "utf8"), original);
    for (const t of V1_TOOL_FILES) assert.equal(readFileSync(join(cfg, "tools", t), "utf8"), `// ${t}`);
    for (const p of V1_PLUGIN_FILES) assert.equal(readFileSync(join(cfg, "plugins", p), "utf8"), `// ${p}`);
    assert.ok(r.restored.includes("opencode.jsonc"));
  });
});

describe("prepareOpencodeV2 (the whole decision)", () => {
  function box({ v1Bin = true, db = true, unit = true, vendorBin = true, state = null } = {}) {
    const home = join(root, "home");
    const mantaHome = join(root, "manta");
    mkdirSync(join(home, ".opencode", "bin"), { recursive: true });
    if (v1Bin) writeFileSync(join(home, ".opencode", "bin", "opencode"), "V1-BINARY");
    if (db) {
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
      writeFileSync(join(home, ".local", "share", "opencode", "opencode.db"), "SQLITE");
    }
    if (unit) {
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(
        join(home, ".config", "systemd", "user", "opencode-serve.service"),
        `[Service]\nExecStart=${join(home, ".opencode", "bin", "opencode")} serve --port 4096\n`,
      );
    }
    if (vendorBin) {
      mkdirSync(join(mantaHome, "vendor", "opencode"), { recursive: true });
      writeFileSync(join(mantaHome, "vendor", "opencode", "opencode"), "V2-BINARY");
      writeFileSync(join(mantaHome, "vendor", "opencode", "opencode.sha256"), `${sha("V2-BINARY")}  opencode\n`);
    }
    for (const name of V2_PLUGINS) {
      mkdirSync(join(mantaHome, "docs", "opencode-plugins-v2", name), { recursive: true });
      writeFileSync(join(mantaHome, "docs", "opencode-plugins-v2", name, "index.ts"), "x");
    }
    const cfg = join(home, ".config", "opencode");
    mkdirSync(join(cfg, "tools"), { recursive: true });
    writeFileSync(join(cfg, "tools", "schedule.ts"), "// v1 tool");
    writeFileSync(join(cfg, "opencode.jsonc"), '{"plugin":["opencode-claude-auth@latest"]}');
    if (state) writeFileSync(migrationStatePath(), JSON.stringify(state));
    const execs = [];
    const exec = async (cmd, args) => {
      execs.push([cmd, ...args]);
      if (args[0] === "--version") return cmd.endsWith("opencode") ? (readFileSync(cmd, "utf8") === "V1-BINARY" ? "1.18.34" : "2.0.30") : "";
      return "";
    };
    return { home, mantaHome, cfg, exec, execs, env: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share") } };
  }
  const run = (b) => prepareOpencodeV2({ mantaHome: b.mantaHome, home: b.home, env: b.env, exec: b.exec });

  test("V1 box with a history DB: V1 binary kept, service pinned to it, V2 installed, V1 assets left for the upgrade flow", async () => {
    mkdirSync(join(root, "state", ".manta"), { recursive: true });
    const b = box();
    const r = await run(b);
    assert.equal(r.migrationNeeded, true);
    assert.equal(r.bin, join(b.home, ".opencode", "bin", "opencode-v1"));
    assert.equal(readFileSync(join(b.home, ".opencode", "bin", "opencode-v1"), "utf8"), "V1-BINARY");
    assert.equal(readFileSync(join(b.home, ".opencode", "bin", "opencode"), "utf8"), "V2-BINARY");
    const unit = readFileSync(join(b.home, ".config", "systemd", "user", "opencode-serve.service"), "utf8");
    assert.equal(unitExecBin(unit), join(b.home, ".opencode", "bin", "opencode-v1"), "the unit must not run V2 against a raw V1 DB");
    assert.ok(b.execs.some((e) => e[0] === "systemctl" && e[2] === "daemon-reload"));
    assert.ok(existsSync(join(b.cfg, "tools", "schedule.ts")), "V1 still running: keep its tools until it is stopped");
    assert.match(readFileSync(join(b.cfg, "opencode.jsonc"), "utf8"), /opencode-claude-auth/);
    for (const n of V2_PLUGINS) assert.ok(existsSync(join(b.cfg, "plugins", n, "index.ts")));
    assert.equal(mode(r.passwordFile), 0o600);
    assert.equal(JSON.parse(readFileSync(migrationStatePath(), "utf8")).state, "idle");

    // second run (crash-resume / retry): same answer, nothing rewritten
    const r2 = await run(b);
    assert.equal(r2.migrationNeeded, true);
    assert.equal(r2.binaryChanged, false);
    assert.equal(r2.pluginsChanged, false);
    assert.equal(r2.passwordCreated, false);
    assert.equal(readFileSync(join(b.home, ".opencode", "bin", "opencode-v1"), "utf8"), "V1-BINARY", "the V1 copy is never overwritten by V2");
  });

  test("fresh install (no V1 DB): straight to V2, V1 assets retired immediately, nothing pinned to V1", async () => {
    mkdirSync(join(root, "state", ".manta"), { recursive: true });
    const b = box({ db: false, v1Bin: false, unit: false });
    const r = await run(b);
    assert.equal(r.migrationNeeded, false);
    assert.equal(r.bin, join(b.home, ".opencode", "bin", "opencode"));
    assert.ok(!existsSync(join(b.home, ".opencode", "bin", "opencode-v1")));
    assert.ok(!existsSync(join(b.cfg, "tools", "schedule.ts")));
    assert.ok(!/opencode-claude-auth/.test(readFileSync(join(b.cfg, "opencode.jsonc"), "utf8")));
    assert.ok(!existsSync(migrationStatePath()), "no state file for a fresh box");
  });

  test("a box already on V2 whose own DB exists is NOT mistaken for a V1 box", async () => {
    mkdirSync(join(root, "state", ".manta"), { recursive: true });
    const b = box({ v1Bin: false });
    writeFileSync(join(b.home, ".opencode", "bin", "opencode"), "V2-BINARY");
    const r = await run(b);
    assert.equal(r.migrationNeeded, false);
    assert.ok(!existsSync(join(b.home, ".opencode", "bin", "opencode-v1")));
  });

  test("a checkout with no vendored binary (dev box) is left exactly as it was", async () => {
    mkdirSync(join(root, "state", ".manta"), { recursive: true });
    const b = box({ vendorBin: false });
    const r = await run(b);
    assert.equal(r.migrationNeeded, false);
    assert.equal(r.binaryMissing, true);
    assert.equal(readFileSync(join(b.home, ".opencode", "bin", "opencode"), "utf8"), "V1-BINARY");
    assert.ok(existsSync(join(b.cfg, "tools", "schedule.ts")));
    assert.ok(!existsSync(join(b.cfg, "plugins")) || readdirSync(join(b.cfg, "plugins")).length === 0);
    assert.ok(!unitEnvValue(readFileSync(join(b.home, ".config", "systemd", "user", "opencode-serve.service"), "utf8"), "OPENCODE_PASSWORD"));
  });

  test("a completed migration is final: later runs only refresh binary/plugins and retire leftovers", async () => {
    mkdirSync(join(root, "state", ".manta"), { recursive: true });
    const b = box({ state: { state: "completed", mode: "copy", targetDb: "/x/opencode-v2.db" } });
    const r = await run(b);
    assert.equal(r.migrationNeeded, false);
    assert.equal(r.bin, join(b.home, ".opencode", "bin", "opencode"));
  });
});
